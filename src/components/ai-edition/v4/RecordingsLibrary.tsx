import {
	Check,
	ExternalLink,
	Film,
	FolderOpen,
	Loader2,
	Pencil,
	Plus,
	RefreshCw,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { formatDateTime } from "@/i18n/format";
import { useProjectStore, waitForDocumentSaves } from "@/lib/ai-edition/store/projectStore";
import {
	assetsUsingFiles,
	documentUsesFiles,
	rewriteOpenProjectMedia,
	withMediaReleased,
} from "@/lib/ai-edition/store/recordingMedia";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import { sanitizeRecordingName } from "@/lib/recordingName";
import { formatBytes } from "@/utils/formatBytes";
import type { LibraryListing } from "../../../../electron/ipc/recordingsLibraryHandlers";
import { ModalShell } from "../Modals";
import shellStyles from "../NewEditorShell.module.css";
import styles from "./RecordingsLibrary.module.css";

type LibraryItem = LibraryListing["recordings"][number];

interface Preview {
	durationSec: number | null;
	thumbnailDataUrl: string | null;
}

const ASSET_MIME = "application/x-axcut-asset";

const samePath = (a: string, b: string) =>
	a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/** The error code the main process answered with, as a sentence the user can act on. */
function errorKey(code: string): string {
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
 * Every recording in the recordings folder, in the Media tab: rename, delete (to the
 * Recycle Bin), add to the timeline, open. A section of its own under the project's media,
 * so the rest of the panel stays as it was.
 */
export function RecordingsLibrary({
	query,
	onAddToTimeline,
	onShowEditor,
}: {
	query: string;
	onAddToTimeline: (assetId: string) => Promise<void>;
	onShowEditor?: () => void;
}) {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const api = typeof window === "undefined" ? undefined : window.electronAPI;
	const document = useProjectStore((s) => s.document);
	const [listing, setListing] = useState<LibraryListing | null>(null);
	const [loading, setLoading] = useState(false);
	const [previews, setPreviews] = useState<Record<string, Preview>>({});
	const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<LibraryItem | null>(null);
	const [working, setWorking] = useState<string | null>(null);
	const requested = useRef(new Set<string>());

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

	const recordings = useMemo(() => {
		const all = listing?.recordings ?? [];
		const needle = query.trim().toLowerCase();
		return needle ? all.filter((r) => r.name.toLowerCase().includes(needle)) : all;
	}, [listing, query]);

	const usedHere = useCallback(
		(recording: LibraryItem) => documentUsesFiles(document, recording.files),
		[document],
	);

	/** The project's asset for this recording, imported into the open project if needed. */
	const assetFor = async (recording: LibraryItem): Promise<string | null> => {
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

	const addToTimeline = async (recording: LibraryItem) => {
		setWorking(recording.key);
		try {
			const assetId = await assetFor(recording);
			if (!assetId) return;
			await onAddToTimeline(assetId);
			toast.success(t("mediaStage.addedToTimeline", { label: recording.name }));
		} catch (error) {
			toast.error(t("mediaStage.couldNotAddAsset"), {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setWorking(null);
		}
	};

	// The project that already uses it, newest first; otherwise a new project around it.
	const open = async (recording: LibraryItem) => {
		setWorking(recording.key);
		try {
			const store = useProjectStore.getState();
			const project = recording.projects[0];
			if (project) {
				if (store.projectId !== project.id) await store.loadProject(project.id);
			} else {
				await store.createProject(recording.name);
				const assetId = await assetFor(recording);
				if (assetId) await onAddToTimeline(assetId);
			}
			onShowEditor?.();
		} catch (error) {
			toast.error(t("library.errors.openFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setWorking(null);
		}
	};

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
			const run = async () => {
				await waitForDocumentSaves();
				const answer = await api.recordingsLibraryRename?.(recording.key, name);
				if (answer?.success) await rewriteOpenProjectMedia(answer.moves);
				return answer;
			};
			// The open project's take is held open by the preview: let it go first.
			const answer = usedHere(recording) ? await withMediaReleased(run) : await run();
			if (!answer) return;
			if (answer.success) {
				toast.success(t("library.renamed", { name: answer.name }));
				setRenaming(null);
			} else {
				toast.error(t(errorKey(answer.code)), { description: answer.error });
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
			const run = async () => {
				const answer = await api.recordingsLibraryTrash?.(recording.key);
				// Only once its files are in the bin does the take leave the open project: a bin
				// that refused leaves both where they were.
				if (answer?.success && inOpenProject) {
					const assetIds = assetsUsingFiles(useProjectStore.getState().document, recording.files);
					for (const assetId of assetIds) await useProjectStore.getState().removeAsset(assetId);
				}
				return answer;
			};
			const answer = inOpenProject ? await withMediaReleased(run) : await run();
			if (!answer) return;
			if (answer.success) toast.success(t("library.deleted", { name: recording.name }));
			else toast.error(t(errorKey(answer.code)), { description: answer.error });
		} finally {
			setWorking(null);
			void refresh();
		}
	};

	if (!api?.recordingsLibraryList) return null;

	const deleting = confirmDelete;
	const otherProjects = deleting
		? deleting.projects.filter((project) => project.id !== document?.project.id).length
		: 0;

	return (
		<section
			className={styles.library}
			aria-labelledby="recordings-library-title"
			data-testid="recordings-library"
		>
			<div className={styles.head}>
				<h3 id="recordings-library-title">{t("library.title")}</h3>
				<span className={styles.folder} title={listing?.folder}>
					{listing?.folder}
				</span>
				<button
					type="button"
					className={styles.iconBtn}
					title={t("library.refresh")}
					aria-label={t("library.refresh")}
					onClick={() => void refresh()}
				>
					{loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
				</button>
				<button
					type="button"
					className={styles.iconBtn}
					title={t("library.openFolder")}
					aria-label={t("library.openFolder")}
					onClick={() => void api.openRecordingsFolder?.()}
				>
					<FolderOpen size={14} />
				</button>
			</div>

			{recordings.length === 0 ? (
				<div className={styles.empty}>{listing ? t("library.empty") : t("library.loading")}</div>
			) : (
				<div className={styles.grid}>
					{recordings.map((recording) => {
						const preview = previews[recording.key];
						const isHere = usedHere(recording);
						const isWorking = working === recording.key;
						const locked = recording.busy || isWorking;
						const assetHere = document?.assets.find((asset) =>
							samePath(asset.originalPath, recording.screenVideoPath),
						);
						return (
							<div
								key={recording.key}
								className={`${styles.card}${isHere ? ` ${styles.current}` : ""}`}
								data-testid="library-card"
								data-recording-key={recording.key}
								title={recording.folderPath ?? recording.screenVideoPath}
							>
								<div
									className={styles.thumb}
									draggable={Boolean(assetHere)}
									onDragStart={(event) => {
										if (!assetHere) return;
										event.dataTransfer.setData(ASSET_MIME, assetHere.id);
										event.dataTransfer.effectAllowed = "copy";
									}}
								>
									{preview?.thumbnailDataUrl ? (
										<img src={preview.thumbnailDataUrl} alt="" draggable={false} />
									) : (
										<Film size={28} strokeWidth={1.8} />
									)}
									{recording.busy ? (
										<span className={styles.badge}>{t("library.busy")}</span>
									) : isHere ? (
										<span className={styles.badge}>{t("library.usedHere")}</span>
									) : recording.kind === "flat" ? (
										<span className={styles.badge}>{t("library.flat")}</span>
									) : null}
									{preview?.durationSec ? (
										<span className={styles.duration}>{formatSeconds(preview.durationSec)}</span>
									) : null}
								</div>
								{renaming?.key === recording.key ? (
									<form
										className={styles.renameRow}
										onSubmit={(event) => {
											event.preventDefault();
											void rename(recording, renaming.value);
										}}
									>
										<input
											autoFocus
											value={renaming.value}
											maxLength={200}
											aria-label={t("library.rename")}
											data-testid="library-rename-input"
											onChange={(event) =>
												setRenaming({ key: recording.key, value: event.target.value })
											}
											onKeyDown={(event) => {
												if (event.key === "Escape") {
													event.stopPropagation();
													setRenaming(null);
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
											{isWorking ? (
												<Loader2 size={14} className="animate-spin" />
											) : (
												<Check size={14} />
											)}
										</button>
										<button
											type="button"
											className={styles.iconBtn}
											onClick={() => setRenaming(null)}
											title={t("library.cancel")}
											aria-label={t("library.cancel")}
										>
											<X size={14} />
										</button>
									</form>
								) : (
									<>
										<div className={styles.meta}>
											<div className={styles.name} data-testid="library-card-name">
												{recording.name}
											</div>
											<div className={styles.stats}>
												<span>{formatDateTime(recording.createdAt, locale)}</span>
												<span>{formatBytes(recording.sizeBytes)}</span>
											</div>
										</div>
										<div className={styles.actions}>
											<button
												type="button"
												className={styles.iconBtn}
												disabled={isWorking}
												title={t("mediaStage.addToTimeline")}
												aria-label={t("mediaStage.addToTimeline")}
												onClick={() => void addToTimeline(recording)}
												data-testid="library-add"
											>
												<Plus size={14} />
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
												onClick={() => void open(recording)}
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
												onClick={() => setRenaming({ key: recording.key, value: recording.name })}
												data-testid="library-rename"
											>
												<Pencil size={14} />
											</button>
											<button
												type="button"
												className={styles.iconBtn}
												title={t("library.reveal")}
												aria-label={t("library.reveal")}
												onClick={() => void api.recordingsLibraryReveal?.(recording.key)}
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
												onClick={() => setConfirmDelete(recording)}
												data-testid="library-delete"
											>
												<Trash2 size={14} />
											</button>
										</div>
									</>
								)}
							</div>
						);
					})}
				</div>
			)}

			<ModalShell
				open={deleting !== null}
				onClose={() => setConfirmDelete(null)}
				title={t("library.deleteTitle", { name: deleting?.name ?? "" })}
				footer={
					<>
						<button
							type="button"
							className={`${shellStyles.btn} ${shellStyles.btnSecondary}`}
							onClick={() => setConfirmDelete(null)}
						>
							{t("library.cancel")}
						</button>
						<button
							type="button"
							className={`${shellStyles.btn} ${shellStyles.dangerBtn}`}
							onClick={() => deleting && void remove(deleting)}
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
						{usedHere(deleting) ? (
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
		</section>
	);
}
