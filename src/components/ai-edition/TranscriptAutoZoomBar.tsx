// Under the transcript: once it differs from the one the automatic zooms were planned with
// (transcribed after the take, or a word corrected since), an offer to plan them again so they
// follow what is said. Gone again once they do.

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { autoZoomsBehindTranscript } from "@/lib/ai-edition/timeline/apply-auto-zooms";
import { replanAutoZooms } from "./autoZoomReplan";
import shell from "./NewEditorShell.module.css";

export function TranscriptAutoZoomBar() {
	const te = useScopedT("editor");
	const document = useProjectStore((s) => s.document);
	const behind = useMemo(
		() => (document ? autoZoomsBehindTranscript(document) : false),
		[document],
	);
	const [busy, setBusy] = useState(false);
	if (!behind) return null;

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
		<div
			data-testid="transcript-autozoom-bar"
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				margin: "0 4px 8px",
				padding: "8px 10px",
				borderRadius: 10,
				background: "color-mix(in oklab, var(--brand) 10%, transparent)",
			}}
		>
			<span style={{ flex: 1, font: "400 12px/1.4 var(--font-body)", color: "var(--fg-2)" }}>
				{te("autoZoom.transcriptBehind")}
			</span>
			<button
				type="button"
				className={`${shell.btn} ${shell.btnSecondary}`}
				disabled={busy}
				onClick={() => void replan()}
			>
				{te("autoZoom.replanWithTranscript")}
			</button>
		</div>
	);
}
