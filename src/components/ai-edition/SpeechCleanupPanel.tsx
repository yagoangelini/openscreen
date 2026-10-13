// "Limpar fala": the review list of what `planSpeechCleanup` would cut -- hesitations, the
// fillers it judged isolated or repeated, and long silences shortened -- each one ticked by
// default and untickable, with its settings (the word lists, the rules) a fold away. Nothing
// is cut until "Cut" is pressed, and then everything picked goes in one undoable edit.

import { useMemo, useState } from "react";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { formatMs } from "@/lib/ai-edition/timeline/format";
import {
	DEFAULT_CONTEXTUAL_FILLERS,
	DEFAULT_SILENCE_KEEP_SEC,
	DEFAULT_SILENCE_MIN_SEC,
	DEFAULT_SPEECH_FILLERS,
	formatFillerList,
	planSpeechCleanup,
	type SpeechCleanupItem,
	type SpeechCleanupOptions,
	speechCleanupSavedSec,
} from "@/lib/ai-edition/timeline/speechCleanup";
import {
	loadUserPreferences,
	SPEECH_SILENCE_KEEP_RANGE,
	SPEECH_SILENCE_MIN_RANGE,
	saveUserPreferences,
	speechCleanupOptions,
	type UserPreferences,
} from "@/lib/userPreferences";
import styles from "./NewEditorShell.module.css";

export type CleanupPrefs = Pick<
	UserPreferences,
	| "speechFillers"
	| "speechContextualFillers"
	| "speechCleanupAggressive"
	| "speechSilenceMinSec"
	| "speechSilenceKeepSec"
>;

export const DEFAULT_CLEANUP_PREFS: CleanupPrefs = {
	speechFillers: formatFillerList(DEFAULT_SPEECH_FILLERS),
	speechContextualFillers: formatFillerList(DEFAULT_CONTEXTUAL_FILLERS),
	speechCleanupAggressive: false,
	speechSilenceMinSec: DEFAULT_SILENCE_MIN_SEC,
	speechSilenceKeepSec: DEFAULT_SILENCE_KEEP_SEC,
};

export function readCleanupPrefs(): CleanupPrefs {
	const p = loadUserPreferences();
	return {
		speechFillers: p.speechFillers,
		speechContextualFillers: p.speechContextualFillers,
		speechCleanupAggressive: p.speechCleanupAggressive,
		speechSilenceMinSec: p.speechSilenceMinSec,
		speechSilenceKeepSec: p.speechSilenceKeepSec,
	};
}

const fieldStyle = {
	width: "100%",
	resize: "vertical",
	padding: "6px 8px",
	borderRadius: 8,
	border: "1px solid var(--border)",
	background: "var(--surface-2)",
	color: "var(--fg)",
	font: "500 12px var(--font-mono)",
} as const;

/**
 * "Palavras e regras": the lists and thresholds "Limpar fala" plans with. The panel shows them
 * under its own fold; the global defaults dialog ("Padrões") shows the same controls.
 */
export function SpeechCleanupRules({
	prefs,
	onChange,
}: {
	prefs: CleanupPrefs;
	onChange: (patch: Partial<CleanupPrefs>) => void;
}) {
	const ts = useScopedT("settings");
	const update = onChange;
	const numberField = (
		key: "speechSilenceMinSec" | "speechSilenceKeepSec",
		range: { min: number; max: number },
		label: string,
	) => (
		<label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
			<span style={{ flex: 1 }}>{label}</span>
			<input
				type="number"
				data-testid={`speech-cleanup-${key}`}
				min={range.min}
				max={range.max}
				step={0.1}
				value={prefs[key]}
				onChange={(event) => {
					const value = Number(event.target.value);
					if (Number.isFinite(value) && value >= range.min && value <= range.max) {
						update({ [key]: value });
					}
				}}
				style={{ ...fieldStyle, width: 72, resize: undefined }}
			/>
		</label>
	);

	return (
		<>
			<label style={{ display: "block", marginTop: 6 }}>
				{ts("transcript.cleanup.fillers")}
				<textarea
					data-testid="speech-cleanup-fillers"
					value={prefs.speechFillers}
					rows={3}
					spellCheck={false}
					onChange={(event) => update({ speechFillers: event.target.value })}
					style={fieldStyle}
				/>
			</label>
			<label style={{ display: "block", marginTop: 6 }}>
				{ts("transcript.cleanup.contextual")}
				<textarea
					data-testid="speech-cleanup-contextual"
					value={prefs.speechContextualFillers}
					rows={3}
					spellCheck={false}
					onChange={(event) => update({ speechContextualFillers: event.target.value })}
					style={fieldStyle}
				/>
			</label>
			<span style={{ display: "block", color: "var(--muted)" }}>
				{ts("transcript.cleanup.contextualHint")}
			</span>
			<label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
				<input
					type="checkbox"
					data-testid="speech-cleanup-aggressive"
					checked={prefs.speechCleanupAggressive}
					onChange={(event) => update({ speechCleanupAggressive: event.target.checked })}
				/>
				{ts("transcript.cleanup.aggressive")}
			</label>
			{numberField(
				"speechSilenceMinSec",
				SPEECH_SILENCE_MIN_RANGE,
				ts("transcript.cleanup.silenceMin"),
			)}
			{numberField(
				"speechSilenceKeepSec",
				SPEECH_SILENCE_KEEP_RANGE,
				ts("transcript.cleanup.silenceKeep"),
			)}
			<button
				type="button"
				className={styles.btn}
				style={{ marginTop: 8 }}
				onClick={() => update(DEFAULT_CLEANUP_PREFS)}
			>
				{ts("transcript.cleanup.restoreDefaults")}
			</button>
		</>
	);
}

export function SpeechCleanupPanel({
	onApply,
	onSeek,
	onClose,
}: {
	/** The ids picked and the options they were planned with; the shell plans again inside
	 *  its write chain and cuts only those. */
	onApply: (itemIds: string[], options: SpeechCleanupOptions) => void;
	onSeek: (rawSec: number) => void;
	onClose: () => void;
}) {
	const ts = useScopedT("settings");
	const { locale } = useI18n();
	const document = useProjectStore((s) => s.document);
	const [prefs, setPrefs] = useState<CleanupPrefs>(readCleanupPrefs);
	const options = useMemo(() => speechCleanupOptions(prefs), [prefs]);
	const items = useMemo(
		() => (document ? planSpeechCleanup(document, options) : []),
		[document, options],
	);
	// Unticked, not ticked: a fresh plan (new settings, an edit) starts with everything picked.
	const [unpicked, setUnpicked] = useState<ReadonlySet<string>>(() => new Set());
	const picked = items.filter((item) => !unpicked.has(item.id));
	const savedSec = speechCleanupSavedSec(picked);
	const seconds = (sec: number) =>
		sec.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

	const update = (patch: Partial<CleanupPrefs>) => {
		const next = { ...prefs, ...patch };
		setPrefs(next);
		saveUserPreferences(patch);
	};
	const reasonLabel = (item: SpeechCleanupItem) => ts(`transcript.cleanup.reason.${item.reason}`);

	return (
		<div data-testid="speech-cleanup" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			<p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--muted)" }}>
				{ts("transcript.cleanup.intro")}
			</p>
			<details style={{ font: "400 12px/1.5 var(--font-body)", color: "var(--fg-2)" }}>
				<summary style={{ cursor: "pointer" }}>{ts("transcript.cleanup.settings")}</summary>
				<SpeechCleanupRules prefs={prefs} onChange={update} />
			</details>

			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					font: "600 12.5px var(--font-body)",
				}}
			>
				<span data-testid="speech-cleanup-summary" style={{ flex: 1 }}>
					{items.length === 0
						? ts("transcript.cleanup.nothing")
						: ts("transcript.cleanup.summary", {
								count: picked.length,
								total: items.length,
								seconds: seconds(savedSec),
							})}
				</span>
				{items.length > 0 ? (
					<>
						<button
							type="button"
							className={styles.paneHeadBtn}
							onClick={() => setUnpicked(new Set())}
						>
							{ts("transcript.cleanup.all")}
						</button>
						<button
							type="button"
							className={styles.paneHeadBtn}
							onClick={() => setUnpicked(new Set(items.map((item) => item.id)))}
						>
							{ts("transcript.cleanup.none")}
						</button>
					</>
				) : null}
			</div>

			<ul
				style={{
					listStyle: "none",
					margin: 0,
					padding: 0,
					display: "flex",
					flexDirection: "column",
					gap: 2,
				}}
			>
				{items.map((item) => {
					const on = !unpicked.has(item.id);
					const cut = item.endSec - item.startSec;
					return (
						<li
							key={item.id}
							data-testid="speech-cleanup-item"
							data-kind={item.kind}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 8,
								padding: "3px 4px",
								borderRadius: 6,
								font: "400 12.5px/1.4 var(--font-body)",
								color: on ? "var(--fg)" : "var(--muted)",
							}}
						>
							<input
								type="checkbox"
								checked={on}
								aria-label={
									item.kind === "silence"
										? ts("transcript.cleanup.silenceItem", {
												from: seconds(cut + item.keptSec),
												to: seconds(item.keptSec),
											})
										: item.text
								}
								onChange={(event) => {
									const next = new Set(unpicked);
									if (event.target.checked) next.delete(item.id);
									else next.add(item.id);
									setUnpicked(next);
								}}
							/>
							<button
								type="button"
								onClick={() => onSeek(item.rawStartSec)}
								title={ts("transcript.cleanup.seek")}
								style={{
									font: "500 11.5px var(--font-mono)",
									color: "var(--accent)",
									background: "none",
									border: "none",
									padding: 0,
									cursor: "pointer",
									fontVariantNumeric: "tabular-nums",
								}}
							>
								{formatMs(item.rawStartSec * 1000)}
							</button>
							<span style={{ flex: 1, minWidth: 0 }}>
								{item.kind === "silence"
									? ts("transcript.cleanup.silenceItem", {
											from: seconds(cut + item.keptSec),
											to: seconds(item.keptSec),
										})
									: `“${item.text}”`}
							</span>
							<span style={{ color: "var(--muted)", font: "400 11.5px var(--font-body)" }}>
								{item.kind === "silence" ? `−${seconds(cut)} s` : reasonLabel(item)}
							</span>
						</li>
					);
				})}
			</ul>

			<div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
				<button type="button" className={styles.btn} onClick={onClose}>
					{ts("transcript.cleanup.cancel")}
				</button>
				<button
					type="button"
					data-testid="speech-cleanup-apply"
					className={`${styles.btn} ${styles.btnPrimary}`}
					disabled={picked.length === 0}
					onClick={() => {
						onApply(
							picked.map((item) => item.id),
							options,
						);
						onClose();
					}}
				>
					{ts("transcript.cleanup.apply", { count: picked.length })}
				</button>
			</div>
		</div>
	);
}
