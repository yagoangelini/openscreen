// Lightweight undo/redo for the project document. Every write that goes through
// `projectStore`'s `saveDocument` / `setDocument` records the outgoing document
// on the stack in `undoStack.ts` (callers opt out with `{ history: false }` for
// background writes). Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y walk that stack.
//
// The restore writes `useProjectStore.setState` DIRECTLY rather than calling
// back into `setDocument`, which is what makes redo work: routing it through a
// recording write meant an undo re-recorded the document it had just replaced
// and cleared `future` on the way past, so redo was gone before the user could
// reach for it and Ctrl+Z degraded into an A/B toggle. Writing the state is also
// all a repaint needs — the timeline, preview and shell all subscribe to
// `s.document`.

import { useCallback, useEffect, useRef } from "react";
import { isModalOpen } from "../modalGuard";
import type { AxcutDocument } from "../schema";
import type { HistoryLabel } from "./historyLabels";
import { useProjectStore } from "./projectStore";
import {
	clearHistory,
	future,
	past,
	popFuture,
	popPast,
	pushFuture,
	pushPast,
	supersedeInFlightWrites,
} from "./undoStack";

export { clearHistory } from "./undoStack";

/** Put a snapshot back on screen without recording it as a new edit. `dirty` is
 *  set because the document on disk is no longer the one in memory — the caller
 *  of `useUndoRedoShortcuts` persists it. */
function restore(doc: unknown) {
	// Before the state write, so a save that resolves between here and the caller's
	// persist cannot slip its result in. See `undoStack.ts`: a save already in flight
	// when Ctrl+Z was pressed used to install its document over the restored one and
	// push a FORWARD state onto `past`, wiping the redo the undo had just created.
	supersedeInFlightWrites();
	useProjectStore.setState((state) => ({
		document: doc as AxcutDocument,
		revision: state.revision + 1,
		dirty: true,
	}));
}

/**
 * Step back `steps` entries at once (the history menu's "go back to here"), as ONE restore:
 * every entry walked past moves to `future` with its label, so redo can replay them one by
 * one or all together, and the screen and the persist that follows see only the last state.
 * Fewer entries than asked is fine: it stops at the oldest. Returns whether anything moved.
 */
export function undo(steps = 1): boolean {
	const state = useProjectStore.getState();
	let current: unknown = state.document;
	let moved = 0;
	for (let i = 0; i < Math.max(1, Math.floor(steps)); i++) {
		const prev = popPast();
		if (!prev) break;
		if (!state.projectId || state.projectId !== prev.projectId) {
			clearHistory();
			return false;
		}
		// The entry leaving `past` named the edit between it and `current`: redoing it is
		// what the new `future` entry stands for.
		if (current) {
			pushFuture({ projectId: prev.projectId, doc: structuredClone(current), label: prev.label });
		}
		current = prev.doc;
		moved += 1;
	}
	if (moved === 0) return false;
	restore(current);
	return true;
}

/** The mirror of `undo(steps)`: replay `steps` undone entries as one restore. */
export function redo(steps = 1): boolean {
	const state = useProjectStore.getState();
	let current: unknown = state.document;
	let moved = 0;
	for (let i = 0; i < Math.max(1, Math.floor(steps)); i++) {
		const next = popFuture();
		if (!next) break;
		if (!state.projectId || state.projectId !== next.projectId) {
			clearHistory();
			return false;
		}
		if (current) {
			pushPast({ projectId: next.projectId, doc: structuredClone(current), label: next.label });
		}
		current = next.doc;
		moved += 1;
	}
	if (moved === 0) return false;
	restore(current);
	return true;
}

/** One row of the history menu: what the step was, and how many steps away it is. */
export interface HistoryEntry {
	label: HistoryLabel;
	/** 1 for the step one Ctrl+Z (or one redo) takes, 2 for the one behind it, and so on. */
	steps: number;
}

/**
 * The history as the menus list it, nearest first: `undo` the steps Ctrl+Z walks back
 * through, `redo` the ones redo replays. Only the open project's; an entry without a label
 * (recorded before labels existed in this session) reads as a plain edit.
 */
export function historyEntries(): { undo: HistoryEntry[]; redo: HistoryEntry[] } {
	const projectId = useProjectStore.getState().projectId;
	const list = (stack: typeof past): HistoryEntry[] => {
		const out: HistoryEntry[] = [];
		for (let i = stack.length - 1; i >= 0; i--) {
			if (stack[i].projectId !== projectId) break;
			out.push({ label: stack[i].label ?? "edit", steps: stack.length - i });
		}
		return out;
	};
	return { undo: list(past), redo: list(future) };
}

/**
 * Whether the document undo must keep its hands off: inside a text field the
 * browser's own text undo is the one the user means. The keydown path checks the
 * event target, the menu path checks `activeElement` — same rule, two entry
 * points, so it lives in one function.
 *
 * A block marked `data-document-undo` is editable without being a text field: the
 * transcript is contentEditable only to carry a caret, and its edits are document
 * writes (Backspace is a trim) that the browser's text history never sees. Left to
 * that history, Ctrl/Cmd+Z there did nothing at all (#1012). The fields inside it
 * (the word editor) are still fields.
 */
function isTextEditingTarget(node: EventTarget | null): boolean {
	if (
		node instanceof HTMLTextAreaElement ||
		node instanceof HTMLInputElement ||
		node instanceof HTMLSelectElement
	) {
		return true;
	}
	return (
		node instanceof HTMLElement && node.isContentEditable && !node.closest("[data-document-undo]")
	);
}

export interface UndoRedoHandlers {
	/**
	 * Undo, applying the same text-field rule the keyboard path applies.
	 *
	 * Wired to the native Edit menu, which on macOS is the ONLY route Cmd+Z has:
	 * AppKit matches the menu's key equivalent before the key event reaches the web
	 * contents, so the keydown listener below never runs there. See
	 * `electron/edit-menu.ts`.
	 */
	runUndo: () => void;
	runRedo: () => void;
	/** The history menu's jump: undo (or redo) `steps` entries in one step, then persist. */
	runUndoSteps: (steps: number) => void;
	runRedoSteps: (steps: number) => void;
}

export function useUndoRedoShortcuts(onAfter: () => void): UndoRedoHandlers {
	const onAfterRef = useRef(onAfter);
	onAfterRef.current = onAfter;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isTextEditingTarget(e.target)) return;
			// `NewEditorShell` hands Ctrl+Z / Ctrl+Y to this listener instead of handling them,
			// so its modal guard never runs for them: without this one, undo kept rewriting the
			// document under every open modal, including the ones the shell does suppress.
			if (isModalOpen()) return;
			const ctrl = e.ctrlKey || e.metaKey;
			if (ctrl && e.shiftKey && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (redo()) onAfterRef.current();
				return;
			}
			if (ctrl && e.key.toLowerCase() === "y") {
				e.preventDefault();
				if (redo()) onAfterRef.current();
				return;
			}
			// `toLowerCase()`, like the two branches above: with Caps Lock on the browser
			// reports "Z", and the bare `=== "z"` here fell through to nothing at all.
			if (ctrl && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (undo()) onAfterRef.current();
				return;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// `execCommand` is the only handle the renderer has on the browser's text undo,
	// and it is what the `undo` menu ROLE reached through `webContents.undo()`. It is
	// deprecated and absent under jsdom, hence the optional call: losing text undo in
	// a field is survivable, a TypeError from a menu click is not.
	const runUndo = useCallback(() => {
		if (isTextEditingTarget(window.document.activeElement)) {
			window.document.execCommand?.("undo");
			return;
		}
		// AFTER the text-field check, so a rename dialog's input still gets the browser's
		// own text undo. Before it, this route rewrote the DOCUMENT under an open modal:
		// a modal's controls are buttons, so `isTextEditingTarget` waves them through, and
		// on macOS the menu is the only path Cmd+Z has -- there is no keydown handler
		// upstream of this one to stop it. See `../modalGuard`, and #434, which fixes the
		// same hole on the keydown path.
		if (isModalOpen()) return;
		if (undo()) onAfterRef.current();
	}, []);

	const runRedo = useCallback(() => {
		if (isTextEditingTarget(window.document.activeElement)) {
			window.document.execCommand?.("redo");
			return;
		}
		if (isModalOpen()) return;
		if (redo()) onAfterRef.current();
	}, []);

	// No text-field rule: the menu is a button's, so focus is never in a field when it runs.
	const runUndoSteps = useCallback((steps: number) => {
		if (isModalOpen()) return;
		if (undo(steps)) onAfterRef.current();
	}, []);

	const runRedoSteps = useCallback((steps: number) => {
		if (isModalOpen()) return;
		if (redo(steps)) onAfterRef.current();
	}, []);

	return { runUndo, runRedo, runUndoSteps, runRedoSteps };
}
