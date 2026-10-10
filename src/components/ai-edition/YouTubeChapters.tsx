import { Copy } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { buildChapters, formatChaptersForYouTube } from "@/lib/ai-edition/chapters";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import styles from "./NewEditorShell.module.css";

/**
 * The chapter list for the video's YouTube description, shown once an export is
 * done: from the recording's markers (or long pauses), titled with the first
 * words spoken. Editable in place before copying; nothing leaves the machine.
 */
export function YouTubeChapters({ document }: { document: AxcutDocument }) {
	const t = useScopedT("editor");
	const text = useMemo(
		() =>
			formatChaptersForYouTube(
				buildChapters(document, {
					fallbackTitle: (index) => t("youtubeChapters.fallbackTitle", { index }),
				}),
			),
		[document, t],
	);
	if (!text) return null;
	const lineCount = text.split("\n").length;

	const copy = async (value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(t("youtubeChapters.copied"));
		} catch {
			toast.error(t("youtubeChapters.copyFailed"));
		}
	};

	return (
		<div
			data-testid="youtube-chapters"
			style={{ display: "flex", flexDirection: "column", gap: 8 }}
		>
			<div className={styles.groupLabel}>{t("youtubeChapters.title")}</div>
			<textarea
				data-testid="youtube-chapters-text"
				defaultValue={text}
				rows={Math.min(8, lineCount + 1)}
				spellCheck={false}
				style={{
					width: "100%",
					resize: "vertical",
					padding: "8px 10px",
					borderRadius: 9,
					border: "1px solid var(--border)",
					background: "var(--surface-2)",
					color: "var(--fg)",
					font: "500 12px var(--font-mono)",
				}}
				id="youtube-chapters-text"
			/>
			{lineCount < 3 ? (
				<span style={{ fontSize: 11.5, color: "var(--muted)" }}>
					{t("youtubeChapters.needThree")}
				</span>
			) : null}
			<button
				type="button"
				data-testid="youtube-chapters-copy"
				className={`${styles.btn} ${styles.btnSecondary}`}
				style={{ alignSelf: "flex-start" }}
				onClick={() => {
					const area = window.document.getElementById(
						"youtube-chapters-text",
					) as HTMLTextAreaElement | null;
					void copy(area?.value ?? text);
				}}
			>
				<Copy size={14} />
				{t("youtubeChapters.copy")}
			</button>
		</div>
	);
}
