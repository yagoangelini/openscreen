// "Desfazer esta resposta": undoing ONE agent turn from the chat, in one step.
//
// A turn is already a single undo step by construction. The agent never writes the
// live document while it works: every tool call edits the main process's working
// copy, and the renderer receives the turn's FINAL document once, which
// `applyAgentDocumentIfCurrent` saves with `historyBase` = the pre-turn document.
// So however many cuts, zooms and word edits a reply made, the stack gains exactly
// one entry for it, and Ctrl+Z / redo walk it as one.
//
// What this module adds is a way to name THAT entry later, from the chat bubble,
// and to refuse when it is no longer the latest one. Undoing a turn that has later
// edits on top of it would mean either reverting those too (the stack is snapshots,
// not inverse operations) or a three-way merge nobody asked for -- so the button
// only acts while the turn's entry is still the top of `past`, and otherwise tells
// the user to walk back with Ctrl+Z.

import { useProjectStore } from "./projectStore";
import { undo } from "./undo";
import { past, type Snapshot } from "./undoStack";

export interface AgentTurnUndoHandle {
	readonly projectId: string;
	/** The exact entry the turn's save pushed. Compared by identity: any later
	 *  recording write pushes a new object, and an undo pops this one. */
	readonly snapshot: Snapshot;
}

/**
 * Name the entry an agent apply just pushed. Call it with nothing awaited between
 * the apply resolving and this line, so no other write can have recorded first.
 */
export function captureAgentTurnUndo(): AgentTurnUndoHandle | null {
	const { projectId } = useProjectStore.getState();
	const snapshot = past[past.length - 1];
	if (!projectId || !snapshot || snapshot.projectId !== projectId) return null;
	return { projectId, snapshot };
}

/** Whether the turn is still the latest change, i.e. one Ctrl+Z would revert exactly it. */
export function isAgentTurnLatest(handle: AgentTurnUndoHandle | null | undefined): boolean {
	if (!handle) return false;
	if (useProjectStore.getState().projectId !== handle.projectId) return false;
	return past[past.length - 1] === handle.snapshot;
}

/**
 * Undo the turn if it is still the latest change. Returns false, touching nothing,
 * when it is not. The persist mirrors the one `NewEditorShell` runs after Ctrl+Z:
 * `history: false`, because recording it would push the restored document straight
 * back onto the stack and clear the redo the undo just created.
 */
export function undoAgentTurn(handle: AgentTurnUndoHandle | null | undefined): boolean {
	if (!isAgentTurnLatest(handle)) return false;
	if (!undo()) return false;
	const doc = useProjectStore.getState().document;
	if (doc) void useProjectStore.getState().saveDocument(doc, { history: false });
	return true;
}
