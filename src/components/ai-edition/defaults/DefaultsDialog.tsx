// "Padrões": the global defaults every project starts from, in one dialog opened from the app
// menu (and from the Media panel).
//
// Two models, on purpose, and each section says which one it follows:
//
// - Transcription, privacy, speech cleanup and export are the user preferences the app already
//   had. A project follows them until it changes a value in the Media panel
//   (`projectTranscriptionSettings.ts`), so a change here reaches every project that did not.
// - The look and the editing of a project ("Projetos novos") is COPIED into each new project
//   when it is created (`newProjectDefaults.ts`): a project's editor settings are its own, and a
//   change here never restyles a project that already exists.
//
// The look section renders the editor's own panes, the very controls of the inspector, inside an
// `EditorSettingsSourceContext` that points them at the stored defaults instead of the project.

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useEditorDialogActions, useEditorDialogSection } from "@/contexts/EditorDialogsContext";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import {
	editorDefaultsDocument,
	loadEditorDefaults,
	saveEditorDefaults,
} from "@/lib/ai-edition/editorDefaultsStore";
import { applyEditorDefaults, pickEditorDefaults } from "@/lib/ai-edition/newProjectDefaults";
import type { TranscriptLanguageCode } from "@/lib/ai-edition/schema";
import {
	type EditorSettingsPatch,
	getEditorSettings,
	patchEditorSettings,
} from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	type EditorSettingsSource,
	EditorSettingsSourceContext,
} from "@/lib/ai-edition/store/useEditorSettings";
import { DEFAULT_GLOSSARY } from "@/lib/ai-edition/transcription/glossary";
import { sortedLanguageOptions } from "@/lib/ai-edition/transcription/languageLabels";
import { DEFAULT_VOCABULARY } from "@/lib/ai-edition/transcription/vocabulary";
import type { ExportFormat, ExportQuality } from "@/lib/exporter";
import {
	EXPORT_FPS_OPTIONS,
	type ExportFps,
	loadUserPreferences,
	saveUserPreferences,
	type UserPreferences,
} from "@/lib/userPreferences";
import { nativeBridgeClient } from "@/native/client";
import type { SttWhisperModelPreference } from "../../../../electron/stt/transcriptionContract";
import { ModalShell } from "../Modals";
import shell from "../NewEditorShell.module.css";
import { AudioPane, CursorPane, LayoutPane, VideoEffectsPane } from "../RightPanes";
import { type CleanupPrefs, readCleanupPrefs, SpeechCleanupRules } from "../SpeechCleanupPanel";
import { AutoZoomSettings } from "../v4/AutoZoomSettings";
import {
	CheckRow,
	fieldSelectStyle,
	fieldTextareaStyle,
	ModelOptions,
	SettingHeader,
} from "./settingRows";

type Section = "transcription" | "privacy" | "cleanup" | "look" | "captions" | "export" | "ai";

const SECTIONS: readonly Section[] = [
	"transcription",
	"privacy",
	"cleanup",
	"look",
	"captions",
	"export",
	"ai",
];

const QUALITY_CHOICES: readonly ExportQuality[] = ["medium", "good", "high", "source"];

/**
 * The stored editor defaults as a settings source for the editor's panes. A live change (a
 * slider being dragged) updates the panes; the write to storage happens on commit and on
 * every discrete change, as a project's would.
 */
function useDefaultsSettingsSource(onSaveFailed: () => void): {
	source: EditorSettingsSource;
	stored: Record<string, unknown> | null;
	replace: (next: Record<string, unknown> | null) => void;
} {
	const [stored, setStored] = useState<Record<string, unknown> | null>(() => loadEditorDefaults());
	const storedRef = useRef(stored);
	storedRef.current = stored;
	const document = useMemo(() => editorDefaultsDocument(stored), [stored]);
	const documentRef = useRef(document);
	documentRef.current = document;

	const persist = useCallback(
		(next: Record<string, unknown> | null) => {
			if (!saveEditorDefaults(next)) onSaveFailed();
		},
		[onSaveFailed],
	);
	const apply = useCallback((patch: EditorSettingsPatch) => {
		const next = pickEditorDefaults(patchEditorSettings(documentRef.current, patch).legacyEditor);
		storedRef.current = next;
		setStored(next);
		return next;
	}, []);
	const replace = useCallback(
		(next: Record<string, unknown> | null) => {
			storedRef.current = next;
			setStored(next);
			persist(next);
		},
		[persist],
	);

	const source = useMemo<EditorSettingsSource>(
		() => ({
			settings: getEditorSettings(document),
			document,
			hasDocument: true,
			editingDefaults: true,
			set: async (patch) => {
				persist(apply(patch));
				return true;
			},
			setLive: (patch) => {
				apply(patch);
			},
			commit: async () => persist(storedRef.current),
		}),
		[document, apply, persist],
	);
	return { source, stored, replace };
}

export function DefaultsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useScopedT("editor");
	const [section, setSection] = useState<Section>("transcription");
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t("defaults.title")}
			subtitle={t("defaults.subtitle")}
		>
			<div
				data-testid="defaults-dialog"
				style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 18, minHeight: 420 }}
			>
				<nav
					aria-label={t("defaults.title")}
					// Sticky: the body scrolls, and the sections stay in reach on a long one.
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 4,
						position: "sticky",
						top: 0,
						alignSelf: "start",
					}}
				>
					{SECTIONS.map((id) => (
						<button
							type="button"
							key={id}
							data-testid={`defaults-tab-${id}`}
							aria-current={section === id ? "page" : undefined}
							onClick={() => setSection(id)}
							style={{
								textAlign: "left",
								padding: "8px 10px",
								borderRadius: 8,
								border: 0,
								background: section === id ? "var(--accent-soft)" : "transparent",
								color: section === id ? "var(--accent)" : "var(--fg-2)",
								font: "600 12.5px var(--font-body)",
								cursor: "pointer",
							}}
						>
							{t(`defaults.sections.${id}`)}
						</button>
					))}
				</nav>
				<div style={{ minWidth: 0 }}>
					{section === "transcription" ? <TranscriptionDefaults /> : null}
					{section === "privacy" ? <PrivacyDefaults /> : null}
					{section === "cleanup" ? <CleanupDefaults /> : null}
					{section === "look" ? <LookDefaults /> : null}
					{section === "captions" ? <CaptionDefaults /> : null}
					{section === "export" ? <ExportDefaults /> : null}
					{section === "ai" ? <AiDefaults onOpenProviders={onClose} /> : null}
				</div>
			</div>
		</ModalShell>
	);
}

/** The one mount, bound to the editor's dialog context like `ProviderSettingsDialog`. */
export function DefaultsSettingsDialog() {
	const section = useEditorDialogSection();
	const { closeDialog } = useEditorDialogActions();
	return <DefaultsDialog open={section === "defaults"} onClose={closeDialog} />;
}

function SectionIntro({ children }: { children: ReactNode }) {
	return (
		<p style={{ margin: "0 0 14px", fontSize: 12.5, lineHeight: 1.55, color: "var(--muted)" }}>
			{children}
		</p>
	);
}

const block = { marginBottom: 14 } as const;

/** Preferences held in local state, written through on every change. */
function usePrefs(): [UserPreferences, (patch: Partial<UserPreferences>) => void] {
	const [prefs, setPrefs] = useState(() => loadUserPreferences());
	const update = useCallback((patch: Partial<UserPreferences>) => {
		saveUserPreferences(patch);
		setPrefs(loadUserPreferences());
	}, []);
	return [prefs, update];
}

/** A list setting edited as text: saved on blur, with a button back to the built-in list. */
function ListField({
	label,
	hint,
	value,
	builtIn,
	rows,
	testId,
	resetLabel,
	placeholder,
	onSave,
}: {
	label: string;
	hint: string;
	value: string;
	builtIn?: string;
	rows: number;
	testId: string;
	resetLabel?: string;
	placeholder?: string;
	onSave: (value: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	return (
		<div style={block}>
			<SettingHeader label={label} />
			<p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--muted)" }}>{hint}</p>
			<textarea
				data-testid={testId}
				value={draft}
				rows={rows}
				spellCheck={false}
				placeholder={placeholder}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => {
					if (draft !== value) onSave(draft);
				}}
				style={fieldTextareaStyle}
			/>
			{builtIn !== undefined && resetLabel ? (
				<button
					type="button"
					className={`${shell.btn} ${shell.btnSecondary}`}
					data-testid={`${testId}-reset`}
					disabled={draft === builtIn}
					onClick={() => {
						setDraft(builtIn);
						onSave(builtIn);
					}}
					style={{ marginTop: 6 }}
				>
					{resetLabel}
				</button>
			) : null}
		</div>
	);
}

function TranscriptionDefaults() {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const [prefs, update] = usePrefs();
	const languages = useMemo(() => sortedLanguageOptions(locale, t("mediaStage.auto")), [locale, t]);
	return (
		<div data-testid="defaults-transcription">
			<SectionIntro>{t("defaults.inheritHint")}</SectionIntro>
			<div style={block}>
				<SettingHeader label={t("projectSettings.language")} />
				<select
					data-testid="defaults-language"
					value={prefs.transcriptionLanguage ?? ""}
					onChange={(e) =>
						update({
							transcriptionLanguage: (e.target.value || null) as TranscriptLanguageCode | null,
						})
					}
					style={fieldSelectStyle}
				>
					<option value="">{t("defaults.languageFollowApp")}</option>
					{languages.map(({ code, label }) => (
						<option key={code} value={code}>
							{label}
						</option>
					))}
				</select>
			</div>
			<div style={block}>
				<SettingHeader label={t("mediaStage.model")} />
				<select
					data-testid="defaults-model"
					value={prefs.transcriptionModel}
					title={t("mediaStage.modelHint")}
					onChange={(e) =>
						update({ transcriptionModel: e.target.value as SttWhisperModelPreference })
					}
					style={fieldSelectStyle}
				>
					<ModelOptions />
				</select>
			</div>
			<div style={block}>
				<CheckRow
					testId="defaults-auto-transcribe"
					checked={prefs.autoTranscribe}
					label={t("mediaStage.autoTranscribe")}
					onChange={(autoTranscribe) => update({ autoTranscribe })}
				/>
				<CheckRow
					testId="defaults-transcribe-guest"
					checked={prefs.transcribeGuestAudio}
					title={t("mediaStage.transcribeGuestHint")}
					label={t("mediaStage.transcribeGuest")}
					onChange={(transcribeGuestAudio) => update({ transcribeGuestAudio })}
				/>
			</div>
			<ListField
				label={t("mediaStage.standingTerms")}
				hint={t("mediaStage.standingTermsHint")}
				value={prefs.transcriptionVocabulary}
				builtIn={DEFAULT_VOCABULARY}
				rows={4}
				testId="defaults-standing-terms"
				resetLabel={t("mediaStage.standingTermsReset")}
				onSave={(transcriptionVocabulary) => update({ transcriptionVocabulary })}
			/>
			<ListField
				label={t("mediaStage.glossary")}
				hint={t("defaults.glossaryHint")}
				value={prefs.glossary}
				builtIn={DEFAULT_GLOSSARY}
				rows={10}
				testId="defaults-glossary"
				resetLabel={t("defaults.glossaryReset")}
				onSave={(glossary) => update({ glossary })}
			/>
		</div>
	);
}

function PrivacyDefaults() {
	const t = useScopedT("editor");
	const [prefs, update] = usePrefs();
	return (
		<div data-testid="defaults-privacy">
			<SectionIntro>{t("defaults.inheritHint")}</SectionIntro>
			<div style={block}>
				<CheckRow
					testId="defaults-auto-redact"
					checked={prefs.autoRedact}
					title={t("mediaStage.autoRedactHint")}
					label={t("mediaStage.autoRedact")}
					onChange={(autoRedact) => update({ autoRedact })}
				/>
			</div>
			<ListField
				label={t("mediaStage.redactTerms")}
				hint={t("mediaStage.redactTermsHint")}
				value={prefs.autoRedactTerms}
				rows={5}
				testId="defaults-redact-terms"
				placeholder={t("mediaStage.redactTermsPlaceholder")}
				onSave={(autoRedactTerms) => update({ autoRedactTerms })}
			/>
		</div>
	);
}

function CleanupDefaults() {
	const t = useScopedT("editor");
	const [prefs, setPrefs] = useState<CleanupPrefs>(readCleanupPrefs);
	return (
		<div data-testid="defaults-cleanup" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>
			<SectionIntro>{t("defaults.cleanupHint")}</SectionIntro>
			<SpeechCleanupRules
				prefs={prefs}
				onChange={(patch) => {
					saveUserPreferences(patch);
					setPrefs((current) => ({ ...current, ...patch }));
				}}
			/>
		</div>
	);
}

function LookDefaults() {
	const t = useScopedT("editor");
	const onSaveFailed = useCallback(() => toast.error(t("defaults.saveFailed")), [t]);
	const { source, stored, replace } = useDefaultsSettingsSource(onSaveFailed);
	const projectDocument = useProjectStore((s) => s.document);
	const [presetName, setPresetName] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		void nativeBridgeClient.presets
			.list()
			.then((presets) => {
				if (alive) setPresetName(presets.find((p) => p.forNewProjects)?.name ?? null);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, []);

	const copyFromProject = () => {
		const current = useProjectStore.getState().document;
		if (!current) return;
		replace({ ...(stored ?? {}), ...pickEditorDefaults(current.legacyEditor) });
		toast.success(t("defaults.fromProjectDone"));
	};
	const applyToProject = async () => {
		const current = useProjectStore.getState().document;
		if (!current || !stored) return;
		const next = { ...current, legacyEditor: applyEditorDefaults(current.legacyEditor, stored) };
		if (await useProjectStore.getState().saveDocument(next, { history: true })) {
			toast.success(t("defaults.applyToProjectDone"));
		}
	};
	const stopPreset = async () => {
		await nativeBridgeClient.presets.setForNewProjects(null).catch(() => undefined);
		setPresetName(null);
	};

	return (
		<div data-testid="defaults-look">
			<SectionIntro>{t("defaults.lookHint")}</SectionIntro>
			{stored === null ? (
				<p className={shell.hint} data-testid="defaults-look-unset" style={{ marginBottom: 10 }}>
					{t("defaults.lookUnset")}
				</p>
			) : null}
			{presetName ? (
				<p className={shell.hint} data-testid="defaults-look-preset" style={{ marginBottom: 10 }}>
					{t("defaults.lookPreset", { name: presetName })}{" "}
					<button
						type="button"
						className={`${shell.btn} ${shell.btnSecondary}`}
						onClick={() => void stopPreset()}
					>
						{t("defaults.lookPresetStop")}
					</button>
				</p>
			) : null}
			<div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
				<button
					type="button"
					className={`${shell.btn} ${shell.btnSecondary}`}
					data-testid="defaults-look-from-project"
					disabled={!projectDocument}
					onClick={copyFromProject}
				>
					{t("defaults.fromProject")}
				</button>
				<button
					type="button"
					className={`${shell.btn} ${shell.btnSecondary}`}
					data-testid="defaults-look-apply"
					disabled={!projectDocument || stored === null}
					onClick={() => void applyToProject()}
				>
					{t("defaults.applyToProject")}
				</button>
				<button
					type="button"
					className={`${shell.btn} ${shell.btnSecondary}`}
					data-testid="defaults-look-reset"
					disabled={stored === null}
					onClick={() => replace(null)}
				>
					{t("defaults.resetLook")}
				</button>
			</div>
			<EditorSettingsSourceContext.Provider value={source}>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
						gap: 12,
						alignItems: "start",
					}}
				>
					<PaneCard>
						<VideoEffectsPane />
					</PaneCard>
					<PaneCard>
						<CursorPane />
					</PaneCard>
					<PaneCard>
						<LayoutPane />
					</PaneCard>
					<PaneCard>
						<AudioPane />
					</PaneCard>
					<PaneCard padded>
						<AutoZoomSettings />
					</PaneCard>
				</div>
			</EditorSettingsSourceContext.Provider>
		</div>
	);
}

function PaneCard({ children, padded }: { children: ReactNode; padded?: boolean }) {
	return (
		<div
			style={{
				border: "1px solid var(--border)",
				borderRadius: 12,
				background: "var(--surface)",
				padding: padded ? 14 : 0,
				minWidth: 0,
			}}
		>
			{children}
		</div>
	);
}

function CaptionDefaults() {
	const t = useScopedT("editor");
	const onSaveFailed = useCallback(() => toast.error(t("defaults.saveFailed")), [t]);
	const [stored, setStored] = useState(() => loadEditorDefaults());
	const projectDocument = useProjectStore((s) => s.document);
	const hasStyle = Boolean(stored?.captions);
	const write = (next: Record<string, unknown> | null) => {
		if (!saveEditorDefaults(next)) onSaveFailed();
		setStored(loadEditorDefaults());
	};
	return (
		<div data-testid="defaults-captions">
			<SectionIntro>{t("defaults.captionsHint")}</SectionIntro>
			<p className={shell.hint} data-testid="defaults-captions-state" style={{ marginBottom: 10 }}>
				{t(hasStyle ? "defaults.captionsSaved" : "defaults.captionsFactory")}
			</p>
			<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
				<button
					type="button"
					className={`${shell.btn} ${shell.btnSecondary}`}
					data-testid="defaults-captions-from-project"
					disabled={!projectDocument}
					onClick={() => {
						const current = useProjectStore.getState().document;
						const captions = pickEditorDefaults(current?.legacyEditor).captions;
						const { captions: _old, ...rest } = loadEditorDefaults() ?? {};
						write(captions ? { ...rest, captions } : rest);
						toast.success(t("defaults.captionsFromProjectDone"));
					}}
				>
					{t("defaults.captionsFromProject")}
				</button>
				<button
					type="button"
					className={`${shell.btn} ${shell.btnSecondary}`}
					data-testid="defaults-captions-reset"
					disabled={!hasStyle}
					onClick={() => {
						const { captions: _old, ...rest } = loadEditorDefaults() ?? {};
						write(rest);
					}}
				>
					{t("defaults.resetLook")}
				</button>
			</div>
		</div>
	);
}

function ExportDefaults() {
	const t = useScopedT("editor");
	const ts = useScopedT("settings");
	const [prefs, update] = usePrefs();
	const qualityLabel = (q: ExportQuality) =>
		q === "medium"
			? ts("exportQuality.low")
			: q === "good"
				? ts("exportQuality.medium")
				: q === "high"
					? t("exportPipeline.quality1440p")
					: ts("exportQuality.high");
	return (
		<div data-testid="defaults-export">
			<SectionIntro>{t("defaults.exportHint")}</SectionIntro>
			<div style={block}>
				<SettingHeader label={t("defaults.exportFormat")} />
				<select
					data-testid="defaults-export-format"
					value={prefs.exportFormat}
					onChange={(e) => update({ exportFormat: e.target.value as ExportFormat })}
					style={fieldSelectStyle}
				>
					<option value="mp4">{ts("exportFormat.mp4")}</option>
					<option value="gif">{ts("exportFormat.gif")}</option>
				</select>
			</div>
			<div style={block}>
				<SettingHeader label={t("exportDialog.quality")} />
				<select
					data-testid="defaults-export-quality"
					value={prefs.exportQuality}
					onChange={(e) => update({ exportQuality: e.target.value as ExportQuality })}
					style={fieldSelectStyle}
				>
					{QUALITY_CHOICES.map((q) => (
						<option key={q} value={q}>
							{qualityLabel(q)}
						</option>
					))}
				</select>
			</div>
			<div style={block}>
				<SettingHeader label={t("exportDialog.frameRate")} />
				<select
					data-testid="defaults-export-fps"
					value={prefs.exportFps}
					onChange={(e) => update({ exportFps: Number(e.target.value) as ExportFps })}
					style={fieldSelectStyle}
				>
					{EXPORT_FPS_OPTIONS.map((fps) => (
						<option key={fps} value={fps}>
							{fps}
						</option>
					))}
				</select>
			</div>
			<CheckRow
				testId="defaults-youtube-loudness"
				checked={prefs.youtubeLoudness}
				title={t("exportDialog.youtubeLoudnessHint")}
				label={t("exportDialog.youtubeLoudness")}
				onChange={(youtubeLoudness) => update({ youtubeLoudness })}
			/>
		</div>
	);
}

function AiDefaults({ onOpenProviders }: { onOpenProviders: () => void }) {
	const t = useScopedT("editor");
	const { openDialog } = useEditorDialogActions();
	return (
		<div data-testid="defaults-ai">
			<SectionIntro>{t("defaults.aiHint")}</SectionIntro>
			<button
				type="button"
				className={`${shell.btn} ${shell.btnSecondary}`}
				onClick={() => {
					onOpenProviders();
					openDialog("providers");
				}}
			>
				{t("defaults.aiOpen")}
			</button>
		</div>
	);
}
