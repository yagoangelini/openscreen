// Agent turns as the chat sees them: staged for approval, applied, discarded or undone.
//
// "Pedir aprovação antes de aplicar" (on by default) holds a turn's document here
// instead of writing it: the reply renders with what WOULD change, and nothing
// touches the project until the user presses Aplicar. The agent's tools never wrote
// the live document in the first place -- they edit a working copy in the main
// process, and the turn's final document is the only thing that comes back -- so
// staging is just not calling `applyDocument` yet. Read-only tools ran during the
// turn either way.
//
// A zustand store and not panel state, because the panel unmounts whenever the chat
// is closed, and a staged turn is the only copy of the agent's work: closing the
// chat must not be a silent "Descartar". Keyed by the assistant message id, which is
// the server's, so a session reload still finds the entry.

import { create } from "zustand";
import type { AxcutDocument } from "../schema";
import type { AgentDocumentApplyResult } from "./agentDocumentApply";
import { type AgentTurnUndoHandle, isAgentTurnLatest, undoAgentTurn } from "./agentTurnUndo";

// ---------------------------------------------------------------------------
// What a turn changes, by category, for the approval card.
// ---------------------------------------------------------------------------

export type AgentTurnChangeKind =
	| "clips"
	| "cuts"
	| "zooms"
	| "speed"
	| "annotations"
	| "audio"
	| "camera"
	| "captions"
	| "transcript"
	| "other";

export interface AgentTurnChange {
	kind: AgentTurnChangeKind;
	added: number;
	removed: number;
	changed: number;
}

const CHANGE_ORDER: readonly AgentTurnChangeKind[] = [
	"clips",
	"cuts",
	"zooms",
	"speed",
	"annotations",
	"audio",
	"camera",
	"captions",
	"transcript",
	"other",
];

function keyOf(item: unknown): string {
	if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
		return `id:${(item as { id: string }).id}`;
	}
	// Id-less ranges (mute, speed, caption) are keyed by content, so editing one reads
	// as one removed plus one added -- which is what happened to it, as far as an id
	// can tell.
	return `json:${JSON.stringify(item)}`;
}

function diffItems(before: readonly unknown[], after: readonly unknown[]) {
	const was = new Map(before.map((item) => [keyOf(item), JSON.stringify(item)]));
	const now = new Map(after.map((item) => [keyOf(item), JSON.stringify(item)]));
	let added = 0;
	let removed = 0;
	let changed = 0;
	for (const [key, json] of now) {
		const old = was.get(key);
		if (old === undefined) added += 1;
		else if (old !== json) changed += 1;
	}
	for (const key of was.keys()) if (!now.has(key)) removed += 1;
	return { added, removed, changed };
}

function legacyArray(document: AxcutDocument, key: string): unknown[] {
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const value = legacy?.[key];
	return Array.isArray(value) ? value : [];
}

function allWords(document: AxcutDocument): unknown[] {
	const transcripts = document.transcript
		? [document.transcript, ...document.transcripts]
		: document.transcripts;
	const words = new Map<string, unknown>();
	for (const transcript of transcripts) {
		for (const word of transcript.words) {
			words.set(`${transcript.assetId}:${word.id}`, {
				...word,
				id: `${transcript.assetId}:${word.id}`,
			});
		}
	}
	return [...words.values()];
}

/** Everything the categories above do not cover, for the catch-all "other" row. */
function remainder(document: AxcutDocument): string {
	const legacy = { ...((document.legacyEditor as Record<string, unknown> | null) ?? {}) };
	delete legacy.speedRegions;
	return JSON.stringify({
		assets: document.assets,
		legacy,
		project: { ...document.project, updatedAt: undefined },
		timeline: { gaps: document.timeline.gaps },
	});
}

/**
 * What the agent's document changes against the one it was given, by category.
 * Only categories with a change are returned, in a fixed order. Counts are of
 * items (a cut, a zoom, a word), not of tool calls: a single `addTrims` that
 * placed six cuts reads as six.
 */
export function summarizeAgentTurnChanges(
	before: AxcutDocument,
	after: AxcutDocument,
): AgentTurnChange[] {
	const rows: Record<AgentTurnChangeKind, { added: number; removed: number; changed: number }> = {
		clips: diffItems(before.timeline.clips, after.timeline.clips),
		cuts: diffItems(before.timeline.trimRanges, after.timeline.trimRanges),
		zooms: diffItems(before.zoomRanges, after.zoomRanges),
		speed: diffItems(
			[...before.timeline.speedRanges, ...legacyArray(before, "speedRegions")],
			[...after.timeline.speedRanges, ...legacyArray(after, "speedRegions")],
		),
		annotations: diffItems(before.annotations, after.annotations),
		audio: diffItems(
			[...before.audioTracks, ...before.timeline.muteRanges],
			[...after.audioTracks, ...after.timeline.muteRanges],
		),
		camera: diffItems(before.cameraSegments, after.cameraSegments),
		captions: diffItems(before.timeline.captionRanges, after.timeline.captionRanges),
		transcript: diffItems(allWords(before), allWords(after)),
		other: { added: 0, removed: 0, changed: remainder(before) === remainder(after) ? 0 : 1 },
	};
	return CHANGE_ORDER.flatMap((kind) => {
		const row = rows[kind];
		return row.added + row.removed + row.changed > 0 ? [{ kind, ...row }] : [];
	});
}

// ---------------------------------------------------------------------------
// The per-turn state the chat renders.
// ---------------------------------------------------------------------------

export type AgentTurnStatus = "pending" | "applying" | "applied" | "discarded" | "undone";

export type AgentTurnApply = (options?: {
	ignoreConflict?: boolean;
}) => Promise<AgentDocumentApplyResult | "malformed">;

export interface AgentTurnEntry {
	projectId: string;
	status: AgentTurnStatus;
	changes: AgentTurnChange[];
	/** Writes the staged document. Kept after a conflict so "apply anyway" can retry. */
	apply?: AgentTurnApply;
	/** Reads the undo entry the apply pushed. Set once the turn is applied. */
	undoHandle?: () => AgentTurnUndoHandle | null;
}

interface AgentTurnState {
	turns: Record<string, AgentTurnEntry>;
	/** Record a turn: staged ("pending") or already applied. */
	track: (messageId: string, entry: AgentTurnEntry) => void;
	/**
	 * Apply a staged turn. Resolves with the apply's verdict. "applied" moves it on;
	 * a conflict or failed save leaves it pending so the user can retry or discard;
	 * a turn that can never apply is retired. A second press while one is in flight
	 * is ignored.
	 */
	applyTurn: (
		messageId: string,
		options?: { ignoreConflict?: boolean },
	) => Promise<AgentDocumentApplyResult | "malformed" | "not-pending">;
	/** Drop a staged turn. Nothing was written, so there is nothing to revert. */
	discardTurn: (messageId: string) => void;
	/** Undo an applied turn if it is still the latest change. */
	undoTurn: (messageId: string) => boolean;
}

export const useAgentTurnStore = create<AgentTurnState>((set, get) => {
	const patch = (messageId: string, next: Partial<AgentTurnEntry>) =>
		set((state) => {
			const current = state.turns[messageId];
			if (!current) return state;
			return { turns: { ...state.turns, [messageId]: { ...current, ...next } } };
		});

	return {
		turns: {},
		track: (messageId, entry) =>
			set((state) => ({ turns: { ...state.turns, [messageId]: entry } })),
		applyTurn: async (messageId, options) => {
			const entry = get().turns[messageId];
			if (!entry?.apply || entry.status !== "pending") return "not-pending";
			patch(messageId, { status: "applying" });
			let result: AgentDocumentApplyResult | "malformed";
			try {
				result = await entry.apply(options);
			} catch {
				result = "malformed";
			}
			if (result === "applied") {
				patch(messageId, { status: "applied", apply: undefined });
			} else if (result === "malformed" || result === "no-live-document") {
				// Neither can ever succeed: not a document, or a project no longer open.
				// Leaving an "Apply" button that can only fail is worse than retiring it.
				patch(messageId, { status: "discarded", apply: undefined });
			} else {
				// A conflict or a failed save: still in hand, so the user can retry (or
				// answer the conflict with "apply anyway") or discard.
				patch(messageId, { status: "pending" });
			}
			return result;
		},
		discardTurn: (messageId) => {
			const entry = get().turns[messageId];
			if (!entry || entry.status !== "pending") return;
			patch(messageId, { status: "discarded", apply: undefined });
		},
		undoTurn: (messageId) => {
			const entry = get().turns[messageId];
			if (!entry || entry.status !== "applied") return false;
			if (!undoAgentTurn(entry.undoHandle?.())) return false;
			patch(messageId, { status: "undone" });
			return true;
		},
	};
});

/**
 * The applied turn one Ctrl+Z would revert, if any. Reads the undo stack, which is
 * not reactive: call it from a `useProjectStore` selector, since every write that
 * moves the stack also moves that store.
 */
export function latestUndoableTurnId(turns: Record<string, AgentTurnEntry>): string | null {
	for (const [messageId, entry] of Object.entries(turns)) {
		if (entry.status === "applied" && isAgentTurnLatest(entry.undoHandle?.())) return messageId;
	}
	return null;
}
