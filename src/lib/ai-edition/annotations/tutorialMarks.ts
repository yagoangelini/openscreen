// Annotations de tutoriel : le « Destaque » (tout le cadre assombri autour d'un rectangle
// arrondi) et les « Passos numerados » (une pastille numérotée, avec un court libellé à côté).
//
// Aucune des deux n'a de rendu à elle. Le compositeur ne connaît qu'une forme générique
// (`kind: "shape"`, mode 21, `frame_geometry::shape_annotation_cb`) et le texte qu'il dessine déjà ;
// ce module traduit chaque annotation du document en ces entrées de la scène. Les trois backends
// et l'aperçu (qui EST le compositeur) dessinent donc les mêmes pixels, et l'export avec eux.
//
// Toutes les longueurs du document sont des px à 1080 (`ANNOTATION_REFERENCE_HEIGHT`), comme
// `style.fontSize` ; la scène les porte en fractions de la hauteur du cadre.

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { resolveTextFontFamily } from "@/lib/textFonts";
import type { SceneAnnotation } from "@/native/sceneDescription";
import { ANNOTATION_REFERENCE_HEIGHT, annotationFontSizeFraction } from "../annotationScale";
import { DEFAULT_TEXT_PLATE } from "./background";

type Region = AxcutAnnotationRegion;
export type HighlightData = NonNullable<Region["highlightData"]>;
export type StepData = NonNullable<Region["stepData"]>;

export const HIGHLIGHT_DEFAULTS: HighlightData = {
	dim: 0.6,
	feather: 12,
	radius: 16,
	borderColor: "#34B27B",
	borderWidth: 0,
};

export const STEP_DEFAULTS: StepData = { number: 1, color: "#2563EB", label: "" };

/** Diameter of a new step badge, px at 1080. */
export const STEP_DIAMETER_PX = 64;
/** A new mark enters this long before the playhead, so it is already in at the playhead's frame. */
export const TUTORIAL_LEAD_MS = 300;
/** And lasts at least this long (seconds). */
export const TUTORIAL_MIN_SEC = 3;
/** Box of a new highlight, % of the frame. */
export const HIGHLIGHT_BOX = { width: 40, height: 30 } as const;

/** The badge's border, a white ring: this share of its diameter. */
const STEP_RING = 0.06;
/** The number, this share of the diameter. */
const STEP_NUMBER_FONT = 0.5;
/** The label's text, this share of the diameter, and its gap from the badge. */
const STEP_LABEL_FONT = 0.42;
const STEP_LABEL_GAP = 0.22;
/** Deterministic text width estimate (the scene is also built in the main process, without a
 *  canvas to measure): a generous average advance, so the box never wraps the label. */
const LABEL_ADVANCE_EM = 0.62;
const LABEL_PAD_EM = 0.8;

/** Steps are numbered in creation order: the next one after the highest already there. */
export function nextStepNumber(annotations: ReadonlyArray<Pick<Region, "type" | "stepData">>) {
	let highest = 0;
	for (const annotation of annotations) {
		if (annotation.type === "step") highest = Math.max(highest, annotation.stepData?.number ?? 0);
	}
	return highest + 1;
}

/**
 * A square badge box (square in PIXELS) of `diameterPx` at 1080, centred on `center` (% of the
 * frame), kept inside the frame. `frameAspect` = width over height.
 */
export function stepBoxAround(
	center: { x: number; y: number },
	diameterPx: number,
	frameAspect: number,
): Pick<Region, "position" | "size"> {
	const aspect = frameAspect > 0 ? frameAspect : 16 / 9;
	const height = (diameterPx / ANNOTATION_REFERENCE_HEIGHT) * 100;
	const width = height / aspect;
	const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(0, max));
	return {
		position: {
			x: clamp(center.x - width / 2, 100 - width),
			y: clamp(center.y - height / 2, 100 - height),
		},
		size: { width, height },
	};
}

/** Dark digits on a light badge, white ones on a dark badge. */
export function stepNumberColor(fill: string): string {
	const hex = /^#([0-9a-f]{6})$/i.exec(fill.trim());
	if (!hex) return "#ffffff";
	const value = Number.parseInt(hex[1], 16);
	const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
	const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	return luminance > 0.6 ? "#111827" : "#ffffff";
}

/** The highlight's whole-frame dim, from its data: the shape the compositor fills around the box. */
export function highlightShape(
	data: HighlightData | undefined,
): NonNullable<SceneAnnotation["shape"]> {
	const d = { ...HIGHLIGHT_DEFAULTS, ...data };
	const rel = (px: number) => Math.max(0, px) / ANNOTATION_REFERENCE_HEIGHT;
	const dim = Math.min(0.95, Math.max(0, d.dim));
	return {
		fill: `rgba(0, 0, 0, ${dim})`,
		radiusRel: rel(d.radius),
		featherRel: rel(d.feather),
		...(d.borderWidth > 0 ? { borderColor: d.borderColor } : {}),
		borderRel: rel(d.borderWidth),
		invert: true,
		animation: "fade",
	};
}

type SceneBase = Omit<SceneAnnotation, "kind" | "text" | "shape" | "figure" | "blur" | "imagePath">;

/**
 * The scene entries of a tutorial annotation (`type` "highlight" or "step"), sharing `base` (its
 * id, span, clip and box). `frameAspect` places the step's label beside the badge. Ascending
 * paint order is the array order: the compositor's sort by `zIndex` is stable.
 */
export function tutorialSceneEntries(
	region: Pick<Region, "type" | "highlightData" | "stepData">,
	base: SceneBase,
	frameAspect: number,
): SceneAnnotation[] {
	if (region.type === "highlight") {
		return [
			{ ...base, kind: "shape", space: "frame", shape: highlightShape(region.highlightData) },
		];
	}
	if (region.type !== "step") return [];
	const step = { ...STEP_DEFAULTS, ...region.stepData };
	const diameterPx = base.h * ANNOTATION_REFERENCE_HEIGHT;
	if (!(diameterPx > 0)) return [];
	const text = (
		content: string,
		fontPx: number,
		color: string,
		backgroundColor: string,
		textAlign: "left" | "center" | "right",
		animation: string,
	): NonNullable<SceneAnnotation["text"]> => ({
		content,
		color,
		backgroundColor,
		fontSizeRel: annotationFontSizeFraction(fontPx),
		fontFamily: resolveTextFontFamily("Inter"),
		fontWeight: "bold",
		fontStyle: "normal",
		textDecoration: "none",
		textAlign,
		animation,
	});
	const entries: SceneAnnotation[] = [
		{
			...base,
			kind: "shape",
			space: "frame",
			shape: {
				fill: step.color,
				// Larger than any half side: the compositor clamps it, and the badge is a disc.
				radiusRel: base.h,
				featherRel: 0,
				borderColor: "#ffffff",
				borderRel: (STEP_RING * diameterPx) / ANNOTATION_REFERENCE_HEIGHT,
				invert: false,
				animation: "pop",
			},
		},
		{
			...base,
			id: `${base.id}:number`,
			kind: "text",
			space: "frame",
			text: text(
				String(step.number),
				diameterPx * STEP_NUMBER_FONT,
				stepNumberColor(step.color),
				"transparent",
				"center",
				"pop",
			),
		},
	];
	const label = step.label.trim();
	if (label) {
		const aspect = frameAspect > 0 ? frameAspect : 16 / 9;
		const fontPx = diameterPx * STEP_LABEL_FONT;
		const widthPx = ([...label].length * LABEL_ADVANCE_EM + LABEL_PAD_EM) * fontPx;
		const w = widthPx / (ANNOTATION_REFERENCE_HEIGHT * aspect);
		const gap = (STEP_LABEL_GAP * diameterPx) / (ANNOTATION_REFERENCE_HEIGHT * aspect);
		// Beside the badge on its right, or on its left when the right would leave the frame.
		const right = base.x + base.w + gap;
		const onLeft = right + w > 1 && base.x - gap - w >= 0;
		entries.push({
			...base,
			id: `${base.id}:label`,
			kind: "text",
			space: "frame",
			x: onLeft ? base.x - gap - w : right,
			w,
			text: text(label, fontPx, "#ffffff", DEFAULT_TEXT_PLATE, onLeft ? "right" : "left", "fade"),
		});
	}
	return entries;
}
