import {
	ArrowDown,
	ArrowDownLeft,
	ArrowDownRight,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	ArrowUpLeft,
	ArrowUpRight,
	AudioLines,
	Camera,
	CameraOff,
	ChevronRight,
	EyeOff,
	FileText,
	Focus,
	ImageIcon,
	ListOrdered,
	type LucideIcon,
	Maximize2,
	Merge,
	MousePointer2,
	Pencil,
	PictureInPicture2,
	RotateCcw,
	Scissors,
	SlidersHorizontal,
	SquareSplitHorizontal,
	Trash2,
	Type,
	Undo2,
	X,
	ZoomIn,
} from "lucide-react";
import type { ComponentProps } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TOOLTIP_GAP_PX, Tooltip } from "@/components/ui/tooltip";
import { parseCustomPlaybackSpeedInput } from "@/components/video-editor/customPlaybackSpeed";
import {
	effectiveZoomScale,
	FIXED_ROTATION_3D_PRESETS,
	MAX_PLAYBACK_SPEED,
	MAX_ZOOM_SCALE,
	MIN_ZOOM_SCALE,
	MOVING_ROTATION_3D_PRESETS,
	type Rotation3DPreset,
	ZOOM_DEPTH_SCALES,
	type ZoomDepth,
} from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import { formatDecimal } from "@/i18n/format";
import { currentLocale } from "@/i18n/toastText";
import { ANNOTATION_REFERENCE_HEIGHT } from "@/lib/ai-edition/annotationScale";
import { setTextPlate, type TextPlate, textPlateOf } from "@/lib/ai-edition/annotations/background";
import {
	convertAnnotationKind,
	fitTextBox,
	toFrameSpace,
} from "@/lib/ai-edition/annotations/placement";
import {
	type AnnotationTextAnimation,
	TEXT_ANIMATION_VALUES,
} from "@/lib/ai-edition/annotations/textAnimation";
import {
	HIGHLIGHT_DEFAULTS,
	nextStepNumber,
	STEP_DEFAULTS,
	STEP_DIAMETER_PX,
	stepBoxAround,
} from "@/lib/ai-edition/annotations/tutorialMarks";
import {
	type CameraMode,
	type CameraPiece,
	findSelectedCameraPiece,
	mergeCameraLook,
} from "@/lib/ai-edition/document/cameraSegments";
import { resolveAspectRatioValue } from "@/lib/ai-edition/document/outputFormat";
import type { AxcutAnnotationRegion, AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { rafCoalesce } from "@/lib/ai-edition/store/rafCoalesce";
import {
	applyCameraLookToAllPieces,
	type EditorSettingsWriteOptions,
	useEditorSettings,
} from "@/lib/ai-edition/store/useEditorSettings";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { hasAnyClipWithCamera } from "@/lib/ai-edition/timeline/camera";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import { coalescedTrimGroups } from "@/lib/ai-edition/timeline/trim-mapping";
import { resolveWebcamLayoutPreset } from "@/lib/compositeLayout";
import { clampToBound } from "@/lib/projectDefaults";
import { annotationFootageRect, zoomScaleLimit } from "@/native/sceneDescription";
import { ColorField } from "../ColorField";
import shell from "../NewEditorShell.module.css";
import {
	AudioPane,
	AudioTrackPane,
	CameraLookControls,
	type CameraLookValues,
	ChoiceRow,
	CursorPane,
	LayoutPane,
	SliderCell,
	TranscriptPane,
	VideoEffectsPane,
} from "../RightPanes";
import { useHasRecordedCursor } from "../recordedCursorTypes";
import { TextColorField } from "../TextColorField";
import { AutoZoomSettings } from "./AutoZoomSettings";
import styles from "./EditorShellV4.module.css";

type TimelineApi = ReturnType<typeof useTimeline>;

// No "captions" facet: caption settings are a popover on the transcript tab now.
// They were never a separate concern from the transcript — they RENDER it — and two
// tabs meant two entry points to transcription, one of which ("transcribe video",
// on the caption tab) was the only one many users ever found. See issue #560.
export type Facet = "effects" | "layout" | "audio" | "cursor" | "transcript";

const FACETS: Array<{ id: Facet; labelKey: string; icon: typeof SlidersHorizontal }> = [
	// Background is a SECTION of this facet now, not a facet of its own — see
	// VideoEffectsPane for why the split had nowhere to sit.
	{ id: "effects", labelKey: "effects.title", icon: SlidersHorizontal },
	{ id: "layout", labelKey: "layout.title", icon: Camera },
	{ id: "audio", labelKey: "audio.title", icon: AudioLines },
	{ id: "cursor", labelKey: "cursor.title", icon: MousePointer2 },
	{ id: "transcript", labelKey: "facets.transcript", icon: FileText },
];

// The rail is a column against the right edge, so its tooltips open to the left: above or below
// they would cover the next button. The rail's own padding and border (6px + 1px) come on top of
// the usual gap, so the gap is measured from the rail's edge, not from the button's.
const RAIL_TOOLTIP = { side: "left", sideOffset: TOOLTIP_GAP_PX + 7 } as const;

type TranscriptProps = ComponentProps<typeof TranscriptPane>;

interface FloatingInspectorProps {
	facet: Facet;
	open: boolean;
	onFacetChange: (facet: Facet) => void;
	onToggleOpen: () => void;
	/** Clips on the timeline, for the "Edit clip" picker — crop + trim now live
	 * per-clip (see clipSchema.cropRegion) instead of behind a document-wide
	 * facet, so this button opens EditClipModal directly instead of routing
	 * through a facet body. */
	clips: AxcutClip[];
	onEditClip: (clip: AxcutClip) => void;
	transcriptProps: TranscriptProps;
	/** Drives the selected-element settings pane (zoom/speed/annotation/trim) —
	 * takes over the inspector, forcing it open, whenever a timeline region is
	 * selected. Clicking elsewhere on the timeline clears the selection
	 * (see V4Timeline's empty-area click handler) which closes this pane. */
	tl: TimelineApi;
}

export function FloatingInspector({
	facet: chosenFacet,
	open,
	onFacetChange,
	onToggleOpen,
	clips,
	onEditClip,
	transcriptProps,
	tl,
}: FloatingInspectorProps) {
	const ts = useScopedT("settings");
	const te = useScopedT("editor");
	// A take with no cursor data (recorded with the system cursor, or imported) has nothing for
	// the cursor settings to act on, so that facet is not offered: never shown while the answer is
	// unknown, and a choice of it that lost its footing falls back to the first facet.
	const hasCursor = useHasRecordedCursor() === true;
	const facets = hasCursor ? FACETS : FACETS.filter(({ id }) => id !== "cursor");
	// Literal keys, one call each, so `npm run i18n:check` resolves them (a key held in FACETS
	// would not be checked).
	const railTips: Record<Facet, string> = {
		effects: ts("facets.tips.effects"),
		layout: ts("facets.tips.layout"),
		audio: ts("facets.tips.audio"),
		cursor: ts("facets.tips.cursor"),
		transcript: ts("facets.tips.transcript"),
	};
	const facet = facets.some(({ id }) => id === chosenFacet) ? chosenFacet : facets[0].id;
	const [clipPickerOpen, setClipPickerOpen] = useState(false);
	const selection = tl.selection;
	// An imported audio track is selected (issue #350) — like a region selection it
	// takes over the inspector body with its own pane (see AudioTrackPane).
	const audioTrackSelected = Boolean(tl.selectedAudioTrackId);
	const effectiveOpen = open || selection !== null || audioTrackSelected;
	return (
		<div className={styles.inspectorWrap}>
			{effectiveOpen ? (
				<div className={styles.inspector}>
					{selection ? (
						<SelectionPane tl={tl} onClose={() => tl.clearSelection()} />
					) : audioTrackSelected ? (
						<AudioTrackPane tl={tl} onClose={() => tl.clearSelection()} />
					) : (
						<FacetBody facet={facet} onCollapse={onToggleOpen} transcriptProps={transcriptProps} />
					)}
				</div>
			) : null}
			<div className={styles.facetRail}>
				{facets.map(({ id, labelKey, icon: Icon }) => (
					// The name is the pane's title; the tip says what the pane holds. They are two keys
					// because the title is also the pane's heading and cannot carry the list.
					<Tooltip key={id} content={railTips[id]} {...RAIL_TOOLTIP}>
						<button
							type="button"
							aria-label={ts(labelKey)}
							aria-pressed={!selection && !audioTrackSelected && open && facet === id}
							onClick={() => {
								// Switching facets while an element is selected should show
								// the facet, not leave the selection pane on top of it.
								if (selection || audioTrackSelected) tl.clearSelection();
								if (facet === id && open) {
									onToggleOpen();
								} else {
									onFacetChange(id);
								}
							}}
						>
							<Icon size={17} />
						</button>
					</Tooltip>
				))}
				{/* A portal, like the timeline's menus: drawn inside the stage, the list was clipped by
				    the stage's edge, and the rows past it sat under the timeline, out of reach. */}
				<Popover open={clipPickerOpen && clips.length > 1} onOpenChange={setClipPickerOpen}>
					<Tooltip content={te("inspector.editClipTip")} {...RAIL_TOOLTIP}>
						<PopoverTrigger asChild>
							<button
								type="button"
								aria-label={te("editClipDialog.title")}
								aria-haspopup={clips.length > 1 ? "menu" : undefined}
								aria-expanded={clips.length > 1 ? clipPickerOpen : undefined}
								onClick={(event) => {
									if (selection) tl.clearSelection();
									if (clips.length > 1) return;
									// One clip or none: no menu to open (Radix skips a prevented click).
									event.preventDefault();
									if (clips.length === 1) onEditClip(clips[0]);
								}}
							>
								<Pencil size={17} />
							</button>
						</PopoverTrigger>
					</Tooltip>
					<PopoverContent
						side="left"
						align="start"
						sideOffset={RAIL_TOOLTIP.sideOffset}
						collisionPadding={12}
						animated={false}
						className="w-auto border-0 bg-transparent p-0 shadow-none"
						onCloseAutoFocus={(event) => {
							// The clip's dialog has the focus by then: handing it back to this button would
							// leave it behind the dialog.
							if (document.activeElement !== document.body) event.preventDefault();
						}}
					>
						<div
							role="menu"
							aria-label={te("editClipDialog.pickClipTitle")}
							style={{
								minWidth: 200,
								maxHeight: 320,
								overflowY: "auto",
								background: "var(--surface-1)",
								border: "1px solid var(--border)",
								borderRadius: 12,
								boxShadow: "var(--elev-pop)",
								backdropFilter: "blur(18px)",
								padding: 6,
							}}
						>
							<p
								style={{
									margin: "4px 8px 6px",
									font: "600 12px/1.3 var(--font-body)",
									color: "var(--fg-2)",
								}}
							>
								{te("editClipDialog.pickClipTitle")}
							</p>
							{clips.map((clip, index) => (
								<button
									key={clip.id}
									type="button"
									role="menuitem"
									onClick={() => {
										setClipPickerOpen(false);
										onEditClip(clip);
									}}
									style={{
										display: "flex",
										flexDirection: "column",
										alignItems: "flex-start",
										width: "100%",
										padding: "7px 8px",
										border: "none",
										borderRadius: 8,
										background: "transparent",
										color: "var(--fg)",
										cursor: "pointer",
										textAlign: "left",
									}}
								>
									<span style={{ font: "600 13px var(--font-display)" }}>
										{te("editClipDialog.clipLabel", { index: index + 1 })}
									</span>
									<span
										style={{
											font: "500 12px var(--font-body)",
											fontVariantNumeric: "tabular-nums",
											color: "var(--muted)",
										}}
									>
										{formatSeconds(clip.timelineStartSec)}–{formatSeconds(clip.timelineEndSec)}
									</span>
								</button>
							))}
						</div>
					</PopoverContent>
				</Popover>
			</div>
		</div>
	);
}

function paneHeader(icon: React.ReactNode, title: string, onClose: () => void, closeLabel: string) {
	return (
		<header
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "14px 16px 12px",
				borderBottom: "1px solid var(--border-soft)",
				// Le corps défile sous l'en-tête : sans ça, l'en-tête se comprime avec lui.
				flexShrink: 0,
			}}
		>
			<span style={{ display: "grid", placeItems: "center", color: "var(--muted)" }}>{icon}</span>
			<h2
				style={{
					margin: 0,
					flex: 1,
					fontSize: 14,
					fontWeight: 600,
					color: "var(--fg-emphasis)",
					letterSpacing: "-0.01em",
				}}
			>
				{title}
			</h2>
			<Tooltip content={closeLabel}>
				<button
					type="button"
					className={styles.iconBtn}
					aria-label={closeLabel}
					onClick={onClose}
					style={{
						width: 30,
						height: 30,
					}}
				>
					<X size={16} />
				</button>
			</Tooltip>
		</header>
	);
}

function paneRow(label: string, control: React.ReactNode) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 10,
			}}
		>
			<span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>{label}</span>
			{control}
		</div>
	);
}

/** Un libellé au-dessus de son contrôle, pour ceux qui prennent toute la largeur du panneau
 *  (une `ChoiceRow`) : à côté d'un libellé, ils n'auraient plus la place de montrer leurs choix.
 *  `value` nomme le choix courant quand les boutons ne font que le dessiner. */
function paneStack(label: string, control: React.ReactNode, value?: string) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
			<span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>
				{label}
				{value ? <span className={shell.sectionLabelValue}>{value}</span> : null}
			</span>
			{control}
		</div>
	);
}

/** What each camera does to the screen (viewBox 0 0 32 22, as the camera layout tiles). A fixed
 *  angle is the outline of its pose: `ROTATION_3D_PRESETS` projected with the shipped
 *  perspective and centred. The moving camera leaves the screen flat and circles it. */
const CAMERA_ICONS: Record<Rotation3DPreset | "off", React.ReactNode> = {
	off: <rect x="6.5" y="5.5" width="19" height="11" rx="1.5" />,
	left: <polygon points="6.1,6.2 25.9,4.7 24.7,17.3 7.2,15.1" />,
	right: <polygon points="6.1,4.7 25.9,6.2 24.8,15.1 7.3,17.3" />,
	orbit: (
		<>
			<rect x="10.5" y="7.5" width="11" height="7" rx="1" />
			<ellipse cx="16" cy="11" rx="14" ry="7.5" strokeDasharray="2 2.5" />
		</>
	),
};

type AnnotationKind = AxcutAnnotationRegion["type"];
type ArrowDirectionKind = NonNullable<AxcutAnnotationRegion["figureData"]>["arrowDirection"];

/** Les huit directions de `ArrowSvgs.tsx`, dans l'ordre d'une boussole (du haut, dans le sens
 *  des aiguilles d'une montre), chacune avec la flèche qui la montre. Aucune langue n'a de
 *  libellé pour elles, et la valeur brute (« up-right ») s'affichait telle quelle : le caractère
 *  fléché sert de nom accessible. */
const ARROW_DIRECTIONS: Array<{ value: ArrowDirectionKind; glyph: string; Icon: LucideIcon }> = [
	{ value: "up", glyph: "↑", Icon: ArrowUp },
	{ value: "up-right", glyph: "↗", Icon: ArrowUpRight },
	{ value: "right", glyph: "→", Icon: ArrowRight },
	{ value: "down-right", glyph: "↘", Icon: ArrowDownRight },
	{ value: "down", glyph: "↓", Icon: ArrowDown },
	{ value: "down-left", glyph: "↙", Icon: ArrowDownLeft },
	{ value: "left", glyph: "←", Icon: ArrowLeft },
	{ value: "up-left", glyph: "↖", Icon: ArrowUpLeft },
];

/** Défauts du schéma, pour compléter un `blurData` absent sans écraser ce qui existe. */
const BLUR_DEFAULTS = {
	type: "mosaic",
	shape: "rectangle",
	color: "white",
	intensity: 12,
	blockSize: 12,
} as const;

const ZOOM_DEPTHS: readonly ZoomDepth[] = [1, 2, 3, 4, 5, 6];

// The row: the default and one step either side, plus a strong close-up. The two ends of the
// table (1.25×, 5×) and every level between are one entry in the free field below, which is
// why the row stays short. Labels read the table, not a formula: a formula once announced
// "2.0×" where the timeline pill showed "1.80×" and the render applied 1.8.
const ZOOM_PRESETS = ([2, 3, 4, 5] as const).map((depth) => ({
	value: ZOOM_DEPTH_SCALES[depth],
	label: `${ZOOM_DEPTH_SCALES[depth]}×`,
}));

/**
 * The zoom level as a row of presets plus a free field, the same pair as the speed control
 * below. A level is one click away instead of two (open the select, then pick): that is
 * My-Denia's change (#694), and so is everything that keeps rapid clicks and arrow steps in
 * order, below.
 *
 * The control speaks in scales, not depths: a preset and a typed level are the same kind of
 * value, and a typed level the table has (1.8, or 1.25 which is not in the row) is written as
 * its depth, so a document keeps naming its presets. Anything else is a `customScale`.
 */
export function ZoomLevelControl({
	region,
	tl,
	maxScale = MAX_ZOOM_SCALE,
}: {
	region: { id: string; depth: ZoomDepth; customScale?: number };
	tl: Pick<TimelineApi, "updateZoomDepth" | "updateZoomCustomScale">;
	/** The deepest level this region's clip takes before its recording blurs
	 *  (`zoomScaleLimit`). Deeper presets are not offered. */
	maxScale?: number;
}) {
	const ts = useScopedT("settings");
	const current = effectiveZoomScale(region);
	// Last level this instance asked for, and the generation of that request. Levels repeat,
	// so a set of levels cannot tell "our older 2.2 landed" from "the latest request is 2.2" or
	// from an undo that happens to land on 2.2. Each click/key gets a new gen. Every gen
	// belonging to this region epoch is removed from `pending` when it settles: a superseded
	// request must still drain, or `pending` stays non-empty and undo/redo can never overwrite
	// the request. Only the latest gen may change it.
	//
	// The row shows the request, not the document: its no-op guard compares against the value
	// it is given, and against a document still saying 1.8 while a 2.2 is in flight, stepping
	// back to 1.8 would be dropped as a re-press.
	const requestedRef = useRef(current);
	const [requested, setRequested] = useState(current);
	const genRef = useRef(0);
	const pendingRef = useRef(new Set<number>());
	const currentRef = useRef(current);
	currentRef.current = current;
	// "" means the field is idle and shows the live level as its placeholder.
	const [draft, setDraft] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: region.id is the trigger, not a read — the body resets request state; the level is taken from the render's ref so a same-level other pill still clears the previous pill's pending gen.
	useEffect(() => {
		genRef.current += 1;
		pendingRef.current.clear();
		requestedRef.current = currentRef.current;
		setRequested(currentRef.current);
	}, [region.id]);

	useEffect(() => {
		if (pendingRef.current.size > 0) return;
		requestedRef.current = current;
		setRequested(current);
	}, [current]);

	const setScale = (scale: number) => {
		// Re-choosing the current level is not an edit: no save, no undo entry.
		if (scale === requestedRef.current) return;
		requestedRef.current = scale;
		setRequested(scale);
		const gen = ++genRef.current;
		pendingRef.current.add(gen);
		const depth = ZOOM_DEPTHS.find((d) => ZOOM_DEPTH_SCALES[d] === scale);
		const write =
			depth === undefined
				? tl.updateZoomCustomScale(region.id, scale)
				: tl.updateZoomDepth(region.id, depth);
		// A refused write hands the level back to the document, so the same one can be retried.
		const settle = (ok: boolean) => {
			pendingRef.current.delete(gen);
			if (ok || gen !== genRef.current) return;
			requestedRef.current = currentRef.current;
			setRequested(currentRef.current);
		};
		void Promise.resolve(write).then(
			(ok) => settle(ok !== false),
			() => settle(false),
		);
	};

	const commitDraft = () => {
		const text = draft
			.trim()
			.replace(",", ".")
			.replace(/\s*[×x]$/i, "");
		setDraft("");
		// Empty or unparseable reverts to the live level rather than guessing at an intent.
		if (text === "" || !Number.isFinite(Number(text))) return;
		const scale = Math.round(Number(text) * 100) / 100;
		if (scale < MIN_ZOOM_SCALE || scale > maxScale) {
			toast.error(ts("zoom.customScaleRange", { min: MIN_ZOOM_SCALE, max: maxScale }));
			return;
		}
		setScale(scale);
	};

	const presets = ZOOM_PRESETS.filter((preset) => preset.value <= maxScale);
	const hasSelectedPreset = presets.some((preset) => preset.value === requested);

	return (
		<>
			{/* A level outside the row presses no button; the field beside it shows it. With no
			    preset within reach, the field alone remains. */}
			{paneStack(
				ts("zoom.level"),
				<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
					{presets.length > 0 ? (
						<div style={{ flex: 1, minWidth: 0 }}>
							<ChoiceRow<number>
								label={ts("zoom.level")}
								options={presets}
								value={requested}
								onChange={setScale}
							/>
						</div>
					) : null}
					<input
						type="text"
						inputMode="decimal"
						aria-label={ts("zoom.customScale")}
						placeholder={hasSelectedPreset ? "" : `${requested}×`}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={commitDraft}
						// Enter blurs, and the blur handler commits: one path, so a keyboard commit
						// can't apply the same draft twice.
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
						className={shell.control}
						style={{ width: 56, textAlign: "right" }}
					/>
					<FieldUnit>×</FieldUnit>
				</div>,
			)}
		</>
	);
}

// The speeds people actually reach for, one row of buttons: slow down, back to normal, and three
// steps up. Every other speed (the shared ladder's 0.25×, 3×, 5×, anything up to
// `MAX_PLAYBACK_SPEED`) is one entry in the free field below, which is why the row stays short.
const SPEED_PRESETS = [0.5, 1, 1.5, 2, 4];

/**
 * Preset select + free numeric field, the speed UX this editor already had translations for
 * (`settings.speed.customPlaybackSpeed` / `maxSpeedError`) but no longer any control for: the V4
 * shell replaced the panel that hosted it with a preset-only `<select>` capped at 3×, while the
 * underlying capability goes to `MAX_PLAYBACK_SPEED` (100×). Only the control was missing, so
 * this rewires it rather than adding anything new. `previewFrameSteppingHint` is deliberately
 * not rendered: it describes the legacy editor, while this preview caps at
 * `MAX_NATIVE_PLAYBACK_RATE` (16×) without frame-stepping or muting (see the note below).
 */
export function SpeedControl({
	region,
	tl,
}: {
	region: { id: string; speed: number };
	tl: Pick<TimelineApi, "updateSpeedValue">;
}) {
	const ts = useScopedT("settings");
	// "" means the field is idle and the select is showing the truth. A non-empty draft is
	// uncommitted text; it's cleared on commit so the placeholder tracks the live speed again.
	const [draft, setDraft] = useState("");

	const commitDraft = () => {
		const result = parseCustomPlaybackSpeedInput(draft);
		if (result.status === "valid") {
			void tl.updateSpeedValue(region.id, result.speed);
		} else if (result.status === "too-fast") {
			toast.error(ts("speed.maxSpeedError", { max: MAX_PLAYBACK_SPEED }));
		}
		// Anything else (empty, unparseable, below the floor) just reverts to the live value
		// rather than guessing at an intent.
		setDraft("");
	};

	return (
		<>
			{/* A speed outside the row presses no button; the field below shows it as its
			    placeholder. */}
			{paneStack(
				ts("speed.playbackSpeed"),
				<ChoiceRow<number>
					label={ts("speed.playbackSpeed")}
					options={SPEED_PRESETS.map((speed) => ({ value: speed, label: `${speed}×` }))}
					value={region.speed}
					onChange={(speed) => void tl.updateSpeedValue(region.id, speed)}
				/>,
			)}
			{paneRow(
				ts("speed.customPlaybackSpeed"),
				<span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
					<input
						type="text"
						inputMode="decimal"
						placeholder={`${region.speed}×`}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={commitDraft}
						// Enter blurs, and the blur handler commits — one path, so a keyboard commit
						// can't apply the same draft twice.
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
						className={shell.control}
						style={{ width: 84, textAlign: "right" }}
					/>
					<FieldUnit>×</FieldUnit>
				</span>,
			)}
			{/* No hint past 16×. There is nothing for the user to do about it and nothing that
			    changes in what they get: the export renders the true speed either way. The note
			    that used to sit here described the legacy editor's frame-stepped, silent preview,
			    which is not this one. */}
		</>
	);
}

// The sizes a text reaches for, in pixels at 1080 (`annotationScale.ts`): a caption-sized note,
// the default, a heading and a title. Anything else, down to 8 and up to 200, is typed in the
// field at the end of the row, the zoom level's pair.
const TEXT_SIZE_PRESETS = [24, 32, 48, 72];

/** The text size as a row of presets plus a free field, like the zoom level. */
export function AnnotationSizeControl({
	size,
	onChange,
}: {
	size: number;
	onChange: (size: number) => void;
}) {
	const ts = useScopedT("settings");
	// A size outside the row presses no button; the field beside it shows it.
	return paneStack(
		ts("annotation.size"),
		<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
			<div style={{ flex: 1, minWidth: 0 }}>
				<ChoiceRow<number>
					label={ts("annotation.size")}
					options={TEXT_SIZE_PRESETS.map((value) => ({ value, label: String(value) }))}
					value={size}
					onChange={onChange}
				/>
			</div>
			<AnnotationSizeField label={ts("annotation.customSize")} size={size} onCommit={onChange} />
			<FieldUnit>px</FieldUnit>
		</div>,
	);
}

/** The unit beside a free field. The placeholder alone loses it as soon as the user types. */
function FieldUnit({ children }: { children: string }) {
	return (
		<span aria-hidden="true" style={{ fontSize: 11, opacity: 0.7 }}>
			{children}
		</span>
	);
}

/**
 * The text size as a free field, committed on blur like the speed and zoom fields and read into
 * `SETTING_BOUNDS.annotationFontSize`. It used to write every keystroke as typed, so an emptied
 * field stored a size of 0 and the text vanished.
 */
export function AnnotationSizeField({
	label,
	size,
	onCommit,
}: {
	label: string;
	size: number;
	onCommit: (size: number) => void;
}) {
	// "" means the field is idle and shows the live size as its placeholder.
	const [draft, setDraft] = useState("");
	/** The committed size a draft reads as, or null when it names none. */
	const sizeOf = (text: string) => {
		const typed = text.trim().replace(",", ".");
		// Empty or unparseable reverts to the live size rather than guessing at an intent.
		if (typed === "" || !Number.isFinite(Number(typed))) return null;
		return Math.round(clampToBound(Number(typed), "annotationFontSize"));
	};
	const commitDraft = () => {
		const next = sizeOf(draft);
		setDraft("");
		if (next !== null && next !== size) onCommit(next);
	};
	// A click on the timeline clears the selection on pointerdown, which unmounts this field
	// before its blur can fire. A size typed and never blurred is committed on the way out.
	const pendingRef = useRef({ draft, size, onCommit });
	pendingRef.current = { draft, size, onCommit };
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on unmount; the ref carries the latest draft.
	useEffect(
		() => () => {
			const { draft: left, size: live, onCommit: commit } = pendingRef.current;
			const next = sizeOf(left);
			if (next !== null && next !== live) commit(next);
		},
		[],
	);
	return (
		<input
			type="text"
			inputMode="numeric"
			aria-label={label}
			placeholder={String(size)}
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commitDraft}
			// Enter blurs, and the blur handler commits: one path, so a keyboard commit can't
			// apply the same draft twice.
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
			}}
			className={shell.control}
			style={{ width: 56, textAlign: "right" }}
		/>
	);
}

function SelectionPane({ tl, onClose }: { tl: TimelineApi; onClose: () => void }) {
	const ts = useScopedT("settings");
	const tt = useScopedT("timeline");
	const tc = useScopedT("common");
	const te = useScopedT("editor");
	// Read here rather than threading it through: the zoom pane is the only consumer, and the
	// toggle that writes it lives in the timeline toolbar, not on this component's path.
	const { settings } = useEditorSettings();
	const autoFocusAll = settings.autoFocusAll;
	const focusHintId = useId();
	// The camera piece on screen, for the render where a write has re-keyed it ahead of the
	// selection (`findSelectedCameraPiece`).
	const shownCameraPiece = useRef<CameraPiece | null>(null);
	const doc = useProjectStore((s) => s.document);
	const zoomId = tl.selection?.kind === "zoom" ? tl.selection.id : null;
	const zoomMaxScale = useMemo(
		() => (doc && zoomId ? zoomScaleLimit(doc, zoomId) : MAX_ZOOM_SCALE),
		[doc, zoomId],
	);
	// Mise à jour en direct regroupée à une par frame. `updateAnnotationLive` remplace le document
	// dans le store, donc chaque appel fait reconstruire et re-sérialiser toute la scène avant de
	// la pousser au natif : c'est le juste prix une fois par image, mais un `<input type="color">`
	// émet un événement par pixel de glissement et saturait le thread. La référence garde la
	// dernière fonction du store sans recréer le coalesceur, dont l'état en attente doit survivre
	// aux rendus.
	const liveUpdateRef = useRef(tl.updateAnnotationLive);
	liveUpdateRef.current = tl.updateAnnotationLive;
	const liveUpdate = useMemo(
		() =>
			rafCoalesce((id: string, patch: Partial<AxcutAnnotationRegion>) =>
				liveUpdateRef.current(id, patch),
			),
		[],
	);
	/** Fin de geste : on applique la dernière valeur en attente AVANT d'enregistrer, sinon la
	 *  frame en vol serait perdue et le disque garderait l'avant-dernière couleur. */
	const commitAnnotation = () => {
		liveUpdate.flush();
		void tl.commitAnnotationChange();
	};
	// Largeur sur hauteur du cadre de sortie : ce sur quoi une boîte de texte est taillée.
	const frameAspect = useMemo(
		() => (doc ? resolveAspectRatioValue(doc, settings.aspectRatio) : 16 / 9),
		[doc, settings.aspectRatio],
	);
	/** Le footage sous l'annotation, lu au moment du geste : la scène entière le calcule. */
	const footageOf = (id: string) => {
		const current = useProjectStore.getState().document;
		return current ? annotationFootageRect(current, id) : null;
	};
	/**
	 * Une édition du texte (mots, taille), la boîte retaillée sur le résultat, centre conservé.
	 * Un texte encore rangé sur le footage passe d'abord dans le cadre, comme à son premier
	 * déplacement dans l'aperçu : c'est là que sa boîte veut dire quelque chose.
	 */
	const textEdit = (
		region: AxcutAnnotationRegion,
		patch: Partial<AxcutAnnotationRegion>,
	): Partial<AxcutAnnotationRegion> => {
		const footage = region.space === "frame" ? null : footageOf(region.id);
		const toFrame = footage ? toFrameSpace(region, footage) : null;
		const next = { ...region, ...toFrame, ...patch };
		if (next.space !== "frame") return patch;
		return { ...toFrame, ...patch, ...fitTextBox(next, frameAspect) };
	};
	const selection = tl.selection;
	if (!selection) return null;

	const deleteAndClose = () => {
		void tl.removeRegion(selection.kind, selection.id);
		onClose();
	};

	// Le panneau découpe son contenu (coins arrondis + flou), donc un corps sans ascenseur perd
	// silencieusement ce qui dépasse — c'est ce qui arrivait au pane d'annotation, le plus haut de
	// tous, dès qu'on réduisait la fenêtre. L'en-tête reste fixe, le corps défile, comme les
	// panneaux de facette (cf. `.paneBody` de NewEditorShell).
	const bodyStyle: React.CSSProperties = {
		padding: "16px",
		display: "flex",
		flexDirection: "column",
		gap: 16,
		flex: "1 1 auto",
		minHeight: 0,
		overflowY: "auto",
		overflowX: "hidden",
		overscrollBehavior: "contain",
		scrollbarWidth: "thin",
		scrollbarColor: "var(--border) transparent",
	};

	if (selection.kind === "zoom") {
		const region = tl.zoomRegions.find((z) => z.id === selection.id);
		if (!region) return null;
		const cameraLabel = (preset: Rotation3DPreset | "off") =>
			ts(preset === "off" ? "zoom.camera.off" : `zoom.camera.preset.${preset}`);
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(<ZoomIn size={16} />, tt("labels.zoom"), onClose, tc("actions.close"))}
				<div style={bodyStyle}>
					<ZoomLevelControl key={region.id} region={region} tl={tl} maxScale={zoomMaxScale} />
					<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						{paneStack(
							ts("zoom.camera.title"),
							// ONE control for the whole 3D camera: a fixed angle and a moving camera are
							// alternatives, not two settings to combine. Each tile draws what it does to
							// the screen, so the label names the one picked.
							<ChoiceRow<Rotation3DPreset | "off">
								label={ts("zoom.camera.title")}
								tiles
								options={[
									"off" as const,
									// The orbit follows the cursor under auto focus, and a hidden cursor drives
									// nothing: not offered then, rather than a camera that silently holds still.
									// Under manual focus the focus point poses it, cursor or not. Still listed
									// once picked, so the row can show it.
									...(settings.cursorShow ||
									(!autoFocusAll && (region.focusMode ?? "manual") === "manual") ||
									region.rotationPreset === "orbit"
										? MOVING_ROTATION_3D_PRESETS
										: []),
									...FIXED_ROTATION_3D_PRESETS,
								].map((preset) => ({
									value: preset,
									label: cameraLabel(preset),
									icon: (
										<svg
											viewBox="0 0 32 22"
											width={32}
											height={22}
											fill="none"
											stroke="currentColor"
											strokeWidth="1.75"
											strokeLinejoin="round"
											aria-hidden="true"
										>
											{CAMERA_ICONS[preset]}
										</svg>
									),
								}))}
								value={region.rotationPreset ?? "off"}
								// "off" is the absence of a preset — the schema field is optional and
								// `migrate.ts` drops it when falsy.
								onChange={(preset) =>
									void tl.updateZoomRotation(region.id, preset === "off" ? undefined : preset)
								}
							/>,
							cameraLabel(region.rotationPreset ?? "off"),
						)}
					</div>
					{/* An automatic zoom moves by the project's auto-zoom camera, not by a mode of its
					    own: its settings stand where the focus mode would, for all of them at once. */}
					{region.source === "auto" ? <AutoZoomSettings /> : null}
					{region.source === "auto"
						? null
						: paneStack(
								ts("zoom.focusMode.title"),
								// While the global toggle is on it OVERRIDES every region, so the control shows
								// the effective mode ("auto") and goes read-only rather than lying about a
								// per-region value that currently has no effect. The region's own `focusMode` is
								// never written by the toggle — that is what makes each zoom snap back to its
								// previous value the moment the toggle goes off.
								<ChoiceRow<"manual" | "auto">
									label={ts("zoom.focusMode.title")}
									options={[
										{ value: "manual", label: ts("zoom.focusMode.manual") },
										{ value: "auto", label: ts("zoom.focusMode.auto") },
									]}
									value={autoFocusAll ? "auto" : (region.focusMode ?? "manual")}
									disabled={autoFocusAll}
									describedBy={autoFocusAll ? focusHintId : undefined}
									onChange={(mode) => void tl.updateZoomFocusMode(region.id, mode)}
								/>,
							)}
					{paneStack(
						ts("zoom.cursor.title"),
						<ChoiceRow<"show" | "hide">
							label={ts("zoom.cursor.title")}
							options={[
								{ value: "show", label: ts("zoom.cursor.show") },
								{ value: "hide", label: ts("zoom.cursor.hide") },
							]}
							value={region.hideCursor ? "hide" : "show"}
							onChange={(v) => void tl.updateZoomHideCursor(region.id, v === "hide")}
						/>,
					)}
					{autoFocusAll || region.focusMode === "auto" ? (
						// Auto resamples the focus from cursor telemetry every frame, so there is no fixed
						// point to reset and no gimbal on the canvas (ZoomFocusOverlay bows out) — the
						// reset button would be a no-op. When the global toggle is what forced auto, say
						// where to turn it off.
						autoFocusAll ? (
							<p id={focusHintId} className={shell.hint}>
								{ts("zoom.focusMode.lockedDisclaimer")}
							</p>
						) : null
					) : (
						<button
							type="button"
							onClick={() => {
								tl.updateZoomFocusLive(region.id, { cx: 0.5, cy: 0.5 });
								void tl.commitZoomFocus();
							}}
							className={PANE_BUTTON}
						>
							{te("inspector.resetFocusPoint")}
						</button>
					)}
					<button type="button" onClick={deleteAndClose} className={PANE_BUTTON}>
						<Trash2 size={16} style={{ color: "var(--danger)" }} />
						{ts("zoom.deleteZoom")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "speed") {
		const region = tl.speedRegions.find((s) => s.id === selection.id);
		if (!region) return null;
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(<ZoomIn size={16} />, tt("labels.speed"), onClose, tc("actions.close"))}
				<div style={bodyStyle}>
					<SpeedControl region={region} tl={tl} />
					<button type="button" onClick={deleteAndClose} className={PANE_BUTTON}>
						<Trash2 size={16} style={{ color: "var(--danger)" }} />
						{ts("speed.deleteRegion")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "annotation") {
		const region = tl.annotationRegions.find((a) => a.id === selection.id);
		if (!region) return null;
		const plate = textPlateOf(region.style);
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(
					<FileText size={16} />,
					tt("labels.annotationItem"),
					onClose,
					tc("actions.close"),
				)}
				<div style={bodyStyle}>
					{/* Type switch. Only text annotations could ever be created, so image, arrow and
					    blur were unreachable even though the compositor renders all four and every
					    label here already shipped translated. Converting keeps the span and box, so
					    a mistake costs one more click rather than redrawing the region. */}
					{paneStack(
						ts("annotation.type"),
						<ChoiceRow<AnnotationKind>
							label={ts("annotation.type")}
							display="both"
							tiles
							// Six types: two rows of three, every label whole.
							columns={3}
							options={[
								{ value: "text", label: ts("annotation.typeText"), icon: <Type size={16} /> },
								{
									value: "image",
									label: ts("annotation.typeImage"),
									icon: <ImageIcon size={16} />,
								},
								{
									value: "figure",
									label: ts("annotation.typeArrow"),
									icon: <ArrowUpRight size={16} />,
								},
								{ value: "blur", label: ts("annotation.typeBlur"), icon: <EyeOff size={16} /> },
								{
									value: "highlight",
									label: ts("annotation.typeHighlight"),
									icon: <Focus size={16} />,
								},
								{
									value: "step",
									label: ts("annotation.typeStep"),
									icon: <ListOrdered size={16} />,
								},
							]}
							value={region.type}
							onChange={(kind) => {
								tl.updateAnnotationLive(region.id, {
									...convertAnnotationKind(region, kind, {
										footage: footageOf(region.id),
										frameAspect,
									}),
									// A tutorial annotation arrives with its own settings: a step takes the
									// next number in creation order.
									...(kind === "highlight" && !region.highlightData
										? { highlightData: { ...HIGHLIGHT_DEFAULTS } }
										: {}),
									...(kind === "step" && !region.stepData
										? {
												stepData: {
													...STEP_DEFAULTS,
													number: nextStepNumber(tl.annotationRegions),
												},
											}
										: {}),
								});
								void tl.commitAnnotationChange();
							}}
						/>,
					)}
					{region.type === "text" ? (
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							<span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>
								{ts("annotation.textContent")}
							</span>
							<textarea
								value={region.content ?? ""}
								placeholder={ts("annotation.textPlaceholder")}
								onChange={(e) =>
									tl.updateAnnotationLive(region.id, textEdit(region, { content: e.target.value }))
								}
								onBlur={commitAnnotation}
								rows={2}
								className={shell.control}
							/>
						</div>
					) : null}
					{region.type === "image" ? (
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							{/* Read as a data URL, which is what the renderer expects: `content` holds
							    "Separate storage for image data URL" (types.ts) and both the preview
							    overlay and the compositor read it from there. */}
							<label className={PANE_BUTTON} htmlFor={`ann-img-${region.id}`}>
								{ts("annotation.uploadImage")}
							</label>
							<input
								id={`ann-img-${region.id}`}
								type="file"
								accept="image/jpeg,image/png,image/gif,image/webp"
								style={{ display: "none" }}
								onChange={(e) => {
									const file = e.target.files?.[0];
									if (!file) return;
									if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
										toast.error(ts("annotation.imageFormatsOnly"));
										return;
									}
									const reader = new FileReader();
									reader.onload = () => {
										tl.updateAnnotationLive(region.id, { content: String(reader.result) });
										void tl.commitAnnotationChange();
										toast.success(ts("annotation.imageUploadSuccess"));
									};
									reader.readAsDataURL(file);
								}}
							/>
						</div>
					) : null}
					{region.type === "figure" ? (
						<>
							{paneStack(
								ts("annotation.arrowDirection"),
								<ChoiceRow<ArrowDirectionKind>
									label={ts("annotation.arrowDirection")}
									options={ARROW_DIRECTIONS.map(({ value, glyph, Icon }) => ({
										value,
										label: glyph,
										icon: <Icon size={16} />,
									}))}
									value={region.figureData?.arrowDirection ?? "right"}
									onChange={(arrowDirection) => {
										tl.updateAnnotationLive(region.id, {
											figureData: {
												...(region.figureData ?? { color: "#34B27B", strokeWidth: 4 }),
												arrowDirection,
											},
										});
										void tl.commitAnnotationChange();
									}}
								/>,
							)}
							{paneRow(
								ts("annotation.arrowColor"),
								<ColorField
									label={ts("annotation.arrowColor")}
									value={region.figureData?.color ?? "#34B27B"}
									onChange={(next) =>
										liveUpdate(region.id, {
											figureData: {
												...(region.figureData ?? { arrowDirection: "right", strokeWidth: 4 }),
												color: next,
											},
										})
									}
									onCommit={commitAnnotation}
								/>,
							)}
							<SliderCell
								label={ts("annotation.strokeWidth", {
									width: region.figureData?.strokeWidth ?? 4,
								})}
								value={region.figureData?.strokeWidth ?? 4}
								min={1}
								max={20}
								// The schema's default (`figureDataSchema`), the width every new arrow starts at.
								defaultValue={4}
								onChange={(next) =>
									tl.updateAnnotationLive(region.id, {
										figureData: {
											...(region.figureData ?? { arrowDirection: "right", color: "#34B27B" }),
											strokeWidth: next,
										},
									})
								}
								onCommit={() => void tl.commitAnnotationChange()}
								// Le libellé i18n interpole déjà « : 11px » ; sans ça on lisait « 11px11 ».
								showValue={false}
							/>
						</>
					) : null}
					{region.type === "blur" ? (
						<>
							{paneStack(
								ts("annotation.blurType"),
								<ChoiceRow<"blur" | "mosaic">
									label={ts("annotation.blurType")}
									options={[
										{ value: "blur", label: ts("annotation.blurTypeBlur") },
										{ value: "mosaic", label: ts("annotation.blurTypeMosaic") },
									]}
									value={region.blurData?.type ?? "mosaic"}
									onChange={(type) => {
										tl.updateAnnotationLive(region.id, {
											blurData: { ...(region.blurData ?? BLUR_DEFAULTS), type },
										});
										void tl.commitAnnotationChange();
									}}
								/>,
							)}
							{paneStack(
								ts("annotation.blurShape"),
								<ChoiceRow<"rectangle" | "oval" | "freehand">
									label={ts("annotation.blurShape")}
									options={[
										{ value: "rectangle", label: ts("annotation.blurShapeRectangle") },
										{ value: "oval", label: ts("annotation.blurShapeOval") },
										// Le tracé libre n'est plus proposé à la création : sa saisie était cassée et
										// le rendu ne couvrait que la boîte englobante. Un outil de confidentialité
										// à moitié fiable vaut moins que pas d'outil, parce qu'on lui fait confiance.
										// Le choix reste visible pour une annotation qui l'utilise déjà, avec la
										// phrase qui dit ce que le rendu en fait — plutôt que de le faire disparaître
										// d'un projet existant.
										...(region.blurData?.shape === "freehand"
											? [{ value: "freehand" as const, label: ts("annotation.blurShapeFreehand") }]
											: []),
									]}
									value={region.blurData?.shape ?? "rectangle"}
									onChange={(shape) => {
										tl.updateAnnotationLive(region.id, {
											blurData: { ...(region.blurData ?? BLUR_DEFAULTS), shape },
										});
										void tl.commitAnnotationChange();
									}}
								/>,
							)}
							{region.blurData?.shape === "freehand" ? (
								// Say it rather than let the user discover it: the compositor masks the
								// bounding box for a freehand shape, deliberately over-covering instead
								// of leaving anything the user marked private visible in the export.
								<p className={shell.hint}>{te("inspector.freehandRendersAsBox")}</p>
							) : null}
						</>
					) : null}
					{region.type === "highlight" ? (
						<HighlightControls
							region={region}
							onLive={(patch) => liveUpdate(region.id, patch)}
							onCommit={commitAnnotation}
						/>
					) : null}
					{region.type === "step" ? (
						<StepControls
							region={region}
							frameAspect={frameAspect}
							onLive={(patch) => liveUpdate(region.id, patch)}
							onCommit={commitAnnotation}
						/>
					) : null}
					{region.type === "text" ? (
						// Le nombre vaut « pixels à 1080 » (cf. annotationScale.ts) : aperçu et rendu le
						// multiplient tous deux par la hauteur du cadre, donc il veut dire la même chose
						// des deux côtés. La boîte suit : elle reste taillée sur le texte.
						<AnnotationSizeControl
							size={region.style?.fontSize ?? 32}
							onChange={(fontSize) => {
								tl.updateAnnotationLive(
									region.id,
									textEdit(region, { style: { ...region.style, fontSize } }),
								);
								commitAnnotation();
							}}
						/>
					) : null}
					{region.type === "text"
						? paneStack(
								ts("annotation.background"),
								// Trois plaques nommées : la plaque porte seule l'état allumé/éteint, et en
								// choisir une ajuste un texte qui y deviendrait illisible. Une couleur libre
								// d'un projet plus ancien reste montrée tant qu'elle est là, comme le tracé
								// libre du flou.
								<ChoiceRow<TextPlate | "custom">
									label={ts("annotation.background")}
									// Quatre libellés ne tiennent pas sur une rangée : « Personnalisé » était rogné.
									columns={plate === "custom" ? 2 : undefined}
									options={[
										{ value: "none", label: ts("textPlate.none") },
										{ value: "dark", label: ts("textPlate.dark") },
										{ value: "light", label: ts("textPlate.light") },
										...(plate === "custom"
											? [{ value: "custom" as const, label: ts("textPlate.custom") }]
											: []),
									]}
									value={plate}
									onChange={(next) => {
										if (next === "custom") return;
										tl.updateAnnotationLive(region.id, {
											style: setTextPlate(region.style, next),
										});
										void tl.commitAnnotationChange();
									}}
								/>,
							)
						: null}
					{region.type === "text"
						? paneStack(
								ts("annotation.color"),
								<TextColorField
									label={ts("annotation.color")}
									value={region.style?.color ?? "#ffffff"}
									plate={region.style?.backgroundColor ?? "transparent"}
									onChange={(next) =>
										liveUpdate(region.id, {
											style: { ...region.style, color: next },
										})
									}
									onCommit={commitAnnotation}
								/>,
							)
						: null}
					{region.type === "text"
						? paneStack(
								ts("textAnimation.title"),
								// Les sept animations existaient : nommées dans le schéma, traduites dans les
								// treize langues, transportées jusqu'au compositeur — et injouables, faute de
								// ce sélecteur. Trois par rangée : « Typewriter » et ses traductions tiennent.
								<ChoiceRow<AnnotationTextAnimation>
									label={ts("textAnimation.selectAnimation")}
									columns={3}
									options={TEXT_ANIMATION_VALUES.map((value) => ({
										value,
										label: ts(`textAnimation.${value === "slide-left" ? "slideLeft" : value}`),
									}))}
									value={region.style?.textAnimation ?? "none"}
									onChange={(textAnimation) => {
										tl.updateAnnotationLive(region.id, {
											style: { ...region.style, textAnimation },
										});
										void tl.commitAnnotationChange();
									}}
								/>,
							)
						: null}
					<button type="button" onClick={deleteAndClose} className={PANE_BUTTON}>
						<Trash2 size={16} style={{ color: "var(--danger)" }} />
						{ts("annotation.deleteAnnotation")}
					</button>
				</div>
			</div>
		);
	}

	// A piece of the camera track. Only how the camera is SHOWN over this stretch changes
	// here; its timing stays locked to the screen clip, so the inspector offers no span.
	if (selection.kind === "camera") {
		const pieces = tl.cameraPieces;
		const piece = findSelectedCameraPiece(pieces, selection.id, shownCameraPiece.current);
		shownCameraPiece.current = piece ?? null;
		if (!piece) return null;
		const index = pieces.indexOf(piece);
		const hasNext = index >= 0 && index < pieces.length - 1;
		const modeOptions: Array<{ value: CameraMode; label: string; icon: React.ReactNode }> = [
			{ value: "pip", label: tt("cameraPiece.modePip"), icon: <PictureInPicture2 size={16} /> },
			{
				value: "fullscreen",
				label: tt("cameraPiece.modeFullscreen"),
				icon: <Maximize2 size={16} />,
			},
			{ value: "hidden", label: tt("cameraPiece.modeHidden"), icon: <CameraOff size={16} /> },
		];
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(<Camera size={16} />, tt("cameraPiece.title"), onClose, tc("actions.close"))}
				<div style={bodyStyle}>
					<p className={shell.hint}>
						{tt("cameraPiece.span", {
							start: formatSeconds(piece.startMs / 1000),
							end: formatSeconds(piece.endMs / 1000),
						})}
					</p>
					{paneStack(
						tt("cameraPiece.mode"),
						<ChoiceRow<CameraMode>
							label={tt("cameraPiece.mode")}
							columns={3}
							display="both"
							options={modeOptions}
							value={piece.mode}
							onChange={(mode) => void tl.setCameraMode(piece.key, mode)}
						/>,
					)}
					<p className={shell.hint}>{tt("cameraPiece.syncHint")}</p>
					<CameraPieceLook tl={tl} piece={piece} />
					<button type="button" onClick={() => void tl.splitCamera()} className={PANE_BUTTON}>
						<SquareSplitHorizontal size={16} />
						{tt("cameraPiece.splitAtPlayhead")}
					</button>
					<button
						type="button"
						disabled={!hasNext}
						onClick={() => void tl.mergeCameraWithNext(piece.key)}
						className={PANE_BUTTON}
					>
						<Merge size={16} />
						{tt("cameraPiece.mergeWithNext")}
					</button>
					{piece.implicit ? null : (
						<button
							type="button"
							onClick={() => void tl.resetCameraPiece(piece.key)}
							className={PANE_BUTTON}
						>
							<Undo2 size={16} />
							{tt("cameraPiece.reset")}
						</button>
					)}
				</div>
			</div>
		);
	}

	// trim — a trim ventilated across a clip boundary is 2+ DSL rows that render
	// as one coalesced pill (see V4Timeline's trimPills), so the DURATION shown has to be
	// the group's, not the clicked row's. Deleting no longer needs the same expansion here:
	// `removeRegion` drops the whole pill for every kind (`dropTrimPillsByIds`), which is
	// what this pane used to have to arrange for itself.
	const trimGroup = coalescedTrimGroups(tl.trimRanges, tl.clips).find((g) =>
		g.ids.includes(selection.id),
	);
	if (!trimGroup) return null;
	const durationSec = Math.max(0, trimGroup.end - trimGroup.start);
	const deleteTrimGroup = () => {
		void tl.removeRegion("trim", selection.id);
		onClose();
	};
	return (
		<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
			{paneHeader(<Scissors size={16} />, tt("labels.trim"), onClose, tc("actions.close"))}
			<div style={bodyStyle}>
				<p className={shell.hint}>
					{te("inspector.trimHiddenDuration", {
						duration: formatDecimal(durationSec, 1, currentLocale()),
					})}
				</p>
				{/* Deleting the trim restores the footage, so it reads as an undo, not a delete. */}
				<button type="button" onClick={deleteTrimGroup} className={PANE_BUTTON}>
					<Undo2 size={16} />
					{te("inspector.restoreDeleteTrim")}
				</button>
			</div>
		</div>
	);
}

/** Every action of the selection pane, delete included: the red icon says it destroys; a red
 *  slab outshouted every setting above it. */
const PANE_BUTTON = `${shell.btn} ${shell.btnSecondary}`;

type LookScope = "piece" | "all";

/** "Todos os trechos" writes: the global setting, and every piece's own value for it dropped. */
const LOOK_FOR_ALL_PIECES: EditorSettingsWriteOptions = {
	transform: applyCameraLookToAllPieces,
	historyLabel: "cameraLookAll",
};

/**
 * The scope the user last picked, for the next piece selected in this session. Until they pick
 * one, a piece opens on its own scope when it has a look of its own and on "all" otherwise.
 * Sticky because the choice is about the edit, not the piece: re-opening every piece with a
 * look of its own on "Este trecho" made a user who had chosen "Todos os trechos" restyle only
 * the piece they clicked next.
 */
let pickedLookScope: LookScope | null = null;

/**
 * A camera piece's look: the global camera controls (`CameraLookControls`) behind a scope
 * switch. "Este trecho" edits the piece's own overrides and shows what the piece shows (the
 * global settings with its overrides over them); "Todos os trechos" edits the global settings
 * AND drops each piece's own value for the setting changed (`applyCameraLookToAllPieces`), so
 * every piece ends up with it, in one undoable write.
 */
function CameraPieceLook({ tl, piece }: { tl: TimelineApi; piece: CameraPiece }) {
	const tt = useScopedT("timeline");
	const { settings } = useEditorSettings();
	const { set, setLive, commit } = useEditorSettings(LOOK_FOR_ALL_PIECES);
	const doc = useProjectStore((s) => s.document);
	const hasAnyCamera = useMemo(
		() => (doc ? hasAnyClipWithCamera(doc.assets, doc.timeline.clips) : false),
		[doc],
	);
	const ownLook = piece.overrides !== undefined;
	const initialScope = (): LookScope => pickedLookScope ?? (ownLook ? "piece" : "all");
	const [scope, setScopeState] = useState<LookScope>(initialScope);
	const setScope = (next: LookScope) => {
		pickedLookScope = next;
		setScopeState(next);
	};
	// Another piece selected: open on the scope picked last, else on its own. Keyed on the start,
	// which a piece keeps when its first write stores it (an implicit piece changes key, not place).
	// biome-ignore lint/correctness/useExhaustiveDependencies: the start is the trigger; the scope is read once per piece
	useEffect(() => {
		setScopeState(initialScope());
	}, [piece.startMs]);
	const isPip =
		resolveWebcamLayoutPreset(settings.webcamLayoutPreset, hasAnyCamera) === "picture-in-picture";
	// One live write per frame, as for the annotations (see `SelectionPane`).
	const liveRef = useRef(tl.updateCameraLookLive);
	liveRef.current = tl.updateCameraLookLive;
	const liveLook = useMemo(
		() =>
			rafCoalesce((key: string, patch: Partial<CameraLookValues>) => liveRef.current(key, patch)),
		[],
	);
	const values: CameraLookValues = mergeCameraLook(
		{
			webcamMirrored: settings.webcamMirrored,
			webcamMaskShape: settings.webcamMaskShape,
			webcamRoundness: settings.webcamRoundness,
			webcamSizePreset: settings.webcamSizePreset,
			webcamAnchor: settings.webcamAnchor,
		},
		scope === "piece" ? piece.overrides : undefined,
	);
	const disabled = !doc || !hasAnyCamera;
	return (
		<>
			{paneStack(
				tt("cameraPiece.look"),
				<ChoiceRow<LookScope>
					label={tt("cameraPiece.look")}
					columns={2}
					options={[
						{ value: "piece", label: tt("cameraPiece.lookScopePiece") },
						{ value: "all", label: tt("cameraPiece.lookScopeAll") },
					]}
					value={scope}
					disabled={disabled}
					onChange={setScope}
				/>,
			)}
			<p className={shell.hint}>
				{tt(scope === "piece" ? "cameraPiece.lookPieceHint" : "cameraPiece.lookAllHint")}
			</p>
			{scope === "piece" ? (
				<CameraLookControls
					values={values}
					isPip={isPip}
					disabled={disabled}
					onSet={(patch) => void tl.setCameraLook(piece.key, patch)}
					onSetLive={(patch) => liveLook(piece.key, patch)}
					onCommit={() => {
						liveLook.flush();
						void tl.commitCameraLook();
					}}
				/>
			) : (
				<CameraLookControls
					values={values}
					isPip={isPip}
					disabled={disabled}
					pushNativeParams
					onSet={(patch) => void set(patch)}
					onSetLive={setLive}
					onCommit={() => void commit()}
				/>
			)}
			{ownLook ? (
				<button
					type="button"
					onClick={() => void tl.clearCameraLook(piece.key)}
					className={PANE_BUTTON}
				>
					<RotateCcw size={16} />
					{tt("cameraPiece.lookRestore")}
				</button>
			) : null}
		</>
	);
}

function FacetBody({
	facet,
	onCollapse,
	transcriptProps,
}: {
	facet: Facet;
	onCollapse: () => void;
	transcriptProps: TranscriptProps;
}) {
	const te = useScopedT("editor");
	// A small collapse affordance floated over the reused pane header.
	const collapse = (
		<Tooltip content={te("inspector.collapseInspector")}>
			<button
				type="button"
				aria-label={te("inspector.collapseInspector")}
				onClick={onCollapse}
				style={{
					position: "absolute",
					top: 12,
					right: 12,
					width: 30,
					height: 30,
					display: "grid",
					placeItems: "center",
					borderRadius: 10,
					color: "var(--muted)",
					background: "var(--surface-1)",
					border: 0,
					cursor: "pointer",
					zIndex: 5,
				}}
			>
				<ChevronRight size={16} />
			</button>
		</Tooltip>
	);

	if (facet === "layout") return wrap(collapse, <LayoutPane />);
	if (facet === "audio") return wrap(collapse, <AudioPane />);
	if (facet === "cursor") return wrap(collapse, <CursorPane />);
	if (facet === "transcript") return wrap(collapse, <TranscriptPane {...transcriptProps} />);
	// `effects` is the fallthrough rather than a branch of its own: the union has no
	// tail left now that captions is a popover, and a `never` check here would only
	// restate what the type already says.
	return wrap(collapse, <VideoEffectsPane />);
}

function wrap(collapse: React.ReactNode, body: React.ReactNode) {
	return (
		<div style={{ position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
			{collapse}
			{body}
		</div>
	);
}

type AnnotationPatch = Partial<AxcutAnnotationRegion>;

/** "Destaque": how dark the frame gets around the lit rectangle, its soft edge, corners, border. */
function HighlightControls({
	region,
	onLive,
	onCommit,
}: {
	region: AxcutAnnotationRegion;
	onLive: (patch: AnnotationPatch) => void;
	onCommit: () => void;
}) {
	const ts = useScopedT("settings");
	const data = { ...HIGHLIGHT_DEFAULTS, ...region.highlightData };
	const set = (patch: Partial<typeof data>) => onLive({ highlightData: { ...data, ...patch } });
	return (
		<>
			<p className={shell.hint}>{ts("annotation.highlightHint")}</p>
			<SliderCell
				label={ts("annotation.highlightDim")}
				value={Math.round(data.dim * 100)}
				min={0}
				max={95}
				suffix="%"
				defaultValue={HIGHLIGHT_DEFAULTS.dim * 100}
				onChange={(next) => set({ dim: next / 100 })}
				onCommit={onCommit}
			/>
			<SliderCell
				label={ts("annotation.highlightFeather")}
				value={data.feather}
				min={0}
				max={80}
				suffix="px"
				defaultValue={HIGHLIGHT_DEFAULTS.feather}
				onChange={(feather) => set({ feather })}
				onCommit={onCommit}
			/>
			<SliderCell
				label={ts("annotation.highlightRadius")}
				value={data.radius}
				min={0}
				max={120}
				suffix="px"
				defaultValue={HIGHLIGHT_DEFAULTS.radius}
				onChange={(radius) => set({ radius })}
				onCommit={onCommit}
			/>
			<SliderCell
				label={ts("annotation.highlightBorder")}
				value={data.borderWidth}
				min={0}
				max={12}
				suffix="px"
				defaultValue={HIGHLIGHT_DEFAULTS.borderWidth}
				onChange={(borderWidth) => set({ borderWidth })}
				onCommit={onCommit}
			/>
			{data.borderWidth > 0
				? paneRow(
						ts("annotation.highlightBorderColor"),
						<ColorField
							label={ts("annotation.highlightBorderColor")}
							value={data.borderColor}
							onChange={(borderColor) => set({ borderColor })}
							onCommit={onCommit}
						/>,
					)
				: null}
		</>
	);
}

/** "Passo numerado": its number, colour, size (the badge's diameter) and optional label. */
function StepControls({
	region,
	frameAspect,
	onLive,
	onCommit,
}: {
	region: AxcutAnnotationRegion;
	frameAspect: number;
	onLive: (patch: AnnotationPatch) => void;
	onCommit: () => void;
}) {
	const ts = useScopedT("settings");
	const data = { ...STEP_DEFAULTS, ...region.stepData };
	const set = (patch: Partial<typeof data>) => onLive({ stepData: { ...data, ...patch } });
	const diameterPx = Math.round((region.size.height / 100) * ANNOTATION_REFERENCE_HEIGHT);
	const center = {
		x: region.position.x + region.size.width / 2,
		y: region.position.y + region.size.height / 2,
	};
	return (
		<>
			{paneRow(
				ts("annotation.stepNumber"),
				<input
					type="number"
					min={0}
					max={999}
					step={1}
					value={data.number}
					aria-label={ts("annotation.stepNumber")}
					onChange={(e) => {
						const next = Math.round(Number(e.target.value));
						if (Number.isFinite(next)) set({ number: Math.min(999, Math.max(0, next)) });
					}}
					onBlur={onCommit}
					className={shell.control}
					style={{ width: 72 }}
				/>,
			)}
			{paneRow(
				ts("annotation.stepColor"),
				<ColorField
					label={ts("annotation.stepColor")}
					value={data.color}
					onChange={(color) => set({ color })}
					onCommit={onCommit}
				/>,
			)}
			<SliderCell
				label={ts("annotation.stepSize")}
				value={diameterPx}
				min={24}
				max={200}
				suffix="px"
				defaultValue={STEP_DIAMETER_PX}
				onChange={(px) => onLive(stepBoxAround(center, px, frameAspect))}
				onCommit={onCommit}
			/>
			<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
				<span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>
					{ts("annotation.stepLabel")}
				</span>
				<input
					type="text"
					maxLength={80}
					value={data.label}
					placeholder={ts("annotation.stepLabelPlaceholder")}
					onChange={(e) => set({ label: e.target.value })}
					onBlur={onCommit}
					className={shell.control}
				/>
			</div>
		</>
	);
}
