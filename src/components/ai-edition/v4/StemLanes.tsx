// The two stem lanes under the clips: "Microfone" and "Áudio do sistema", for the takes recorded
// with their voice and computer sound apart. What a lane edit is, and why cutting the video still
// cuts both, is in `src/lib/ai-edition/document/stemLanes.ts`.
//
// A lane shows each clip's stem waveform (dimmed when the lane is muted) and the silenced
// stretches as hatched pills. Click the lane to edit it in the inspector (`StemLanePane`); drag a
// stretch to move it, its edges to resize it; Delete removes the selected one.

import { Mic, MicOff, Monitor, VolumeX } from "lucide-react";
import {
	memo,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { useScopedT } from "@/contexts/I18nContext";
import { useAudioPeaks } from "@/hooks/useAudioPeaks";
import {
	documentHasStemLanes,
	moveStemMute,
	type StemMutePill,
	stemMutePills,
} from "@/lib/ai-edition/document/stemLanes";
import type { AxcutDocument, AxcutStemKind } from "@/lib/ai-edition/schema";
import { audioGainScalar } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import styles from "./EditorShellV4.module.css";

/** Every stem-lane edit goes through here: one undo step each, named by the diff ("mute"). */
export async function writeStemEdit(next: AxcutDocument): Promise<boolean> {
	return useProjectStore.getState().saveDocument(next, { history: true });
}

/** A drag shorter than this is a click: it selects the stretch. */
const CLICK_SLOP_PX = 3;

const StemWave = memo(function StemWave({
	url,
	durationSec,
	sourceStartSec,
	sourceEndSec,
	gain,
}: {
	url: string;
	durationSec: number | undefined;
	sourceStartSec: number;
	sourceEndSec: number;
	gain: number;
}) {
	const peaks = useAudioPeaks(url, durationSec);
	const path = useMemo(() => {
		if (!peaks || peaks.length < 2 || !durationSec) return null;
		const blocks = Math.floor(peaks.length / 2);
		const perSec = blocks / durationSec;
		const from = Math.max(0, Math.floor(sourceStartSec * perSec));
		const to = Math.min(blocks, Math.ceil(sourceEndSec * perSec));
		const count = Math.min(400, Math.max(20, Math.round((sourceEndSec - sourceStartSec) * 8)));
		const range = Math.max(1, to - from);
		const levels: number[] = [];
		for (let i = 0; i < count; i++) {
			const a = from + Math.floor((i / count) * range);
			const b = Math.max(a + 1, from + Math.floor(((i + 1) / count) * range));
			let amp = 0;
			for (let k = a; k < b && k < blocks; k++) {
				amp = Math.max(amp, Math.abs(peaks[k * 2] ?? 0), Math.abs(peaks[k * 2 + 1] ?? 0));
			}
			levels.push(amp);
		}
		return levels;
	}, [peaks, durationSec, sourceStartSec, sourceEndSec]);
	if (!path) return null;
	const heights = path.map((h) => Math.max(6, Math.round(Math.min(1, h * gain) * 100)));
	const last = heights.length - 1;
	const top = heights.map((h, i) => `${i},${100 - h}`).join(" L");
	return (
		<svg
			aria-hidden
			className={styles.tlWave}
			viewBox={`0 0 ${last} 100`}
			preserveAspectRatio="none"
		>
			<path className={styles.tlWaveArea} d={`M0,100 L${top} L${last},100 Z`} />
		</svg>
	);
});

interface LaneDrag {
	id: string;
	mode: "move" | "l" | "r";
	startX: number;
	deltaSec: number;
}

export interface StemLanesProps {
	/** Ruler seconds → % of the zoomed canvas, and the canvas' scale. */
	pctOf: (sec: number) => number;
	pxPerSec: number;
	/** The visible window of the canvas, in %: where the lane names sit. */
	visibleStartPct: number;
}

export function StemLanes({ pctOf, pxPerSec, visibleStartPct }: StemLanesProps) {
	const document = useProjectStore((s) => s.document);
	if (!document || !documentHasStemLanes(document)) return null;
	return (
		<div data-testid="stem-lanes">
			{(["voice", "system"] as const).map((lane) => (
				<StemLane
					key={lane}
					lane={lane}
					document={document}
					pctOf={pctOf}
					pxPerSec={pxPerSec}
					visibleStartPct={visibleStartPct}
				/>
			))}
		</div>
	);
}

function StemLane({
	lane,
	document,
	pctOf,
	pxPerSec,
	visibleStartPct,
}: StemLanesProps & { lane: AxcutStemKind; document: AxcutDocument }) {
	const ts = useScopedT("settings");
	const { settings, set } = useEditorSettings();
	const selected = useProjectStore((s) => s.selectedStem);
	const setSelectedStem = useProjectStore((s) => s.setSelectedStem);
	const [drag, setDrag] = useState<LaneDrag | null>(null);
	const dragRef = useRef<LaneDrag | null>(null);
	const muted = lane === "voice" ? settings.voiceMuted : settings.systemMuted;
	const gainDb = lane === "voice" ? settings.voiceGainDb : settings.systemGainDb;
	const pills = useMemo(() => stemMutePills(document, lane), [document, lane]);
	const label = lane === "voice" ? ts("audio.lanes.voice") : ts("audio.lanes.system");
	const laneSelected = selected?.lane === lane;

	const select = useCallback(
		(muteId: string | null) => {
			// One thing selected at a time: the region and track selections give way.
			useProjectStore.getState().setSelectedAudioTrackId(null);
			setSelectedStem({ lane, muteId });
		},
		[lane, setSelectedStem],
	);

	const startDrag = (
		e: ReactPointerEvent<HTMLElement>,
		pill: StemMutePill,
		mode: LaneDrag["mode"],
	) => {
		e.stopPropagation();
		e.preventDefault();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const next = { id: pill.id, mode, startX: e.clientX, deltaSec: 0 };
		dragRef.current = next;
		setDrag(next);
	};
	const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
		const current = dragRef.current;
		if (!current || pxPerSec <= 0) return;
		const next = { ...current, deltaSec: (e.clientX - current.startX) / pxPerSec };
		dragRef.current = next;
		setDrag(next);
	};
	const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
		const current = dragRef.current;
		dragRef.current = null;
		setDrag(null);
		if (!current) return;
		e.stopPropagation();
		if (Math.abs(current.deltaSec * pxPerSec) < CLICK_SLOP_PX) {
			select(current.id);
			return;
		}
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		const mute = (doc.audioStemMutes ?? []).find((m) => m.id === current.id);
		const asset = mute ? doc.assets.find((a) => a.id === mute.assetId) : undefined;
		const d = current.deltaSec;
		const moved = moveStemMute(
			doc,
			current.id,
			current.mode === "r" ? 0 : d,
			current.mode === "l" ? 0 : d,
			asset?.durationSec ?? 0,
		);
		if (moved) {
			void writeStemEdit(moved.document).then((ok) => {
				if (ok) select(moved.id);
			});
		}
	};

	const withStems = document.timeline.clips.flatMap((clip) => {
		const asset = document.assets.find((a) => a.id === clip.assetId);
		const stems = asset?.audioStems;
		if (!asset || !stems) return [];
		const path = lane === "voice" ? stems.voicePath : stems.systemPath;
		const length = clip.timelineEndSec - clip.timelineStartSec;
		return [{ clip, asset, url: toFileUrl(path), length }];
	});

	return (
		<div
			className={`${styles.tlLane} ${styles.tlLaneStem}${laneSelected ? ` ${styles.tlLaneStemSel}` : ""}`}
			data-testid={`stem-lane-${lane}`}
			data-muted={muted || undefined}
			onClick={() => select(null)}
			onKeyDown={undefined}
		>
			{withStems.map(({ clip, asset, url, length }) => (
				<div
					key={clip.id}
					className={`${styles.stemSegment}${muted ? ` ${styles.stemSegmentMuted}` : ""}`}
					style={{ left: `${pctOf(clip.timelineStartSec)}%`, width: `${pctOf(length)}%` }}
				>
					<StemWave
						url={url}
						durationSec={asset.durationSec}
						sourceStartSec={clip.sourceStartSec}
						sourceEndSec={clip.sourceEndSec ?? clip.sourceStartSec + length}
						gain={muted ? 0 : audioGainScalar(gainDb)}
					/>
				</div>
			))}
			{pills.map((pill) => {
				const live = drag?.id === pill.id ? drag : null;
				const start = pill.startSec + (live && live.mode !== "r" ? live.deltaSec : 0);
				const end = pill.endSec + (live && live.mode !== "l" ? live.deltaSec : 0);
				const isSelected = laneSelected && selected?.muteId === pill.id;
				return (
					<div
						key={`${pill.id}:${pill.clipId}`}
						role="button"
						tabIndex={-1}
						data-testid={`stem-mute-${lane}`}
						className={`${styles.lanePill} ${styles.stemMutePill}${isSelected ? ` ${styles.lanePillSel}` : ""}`}
						style={{ left: `${pctOf(start)}%`, width: `${pctOf(Math.max(0, end - start))}%` }}
						title={ts("audio.lanes.muteLabel")}
						onPointerDown={(e) => startDrag(e, pill, "move")}
						onPointerMove={moveDrag}
						onPointerUp={endDrag}
						onPointerCancel={endDrag}
						onClick={(e) => e.stopPropagation()}
						onKeyDown={undefined}
					>
						<span
							className={styles.lanePillHandle}
							onPointerDown={(e) => startDrag(e, pill, "l")}
							onPointerMove={moveDrag}
							onPointerUp={endDrag}
						/>
						<VolumeX size={12} className={styles.stemMuteIcon} />
						<span
							className={styles.lanePillHandle}
							onPointerDown={(e) => startDrag(e, pill, "r")}
							onPointerMove={moveDrag}
							onPointerUp={endDrag}
						/>
					</div>
				);
			})}
			<span className={styles.stemLaneName} style={{ left: `${visibleStartPct}%` }}>
				<button
					type="button"
					className={styles.stemLaneMute}
					data-testid={`stem-lane-mute-${lane}`}
					aria-pressed={muted}
					title={muted ? ts("audio.lanes.unmute") : ts("audio.lanes.mute")}
					aria-label={muted ? ts("audio.lanes.unmute") : ts("audio.lanes.mute")}
					onPointerDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						void set(lane === "voice" ? { voiceMuted: !muted } : { systemMuted: !muted });
					}}
				>
					{lane === "voice" ? (
						muted ? (
							<MicOff size={12} />
						) : (
							<Mic size={12} />
						)
					) : muted ? (
						<VolumeX size={12} />
					) : (
						<Monitor size={12} />
					)}
				</button>
				{label}
			</span>
		</div>
	);
}
