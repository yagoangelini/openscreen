// After a recording: should its automatic zooms follow what was said? If so, the take is
// transcribed first (on the dedicated GPU when there is one), with its progress and the time
// left on screen, then the zooms are planned from the cursor and the transcript, and only then
// is the editor handed over. The modal holds the keyboard meanwhile (`modalGuard`).

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useTranscriptionStore } from "@/lib/ai-edition/store/transcriptionStore";
import { findAssetTranscript } from "@/lib/ai-edition/transcription/status";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import { replanAutoZooms } from "./autoZoomReplan";
import { ModalShell } from "./Modals";
import shell from "./NewEditorShell.module.css";
import {
	handFreshRecordingAutoZoomsToTranscript,
	whenAssetDurationProbed,
} from "./recordingImport";

/** Seconds of compute per second of audio, before the engine has said how fast it goes. */
const ASSUMED_RTF = 0.15;

type Stage = "ask" | "transcribing" | "planning";

/** "45 s", "2 min 05 s". */
export function formatRemaining(sec: number): string {
	const total = Math.max(1, Math.round(sec));
	if (total < 60) return `${total} s`;
	const minutes = Math.floor(total / 60);
	return `${minutes} min ${String(total % 60).padStart(2, "0")} s`;
}

/**
 * Where the transcription stands, smoothed between the engine's reports: it reports once per
 * ~90 s chunk, so the bar would otherwise sit still for a long while on a long take.
 */
export function estimateTranscription(input: {
	totalSec: number;
	completedSec: number;
	rtf: number | undefined;
	/** Wall-clock seconds since transcribing began. */
	elapsedSec: number;
}): { fraction: number; remainingSec: number } {
	const rtf = input.rtf && input.rtf > 0 ? input.rtf : ASSUMED_RTF;
	const totalSec = Math.max(input.totalSec, 0.001);
	const doneSec = Math.min(totalSec * 0.98, Math.max(input.completedSec, input.elapsedSec / rtf));
	return { fraction: doneSec / totalSec, remainingSec: (totalSec - doneSec) * rtf };
}

export function TranscriptAutoZoomDialog({
	offer,
	onClose,
}: {
	offer: { assetId: string } | null;
	onClose: () => void;
}) {
	const te = useScopedT("editor");
	const [stage, setStage] = useState<Stage>("ask");
	const [remember, setRemember] = useState(false);
	const stopped = useRef(false);
	const startedAt = useRef<number | null>(null);
	const [, tick] = useState(0);
	const assetId = offer?.assetId ?? "";
	const job = useTranscriptionStore((s) => (assetId ? s.jobs[assetId] : undefined));
	const durationSec = useProjectStore(
		(s) => s.document?.assets.find((asset) => asset.id === assetId)?.durationSec ?? 0,
	);

	// The time left counts down between the engine's reports.
	useEffect(() => {
		if (stage !== "transcribing") return;
		const timer = window.setInterval(() => tick((n) => n + 1), 1000);
		return () => window.clearInterval(timer);
	}, [stage]);

	const finish = async (withTranscript: boolean) => {
		setStage("planning");
		await whenAssetDurationProbed(assetId);
		const count = await replanAutoZooms().catch(() => null);
		if (withTranscript && count !== null) {
			toast.success(te("autoZoom.afterRecording.done", { count }));
		}
		onClose();
	};

	const start = async () => {
		handFreshRecordingAutoZoomsToTranscript();
		stopped.current = false;
		setStage("transcribing");
		await useTranscriptionStore.getState().request(assetId, "auto");
		if (stopped.current) return;
		const transcribed = Boolean(findAssetTranscript(useProjectStore.getState().document, assetId));
		if (!transcribed) toast.warning(te("autoZoom.afterRecording.failed"));
		await finish(transcribed);
	};

	// A remembered "with the transcript" skips the question.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per offer.
	useEffect(() => {
		if (!offer) return;
		setStage("ask");
		startedAt.current = null;
		if (loadUserPreferences().autoZoomAfterRecording === "transcript") void start();
	}, [offer]);

	if (!offer) return null;

	const answer = (withTranscript: boolean) => {
		if (remember) {
			saveUserPreferences({ autoZoomAfterRecording: withTranscript ? "transcript" : "cursor" });
		}
		if (withTranscript) void start();
		else onClose();
	};

	const cancel = () => {
		stopped.current = true;
		void window.electronAPI?.stt?.cancel?.();
		void finish(false);
	};

	const phase = job?.phase;
	if (stage === "transcribing" && phase === "transcribing" && startedAt.current === null) {
		startedAt.current = Date.now();
	}
	const totalSec = job?.progress?.totalSec ?? durationSec;
	const estimate =
		phase === "transcribing" && startedAt.current !== null
			? estimateTranscription({
					totalSec,
					completedSec: job?.progress?.completedSec ?? 0,
					rtf: job?.rtf,
					elapsedSec: (Date.now() - startedAt.current) / 1000,
				})
			: null;
	const downloading =
		phase === "loading-model" && job?.totalBytes
			? (job.downloadedBytes ?? 0) / job.totalBytes
			: null;
	const fraction = estimate?.fraction ?? downloading ?? 0;
	const onGpu = job?.backend ? !/cpu/i.test(job.backend) : null;

	const status =
		stage === "planning"
			? te("autoZoom.afterRecording.planning")
			: phase === "transcribing"
				? te("autoZoom.afterRecording.transcribing")
				: phase === "loading-model"
					? te("autoZoom.afterRecording.loadingModel")
					: te("autoZoom.afterRecording.preparing");

	return (
		<ModalShell
			open
			title={te("autoZoom.afterRecording.title")}
			onClose={stage === "ask" ? () => answer(false) : cancel}
			closeOnEscape={stage === "ask"}
			closeOnBackdrop={false}
			footer={
				stage === "ask" ? (
					<div style={{ display: "flex", gap: 8, justifyContent: "flex-end", width: "100%" }}>
						<button
							type="button"
							className={`${shell.btn} ${shell.btnSecondary}`}
							data-testid="transcript-autozoom-no"
							onClick={() => answer(false)}
						>
							{te("autoZoom.afterRecording.cursorOnly")}
						</button>
						<button
							type="button"
							className={`${shell.btn} ${shell.btnPrimary}`}
							data-testid="transcript-autozoom-yes"
							onClick={() => answer(true)}
						>
							{te("autoZoom.afterRecording.withTranscript")}
						</button>
					</div>
				) : stage === "transcribing" ? (
					<div style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
						<button
							type="button"
							className={`${shell.btn} ${shell.btnSecondary}`}
							data-testid="transcript-autozoom-cancel"
							onClick={cancel}
						>
							{te("autoZoom.afterRecording.cancel")}
						</button>
					</div>
				) : undefined
			}
		>
			{stage === "ask" ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
					<p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--fg-2)" }}>
						{te("autoZoom.afterRecording.question")}
					</p>
					<label
						style={{
							display: "flex",
							gap: 8,
							alignItems: "center",
							font: "400 12px var(--font-body)",
						}}
					>
						<input
							type="checkbox"
							checked={remember}
							onChange={(event) => setRemember(event.target.checked)}
						/>
						{te("autoZoom.afterRecording.remember")}
					</label>
				</div>
			) : (
				<div
					data-testid="transcript-autozoom-progress"
					style={{ display: "flex", flexDirection: "column", gap: 8 }}
				>
					<div style={{ display: "flex", justifyContent: "space-between" }}>
						<span style={{ font: "500 13px var(--font-body)", color: "var(--fg-2)" }}>
							{status}
						</span>
						{stage === "transcribing" && fraction > 0 ? (
							<span
								style={{ font: "600 13px var(--font-body)", fontVariantNumeric: "tabular-nums" }}
							>
								{Math.round(fraction * 100)}%
							</span>
						) : null}
					</div>
					<div
						style={{
							position: "relative",
							height: 8,
							background: "var(--surface-3)",
							borderRadius: 999,
							overflow: "hidden",
						}}
					>
						<div
							style={{
								position: "absolute",
								inset: 0,
								width: `${stage === "planning" ? 100 : Math.max(2, Math.min(100, fraction * 100))}%`,
								background: "var(--brand)",
								transition: "width 400ms var(--ease)",
							}}
						/>
					</div>
					<span style={{ font: "400 12px/1.4 var(--font-body)", color: "var(--muted)" }}>
						{stage === "planning"
							? te("autoZoom.afterRecording.planningHint")
							: estimate
								? te("autoZoom.afterRecording.remaining", {
										time: formatRemaining(estimate.remainingSec),
									})
								: te("autoZoom.afterRecording.estimating")}
						{onGpu === null
							? ""
							: ` · ${te(onGpu ? "autoZoom.afterRecording.onGpu" : "autoZoom.afterRecording.onCpu")}`}
					</span>
				</div>
			)}
		</ModalShell>
	);
}
