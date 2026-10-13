import { FolderPen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { registerTakeNamePrompt, type TakeNameRequest } from "@/lib/ai-edition/freshTakeName";
import { sanitizeRecordingName } from "@/lib/recordingName";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

/**
 * "Dê um nome à gravação": asked as the editor opens on a take that just ended, before it is
 * imported (see `freshTakeName.ts` for why then). Enter saves; Esc, the close button and
 * "Skip" keep the prefilled date and time. Mounted once by the editor shell.
 */
export function TakeNameDialog() {
	const t = useScopedT("editor");
	const [request, setRequest] = useState<TakeNameRequest | null>(null);
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(
		() =>
			registerTakeNamePrompt((next) => {
				setValue(next.defaultName);
				setRequest(next);
			}),
		[],
	);

	useEffect(() => {
		if (!request) return;
		const frame = requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
		return () => cancelAnimationFrame(frame);
	}, [request]);

	const finish = (name: string) => {
		request?.resolve(name);
		setRequest(null);
	};
	const keepDefault = () => finish(request?.defaultName ?? "");
	const sanitized = sanitizeRecordingName(value);
	const save = () => finish(sanitized ?? request?.defaultName ?? "");

	return (
		<ModalShell
			open={request !== null}
			onClose={keepDefault}
			closeOnBackdrop={false}
			title={t("takeName.title")}
			subtitle={t("takeName.subtitle")}
			footer={
				<>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={keepDefault}
						data-testid="take-name-skip"
					>
						{t("takeName.skip")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={save}
						data-testid="take-name-save"
					>
						{t("takeName.save")}
					</button>
				</>
			}
		>
			<form
				data-testid="take-name-dialog"
				onSubmit={(event) => {
					event.preventDefault();
					save();
				}}
			>
				<label htmlFor="take-name-input" className={styles.groupLabel} style={{ margin: 0 }}>
					{t("takeName.label")}
				</label>
				<input
					id="take-name-input"
					ref={inputRef}
					className={styles.control}
					value={value}
					maxLength={200}
					spellCheck={false}
					onChange={(event) => setValue(event.target.value)}
					style={{ width: "100%", marginTop: 8 }}
					data-testid="take-name-input"
				/>
				<p
					style={{
						display: "flex",
						alignItems: "center",
						gap: 6,
						margin: "10px 0 0",
						fontSize: 12,
						color: "var(--muted)",
					}}
				>
					<FolderPen size={13} />
					{sanitized && sanitized !== value.trim()
						? t("takeName.willBeSavedAs", { name: sanitized })
						: t("takeName.hint")}
				</p>
			</form>
		</ModalShell>
	);
}
