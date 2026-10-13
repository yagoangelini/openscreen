// The transcription and privacy settings of the open project, in the Media panel.
//
// Every value follows the global defaults ("Padrões") until it is changed here; a changed value
// is this project's own (`projectTranscriptionSettings.ts`), shown with a badge, and can go back
// to the default or become the default. The glossary and the sensitive words are not replaced
// but extended: the default list stays, and this project adds lines of its own.

import { type ReactNode, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useOptionalEditorDialogActions } from "@/contexts/EditorDialogsContext";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import {
	type OverridableField,
	type ProjectTranscriptionOverrides,
	promoteOverrideToDefault,
	readProjectOverrides,
	resolveProjectTranscriptionSettings,
	withProjectOverrides,
} from "@/lib/ai-edition/projectTranscriptionSettings";
import type { TranscriptLanguageCode } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { applyGlossary, parseGlossary } from "@/lib/ai-edition/transcription/glossary";
import { sortedLanguageOptions } from "@/lib/ai-edition/transcription/languageLabels";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import type { SttWhisperModelPreference } from "../../../../electron/stt/transcriptionContract";
import {
	CheckRow,
	countLines,
	fieldSelectStyle,
	fieldTextareaStyle,
	ModelOptions,
	SettingHeader,
} from "../defaults/settingRows";
import { rescanAutoRedactions } from "../recordingImport";
import styles from "./EditorShellV4.module.css";

/** Saves this project's overrides as one undoable edit, over the latest document. */
async function writeProjectOverrides(
	patch: { [K in OverridableField]?: ProjectTranscriptionOverrides[K] | undefined },
): Promise<boolean> {
	const latest = useProjectStore.getState().document;
	if (!latest) return false;
	const next = withProjectOverrides(latest, patch);
	return useProjectStore.getState().saveDocument(next, { history: true });
}

/** "Salvar como padrão": the default takes this project's value, and the project follows it. */
async function promoteProjectOverride(field: OverridableField): Promise<boolean> {
	const latest = useProjectStore.getState().document;
	if (!latest) return false;
	const promoted = promoteOverrideToDefault(latest, field);
	if (!promoted) return false;
	saveUserPreferences(promoted.prefs);
	return useProjectStore.getState().saveDocument(promoted.document, { history: true });
}

export function ProjectTranscriptionSettings({
	languageAction,
}: {
	/** Shown beside the language: the Media panel's "regenerate" button. */
	languageAction?: ReactNode;
}) {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const dialogs = useOptionalEditorDialogActions();
	const document = useProjectStore((s) => s.document);
	// Bumped after a write to the preferences, which are not a store: what re-reads them.
	const [prefsVersion, setPrefsVersion] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: prefsVersion is the trigger to re-read the preferences.
	const prefs = useMemo(() => loadUserPreferences(), [prefsVersion]);
	const resolved = useMemo(
		() => resolveProjectTranscriptionSettings(document, prefs),
		[document, prefs],
	);
	const overrides = useMemo(() => readProjectOverrides(document), [document]);
	const sources = resolved.sources;
	const [autoTranscribe, setAutoTranscribe] = useState(() => loadUserPreferences().autoTranscribe);
	const [rescanning, setRescanning] = useState(false);
	const languageOptions = useMemo(
		() => sortedLanguageOptions(locale, t("mediaStage.auto")),
		[locale, t],
	);

	const reset = (field: OverridableField) => () =>
		void writeProjectOverrides({ [field]: undefined });
	const promote = (field: OverridableField) => async () => {
		if (await promoteProjectOverride(field)) {
			setPrefsVersion((v) => v + 1);
			toast.success(t("projectSettings.savedAsDefault"));
		}
	};

	// "Procurar de novo" with the words this project blurs: the defaults plus its own.
	const rescanRedactions = useCallback(async () => {
		setRescanning(true);
		try {
			const terms = resolveProjectTranscriptionSettings(
				useProjectStore.getState().document,
			).autoRedactTerms;
			const result = await rescanAutoRedactions({ terms });
			if (result.scanned === 0) {
				toast.error(t("mediaStage.redactRescanFailed"));
			} else if (result.removed === 0 && result.added === 0) {
				toast.info(t("mediaStage.redactRescanNothing"));
			} else if (result.saved) {
				toast.success(
					t("mediaStage.redactRescanDone", { added: result.added, removed: result.removed }),
				);
			}
		} finally {
			setRescanning(false);
		}
	}, [t]);

	// The glossary runs on each new transcript by itself; this puts the transcripts the project
	// already has right too. One undoable edit, and the words the user corrected by hand are
	// theirs, so it never touches them.
	const applyGlossaryToTranscripts = useCallback(async () => {
		const current = useProjectStore.getState().document;
		if (!current) return;
		const entries = parseGlossary(resolveProjectTranscriptionSettings(current).glossary);
		let replaced = 0;
		const transcripts = current.transcripts.map((transcript) => {
			const result = applyGlossary(transcript, entries, { keepEditedWords: true });
			replaced += result.replaced;
			return result.transcript;
		});
		if (replaced === 0) {
			toast.info(t("mediaStage.glossaryNothingToFix"));
			return;
		}
		const saved = await useProjectStore
			.getState()
			.saveDocument({ ...current, transcripts }, { history: true });
		if (saved) toast.success(t("mediaStage.glossaryApplied", { count: replaced }));
	}, [t]);

	const projectKey = document?.project.id ?? "";

	return (
		<div data-testid="project-transcription-settings">
			<p style={{ margin: "0 0 10px", fontSize: 12, lineHeight: 1.5, color: "var(--muted)" }}>
				{t("projectSettings.intro")}{" "}
				<button
					type="button"
					data-testid="project-settings-open-defaults"
					onClick={() => dialogs?.openDialog("defaults")}
					style={{
						padding: 0,
						border: 0,
						background: "none",
						color: "var(--accent)",
						cursor: "pointer",
						font: "inherit",
						textDecoration: "underline",
					}}
				>
					{t("projectSettings.openDefaults")}
				</button>
			</p>

			<div style={{ marginBottom: 10 }}>
				<SettingHeader
					label={t("projectSettings.language")}
					source={sources.transcriptionLanguage}
					testId="project-setting-language"
					onReset={reset("transcriptionLanguage")}
					onPromote={promote("transcriptionLanguage")}
				/>
				<div style={{ display: "flex", gap: 8 }}>
					<select
						data-testid="media-stage-language"
						value={resolved.transcriptionLanguage}
						onChange={(e) =>
							void writeProjectOverrides({
								transcriptionLanguage: e.target.value as TranscriptLanguageCode,
							})
						}
						style={{ ...fieldSelectStyle, flex: 1 }}
					>
						{languageOptions.map(({ code, label }) => (
							<option key={code} value={code}>
								{label}
							</option>
						))}
					</select>
					{languageAction}
				</div>
			</div>

			<div style={{ marginBottom: 10 }}>
				<SettingHeader
					label={t("mediaStage.model")}
					source={sources.transcriptionModel}
					testId="project-setting-model"
					onReset={reset("transcriptionModel")}
					onPromote={promote("transcriptionModel")}
				/>
				<select
					data-testid="media-stage-model"
					value={resolved.transcriptionModel}
					title={t("mediaStage.modelHint")}
					onChange={(e) =>
						void writeProjectOverrides({
							transcriptionModel: e.target.value as SttWhisperModelPreference,
						})
					}
					style={fieldSelectStyle}
				>
					<ModelOptions />
				</select>
			</div>

			{/* An app-wide behaviour, not a project's: it decides what happens when an editor opens. */}
			<CheckRow
				testId="media-stage-auto-transcribe"
				checked={autoTranscribe}
				label={t("mediaStage.autoTranscribe")}
				onChange={(enabled) => {
					setAutoTranscribe(enabled);
					saveUserPreferences({ autoTranscribe: enabled });
				}}
			/>
			<CheckRow
				testId="media-stage-transcribe-guest"
				checked={resolved.transcribeGuestAudio}
				title={t("mediaStage.transcribeGuestHint")}
				label={t("mediaStage.transcribeGuest")}
				source={sources.transcribeGuestAudio}
				onChange={(enabled) => void writeProjectOverrides({ transcribeGuestAudio: enabled })}
				onReset={reset("transcribeGuestAudio")}
				onPromote={promote("transcribeGuestAudio")}
			/>
			<CheckRow
				testId="media-stage-auto-redact"
				checked={resolved.autoRedact}
				title={t("mediaStage.autoRedactHint")}
				label={t("mediaStage.autoRedact")}
				source={sources.autoRedact}
				onChange={(enabled) => void writeProjectOverrides({ autoRedact: enabled })}
				onReset={reset("autoRedact")}
				onPromote={promote("autoRedact")}
			/>

			<details style={{ marginTop: 8, fontSize: 12.5, color: "var(--fg-2)" }}>
				<summary style={{ cursor: "pointer" }}>{t("mediaStage.redactTerms")}</summary>
				<p style={{ margin: "6px 0", color: "var(--muted)" }}>{t("mediaStage.redactTermsHint")}</p>
				<DefaultListPreview text={prefs.autoRedactTerms} />
				<SettingHeader
					label={t("projectSettings.projectAdditions")}
					source={sources.autoRedactTermsAdditions}
					testId="project-setting-redact-terms"
					onReset={reset("autoRedactTermsAdditions")}
					onPromote={promote("autoRedactTermsAdditions")}
				/>
				<textarea
					// Uncontrolled and keyed on the saved value, so an undo or a reset shows it; the
					// save happens on blur, one undo step.
					key={`${projectKey}:redact:${overrides.autoRedactTermsAdditions ?? ""}`}
					data-testid="media-stage-redact-terms"
					defaultValue={overrides.autoRedactTermsAdditions ?? ""}
					spellCheck={false}
					rows={3}
					placeholder={t("mediaStage.redactTermsPlaceholder")}
					onBlur={(e) => {
						if (e.target.value !== (overrides.autoRedactTermsAdditions ?? "")) {
							void writeProjectOverrides({ autoRedactTermsAdditions: e.target.value });
						}
					}}
					style={fieldTextareaStyle}
				/>
				<button
					type="button"
					className={styles.ghostBtn}
					data-testid="media-stage-redact-rescan"
					title={t("mediaStage.redactRescanHint")}
					disabled={rescanning || (document?.timeline.clips.length ?? 0) === 0}
					onClick={() => void rescanRedactions()}
					style={{ marginTop: 6 }}
				>
					{rescanning ? t("mediaStage.redactRescanning") : t("mediaStage.redactRescan")}
				</button>
			</details>

			<details style={{ marginTop: 8, fontSize: 12.5, color: "var(--fg-2)" }}>
				<summary style={{ cursor: "pointer" }}>{t("mediaStage.standingTerms")}</summary>
				<p style={{ margin: "6px 0", color: "var(--muted)" }}>
					{t("mediaStage.standingTermsHint")}
				</p>
				<SettingHeader
					label={t("mediaStage.standingTerms")}
					source={sources.transcriptionVocabulary}
					testId="project-setting-standing-terms"
					onReset={reset("transcriptionVocabulary")}
					onPromote={promote("transcriptionVocabulary")}
				/>
				<textarea
					key={`${projectKey}:standing:${resolved.transcriptionVocabulary}`}
					data-testid="media-stage-standing-terms"
					defaultValue={resolved.transcriptionVocabulary}
					spellCheck={false}
					rows={5}
					onBlur={(e) => {
						if (e.target.value !== resolved.transcriptionVocabulary) {
							void writeProjectOverrides({ transcriptionVocabulary: e.target.value });
						}
					}}
					style={fieldTextareaStyle}
				/>
			</details>

			<details style={{ marginTop: 8, fontSize: 12.5, color: "var(--fg-2)" }}>
				<summary style={{ cursor: "pointer" }}>{t("mediaStage.glossary")}</summary>
				<p style={{ margin: "6px 0", color: "var(--muted)" }}>{t("mediaStage.glossaryHint")}</p>
				<DefaultListPreview text={prefs.glossary} />
				<SettingHeader
					label={t("projectSettings.projectAdditions")}
					source={sources.glossaryAdditions}
					testId="project-setting-glossary"
					onReset={reset("glossaryAdditions")}
					onPromote={promote("glossaryAdditions")}
				/>
				<p style={{ margin: "0 0 6px", color: "var(--muted)" }}>
					{t("projectSettings.glossaryAdditionsHint")}
				</p>
				<textarea
					key={`${projectKey}:glossary:${overrides.glossaryAdditions ?? ""}`}
					data-testid="media-stage-glossary"
					defaultValue={overrides.glossaryAdditions ?? ""}
					spellCheck={false}
					rows={4}
					placeholder="Contoso: contozo, kontoso"
					onBlur={(e) => {
						if (e.target.value !== (overrides.glossaryAdditions ?? "")) {
							void writeProjectOverrides({ glossaryAdditions: e.target.value });
						}
					}}
					style={fieldTextareaStyle}
				/>
				<button
					type="button"
					className={styles.ghostBtn}
					data-testid="media-stage-glossary-apply"
					disabled={(document?.transcripts.length ?? 0) === 0}
					onClick={() => void applyGlossaryToTranscripts()}
					style={{ marginTop: 6 }}
				>
					{t("mediaStage.glossaryApply")}
				</button>
			</details>
		</div>
	);
}

/** The default list, read only and folded: what this project gets before its own lines. */
function DefaultListPreview({ text }: { text: string }) {
	const t = useScopedT("editor");
	return (
		<details style={{ margin: "0 0 8px" }} data-testid="default-list-preview">
			<summary style={{ cursor: "pointer", color: "var(--muted)" }}>
				{t("projectSettings.defaultList", { count: countLines(text) })}
			</summary>
			<pre
				style={{
					margin: "6px 0 0",
					maxHeight: 140,
					overflow: "auto",
					whiteSpace: "pre-wrap",
					font: "500 11.5px var(--font-mono)",
					color: "var(--muted)",
				}}
			>
				{text || "—"}
			</pre>
		</details>
	);
}
