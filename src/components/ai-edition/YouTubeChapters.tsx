import { Captions, Copy, Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { documentToSrt } from "@/lib/ai-edition/captions/srt";
import {
	buildChapters,
	chapterTranscripts,
	formatChaptersForYouTube,
} from "@/lib/ai-edition/chapters";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { nativeBridgeClient } from "@/native/client";
import styles from "./NewEditorShell.module.css";

/**
 * "Save subtitles (.srt)" for the video just exported: the captions, timed to it, in a
 * file beside it to upload to YouTube with the video. Offered only when the take was
 * transcribed and the export is an MP4.
 */
export function SubtitlesFileButton({
	document,
	videoPath,
}: {
	document: AxcutDocument;
	videoPath: string;
}) {
	const t = useScopedT("editor");
	const srt = useMemo(() => documentToSrt(document), [document]);
	const [saving, setSaving] = useState(false);
	if (!srt || !/\.mp4$/i.test(videoPath) || !window.electronAPI?.writeSubtitlesBeside) return null;
	return (
		<button
			type="button"
			data-testid="export-save-srt"
			className={`${styles.btn} ${styles.btnSecondary}`}
			style={{ alignSelf: "flex-start" }}
			disabled={saving}
			onClick={() => {
				setSaving(true);
				void window.electronAPI
					?.writeSubtitlesBeside?.(videoPath, srt)
					.then((result) => {
						if (result?.success)
							toast.success(t("subtitlesFile.saved", { path: result.path ?? "" }));
						else toast.error(t("subtitlesFile.failed"), { description: result?.error });
					})
					.finally(() => setSaving(false));
			}}
		>
			<Captions size={14} />
			{t("subtitlesFile.save")}
		</button>
	);
}

/**
 * The chapter list for the video's YouTube description, shown once an export is
 * done: from the recording's markers (or long pauses), titled with the first
 * words spoken. Editable in place before copying; nothing leaves the machine
 * unless the user asks the configured AI provider to rewrite the titles.
 */
export function YouTubeChapters({ document }: { document: AxcutDocument }) {
	const t = useScopedT("editor");
	const chapters = useMemo(
		() =>
			buildChapters(document, {
				fallbackTitle: (index) => t("youtubeChapters.fallbackTitle", { index }),
			}),
		[document, t],
	);
	const built = useMemo(() => formatChaptersForYouTube(chapters), [chapters]);
	const [text, setText] = useState(built);
	const [improving, setImproving] = useState(false);
	useEffect(() => setText(built), [built]);
	if (!built) return null;
	const lineCount = text.split("\n").length;

	const copy = async (value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(t("youtubeChapters.copied"));
		} catch {
			toast.error(t("youtubeChapters.copyFailed"));
		}
	};

	const improve = async () => {
		setImproving(true);
		try {
			const transcripts = chapterTranscripts(document, chapters);
			const result = await nativeBridgeClient.aiEdition.improveChapterTitles({
				chapters: chapters.map((chapter, index) => ({
					id: String(index),
					draft: chapter.title,
					transcript: transcripts[index] ?? "",
				})),
				language: document.transcripts[0]?.language,
			});
			if (!result.success) {
				toast.error(t("youtubeChapters.aiFailed"), { description: result.error });
				return;
			}
			setText(
				formatChaptersForYouTube(
					chapters.map((chapter, index) => ({
						...chapter,
						title: result.titles[String(index)] ?? chapter.title,
					})),
				),
			);
		} catch (error) {
			toast.error(t("youtubeChapters.aiFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setImproving(false);
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
				value={text}
				onChange={(event) => setText(event.target.value)}
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
			/>
			{lineCount < 3 ? (
				<span style={{ fontSize: 11.5, color: "var(--muted)" }}>
					{t("youtubeChapters.needThree")}
				</span>
			) : null}
			<div style={{ display: "flex", gap: 8 }}>
				<button
					type="button"
					data-testid="youtube-chapters-copy"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={() => void copy(text)}
				>
					<Copy size={14} />
					{t("youtubeChapters.copy")}
				</button>
				<button
					type="button"
					data-testid="youtube-chapters-ai"
					className={`${styles.btn} ${styles.btnSecondary}`}
					disabled={improving}
					title={t("youtubeChapters.aiHint")}
					onClick={() => void improve()}
				>
					{improving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
					{t("youtubeChapters.improveWithAi")}
				</button>
			</div>
		</div>
	);
}
