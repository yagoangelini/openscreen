// Small building blocks shared by the global defaults dialog ("Padrões") and the project's own
// settings in the Media panel, so the two show a setting the same way.

import { Pin, RotateCcw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useScopedT } from "@/contexts/I18nContext";
import type { SettingSource } from "@/lib/ai-edition/projectTranscriptionSettings";
import { formatBytes } from "@/utils/formatBytes";
import { STT_WHISPER_MODEL_BYTES } from "../../../../electron/stt/transcriptionContract";

export const fieldTextareaStyle: CSSProperties = {
	width: "100%",
	resize: "vertical",
	padding: "8px 10px",
	borderRadius: 9,
	border: "1px solid var(--border)",
	background: "var(--surface-2)",
	color: "var(--fg)",
	font: "500 12px var(--font-mono)",
};

export const fieldSelectStyle: CSSProperties = {
	width: "100%",
	minWidth: 0,
	height: 36,
	padding: "0 10px",
	borderRadius: 9,
	border: "1px solid var(--border)",
	background: "var(--surface-2)",
	color: "var(--fg)",
	fontSize: 12.5,
	fontWeight: 500,
	outline: "none",
};

const labelStyle: CSSProperties = {
	fontSize: 12.5,
	fontWeight: 600,
	color: "var(--fg-2)",
};

const iconButtonStyle: CSSProperties = {
	width: 24,
	height: 24,
	display: "grid",
	placeItems: "center",
	borderRadius: 7,
	border: "1px solid var(--border)",
	background: "var(--surface-2)",
	color: "var(--fg-2)",
	cursor: "pointer",
	flexShrink: 0,
};

/** "Padrão" or "Deste projeto": where the value a project uses comes from. */
export function SourceBadge({ source }: { source: SettingSource }) {
	const t = useScopedT("editor");
	const project = source === "project";
	return (
		<span
			data-testid="setting-source"
			data-source={source}
			style={{
				display: "inline-flex",
				alignItems: "center",
				padding: "1px 7px",
				borderRadius: 9999,
				fontSize: 11,
				fontWeight: 600,
				background: project ? "var(--accent-soft)" : "var(--surface-2)",
				color: project ? "var(--accent)" : "var(--muted)",
				border: project ? "1px solid transparent" : "1px solid var(--border)",
				whiteSpace: "nowrap",
			}}
		>
			{t(project ? "projectSettings.sourceProject" : "projectSettings.sourceDefault")}
		</span>
	);
}

/** "Use the default" and "save as default", shown only for a value the project set itself. */
function OverrideActions({
	source,
	testId,
	onReset,
	onPromote,
}: {
	source?: SettingSource;
	testId?: string;
	onReset?: () => void;
	onPromote?: () => void;
}) {
	const t = useScopedT("editor");
	if (source !== "project") return null;
	return (
		<>
			{onReset ? (
				<Tooltip content={t("projectSettings.useDefaultTip")}>
					<button
						type="button"
						aria-label={t("projectSettings.useDefault")}
						data-testid={testId ? `${testId}-reset` : undefined}
						onClick={onReset}
						style={iconButtonStyle}
					>
						<RotateCcw size={12} />
					</button>
				</Tooltip>
			) : null}
			{onPromote ? (
				<Tooltip content={t("projectSettings.saveAsDefaultTip")}>
					<button
						type="button"
						aria-label={t("projectSettings.saveAsDefault")}
						data-testid={testId ? `${testId}-promote` : undefined}
						onClick={onPromote}
						style={iconButtonStyle}
					>
						<Pin size={12} />
					</button>
				</Tooltip>
			) : null}
		</>
	);
}

/**
 * A setting's label row. With `source`, the badge, and for a value the project set itself,
 * "use the default" and "save as default".
 */
export function SettingHeader({
	label,
	source,
	testId,
	onReset,
	onPromote,
	trailing,
}: {
	label: ReactNode;
	source?: SettingSource;
	testId?: string;
	onReset?: () => void;
	onPromote?: () => void;
	trailing?: ReactNode;
}) {
	return (
		<div
			style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, minHeight: 24 }}
			data-testid={testId}
		>
			<span style={{ ...labelStyle, flex: 1, minWidth: 0 }}>{label}</span>
			{source ? <SourceBadge source={source} /> : null}
			<OverrideActions source={source} testId={testId} onReset={onReset} onPromote={onPromote} />
			{trailing}
		</div>
	);
}

/** A checkbox row, with the badge and its actions when it is a project's setting. */
export function CheckRow({
	checked,
	onChange,
	label,
	title,
	testId,
	source,
	onReset,
	onPromote,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: ReactNode;
	title?: string;
	testId?: string;
	source?: SettingSource;
	onReset?: () => void;
	onPromote?: () => void;
}) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
			<label
				title={title}
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					flex: 1,
					minWidth: 0,
					fontSize: 12.5,
					color: "var(--fg-2)",
					cursor: "pointer",
				}}
			>
				<input
					type="checkbox"
					data-testid={testId}
					checked={checked}
					onChange={(event) => onChange(event.target.checked)}
				/>
				{label}
			</label>
			{source ? <SourceBadge source={source} /> : null}
			<OverrideActions source={source} testId={testId} onReset={onReset} onPromote={onPromote} />
		</div>
	);
}

/** The whisper model choices, labelled with their download size. */
export function ModelOptions() {
	const t = useScopedT("editor");
	return (
		<>
			<option value="auto">{t("mediaStage.modelAuto")}</option>
			<option value="large-v3-turbo">
				{t("mediaStage.modelTurbo", {
					size: formatBytes(STT_WHISPER_MODEL_BYTES["large-v3-turbo"]),
				})}
			</option>
			<option value="small">
				{t("mediaStage.modelSmall", { size: formatBytes(STT_WHISPER_MODEL_BYTES.small) })}
			</option>
		</>
	);
}

/** Lines in a list setting, for "N from the defaults". */
export function countLines(text: string): number {
	return text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#")).length;
}
