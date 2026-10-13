import { ArrowDown, Film, Plus, RotateCw, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { formatDate } from "@/i18n/format";
import { buildMediaCards, type MediaCard } from "@/lib/ai-edition/mediaCards";
import { resolveProjectTranscriptionSettings } from "@/lib/ai-edition/projectTranscriptionSettings";
import type { AxcutAsset, AxcutDocument, AxcutTranscript } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	useAssetTranscriptions,
	useTranscriptionStore,
} from "@/lib/ai-edition/store/transcriptionStore";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import { languageLabel } from "@/lib/ai-edition/transcription/languageLabels";
import {
	type AssetTranscriptionStatus,
	type AssetTranscriptionView,
	isSilentFailure,
	transcriptHasSpeech,
	transcriptionFailureHintKey,
} from "@/lib/ai-edition/transcription/status";
import { formatBytes } from "@/utils/formatBytes";
import {
	TranscriptionProgressBar,
	TranscriptionStatusDot,
	useTranscriptionLabel,
} from "../TranscriptionStatus";
import styles from "./EditorShellV4.module.css";
import { ProjectTranscriptionSettings } from "./ProjectTranscriptionSettings";
import {
	DeleteRecordingDialog,
	LibraryFolderBar,
	type LibraryItem,
	RecordingActions,
	RecordingRenameForm,
	useRecordingsLibrary,
} from "./RecordingsLibrary";
import libraryStyles from "./RecordingsLibrary.module.css";

const ASSET_MIME = "application/x-axcut-asset";
/** A recording the project does not have yet, dragged by its library key. */
const LIBRARY_MIME = "application/x-openscreen-recording";
const THUMB_GRADIENTS = [
	"linear-gradient(135deg, #fb7185, #f97316)",
	"linear-gradient(135deg, #10b981, #0d986a)",
	"linear-gradient(135deg, #fbbf24, #f59e0b)",
	"linear-gradient(135deg, #38bdf8, #6366f1)",
];

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

export function detectedLanguageForTranscript(transcript: AxcutTranscript | null): string | null {
	if (!transcript || transcript.language === "auto" || !transcriptHasSpeech(transcript)) {
		return null;
	}
	return transcript.language;
}

/**
 * Whisper reads at most the last 223 tokens of its prompt; 600 characters of
 * names and terms stays under that for Latin scripts (issue #1023).
 */
export const VOCABULARY_MAX_CHARS = 600;

/** The document with its names and terms set, or null when nothing changed. */
export function withVocabulary(document: AxcutDocument, text: string): AxcutDocument | null {
	const vocabulary = text.trim().slice(0, VOCABULARY_MAX_CHARS) || undefined;
	if (vocabulary === document.project.vocabulary) return null;
	return { ...document, project: { ...document.project, vocabulary } };
}

export async function addSelectedAssetToTimeline(
	selected: Pick<AxcutAsset, "id" | "label" | "originalPath"> | null,
	onAddToTimeline: (assetId: string) => Promise<void>,
	onSuccess: (label: string) => void,
): Promise<void> {
	if (!selected) return;
	await onAddToTimeline(selected.id);
	onSuccess(selected.label || basename(selected.originalPath));
}

/**
 * A card's name: a recording's is the take's name in the library (its folder), whatever
 * label its asset carries (takes made before they had names are labelled `recording-<id>.mp4`);
 * any other medium's is its label, else its file name.
 */
export function mediaCardName(card: MediaCard<LibraryItem, AxcutAsset>): string {
	if (card.kind === "recording") return card.recording.name;
	return card.asset.label || basename(card.asset.originalPath);
}

function DetailHeader({
	title,
	closeLabel,
	onClose,
}: {
	title: string;
	closeLabel: string;
	onClose: () => void;
}) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "flex-start",
				justifyContent: "space-between",
				gap: 10,
				marginBottom: 4,
			}}
		>
			<h2
				style={{
					margin: 0,
					fontSize: 16.5,
					fontWeight: 700,
					color: "var(--fg-emphasis)",
					letterSpacing: "-0.01em",
				}}
			>
				{title}
			</h2>
			<button
				type="button"
				title={closeLabel}
				aria-label={closeLabel}
				onClick={onClose}
				style={{
					width: 26,
					height: 26,
					display: "grid",
					placeItems: "center",
					borderRadius: 8,
					color: "var(--muted)",
					background: "transparent",
					border: 0,
					cursor: "pointer",
					flexShrink: 0,
				}}
			>
				<X size={15} />
			</button>
		</div>
	);
}

/**
 * The drop target for "drag a card to the timeline". The Media tab shows no timeline (it is
 * the Edit tab's), so this compact strip appears at the bottom only while a card is dragged.
 */
export function MediaDropZone({
	visible,
	hover,
	label,
	onHover,
	onDrop,
}: {
	visible: boolean;
	hover: boolean;
	label: string;
	onHover: (hover: boolean) => void;
	onDrop: (data: DataTransfer) => void;
}) {
	if (!visible) return null;
	return (
		<div
			className={`${styles.mediaDropZone}${hover ? ` ${styles.mediaDropZoneHover}` : ""}`}
			data-testid="media-drop-zone"
			onDragOver={(event) => {
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
				if (!hover) onHover(true);
			}}
			onDragLeave={() => onHover(false)}
			onDrop={(event) => {
				event.preventDefault();
				onDrop(event.dataTransfer);
			}}
		>
			<ArrowDown size={14} />
			{label}
		</div>
	);
}

export function MediaStage({
	onAddToTimeline,
	onShowEditor,
}: {
	onAddToTimeline: (assetId: string) => Promise<void>;
	/** Back to the editor, after the library opened a recording. */
	onShowEditor?: () => void;
}) {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const projectId = useProjectStore((s) => s.projectId);
	const document = useProjectStore((s) => s.document);
	const addAsset = useProjectStore((s) => s.addAsset);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const vocabularySave = useRef<Promise<boolean>>(undefined);
	// Transcripts are produced in the background as soon as a media lands here
	// (see transcriptionStore) — this stage only reports where each one is at,
	// and lets the user force a re-run in another language.
	const transcriptions = useAssetTranscriptions();
	const requestTranscription = useTranscriptionStore((s) => s.request);
	const transcriptionLabel = useTranscriptionLabel();
	const lib = useRecordingsLibrary({ onAddToTimeline, onShowEditor });
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	// The editor's timeline is not on this tab: while a card is dragged, a strip at the bottom
	// takes the drop instead (`MediaDropZone`).
	const [dragging, setDragging] = useState(false);
	const [dropHover, setDropHover] = useState(false);
	// One card per recording (a take the project uses shows once, as the take) and one per
	// other video the project imported. Imported audio (issue #350) is a timeline overlay
	// added from the timeline toolbar, not a clip, so it never appears here.
	const assets = document?.assets ?? [];
	const cards = useMemo(
		() => buildMediaCards(lib.listing?.recordings ?? [], assets, query),
		[lib.listing, assets, query],
	);
	const selectedCard = cards.find((card) => card.id === selectedCardId) ?? null;
	const selected = selectedCard?.asset ?? null;
	const selectedRecording = selectedCard?.kind === "recording" ? selectedCard.recording : null;
	const selectedName = selectedCard ? mediaCardName(selectedCard) : "";
	const transcript = selected
		? (document?.transcripts?.find((t) => t.assetId === selected.id) ?? null)
		: null;
	const detectedLanguage = detectedLanguageForTranscript(transcript);
	const selectedTranscription: AssetTranscriptionView = selected
		? (transcriptions[selected.id] ?? { assetId: selected.id, status: "idle" })
		: { assetId: "", status: "idle" };
	const selectedBusy =
		selectedTranscription.status === "running" || selectedTranscription.status === "queued";
	const failureHintKey = selectedTranscription.failure
		? transcriptionFailureHintKey(selectedTranscription.failure)
		: null;

	const handleImport = async () => {
		if (!projectId) {
			toast.error(t("mediaStage.openProjectFirst"));
			return;
		}
		const picker = await window.electronAPI?.openVideoFilePicker();
		if (!picker?.success || !picker.path) return;
		setBusy(true);
		try {
			const label = picker.name || basename(picker.path);
			await addAsset(picker.path, label);
			toast.success(t("mediaStage.added", { label }));
		} catch (err) {
			toast.error(t("mediaStage.couldNotAddAsset"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	const openDetail = (cardId: string) => {
		setSelectedCardId(cardId);
		setDetailOpen(true);
	};

	const addSelectedToTimeline = () => {
		if (!selected && selectedRecording) {
			void lib.addToTimeline(selectedRecording);
			return;
		}
		void addSelectedAssetToTimeline(
			selected ? { ...selected, label: selectedName } : null,
			onAddToTimeline,
			(label) => {
				toast.success(t("mediaStage.addedToTimeline", { label }));
			},
		).catch(() => undefined);
	};

	const dropOnTimeline = (data: DataTransfer) => {
		const assetId = data.getData(ASSET_MIME);
		if (assetId) {
			const card = cards.find((candidate) => candidate.asset?.id === assetId);
			void onAddToTimeline(assetId)
				.then(() =>
					toast.success(
						t("mediaStage.addedToTimeline", {
							label: card ? mediaCardName(card) : "",
						}),
					),
				)
				.catch(() => undefined);
			return;
		}
		const key = data.getData(LIBRARY_MIME);
		const recording = lib.listing?.recordings.find((candidate) => candidate.key === key);
		if (recording) void lib.addToTimeline(recording);
	};

	return (
		<div className={styles.mediaStage}>
			<div className={styles.mediaInner} style={{ maxWidth: detailOpen ? 1120 : 900 }}>
				<div className={styles.mediaSearchRow}>
					<Search size={16} style={{ color: "var(--muted)", flexShrink: 0 }} />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("mediaStage.searchPlaceholder")}
					/>
				</div>
				<div className={styles.mediaCols}>
					<div className={styles.mediaListCol}>
						<LibraryFolderBar lib={lib} />
						<div
							className={styles.mediaGrid}
							style={{ gridTemplateColumns: detailOpen ? "repeat(2,1fr)" : "repeat(3,1fr)" }}
						>
							{cards.map((card, i) => {
								const asset = card.asset;
								const recording = card.kind === "recording" ? card.recording : null;
								const preview = recording ? lib.previews[recording.key] : undefined;
								const transcription = asset
									? (transcriptions[asset.id] ?? {
											assetId: asset.id,
											status: "idle" as AssetTranscriptionStatus,
										})
									: null;
								const name = mediaCardName(card);
								const durationSec = preview?.durationSec ?? asset?.durationSec ?? null;
								const sizeBytes = recording ? recording.sizeBytes : asset?.sizeBytes;
								const isSelected = card.id === selectedCardId;
								const inProject = Boolean(asset) || (recording ? lib.usedHere(recording) : false);
								return (
									<div
										key={card.id}
										className={`${styles.mediaCard}${isSelected ? ` ${styles.selected}` : ""}`}
										data-testid="media-card"
										data-card-id={card.id}
										data-in-project={inProject ? "true" : "false"}
									>
										<button
											type="button"
											draggable
											className={styles.mediaCardMain}
											title={
												recording?.folderPath ?? recording?.screenVideoPath ?? asset?.originalPath
											}
											onDragStart={(e) => {
												if (asset) e.dataTransfer.setData(ASSET_MIME, asset.id);
												else if (recording) e.dataTransfer.setData(LIBRARY_MIME, recording.key);
												e.dataTransfer.effectAllowed = "copy";
												setDragging(true);
											}}
											onDragEnd={() => {
												setDragging(false);
												setDropHover(false);
											}}
											onClick={() => openDetail(card.id)}
										>
											<div
												className={styles.mediaThumb}
												style={{ background: THUMB_GRADIENTS[i % THUMB_GRADIENTS.length] }}
											>
												{preview?.thumbnailDataUrl ? (
													<img
														src={preview.thumbnailDataUrl}
														alt=""
														draggable={false}
														className={styles.mediaThumbImg}
													/>
												) : (
													<Film size={30} strokeWidth={1.8} />
												)}
												{recording?.busy ? (
													<span className={libraryStyles.badge}>{t("library.busy")}</span>
												) : inProject ? (
													<span className={libraryStyles.badge}>{t("library.usedHere")}</span>
												) : recording?.kind === "flat" ? (
													<span className={libraryStyles.badge}>{t("library.flat")}</span>
												) : null}
												{durationSec ? (
													<span className={libraryStyles.duration}>
														{formatSeconds(durationSec)}
													</span>
												) : null}
											</div>
											{recording && lib.renaming?.key === recording.key ? null : (
												<div className={styles.mediaCardMeta}>
													{isSelected ? (
														<span
															aria-hidden
															style={{
																width: 6,
																height: 6,
																borderRadius: "50%",
																background: "var(--accent)",
																flexShrink: 0,
															}}
														/>
													) : null}
													<div className={styles.body}>
														<div className={styles.mediaCardName} data-testid="media-card-name">
															{name}
														</div>
														<div className={styles.mediaCardStats}>
															<span className={styles.dur}>{formatSeconds(durationSec ?? 0)}</span>
															{recording ? (
																<span className={styles.size}>
																	{formatDate(recording.createdAt, locale)}
																</span>
															) : null}
															<span className={styles.size}>{formatBytes(sizeBytes)}</span>
														</div>
													</div>
													{transcription ? <TranscriptionStatusDot view={transcription} /> : null}
												</div>
											)}
										</button>
										{recording ? (
											<>
												<RecordingRenameForm lib={lib} recording={recording} />
												{lib.renaming?.key === recording.key ? null : (
													<RecordingActions lib={lib} recording={recording} />
												)}
											</>
										) : null}
									</div>
								);
							})}
						</div>
						{cards.length > 0 ? (
							<div className={styles.mediaHint}>
								<ArrowDown size={12} />
								{t("mediaStage.dragHint")}
							</div>
						) : (
							<div className={styles.mediaHint}>
								{lib.available && !lib.listing ? t("library.loading") : t("mediaStage.emptyHint")}
							</div>
						)}
						<button
							type="button"
							className={styles.importBtn}
							onClick={handleImport}
							disabled={!projectId || busy}
						>
							<Plus size={14} />
							{t("mediaStage.importMedia")}
						</button>
					</div>

					{detailOpen && selectedCard && !selected && selectedRecording ? (
						<div className={styles.mediaDetail} data-testid="media-detail">
							<DetailHeader
								title={selectedName}
								closeLabel={t("mediaStage.close")}
								onClose={() => setDetailOpen(false)}
							/>
							<p className={styles.mediaDetailNote}>{t("mediaStage.notInProject")}</p>
							<button
								type="button"
								className={styles.mediaDetailPrimary}
								onClick={() => void lib.importToProject(selectedRecording)}
								data-testid="media-detail-add-to-project"
							>
								<Plus size={14} />
								{t("mediaStage.addToProject")}
							</button>
							<button
								type="button"
								className={styles.mediaDetailSecondary}
								onClick={() => void lib.addToTimeline(selectedRecording)}
								data-testid="media-detail-add-to-timeline"
							>
								<Plus size={14} />
								{t("mediaStage.addToTimeline")}
							</button>
						</div>
					) : null}

					{detailOpen && selected ? (
						<div className={styles.mediaDetail} data-testid="media-detail">
							<DetailHeader
								title={t("mediaStage.sourceTranscript")}
								closeLabel={t("mediaStage.close")}
								onClose={() => setDetailOpen(false)}
							/>
							<div
								style={{
									fontSize: 12,
									color: "var(--muted)",
									marginBottom: 10,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{selectedName}
							</div>
							<button
								type="button"
								onClick={addSelectedToTimeline}
								style={{
									width: "100%",
									height: 36,
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									gap: 7,
									marginBottom: 16,
									borderRadius: 9,
									border: "1px solid var(--accent)",
									background: "var(--accent)",
									color: "var(--accent-on)",
									fontSize: 12.5,
									fontWeight: 650,
									cursor: "pointer",
								}}
							>
								<Plus size={14} />
								{t("mediaStage.addToTimeline")}
							</button>

							<div style={{ marginBottom: 16 }}>
								<span
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: 6,
										padding: "5px 10px 5px 8px",
										borderRadius: 9999,
										// A silent recording reads as a verdict about the media, not as a
										// broken run, so it keeps the neutral accent rather than the danger
										// red the engine failures get (issue #628).
										background:
											selectedTranscription.status === "failed" &&
											!isSilentFailure(selectedTranscription)
												? "var(--danger-soft)"
												: selectedTranscription.status === "ready"
													? "var(--success-soft)"
													: "var(--accent-soft)",
										color:
											selectedTranscription.status === "failed" &&
											!isSilentFailure(selectedTranscription)
												? "var(--danger)"
												: selectedTranscription.status === "ready"
													? "var(--success)"
													: "var(--accent)",
										fontSize: 12,
										fontWeight: 600,
									}}
								>
									<TranscriptionStatusDot view={selectedTranscription} size={5} />
									{transcriptionLabel(selectedTranscription)}
								</span>
								{/* The language whisper resolved on the first chunk, which every later
								    chunk was then pinned to. Its only pill used to live in the v3 left
								    panel's transcript modal, which nothing mounted, so the value was
								    reaching the document and being displayed nowhere. It belongs next to
								    "Regenerate as" below in any case: that selector is the control
								    you set BECAUSE of what was detected. */}
								{detectedLanguage ? (
									<span
										style={{
											display: "inline-flex",
											alignItems: "center",
											marginLeft: 8,
											padding: "5px 10px",
											borderRadius: 9999,
											background: "var(--success-soft)",
											color: "var(--success)",
											fontSize: 12,
											fontWeight: 600,
										}}
									>
										{t("mediaStage.detectedLanguage", {
											language: languageLabel(detectedLanguage, locale),
										})}
									</span>
								) : null}
							</div>

							{/* Renders itself away — spacing included — unless the run reports progress. */}
							<TranscriptionProgressBar view={selectedTranscription} />

							{selectedTranscription.failure ? (
								<p
									style={{
										margin: "-8px 0 16px",
										fontSize: 12,
										lineHeight: 1.5,
										color: "var(--muted)",
									}}
								>
									{failureHintKey ? t(failureHintKey) : selectedTranscription.failure.message}
								</p>
							) : null}

							{/* Project-wide: whisper's initial prompt for every run (issue #1023).
							    Uncontrolled and keyed on the saved value, so an undo that restores
							    an older list shows it; the save happens on blur, one undo step. */}
							<label style={{ display: "block", marginBottom: 12 }}>
								<span
									style={{
										display: "block",
										fontSize: 12.5,
										fontWeight: 600,
										color: "var(--fg-2)",
										marginBottom: 6,
									}}
								>
									{t("mediaStage.namesAndTerms")}
								</span>
								<textarea
									key={`${document?.project.id}:${document?.project.vocabulary ?? ""}`}
									defaultValue={document?.project.vocabulary ?? ""}
									maxLength={VOCABULARY_MAX_CHARS}
									rows={2}
									spellCheck={false}
									onBlur={(e) => {
										// The latest document, not the render's: a save replaces the whole
										// document, so a stale one would undo a transcript written meanwhile.
										const latest = useProjectStore.getState().document;
										const next = latest && withVocabulary(latest, e.target.value);
										if (next) vocabularySave.current = saveDocument(next, { history: true });
									}}
									style={{
										width: "100%",
										padding: "8px 10px",
										borderRadius: 9,
										border: "1px solid var(--border)",
										background: "var(--surface-2)",
										color: "var(--fg)",
										fontSize: 12.5,
										lineHeight: 1.5,
										resize: "vertical",
										outline: "none",
									}}
								/>
							</label>

							{/* The project's transcription and privacy settings, over the global defaults. */}
							<div style={{ marginBottom: 12 }}>
								<ProjectTranscriptionSettings
									languageAction={
										<Tooltip content={t("mediaStage.regenerateTip")}>
											<button
												type="button"
												aria-label={t("mediaStage.regenerate")}
												// `aria-disabled`, not `disabled`: a natively disabled button cannot take focus or
												// open its tooltip. It does nothing while a transcription runs.
												aria-disabled={selectedBusy || undefined}
												onClick={
													selectedBusy
														? undefined
														: async () => {
																// Clicking here blurs the terms field, whose save is still in
																// flight: the run must read the terms it just saved, so a failed
																// save (already toasted) runs nothing.
																const saving = vocabularySave.current;
																vocabularySave.current = undefined;
																if ((await saving) === false) return;
																// The project's language: its own, else the default.
																void requestTranscription(
																	selected.id,
																	resolveProjectTranscriptionSettings(
																		useProjectStore.getState().document,
																	).transcriptionLanguage,
																);
															}
												}
												style={{
													width: 36,
													height: 36,
													flexShrink: 0,
													display: "grid",
													placeItems: "center",
													borderRadius: 9,
													color: "var(--fg-2)",
													background: "var(--surface-2)",
													border: "1px solid var(--border)",
													cursor: selectedBusy ? "not-allowed" : "pointer",
													opacity: selectedBusy ? 0.6 : 1,
												}}
											>
												<RotateCw size={14} className={selectedBusy ? "animate-spin" : undefined} />
											</button>
										</Tooltip>
									}
								/>
							</div>

							<div
								style={{
									padding: "16px",
									border: "1px solid var(--border)",
									borderRadius: 12,
									background: "var(--surface)",
									fontSize: 12.5,
									lineHeight: 1.7,
									color: "var(--fg-2)",
									maxHeight: 360,
									overflowY: "auto",
								}}
							>
								{transcript ? (
									(transcript.segments ?? [])
										.map((seg) => (seg as { text?: string }).text ?? "")
										.join(" ") || t("mediaStage.transcriptEmpty")
								) : (
									<span style={{ color: "var(--muted)" }}>
										{selectedBusy
											? transcriptionLabel(selectedTranscription)
											: isSilentFailure(selectedTranscription)
												? t("mediaStage.noAudioTrackHint")
												: selectedTranscription.status === "failed"
													? t("mediaStage.generationFailedHint")
													: t("mediaStage.notGeneratedHint")}
									</span>
								)}
							</div>
						</div>
					) : null}
				</div>
			</div>
			<MediaDropZone
				visible={dragging}
				hover={dropHover}
				label={t("mediaStage.dropToTimeline")}
				onHover={setDropHover}
				onDrop={(data) => {
					setDragging(false);
					setDropHover(false);
					dropOnTimeline(data);
				}}
			/>
			<DeleteRecordingDialog lib={lib} />
		</div>
	);
}
