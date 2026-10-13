// The project's auto-zoom settings, shown in the inspector of any automatic zoom: one place for
// all of them, since every automatic zoom moves by these (`zoom-motion.ts`). The camera and the
// transition apply at once, at render time; the maximum and the hold shape the PLAN, so they
// apply when the automatic zooms are planned again (the button below).

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { useEditorDocument, useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import {
	autoZoomsBehindTranscript,
	transcriptSignature,
} from "@/lib/ai-edition/timeline/apply-auto-zooms";
import {
	AUTO_ZOOM_BOUNDS,
	type AutoZoomCameraMode,
	DEFAULT_AUTO_ZOOM_SETTINGS,
} from "@/lib/ai-edition/timeline/zoom-motion";
import {
	type AutoZoomAfterRecording,
	loadUserPreferences,
	saveUserPreferences,
} from "@/lib/userPreferences";
import { replanAutoZooms } from "../autoZoomReplan";
import shell from "../NewEditorShell.module.css";
import { ChoiceRow, SliderCell } from "../RightPanes";

const PANE_BUTTON = `${shell.btn} ${shell.btnSecondary}`;

export function AutoZoomSettings() {
	const te = useScopedT("editor");
	const { settings, set, setLive, commit, editingDefaults } = useEditorSettings();
	const autoZoom = settings.autoZoom;
	const [busy, setBusy] = useState(false);
	const document = useEditorDocument();
	const transcript = useMemo(
		() =>
			document
				? { has: transcriptSignature(document) !== "", behind: autoZoomsBehindTranscript(document) }
				: { has: false, behind: false },
		[document],
	);
	const [afterRecording, setAfterRecording] = useState<AutoZoomAfterRecording>(
		() => loadUserPreferences().autoZoomAfterRecording,
	);
	const live = (patch: Partial<typeof autoZoom>) => setLive({ autoZoom: patch });
	const done = () => void commit();

	const replan = async () => {
		setBusy(true);
		try {
			const count = await replanAutoZooms();
			if (count === null) return;
			if (count === 0) toast.info(te("autoZoom.replanNone"));
			else toast.success(te("autoZoom.replanDone", { count }));
		} catch (error) {
			toast.error(te("autoZoom.replanFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
			<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
				<span className={shell.hint} style={{ fontWeight: 600 }}>
					{te("autoZoom.title")}
				</span>
				<span className={shell.hint}>{te("autoZoom.scope")}</span>
			</div>
			<ChoiceRow<AutoZoomCameraMode>
				label={te("autoZoom.camera.title")}
				options={[
					{ value: "fixed", label: te("autoZoom.camera.fixed") },
					{ value: "hybrid", label: te("autoZoom.camera.hybrid") },
					{ value: "follow", label: te("autoZoom.camera.follow") },
				]}
				value={autoZoom.cameraMode}
				onChange={(cameraMode) => void set({ autoZoom: { cameraMode } })}
			/>
			<p className={shell.hint}>{te(`autoZoom.camera.${autoZoom.cameraMode}Hint`)}</p>
			<SliderCell
				label={te("autoZoom.transition")}
				value={autoZoom.transitionSec}
				min={AUTO_ZOOM_BOUNDS.transitionSec.min}
				max={AUTO_ZOOM_BOUNDS.transitionSec.max}
				step={AUTO_ZOOM_BOUNDS.transitionSec.step}
				decimals={1}
				suffix=" s"
				defaultValue={DEFAULT_AUTO_ZOOM_SETTINGS.transitionSec}
				onChange={(transitionSec) => live({ transitionSec })}
				onCommit={done}
			/>
			<SliderCell
				label={te("autoZoom.maxScale")}
				value={autoZoom.maxScale}
				min={AUTO_ZOOM_BOUNDS.maxScale.min}
				max={AUTO_ZOOM_BOUNDS.maxScale.max}
				step={AUTO_ZOOM_BOUNDS.maxScale.step}
				decimals={2}
				suffix="×"
				defaultValue={DEFAULT_AUTO_ZOOM_SETTINGS.maxScale}
				onChange={(maxScale) => live({ maxScale })}
				onCommit={done}
			/>
			<SliderCell
				label={te("autoZoom.hold")}
				value={autoZoom.holdSec}
				min={AUTO_ZOOM_BOUNDS.holdSec.min}
				max={AUTO_ZOOM_BOUNDS.holdSec.max}
				step={AUTO_ZOOM_BOUNDS.holdSec.step}
				decimals={2}
				suffix=" s"
				defaultValue={DEFAULT_AUTO_ZOOM_SETTINGS.holdSec}
				onChange={(holdSec) => live({ holdSec })}
				onCommit={done}
			/>
			<ChoiceRow<"2.5" | "1.5">
				label={te("autoZoom.wideBetween")}
				options={[
					{ value: "2.5", label: te("autoZoom.wideCalm") },
					{ value: "1.5", label: te("autoZoom.wideBrisk") },
				]}
				value={autoZoom.minWideSec === 1.5 ? "1.5" : "2.5"}
				onChange={(choice) => void set({ autoZoom: { minWideSec: Number(choice) } })}
			/>
			<ChoiceRow<AutoZoomAfterRecording>
				label={te("autoZoom.afterRecording.label")}
				options={[
					{ value: "ask", label: te("autoZoom.afterRecording.ask") },
					{ value: "transcript", label: te("autoZoom.afterRecording.transcript") },
					{ value: "cursor", label: te("autoZoom.afterRecording.cursor") },
				]}
				value={afterRecording}
				onChange={(choice) => {
					saveUserPreferences({ autoZoomAfterRecording: choice });
					setAfterRecording(choice);
				}}
			/>
			{/* Planning again acts on a project's zooms; the defaults have none. */}
			{editingDefaults ? null : (
				<>
					<p className={shell.hint}>
						{te(
							transcript.behind
								? "autoZoom.transcriptBehind"
								: transcript.has
									? "autoZoom.followsTranscript"
									: "autoZoom.replanHint",
						)}
					</p>
					<button
						type="button"
						className={PANE_BUTTON}
						disabled={busy}
						onClick={() => void replan()}
					>
						{te(transcript.has ? "autoZoom.replanWithTranscript" : "autoZoom.replan")}
					</button>
				</>
			)}
		</div>
	);
}
