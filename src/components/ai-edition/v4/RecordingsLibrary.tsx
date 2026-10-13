import {
	Check,
	ExternalLink,
	FolderOpen,
	Loader2,
	Pencil,
	Plus,
	RefreshCw,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { samePath } from "@/lib/ai-edition/mediaCards";
import { useProjectStore, waitForDocumentSaves } from "@/lib/ai-edition/store/projectStore";
import {
	assetsUsingFiles,
	documentUsesFiles,
	rewriteOpenProjectMedia,
	withMediaReleased,
} from "@/lib/ai-edition/store/recordingMedia";
import { sanitizeRecordingName } from "@/lib/recordingName";
import type { LibraryListing } from "../../../../electron/ipc/recordingsLibraryHandlers";
import { ModalShell } from "../Modals";
import shellStyles from "../NewEditorShell.module.css";
import styles from "./RecordingsLibrary.module.css";

export type LibraryItem = LibraryListing["recordings"][number];

export interface RecordingPreview {
	durationSec: number | null;
	thumbnailDataUrl: string | null;
}

/** The error code the main process answered with, as a sentence the user can act on. */
export function libraryErrorKey(code: string): string {
	switch (code) {
		case "busy":
			return "library.errors.busy";
		case "in-use":
			return "library.errors.inUse";
		case "invalid-name":
			return "library.errors.invalidName";
		case "trash-failed":
			return "library.errors.trashFailed";
		case "not-found":
			return "library.errors.notFound";
		default:
			return "library.errors.generic";
	}
}

/**
 * The recordings folder, for the Media tab: the listing (kept fresh by a folder watch and
 * on focus), each take's thumbnail and duration, and what can be done to a take -- add it to
 * the project or the timeline, open it, rename it, recycle it. The tab shows these as its
 * own cards (MediaStage), merged with the project's media, so a take never shows twice.
 */
export function useRecordingsLibrary({
	onAddToTimeline,
	onShowEditor,
}: {
	onAddToTimeline: (assetId: string) => Promise<void>;
	onShowEditor?: () => void;
}) {
	const t = useScopedT("editor");
	const api = typeof window === "undefined" ? undefined : window.electronAPI;
	const document = useProjectStore((s) => s.document);
	const [listing, setListing] = useState<LibraryListing | null>(null);
	const [loading, setLoading] = useState(false);
	const [previews, setPreviews] = useState<Record<string, RecordingPreview>>({});
	const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<LibraryItem | null>(null);
	const [working, setWorking] = useState<string | null>(null);
	const requested = useRef(new Set<string>());
	const available = Boolean(api?.recordingsLibraryList);

	const refresh = useCallback(async () => {
		if (!api?.recordingsLibraryList) return;
		setLoading(true);
		try {
			const answer = await api.recordingsLibraryList();
			if (answer.success) setListing({ folder: answer.folder, recordings: answer.recordings });
		} finally {
			setLoading(false);
		}
	}, [api]);

	useEffect(() => {
		void refresh();
		if (!api?.onRecordingsLibraryChanged) return;
		void api.recordingsLibraryWatch?.(true);
		const off = api.onRecordingsLibraryChanged(() => void refresh());
		const onFocus = () => void refresh();
		window.addEventListener("focus", onFocus);
		return () => {
			off();
			window.removeEventListener("focus", onFocus);
		};
	}, [api, refresh]);

	// Thumbnails and durations, one recording at a time in the main process, cached there.
	useEffect(() => {
		if (!listing || !api?.recordingsLibraryPreview) return;
		for (const recording of listing.recordings) {
			const id = `${recording.key}:${recording.sizeBytes}`;
			if (requested.current.has(id)) continue;
			requested.current.add(id);
			void api.recordingsLibraryPreview(recording.key).then((answer) => {
				if (!answer.success) return;
				setPreviews((current) => ({
					...current,
					[recording.key]: {
						durationSec: answer.durationSec,
						thumbnailDataUrl: answer.thumbnailDataUrl,
					},
				}));
			});
		}
	}, [listing, api]);

	const usedHere = useCallback(
		(recording: LibraryItem) => documentUsesFiles(document, recording.files),
		[document],
	);

	/** The project's asset for this recording, imported into the open project if needed. */
	const addToProject = async (recording: LibraryItem): Promise<string | null> => {
		const store = useProjectStore.getState();
		if (!store.projectId) await store.createProject(recording.name);
		const existing = useProjectStore
			.getState()
			.document?.assets.find((asset) => samePath(asset.originalPath, recording.screenVideoPath));
		if (existing) return existing.id;
		const added = await useProjectStore
			.getState()
			.addAsset(recording.screenVideoPath, recording.name);
		return added?.id ?? null;
	};

	const run = async <T,>(recording: LibraryItem, work: () => Promise<T>, failKey: string) => {
		setWorking(recording.key);
		try {
			return await work();
		} catch (error) {
			toast.error(t(failKey), {
				description: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		} finally {
			setWorking(null);
		}
	};

	const importToProject = (recording: LibraryItem) =>
		run(
			recording,
			async () => {
				const assetId = await addToProject(recording);
				if (assetId) toast.success(t("mediaStage.added", { label: recording.name }));
				return assetId;
			},
			"mediaStage.couldNotAddAsset",
		);

	const addToTimeline = (recording: LibraryItem) =>
		run(
			recording,
			async () => {
				const assetId = await addToProject(recording);
				if (!assetId) return;
				await onAddToTimeline(assetId);
				toast.success(t("mediaStage.addedToTimeline", { label: recording.name }));
			},
			"mediaStage.couldNotAddAsset",
		);

	// The project that already uses it, newest first; otherwise a new project around it.
	const open = (recording: LibraryItem) =>
		run(
			recording,
			async () => {
				const store = useProjectStore.getState();
				const project = recording.projects[0];
				if (project) {
					if (store.projectId !== project.id) await store.loadProject(project.id);
				} else {
					await store.createProject(recording.name);
					const assetId = await addToProject(recording);
					if (assetId) await onAddToTimeline(assetId);
				}
				onShowEditor?.();
			},
			"library.errors.openFailed",
		);

	const rename = async (recording: LibraryItem, value: string) => {
		const name = sanitizeRecordingName(value);
		if (!name) {
			toast.error(t("library.errors.invalidName"));
			return;
		}
		if (name === recording.name || !api?.recordingsLibraryRename) {
			setRenaming(null);
			return;
		}
		setWorking(recording.key);
		try {
			const work = async () => {
				await waitForDocumentSaves();
				const answer = await api.recordingsLibraryRename?.(recording.key, name);
				if (answer?.success) {
					// The project's label for the take follows it, unless the user typed one.
					await rewriteOpenProjectMedia(answer.moves, {
						from: recording.kind === "folder" ? recording.name : null,
						to: answer.name,
					});
				}
				return answer;
			};
			// The open project's take is held open by the preview: let it go first.
			const answer = usedHere(recording) ? await withMediaReleased(work) : await work();
			if (!answer) return;
			if (answer.success) {
				toast.success(t("library.renamed", { name: answer.name }));
				setRenaming(null);
			} else {
				toast.error(t(libraryErrorKey(answer.code)), { description: answer.error });
			}
		} finally {
			setWorking(null);
			void refresh();
		}
	};

	const remove = async (recording: LibraryItem) => {
		if (!api?.recordingsLibraryTrash) return;
		setConfirmDelete(null);
		setWorking(recording.key);
		try {
			const inOpenProject = usedHere(recording);
			const work = async () => {
				await waitForDocumentSaves();
				const answer = await api.recordingsLibraryTrash?.(recording.key);
				// Only once its files are in the bin does the take leave the open project: a bin
				// that refused leaves both where they were.
				if (answer?.success && inOpenProject) {
					const assetIds = assetsUsingFiles(useProjectStore.getState().document, recording.files);
					for (const assetId of assetIds) await useProjectStore.getState().removeAsset(assetId);
				}
				return answer;
			};
			// The editor's own holders (the preview, the timeline) step aside here; the main
			// process stops what it still reads in the take before it asks the bin.
			const answer = inOpenProject ? await withMediaReleased(work) : await work();
			if (!answer) return;
			if (answer.success) toast.success(t("library.deleted", { name: recording.name }));
			else toast.error(t(libraryErrorKey(answer.code)), { description: answer.error });
		} finally {
			setWorking(null);
			void refresh();
		}
	};

	const reveal = (recording: LibraryItem) => void api?.recordingsLibraryReveal?.(recording.key);
	const openFolder = () => void api?.openRecordingsFolder?.();

	return {
		available,
		listing,
		loading,
		previews,
		refresh,
		usedHere,
		working,
		renaming,
		setRenaming,
		confirmDelete,
		setConfirmDelete,
		importToProject,
		addToTimeline,
		open,
		rename,
		remove,
		reveal,
		openFolder,
	};
}

export type RecordingsLibraryState = ReturnType<typeof useRecordingsLibrary>;

/** The recordings folder's path, with refresh and "open the folder". */
export function LibraryFolderBar({ lib }: { lib: RecordingsLibraryState }) {
	const t = useScopedT("editor");
	if (!lib.available) return null;
	return (
		<div className={styles.head} data-testid="recordings-library">
			<FolderOpen size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />
			<span className={styles.folder} title={lib.listing?.folder}>
				{lib.listing
					? t("library.folderLabel", { folder: lib.listing.folder })
					: t("library.loading")}
			</span>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("library.refresh")}
				aria-label={t("library.refresh")}
				onClick={() => void lib.refresh()}
			>
				{lib.loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("library.openFolder")}
				aria-label={t("library.openFolder")}
				onClick={lib.openFolder}
			>
				<ExternalLink size={14} />
			</button>
		</div>
	);
}

/** A take's buttons on its card: add to the timeline, open, rename, show in Explorer, delete. */
export function RecordingActions({
	lib,
	recording,
}: {
	lib: RecordingsLibraryState;
	recording: LibraryItem;
}) {
	const t = useScopedT("editor");
	const isWorking = lib.working === recording.key;
	const locked = recording.busy || isWorking;
	return (
		<div className={styles.actions}>
			<button
				type="button"
				className={styles.iconBtn}
				disabled={isWorking}
				title={t("mediaStage.addToTimeline")}
				aria-label={t("mediaStage.addToTimeline")}
				onClick={() => void lib.addToTimeline(recording)}
				data-testid="library-add"
			>
				{isWorking ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				disabled={isWorking}
				title={
					recording.projects[0]
						? t("library.openProject", { title: recording.projects[0].title })
						: t("library.open")
				}
				aria-label={t("library.open")}
				onClick={() => void lib.open(recording)}
				data-testid="library-open"
			>
				<FolderOpen size={14} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				disabled={locked}
				title={recording.busy ? t("library.errors.busy") : t("library.rename")}
				aria-label={t("library.rename")}
				onClick={() => lib.setRenaming({ key: recording.key, value: recording.name })}
				data-testid="library-rename"
			>
				<Pencil size={14} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("library.reveal")}
				aria-label={t("library.reveal")}
				onClick={() => lib.reveal(recording)}
			>
				<ExternalLink size={14} />
			</button>
			<span style={{ flex: 1 }} />
			<button
				type="button"
				className={`${styles.iconBtn} ${styles.danger}`}
				disabled={locked}
				title={recording.busy ? t("library.errors.busy") : t("library.delete")}
				aria-label={t("library.delete")}
				onClick={() => lib.setConfirmDelete(recording)}
				data-testid="library-delete"
			>
				<Trash2 size={14} />
			</button>
		</div>
	);
}

/** The name field that replaces a card's name while it is being renamed. */
export function RecordingRenameForm({
	lib,
	recording,
}: {
	lib: RecordingsLibraryState;
	recording: LibraryItem;
}) {
	const t = useScopedT("editor");
	const renaming = lib.renaming;
	if (!renaming || renaming.key !== recording.key) return null;
	const isWorking = lib.working === recording.key;
	return (
		<form
			className={styles.renameRow}
			onSubmit={(event) => {
				event.preventDefault();
				void lib.rename(recording, renaming.value);
			}}
		>
			<input
				autoFocus
				value={renaming.value}
				maxLength={200}
				aria-label={t("library.rename")}
				data-testid="library-rename-input"
				onChange={(event) => lib.setRenaming({ key: recording.key, value: event.target.value })}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						lib.setRenaming(null);
					}
				}}
			/>
			<button
				type="submit"
				className={styles.iconBtn}
				disabled={isWorking}
				title={t("library.save")}
				aria-label={t("library.save")}
			>
				{isWorking ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				onClick={() => lib.setRenaming(null)}
				title={t("library.cancel")}
				aria-label={t("library.cancel")}
			>
				<X size={14} />
			</button>
		</form>
	);
}

/** "Delete <name>?": what goes, that the Recycle Bin can bring it back, who else uses it. */
export function DeleteRecordingDialog({ lib }: { lib: RecordingsLibraryState }) {
	const t = useScopedT("editor");
	const document = useProjectStore((s) => s.document);
	const deleting = lib.confirmDelete;
	const otherProjects = deleting
		? deleting.projects.filter((project) => project.id !== document?.project.id).length
		: 0;
	return (
		<ModalShell
			open={deleting !== null}
			onClose={() => lib.setConfirmDelete(null)}
			title={t("library.deleteTitle", { name: deleting?.name ?? "" })}
			footer={
				<>
					<button
						type="button"
						className={`${shellStyles.btn} ${shellStyles.btnSecondary}`}
						onClick={() => lib.setConfirmDelete(null)}
					>
						{t("library.cancel")}
					</button>
					<button
						type="button"
						className={`${shellStyles.btn} ${shellStyles.dangerBtn}`}
						onClick={() => deleting && void lib.remove(deleting)}
						data-testid="library-delete-confirm"
					>
						<Trash2 size={14} />
						{t("library.deleteConfirm")}
					</button>
				</>
			}
		>
			{deleting ? (
				<div
					data-testid="library-delete-dialog"
					style={{ fontSize: 13, lineHeight: 1.55, color: "var(--fg-2)" }}
				>
					<p style={{ margin: "0 0 8px" }}>
						{deleting.folderPath
							? t("library.deleteFolderBody", { count: deleting.files.length })
							: t("library.deleteFlatBody", { count: deleting.files.length })}
					</p>
					<p
						style={{
							margin: "0 0 8px",
							fontSize: 12,
							color: "var(--muted)",
							wordBreak: "break-all",
						}}
					>
						{deleting.folderPath ?? deleting.screenVideoPath}
					</p>
					<p style={{ margin: "0 0 8px" }}>{t("library.deleteRecycleBin")}</p>
					{lib.usedHere(deleting) ? (
						<p style={{ margin: "0 0 8px", color: "var(--danger)" }}>
							{t("library.deleteUsedHere")}
						</p>
					) : null}
					{otherProjects > 0 ? (
						<p style={{ margin: 0, color: "var(--danger)" }}>
							{t("library.deleteUsedElsewhere", { count: otherProjects })}
						</p>
					) : null}
				</div>
			) : null}
		</ModalShell>
	);
}
