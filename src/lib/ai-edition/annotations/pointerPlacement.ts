// Où était le pointeur enregistré sous la tête de lecture, en % du cadre de sortie : là où un
// passo numerado ou un destaque ajouté au clavier se pose. Sans piste, hors du recadrage ou sans
// clip sous la tête de lecture : `null`, et l'appelant retombe sur le centre du cadre.
//
// Le zoom n'entre pas dans le calcul, exprès : une annotation du cadre ne suit pas le zoom
// (`SceneAnnotation`), elle se pose donc sur le métrage au repos, comme son cadre de sélection.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { annotationFootage, type SceneRect } from "@/native/sceneDescription";
import { resolveTimelineSpanToTrim } from "../timeline/trim-mapping";

type Crop = { x: number; y: number; width: number; height: number } | null;

/** A pointer sample (fractions of the recording) placed in the frame, % of it. */
export function pointerToFramePct(
	point: { cx: number; cy: number },
	footage: { rect: SceneRect; crop: Crop },
): { x: number; y: number } | null {
	const crop = footage.crop ?? { x: 0, y: 0, width: 1, height: 1 };
	if (!(crop.width > 0 && crop.height > 0)) return null;
	const u = (point.cx - crop.x) / crop.width;
	const v = (point.cy - crop.y) / crop.height;
	if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
	return {
		x: (footage.rect.x + u * footage.rect.width) * 100,
		y: (footage.rect.y + v * footage.rect.height) * 100,
	};
}

/** The sample in effect at `timeMs`: the last one at or before it. */
export function sampleAt(
	samples: ReadonlyArray<CursorTelemetryPoint>,
	timeMs: number,
): CursorTelemetryPoint | null {
	let found: CursorTelemetryPoint | null = null;
	for (const sample of samples) {
		if (sample.timeMs > timeMs) break;
		found = sample;
	}
	return found ?? samples[0] ?? null;
}

/**
 * The recorded pointer at `playheadSec` (timeline seconds), in % of the frame. `getTelemetry`
 * reads a recording's `.cursor.json` (`nativeBridgeClient.cursor.getTelemetry`).
 */
export async function recordedPointerInFrame(
	document: AxcutDocument,
	playheadSec: number,
	getTelemetry: (path: string) => Promise<CursorTelemetryPoint[]>,
): Promise<{ x: number; y: number } | null> {
	const span = resolveTimelineSpanToTrim(playheadSec, playheadSec + 0.001, document.timeline.clips);
	if (!span) return null;
	const asset = document.assets.find((candidate) => candidate.id === span.assetId);
	const path = (asset as { originalPath?: string } | undefined)?.originalPath;
	if (!path) return null;
	let samples: CursorTelemetryPoint[];
	try {
		samples = await getTelemetry(path);
	} catch {
		return null;
	}
	const sample = sampleAt(samples, span.sourceStartSec * 1000);
	if (!sample || sample.visible === false) return null;
	// A probe annotation at the playhead: the footage rect is the one of the clip it falls on.
	const probeId = "pointer-probe";
	const startMs = Math.round(playheadSec * 1000);
	const probe = {
		id: probeId,
		startMs,
		endMs: startMs + 1,
		type: "text" as const,
		content: "",
		position: { x: 0, y: 0 },
		size: { width: 1, height: 1 },
		style: {
			color: "#ffffff",
			backgroundColor: "transparent",
			fontSize: 32,
			fontFamily: "Inter",
			fontWeight: "bold" as const,
			fontStyle: "normal" as const,
			textDecoration: "none" as const,
			textAlign: "center" as const,
		},
		zIndex: 0,
	};
	const footage = annotationFootage(
		{ ...document, annotations: [...(document.annotations ?? []), probe] },
		probeId,
	);
	return footage ? pointerToFramePct(sample, footage) : null;
}
