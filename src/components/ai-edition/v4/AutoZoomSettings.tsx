// The project's auto-zoom settings, shown in the inspector of any automatic zoom: one place for
// all of them, since every automatic zoom moves by these (`zoom-motion.ts`). The camera and the
// transition apply at once, at render time; the maximum and the hold shape the PLAN, so they
// apply when the automatic zooms are planned again (the button below).

import { useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForLatestDocument,
	withoutAutoZooms,
} from "@/lib/ai-edition/timeline/apply-auto-zooms";
import {
	AUTO_ZOOM_BOUNDS,
	type AutoZoomCameraMode,
	DEFAULT_AUTO_ZOOM_SETTINGS,
} from "@/lib/ai-edition/timeline/zoom-motion";
import { nativeBridgeClient } from "@/native/client";
import shell from "../NewEditorShell.module.css";
import { ChoiceRow, SliderCell } from "../RightPanes";

const PANE_BUTTON = `${shell.btn} ${shell.btnSecondary}`;

/** Drops every automatic zoom and plans them again with the current settings. Zooms drawn by
 *  hand stay, and the new plan keeps clear of them. Returns how many were planned, or null when
 *  the project changed or could not be saved. */
async function replanAutoZooms(): Promise<number | null> {
	const { projectId } = useProjectStore.getState();
	const collected = await collectAutoZoomSuggestionsForLatestDocument(
		() => {
			const document = useProjectStore.getState().document;
			return document ? withoutAutoZooms(document) : null;
		},
		(videoPath) => nativeBridgeClient.cursor.getTelemetry(videoPath),
	);
	const store = useProjectStore.getState();
	if (!collected || store.projectId !== projectId) return null;
	const next = appendAutoZoomSuggestions(collected.document, collected.suggestions);
	return (await store.saveDocument(next, { history: true })) ? collected.suggestions.length : null;
}

export function AutoZoomSettings() {
	const te = useScopedT("editor");
	const { settings, set, setLive, commit } = useEditorSettings();
	const autoZoom = settings.autoZoom;
	const [busy, setBusy] = useState(false);
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
			<p className={shell.hint}>{te("autoZoom.replanHint")}</p>
			<button type="button" className={PANE_BUTTON} disabled={busy} onClick={() => void replan()}>
				{te("autoZoom.replan")}
			</button>
		</div>
	);
}
