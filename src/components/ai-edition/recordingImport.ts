// Hand-off from the recorder to the editor.
//
// The HUD parks the recording it just finished in ONE main-process slot
// (`set/getCurrentRecordingSession`) and opens the editor, which imports it into
// a fresh project on mount. The slot has to be emptied once that project owns
// the file, because opening the editor destroys and recreates its window
// (`createEditorWindowWrapper` in electron/main.ts) — so a session left in place
// is imported AGAIN on the next open: a second project on the same recording,
// back at the default padding / roundness / wallpaper, while everything the user
// set and saved stays behind in the first project, which is no longer the one on
// screen. That reads exactly like "the editor forgot my settings" (#364).
//
// `setCurrentRecordingSession(null)` is the existing clear (it also drops the
// derived `currentVideoPath`); the only renderer that still needs the session
// after this point is the CLI runner, which lives in its own process.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { formatDateTime } from "@/i18n/format";
import { currentLocale, toastText } from "@/i18n/toastText";
import {
	cameraSegmentsFromRecordingLayout,
	readCameraSegments,
} from "@/lib/ai-edition/document/cameraSegments";
import { createId } from "@/lib/ai-edition/document/ids";
import { clipAwaitsProbedDuration } from "@/lib/ai-edition/document/timeline";
import { nameFreshTake } from "@/lib/ai-edition/freshTakeName";
import { resolveProjectTranscriptionSettings } from "@/lib/ai-edition/projectTranscriptionSettings";
import {
	AUTO_REDACT_SOURCE,
	parseOcrScan,
	parseSensitiveTerms,
	type RedactionSpan,
	redactionAnnotations,
	replaceAutoRedactions,
	scannedUpToSec,
	trackDetections,
} from "@/lib/ai-edition/redaction";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import {
	DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
	saveWithDeadline,
	useProjectStore,
	waitForDocumentSaves,
} from "@/lib/ai-edition/store/projectStore";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForLatestDocument,
} from "@/lib/ai-edition/timeline/apply-auto-zooms";
import {
	getScreenActivityForZooms,
	getTelemetryWithFramePopups,
} from "@/lib/ai-edition/timeline/framePopups";
import type { ScreenActivity } from "@/lib/ai-edition/timeline/screenActivity";
import { nativeBridgeClient } from "@/native/client";

// Fresh recordings used to get cursor-dwell zooms on load (legacy editor
// `autoZoomEnabled`, default on). The ai-edition import only seeded a clip, so
// the wand still worked but a new take landed un-zoomed. This flag is the
// one-shot hand-off: set as soon as the asset is on the document, then taken on
// the first pass that can give a real answer -- zooms written, no click in the
// sidecar, or the toggle is off. What keeps it set is only ever "not enough of
// the document yet" (no clips, still the placeholder duration), and the
// `loadedmetadata` write is what comes back when that resolves.
//
// The recording path is what scopes it: `importPendingRecording` always has one,
// and it is what stops a flag left over from a take with nothing to zoom from
// decorating the next document loaded in the same window. A successful save
// records the project id so a later undo or delete cannot silently re-seed it.
let pendingFreshRecordingAutoZoom = false;
let pendingFreshRecordingAutoZoomPath: string | null = null;
let appliedFreshRecordingAutoZoomProjectId: string | null = null;
let freshRecordingAutoZoomSaveChain: Promise<void> = Promise.resolve();
/** The take just imported with zooms to plan, for the transcript offer: kept past the zoom pass. */
let transcriptOfferTakePath: string | null = null;
/**
 * The take whose "Rosto / Tela + câmera" pieces are still to be written. Its automatic zooms
 * wait for them: a "face" span shows no screen, so they are planned around it
 * (`collectAutoZoomSuggestionsForDocument`), and that needs the pieces on the document first.
 *
 * Kept, with the take's project, while the take's length is still unknown: the pieces need it,
 * and the `loadedmetadata` write that brings it asks for them (`resumeFreshRecordingCameraLayout`).
 */
let pendingFreshRecordingCameraLayoutPath: string | null = null;
let pendingFreshRecordingCameraLayoutProjectId: string | null = null;

export function markFreshRecordingAutoZoomPending(assetPath: string): void {
	pendingFreshRecordingAutoZoom = true;
	pendingFreshRecordingAutoZoomPath = assetPath;
	appliedFreshRecordingAutoZoomProjectId = null;
}

function clearFreshRecordingAutoZoomPending(): void {
	pendingFreshRecordingAutoZoom = false;
	pendingFreshRecordingAutoZoomPath = null;
}

/**
 * The take whose automatic zooms may follow its transcript: the one just recorded, when its
 * zooms are on (the HUD's toggle), it has a cursor to plan from and the machine can transcribe.
 * Null otherwise, and then nothing is asked.
 */
export async function freshRecordingTranscriptOffer(): Promise<{ assetId: string } | null> {
	const takePath = transcriptOfferTakePath;
	transcriptOfferTakePath = null;
	if (!takePath) return null;
	if (typeof window === "undefined" || typeof window.electronAPI?.stt?.transcribe !== "function") {
		return null;
	}
	if (!(await readAutoZoomPref())) return null;
	const document = useProjectStore.getState().document;
	const asset = document?.assets.find((candidate) => candidate.originalPath === takePath);
	return asset ? { assetId: asset.id } : null;
}

/**
 * The take's automatic zooms are planned once its transcript is in (`replanAutoZooms`), not by
 * the import's cursor-only pass: that pass stands down. If it already ran, the re-plan replaces
 * what it wrote.
 */
export function handFreshRecordingAutoZoomsToTranscript(): void {
	const document = useProjectStore.getState().document;
	clearFreshRecordingAutoZoomPending();
	if (document) appliedFreshRecordingAutoZoomProjectId = document.project.id;
}

/** Resolves once the asset's clips have their real length (true), or after `timeoutMs` (false). */
export async function whenAssetDurationProbed(
	assetId: string,
	timeoutMs = 60_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const document = useProjectStore.getState().document;
		const clips = document?.timeline.clips ?? [];
		if (clips.length > 0 && !clips.some((clip) => clipAwaitsProbedDuration(clip, assetId))) {
			return true;
		}
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

export function consumeFreshRecordingAutoZoomPending(): boolean {
	const was = pendingFreshRecordingAutoZoom;
	clearFreshRecordingAutoZoomPending();
	appliedFreshRecordingAutoZoomProjectId = null;
	freshRecordingAutoZoomSaveChain = Promise.resolve();
	freshTelemetryPrefetch = null;
	freshActivityPrefetch = null;
	pendingFreshRecordingCameraLayoutPath = null;
	pendingFreshRecordingCameraLayoutProjectId = null;
	return was;
}

/**
 * The fresh take's telemetry, the menus its frames show included, read once. Behind it
 * is a frame scan (`getTelemetryWithFramePopups`) that can take most of a minute on a
 * long web tutorial; started at import and waited for off the editor's write queue, it
 * no longer holds the user's first edits behind it. Keyed by path, so the next take
 * reads its own.
 */
let freshTelemetryPrefetch: { path: string; promise: Promise<CursorTelemetryPoint[]> } | null =
	null;

function freshRecordingTelemetry(videoPath: string): Promise<CursorTelemetryPoint[]> {
	if (freshTelemetryPrefetch?.path === videoPath) return freshTelemetryPrefetch.promise;
	const promise = getTelemetryWithFramePopups(videoPath, (path) =>
		nativeBridgeClient.cursor.getTelemetry(path),
	);
	freshTelemetryPrefetch = { path: videoPath, promise };
	// A read that failed is not an answer to keep: the next pass for this take tries again.
	promise.catch(() => {
		if (freshTelemetryPrefetch?.promise === promise) freshTelemetryPrefetch = null;
	});
	return promise;
}

/**
 * The fresh take's screen activity (where its frames changed), read once and started at
 * import like the telemetry: a decode of the whole take, about 5 % of its length.
 */
let freshActivityPrefetch: { path: string; promise: Promise<ScreenActivity | null> } | null = null;

function freshRecordingActivity(videoPath: string): Promise<ScreenActivity | null> {
	if (freshActivityPrefetch?.path === videoPath) return freshActivityPrefetch.promise;
	const promise = getScreenActivityForZooms(videoPath);
	freshActivityPrefetch = { path: videoPath, promise };
	// No answer is not one to keep: the next pass for this take tries again.
	promise.then(
		(activity) => {
			if (!activity && freshActivityPrefetch?.promise === promise) freshActivityPrefetch = null;
		},
		() => {
			if (freshActivityPrefetch?.promise === promise) freshActivityPrefetch = null;
		},
	);
	return promise;
}

/**
 * Starts reading the pending take's telemetry, frame scans and all, and settles once it
 * is in -- never rejecting: the pass that uses it sees a failure for itself.
 */
export function prefetchFreshRecordingTelemetry(): Promise<void> {
	const path = pendingFreshRecordingAutoZoomPath;
	if (!pendingFreshRecordingAutoZoom || !path) return Promise.resolve();
	return Promise.all([freshRecordingTelemetry(path), freshRecordingActivity(path)]).then(
		() => undefined,
		() => undefined,
	);
}

export type ApplyFreshRecordingAutoZoomsDeps = {
	enabled?: boolean;
	getTelemetry?: (videoPath: string) => Promise<CursorTelemetryPoint[] | null | undefined>;
	/** Where the take's screen changed. Tests stub it. */
	getActivity?: (videoPath: string) => Promise<ScreenActivity | null | undefined>;
	createId?: (prefix: string) => string;
	/** Deadline for this path's own write. Tests use a short one. */
	saveTimeoutMs?: number;
	/** Deadline for waiting on writes somebody else started. Tests shorten it. */
	waitTimeoutMs?: number;
	/** Deadline for the auto-zoom preference read. Tests shorten it. */
	prefsTimeoutMs?: number;
};

/**
 * The user's standing answer, read fresh rather than cached: the toggle lives in the
 * editor's rec panel and the HUD publishes prefs changes across windows, so the value
 * can change between one take and the next within a single renderer.
 *
 * An unreachable or throwing bridge reads as ON, which is what every installation did
 * before the preference existed — a failed IPC call must not silently turn a feature off.
 *
 * Bounded for the same reason the write below is: this runs inside
 * `freshRecordingAutoZoomSaveChain`, which `runLoadedMetadataWrite` awaits, so a main
 * process that accepts the invoke and never answers would hold that queue slot — and
 * every metadata write behind it — for the life of the renderer. `invoke` rejects on a
 * throwing handler but never on a silent one, so the `catch` above cannot cover this.
 * A deadline that expires says only "no answer yet", which reads as ON like every other
 * unreadable answer.
 */
export async function readAutoZoomPref(
	timeoutMs = DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
): Promise<boolean> {
	try {
		const read = (async () => {
			const prefs = await window.electronAPI?.getRecordingPrefs?.();
			return prefs?.autoZoomEnabled !== false;
		})();
		const settled = await saveWithDeadline(read, timeoutMs);
		return settled === "timeout" ? true : settled;
	} catch {
		return true;
	}
}

function isPendingFreshRecordingAsset(asset: { originalPath?: string | null }): boolean {
	return asset.originalPath === pendingFreshRecordingAutoZoomPath;
}

function pendingFreshRecordingAsset(document: AxcutDocument) {
	return document.assets.find(isPendingFreshRecordingAsset);
}

/**
 * Whether the pending take's real length has landed yet.
 *
 * Not just `asset.durationSec != null`. A recording whose container reports no
 * duration (MediaRecorder WebM, until the EBML fix) still gets the placeholder
 * written to that field, because the timeline layer clamps every interval it
 * builds against `primaryAssetDuration` and would otherwise drop every clip. So
 * the asset says "60" for a take nothing has measured, and the clips are what
 * distinguish the two: one still sitting at the placeholder length is waiting.
 *
 * The cost is a take of exactly 60.000 s never being auto-zoomed. That is the
 * same ambiguity `applyProbedDuration` already lives with, and it is a far
 * smaller price than suggesting zooms against a length nothing measured.
 */
function hasProbedDurationForPendingAsset(document: AxcutDocument): boolean {
	const asset = pendingFreshRecordingAsset(document);
	if (
		asset == null ||
		asset.durationSec == null ||
		!Number.isFinite(asset.durationSec) ||
		asset.durationSec <= 0
	) {
		return false;
	}
	return !document.timeline.clips.some((clip) => clipAwaitsProbedDuration(clip, asset.id));
}

function canApplyFreshRecordingAutoZooms(document: AxcutDocument): boolean {
	if (!pendingFreshRecordingAutoZoom) return false;
	// The camera pieces come first; their pass asks for the zooms again once it is done.
	if (
		pendingFreshRecordingCameraLayoutPath !== null &&
		pendingFreshRecordingCameraLayoutPath === pendingFreshRecordingAutoZoomPath
	) {
		return false;
	}
	if (appliedFreshRecordingAutoZoomProjectId === document.project.id) return false;
	if ((document.zoomRanges?.length ?? 0) > 0) return false;
	if ((document.timeline?.clips?.length ?? 0) === 0) return false;
	if (!hasProbedDurationForPendingAsset(document)) return false;
	return document.assets.some(isPendingFreshRecordingAsset);
}

/** Zooms are on the document already -- the wand ran, or a redo brought them back.
 *  The take is decorated, so the hand-off is spent for this project. */
function markDecoratedIfZoomed(document: AxcutDocument): boolean {
	if ((document.zoomRanges?.length ?? 0) === 0) return false;
	clearFreshRecordingAutoZoomPending();
	appliedFreshRecordingAutoZoomProjectId = document.project.id;
	return true;
}

function liveDocument(fallback: AxcutDocument): AxcutDocument {
	return useProjectStore.getState().document ?? fallback;
}

export async function applyPendingFreshRecordingAutoZooms(
	document: AxcutDocument,
	deps: ApplyFreshRecordingAutoZoomsDeps = {},
): Promise<AxcutDocument> {
	if (!pendingFreshRecordingAutoZoom) return document;
	if (appliedFreshRecordingAutoZoomProjectId === document.project.id) {
		clearFreshRecordingAutoZoomPending();
		return document;
	}
	const enabled = deps.enabled ?? (await readAutoZoomPref(deps.prefsTimeoutMs));
	const start = liveDocument(document);
	// The read yields. A project opened meanwhile is not this take's to decorate, and
	// not the place to spend its hand-off either: the pass that comes back with it will.
	if (start.project.id !== document.project.id) return start;
	if (!enabled) {
		clearFreshRecordingAutoZoomPending();
		return start;
	}
	if (markDecoratedIfZoomed(start)) return start;
	if (!canApplyFreshRecordingAutoZooms(start)) return start;

	const inner = deps.getTelemetry ?? freshRecordingTelemetry;
	let telemetryFailed = false;
	const getTelemetry = async (videoPath: string) => {
		try {
			return await inner(videoPath);
		} catch {
			// An unreadable sidecar is NOT the same answer as an empty one: it says
			// nothing about whether this take has a click, so pending survives it and a
			// later `loadedmetadata` for the same take gets another go.
			telemetryFailed = true;
			return [];
		}
	};
	// The wand's own collect path, scoped to the take this hand-off is about: read the
	// document, collect, and collect again if the clips moved while the telemetry was
	// being read. Sharing it is the point -- the suggestions carry TIMELINE spans and
	// `appendAutoZoomSuggestions` anchors them against whatever the store holds at write
	// time, so the two callers must agree on when a collected set has gone stale.
	//
	// The reader re-runs every guard, so a project switch, a wand run or a delete
	// landing during the wait ends the pass exactly where the retry would have started.
	const collected = await collectAutoZoomSuggestionsForLatestDocument(
		() => {
			const live = liveDocument(start);
			if (live.project.id !== start.project.id) return null;
			if (markDecoratedIfZoomed(live)) return null;
			return canApplyFreshRecordingAutoZooms(live) ? live : null;
		},
		getTelemetry,
		isPendingFreshRecordingAsset,
		deps.getActivity ?? freshRecordingActivity,
	);
	if (!collected) return liveDocument(start);
	if (collected.suggestions.length === 0) {
		// A real answer, not a race: the stop handler awaits `writePendingCursorTelemetry`
		// BEFORE it publishes the session, so by the time the editor can import the take
		// its sidecar is on disk. An empty read therefore means this take has no click to
		// zoom, and no amount of retrying changes that -- consume the hand-off rather than
		// leaving it armed for the next document loaded in this window.
		if (!telemetryFailed) clearFreshRecordingAutoZoomPending();
		return collected.document;
	}
	return appendAutoZoomSuggestions(
		collected.document,
		collected.suggestions,
		deps.createId ?? createId,
	);
}

export async function maybeSaveFreshRecordingAutoZooms(
	document: AxcutDocument,
	deps: ApplyFreshRecordingAutoZoomsDeps = {},
): Promise<boolean> {
	/** `"contended"`: a user write landed on the snapshot this attempt built from, so
	 *  it decided nothing and is worth repeating against the settled document. */
	const writeFreshRecordingAutoZooms = async (): Promise<boolean | "contended"> => {
		try {
			// A wait that times out has told us nothing about what is on disk, so the
			// only safe move is to abandon this attempt with pending still set, and let
			// a later `loadedmetadata` for this take rebase onto whatever the stuck save
			// eventually leaves.
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return false;
			const latest = liveDocument(document);
			const next = await applyPendingFreshRecordingAutoZooms(latest, deps);
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return false;
			const current = liveDocument(document);
			if (current.project.id !== latest.project.id) return false;
			if ((current.zoomRanges?.length ?? 0) > 0) {
				appliedFreshRecordingAutoZoomProjectId = current.project.id;
				clearFreshRecordingAutoZoomPending();
				return false;
			}
			// Contention means start over, not rebase. If the document moved while the
			// suggestion pass ran, this attempt is working from a snapshot that is
			// already history — writing `next` over the newer one would take the user's
			// edit with it. Drop it and let the repeat below re-collect from scratch,
			// after `waitForDocumentSaves` has seen that writer finish.
			if (current !== latest) return "contended";
			// Nothing to write: the pass returned the document it was given, because a
			// guard refused it or the take has no click.
			if (next === latest) return false;
			const saved = await saveWithDeadline(
				useProjectStore.getState().saveDocument(next, { history: true }),
				deps.saveTimeoutMs ?? DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
			);
			// The write never answered. Keep pending and let go of the chain, so nothing
			// queues behind a promise that is not coming back.
			if (saved === "timeout") return false;
			// A trim (or any other edit) can start after this save was submitted and
			// still be in flight when it returns: `waitForDocumentSaves` before the
			// write only sees saves that have already begun. Wait again, then look at
			// the store — if that later write landed on the unzoomed snapshot, keep
			// pending. A timeout here says the same thing for a different reason: we
			// cannot tell what landed, so do not clear pending.
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return saved;
			const stored = useProjectStore.getState().document;
			if (saved && stored && (stored.zoomRanges?.length ?? 0) > 0) {
				appliedFreshRecordingAutoZoomProjectId = stored.project.id;
				clearFreshRecordingAutoZoomPending();
			}
			return saved;
		} catch (error) {
			// `saveDocument` reports failure by returning false, so anything thrown
			// here came from the suggestion pass or a bridge call. Pending stays set and
			// the path goes quiet — log it, or it is invisible.
			console.warn("[recording] fresh-recording auto-zoom write failed:", error);
			return false;
		}
	};
	// One repeat, not a loop: a user who keeps editing through the telemetry wait keeps
	// invalidating the attempt, and the honest answer there is the wand, not spinning.
	const attemptFreshRecordingAutoZooms = async (): Promise<boolean> => {
		const first = await writeFreshRecordingAutoZooms();
		if (first !== "contended") return first;
		const second = await writeFreshRecordingAutoZooms();
		return second === "contended" ? false : second;
	};
	const done = freshRecordingAutoZoomSaveChain.then(
		attemptFreshRecordingAutoZooms,
		attemptFreshRecordingAutoZooms,
	);
	freshRecordingAutoZoomSaveChain = done.then(
		() => undefined,
		() => undefined,
	);
	return done;
}

/**
 * Imports the recording the HUD handed over into a new project, and consumes the
 * hand-off so it is imported exactly once.
 *
 * Returns false when there is nothing pending — the caller then falls back to
 * reopening the most recent project. Throws if the import itself fails, leaving
 * the session in place so a later mount can retry it.
 */
/** Why a take is less protected than the user may think: say so rather than stay quiet. */
export type RedactionScanIssue =
	| { kind: "failed"; reason?: string }
	| { kind: "partial"; scannedUpToSec: number };

export type FreshRecordingRedactionDeps = {
	scan?: (
		videoPath: string,
	) => Promise<
		{ success: boolean; output?: string; error?: string; unsupported?: boolean } | undefined
	>;
	/** Told when the scan failed or covered only the start of the take. */
	onScanIssue?: (issue: RedactionScanIssue) => void;
	createId?: (prefix: string) => string;
	/** The user's own sensitive words; the preference when absent. Tests set it. */
	terms?: string;
	/** How long to wait for the take's real length before giving up. Tests shorten it. */
	probeWaitMs?: number;
	saveTimeoutMs?: number;
	waitTimeoutMs?: number;
};

/**
 * The automatic privacy blur for a fresh take: OCR over the recording, then a blur
 * on every e-mail, tenant domain, GUID, secret and phone number it shows, added as
 * one undoable edit. Returns how many were added.
 *
 * Runs beside everything else on the import -- the scan takes a few seconds per
 * minute of a busy screen -- and writes the way the auto-zoom does: against the
 * live document, once the take's real length is known, and not over an edit that
 * landed while it worked.
 */
export async function applyFreshRecordingRedactions(
	screenPath: string,
	deps: FreshRecordingRedactionDeps = {},
): Promise<number> {
	const scan =
		deps.scan ?? ((videoPath: string) => window.electronAPI?.scanRecordingText?.(videoPath));
	const result = await Promise.resolve(scan(screenPath)).catch((error: unknown) => ({
		success: false,
		output: undefined,
		error: error instanceof Error ? error.message : String(error),
		unsupported: false,
	}));
	// No scanner in this host at all (the browser shim): nothing was promised.
	if (!result) return 0;
	if (!result.success || !result.output) {
		if (!result.unsupported) deps.onScanIssue?.({ kind: "failed", reason: result.error });
		return 0;
	}
	const parsed = parseOcrScan(result.output);
	if (parsed.complete === false) {
		deps.onScanIssue?.({ kind: "partial", scannedUpToSec: scannedUpToSec(parsed) });
	}
	const spans = trackDetections(
		parsed,
		parseSensitiveTerms(
			deps.terms ??
				resolveProjectTranscriptionSettings(useProjectStore.getState().document).autoRedactTerms,
		),
	);
	if (spans.length === 0) return 0;

	const deadline = Date.now() + (deps.probeWaitMs ?? 60_000);
	for (let attempt = 0; attempt < 3; ) {
		if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return 0;
		const latest = useProjectStore.getState().document;
		const asset = latest?.assets.find((a) => a.originalPath === screenPath);
		if (!latest || !asset) return 0;
		if (latest.annotations.some((a) => a.annotationSource === AUTO_REDACT_SOURCE)) return 0;
		if (latest.timeline.clips.some((clip) => clipAwaitsProbedDuration(clip, asset.id))) {
			if (Date.now() > deadline) return 0;
			await new Promise((resolve) => setTimeout(resolve, 500));
			continue;
		}
		const added = redactionAnnotations(latest, asset.id, spans, deps.createId ?? createId);
		if (added.length === 0) return 0;
		const next: AxcutDocument = { ...latest, annotations: [...latest.annotations, ...added] };
		if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return 0;
		if (useProjectStore.getState().document !== latest) {
			attempt += 1;
			continue;
		}
		const saved = await saveWithDeadline(
			useProjectStore.getState().saveDocument(next, { history: true }),
			deps.saveTimeoutMs ?? DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
		);
		return saved === true ? added.length : 0;
	}
	return 0;
}

export interface AutoRedactionRescan {
	/** Recordings read again; those the scanner would not read are not counted. */
	scanned: number;
	/** Recordings the scanner failed on, or would not read (not a recording of this app). */
	failed: number;
	/** Automatic blurs taken away, and put back from the new scan. */
	removed: number;
	added: number;
	/** The write went through. False when nothing changed, or nothing could be scanned. */
	saved: boolean;
}

/**
 * "Procurar de novo": OCR over every recording on the timeline again, with the current
 * sensitive words, and the automatic blurs replaced by what it finds -- the user's own blurs
 * untouched -- as ONE undoable edit. A recording whose scan fails keeps its old suggestions.
 */
export async function rescanAutoRedactions(
	deps: Omit<FreshRecordingRedactionDeps, "probeWaitMs"> = {},
): Promise<AutoRedactionRescan> {
	const scan =
		deps.scan ?? ((videoPath: string) => window.electronAPI?.scanRecordingText?.(videoPath));
	const terms = parseSensitiveTerms(
		deps.terms ??
			resolveProjectTranscriptionSettings(useProjectStore.getState().document).autoRedactTerms,
	);
	const outcome: AutoRedactionRescan = {
		scanned: 0,
		failed: 0,
		removed: 0,
		added: 0,
		saved: false,
	};
	const start = useProjectStore.getState().document;
	if (!start) return outcome;
	const onTimeline = new Set(start.timeline.clips.map((clip) => clip.assetId));
	const assets = start.assets.filter((a) => a.kind === "video" && onTimeline.has(a.id));
	const spansByAsset = new Map<string, RedactionSpan[]>();
	for (const asset of assets) {
		const result = await Promise.resolve(scan(asset.originalPath)).catch(() => undefined);
		if (!result?.success || !result.output) {
			outcome.failed += 1;
			if (result && !result.unsupported) {
				deps.onScanIssue?.({ kind: "failed", reason: result.error });
			}
			continue;
		}
		const parsed = parseOcrScan(result.output);
		if (parsed.complete === false) {
			deps.onScanIssue?.({ kind: "partial", scannedUpToSec: scannedUpToSec(parsed) });
		}
		spansByAsset.set(asset.id, trackDetections(parsed, terms));
		outcome.scanned += 1;
	}
	if (spansByAsset.size === 0) return outcome;
	if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return outcome;
	// Read right before the write, so an edit made while the scan ran is kept.
	const latest = useProjectStore.getState().document;
	if (!latest || latest.project.id !== start.project.id) return outcome;
	const replaced = replaceAutoRedactions(latest, spansByAsset, deps.createId ?? createId);
	outcome.removed = replaced.removed;
	outcome.added = replaced.added;
	if (replaced.removed === 0 && replaced.added === 0) return outcome;
	const saved = await saveWithDeadline(
		useProjectStore.getState().saveDocument(replaced.document, { history: true }),
		deps.saveTimeoutMs ?? DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
	);
	outcome.saved = saved === true;
	return outcome;
}

export type FreshRecordingCameraLayoutDeps = {
	/** How long to wait here for the take's real length before leaving the pieces to the
	 *  `loadedmetadata` write that brings it. Tests shorten it. */
	probeWaitMs?: number;
	saveTimeoutMs?: number;
	waitTimeoutMs?: number;
	/** The zoom pass asked for again once the pieces are in. Tests stub it. */
	autoZoom?: (document: AxcutDocument) => Promise<unknown>;
};

/**
 * "Rosto / Tela + câmera" for a fresh take: the layout the HUD logged (`asset.cameraLayout`,
 * read from the take's .layout.json at import) becomes camera pieces -- full screen over each
 * "face" span, the default picture-in-picture elsewhere -- in ONE undoable write. Returns how
 * many pieces were stored.
 *
 * Written once the take's real length is known, as the privacy blur is, so a span past the
 * placeholder length is not lost; not over an edit that landed meanwhile; never over camera
 * pieces already on the document. The fresh take's automatic zooms wait for it (see
 * `pendingFreshRecordingCameraLayoutPath`) and are asked for again when it is done.
 *
 * A length that takes longer than `probeWaitMs` does not cost the take its pieces: this pass
 * stops looking, and the `loadedmetadata` write writes them when the length lands
 * (`resumeFreshRecordingCameraLayout`). Giving up there left a take whose preview reported its
 * length ~12 minutes late with no pieces, and with zooms planned over the face.
 */
export async function applyFreshRecordingCameraLayout(
	screenPath: string,
	deps: FreshRecordingCameraLayoutDeps = {},
): Promise<number> {
	const first = useProjectStore.getState().document;
	if (!first?.assets.find((a) => a.originalPath === screenPath)?.cameraLayout) return 0;
	const projectId = first.project.id;
	// Set before the first await: the zoom pass must not slip in ahead of the pieces.
	pendingFreshRecordingCameraLayoutPath = screenPath;
	pendingFreshRecordingCameraLayoutProjectId = projectId;
	let awaitingLength = false;
	try {
		const deadline = Date.now() + (deps.probeWaitMs ?? 60_000);
		for (let attempt = 0; attempt < 3; ) {
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return 0;
			const latest = useProjectStore.getState().document;
			const asset = latest?.assets.find((a) => a.originalPath === screenPath);
			if (!latest || latest.project.id !== projectId || !asset?.cameraLayout) return 0;
			if (readCameraSegments(latest).length > 0) return 0;
			if (!hasProbedLength(latest, asset.id)) {
				if (Date.now() > deadline) {
					awaitingLength = true;
					return 0;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
				continue;
			}
			const placed = cameraSegmentsFromRecordingLayout(
				readCameraSegments(latest),
				latest.timeline.clips,
				asset.id,
				asset.cameraLayout,
			);
			if (placed.ids.length === 0) return 0;
			const next: AxcutDocument = { ...latest, cameraSegments: placed.segments };
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return 0;
			if (useProjectStore.getState().document !== latest) {
				attempt += 1;
				continue;
			}
			const saved = await saveWithDeadline(
				useProjectStore.getState().saveDocument(next, { history: true }),
				deps.saveTimeoutMs ?? DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
			);
			return saved === true ? placed.ids.length : 0;
		}
		return 0;
	} finally {
		// Still waiting for the length: the pieces stay pending, and the zooms with them.
		if (!awaitingLength) {
			if (pendingFreshRecordingCameraLayoutPath === screenPath) {
				pendingFreshRecordingCameraLayoutPath = null;
				pendingFreshRecordingCameraLayoutProjectId = null;
			}
			const document = useProjectStore.getState().document;
			if (document && pendingFreshRecordingAutoZoom) {
				void (deps.autoZoom ?? maybeSaveFreshRecordingAutoZooms)(document);
			}
		}
	}
}

/** The take's clips have their real length: there are clips, and none still waits for it. */
function hasProbedLength(document: AxcutDocument, assetId: string): boolean {
	const clips = document.timeline.clips;
	return clips.length > 0 && !clips.some((clip) => clipAwaitsProbedDuration(clip, assetId));
}

/**
 * The camera pieces of a fresh take whose length arrived after the import stopped waiting for
 * it, called by the `loadedmetadata` write once it has folded the length in. Nothing unless
 * `document` is that take's project and the length is in. Its caller asks for the zooms next,
 * so this does not.
 */
export async function resumeFreshRecordingCameraLayout(
	document: AxcutDocument,
	deps: FreshRecordingCameraLayoutDeps = {},
): Promise<number> {
	const screenPath = pendingFreshRecordingCameraLayoutPath;
	if (!screenPath || pendingFreshRecordingCameraLayoutProjectId !== document.project.id) return 0;
	const asset = document.assets.find((a) => a.originalPath === screenPath);
	if (!asset || !hasProbedLength(document, asset.id)) return 0;
	return applyFreshRecordingCameraLayout(screenPath, {
		autoZoom: async () => undefined,
		...deps,
	});
}

export async function importPendingRecording(
	/**
	 * Called once the import succeeded, with why the take ended before it was
	 * stopped when it did. The HUD that ran the stop closes as the editor opens, so
	 * the editor is the only window left to say it.
	 */
	onWarning?: (message: string) => void,
	/** Called when the privacy pass blurred something, with how many areas. */
	onRedacted?: (count: number) => void,
	/** Called when the privacy pass failed, or looked at the start of the take only. */
	onRedactionIssue?: (issue: RedactionScanIssue) => void,
): Promise<boolean> {
	const api = window.electronAPI;
	if (!api) return false;

	const result = await api.getCurrentRecordingSession();
	// The take's name first, while nothing has its files open: it renames the take's folder,
	// and everything below works on the renamed paths (see freshTakeName.ts).
	const named =
		result.success && result.session
			? await nameFreshTake(result.session, (reason) => {
					console.warn("[recording] the take could not be renamed:", reason);
					onWarning?.(toastText("editor", "takeName.renameFailed"));
				})
			: null;
	const screenPath =
		named?.session.screenVideoPath ??
		(result.success ? result.session?.screenVideoPath : undefined);
	if (!screenPath) return false;
	const cursorCaptureMode = result.success ? result.session?.cursorCaptureMode : undefined;
	const warning = result.success ? result.warning : undefined;

	// The take's name, as the Media tab and the timeline show it: its files keep their
	// `recording-<id>` names, which say nothing to the user.
	const label =
		named?.title || screenPath.split(/[\\/]/).pop() || toastText("editor", "projectNames.asset");
	await useProjectStore.getState().createProject(
		named?.title ??
			toastText("editor", "projectNames.recording", {
				date: formatDateTime(new Date(), currentLocale()),
			}),
	);
	await useProjectStore.getState().addAsset(screenPath, label);
	// Before the zoom hand-off below, so the zooms wait for the "face" spans to be pieces.
	void applyFreshRecordingCameraLayout(screenPath).catch((error) => {
		console.warn("[recording] the take's camera layout could not be applied:", error);
	});
	// Mark before the video element can fire `loadedmetadata`. The asset path is
	// already on the document; waiting until the 60s seed finished let the first
	// metadata pass consume nothing and the second never arrive.
	//
	// Except for a system-cursor take, which writes no `.cursor.json` at all: the
	// toggle stays on in prefs (it is only disabled in the UI while that mode is
	// picked), so without this the flag is set for a recording that can never produce
	// a click. What governs is the mode THIS take was recorded in, not the current
	// preference.
	if (cursorCaptureMode !== "system") {
		markFreshRecordingAutoZoomPending(screenPath);
		transcriptOfferTakePath = screenPath;
		// A head start on the frame scan the zoom pass will want, if it is going to run.
		void readAutoZoomPref().then((enabled) => {
			if (enabled) void prefetchFreshRecordingTelemetry();
		});
	}
	// The project the take lands in decides: its own switch, else the default.
	if (resolveProjectTranscriptionSettings(useProjectStore.getState().document).autoRedact) {
		void applyFreshRecordingRedactions(screenPath, { onScanIssue: onRedactionIssue }).then(
			(count) => {
				if (count > 0) onRedacted?.(count);
			},
		);
	}
	// Consumed: the recording now lives in a project. Cleared here rather than
	// after the timeline seed below so a failure down there can't hand the same
	// recording to the next editor window.
	await api.setCurrentRecordingSession(null);

	// ponytail: MediaRecorder WebMs ship with duration = NaN until
	// fix-webm-duration patches the EBML header; until that flows through the
	// asset, drop a default 60s clip into the timeline so the editor isn't stuck
	// on "No clips yet" the moment the user lands in the project. Real duration
	// overwrites this when handleLoadedMetadata fires with a finite value.
	const doc = useProjectStore.getState().document;
	if (doc && doc.timeline.clips.length === 0 && doc.assets.length > 0) {
		// `history: false`. Nothing here is an edit: the user finished a recording and the
		// editor built them a project around it, unattended, on mount. Recording it left a
		// brand-new project sitting at `past.length === 1` before the user had touched
		// anything, so their FIRST Ctrl+Z restored the state before the seed -- an empty
		// timeline -- and the persist that follows an undo wrote that empty timeline to disk.
		await useProjectStore
			.getState()
			.replaceTimeline([{ startSec: 0, endSec: 60 }], "Auto-imported recording", {
				history: false,
			});
	}
	const latest = useProjectStore.getState().document;
	if (latest) {
		await maybeSaveFreshRecordingAutoZooms(latest);
	}
	if (warning) {
		onWarning?.(warning);
	}
	return true;
}
