// The Media tab's cards: one per recording, whether the open project uses it or not, and one
// per other medium the project imported. Pure, so the merge is tested without a window.
//
// Before, the tab listed the project's assets (a gradient, the file name `recording-<id>.mp4`,
// the screen file's size) and, under them, the recordings folder (the take's name, its real
// thumbnail, every file's size): a take in the project showed twice, and only the first card
// opened its details.

export interface MediaCardRecording {
	key: string;
	name: string;
	screenVideoPath: string;
	files: readonly string[];
}

export interface MediaCardAsset {
	id: string;
	label: string;
	originalPath: string;
	kind?: string;
}

export type MediaCard<R extends MediaCardRecording, A extends MediaCardAsset> =
	| {
			kind: "recording";
			/** Unique among the cards. */
			id: string;
			recording: R;
			/** The project's asset for this take, when the open project has it. */
			asset: A | null;
	  }
	| { kind: "asset"; id: string; asset: A };

const normalize = (filePath: string) => filePath.replace(/\//g, "\\").toLowerCase();

/** Whether two paths name the same file (Windows: no case, either slash). */
export function samePath(a: string, b: string): boolean {
	return normalize(a) === normalize(b);
}

export function recordingCardId(key: string): string {
	return `recording:${key}`;
}

export function assetCardId(assetId: string): string {
	return `asset:${assetId}`;
}

/**
 * The cards, in this order: what the open project has, in its own order (a take it uses
 * shows as that take's card), then the recordings it does not have, as the library listed
 * them (newest first). Audio assets are timeline overlays, not media cards. `query` keeps
 * the cards whose name or path holds it, without case.
 */
export function buildMediaCards<R extends MediaCardRecording, A extends MediaCardAsset>(
	recordings: readonly R[],
	assets: readonly A[],
	query = "",
): Array<MediaCard<R, A>> {
	const used = new Set<string>();
	const cards: Array<MediaCard<R, A>> = [];
	for (const asset of assets) {
		if (asset.kind === "audio") continue;
		const recording = recordings.find(
			(candidate) =>
				!used.has(candidate.key) && samePath(candidate.screenVideoPath, asset.originalPath),
		);
		if (recording) {
			used.add(recording.key);
			cards.push({ kind: "recording", id: recordingCardId(recording.key), recording, asset });
		} else {
			cards.push({ kind: "asset", id: assetCardId(asset.id), asset });
		}
	}
	for (const recording of recordings) {
		if (used.has(recording.key)) continue;
		cards.push({ kind: "recording", id: recordingCardId(recording.key), recording, asset: null });
	}
	const needle = query.trim().toLowerCase();
	if (!needle) return cards;
	return cards.filter((card) => {
		const text =
			card.kind === "recording"
				? `${card.recording.name} ${card.asset?.label ?? ""} ${card.recording.screenVideoPath}`
				: `${card.asset.label} ${card.asset.originalPath}`;
		return text.toLowerCase().includes(needle);
	});
}
