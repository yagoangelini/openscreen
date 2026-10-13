// The confirmation every reset goes through: what it puts back, what it keeps, and that one
// Ctrl+Z undoes it. Mounted once by the editor; any surface opens it with
// `requestProjectReset(scope)`.

import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";
import { runProjectReset, useProjectResetRequest } from "./projectReset";

export function ProjectResetDialog() {
	const te = useScopedT("editor");
	const tc = useScopedT("common");
	const pending = useProjectResetRequest((s) => s.pending);
	const dismiss = useProjectResetRequest((s) => s.dismiss);
	const [busy, setBusy] = useState(false);
	if (!pending) return null;
	const close = () => {
		if (!busy) dismiss();
	};
	const confirm = async () => {
		setBusy(true);
		try {
			const done = await runProjectReset(pending);
			if (done) toast.success(te(`projectReset.${pending}.done`));
			else toast.error(te("projectReset.failed"));
		} finally {
			setBusy(false);
			dismiss();
		}
	};
	return (
		<ModalShell
			open
			onClose={close}
			closeOnBackdrop={!busy}
			title={te(`projectReset.${pending}.title`)}
			subtitle={te(`projectReset.${pending}.body`)}
		>
			<p
				data-testid="project-reset-undo-hint"
				style={{ font: "500 12px var(--font-body)", color: "var(--fg-2)", margin: "0 0 4px" }}
			>
				{te("projectReset.undoHint")}
			</p>
			<div
				style={{
					display: "flex",
					justifyContent: "flex-end",
					gap: 8,
					paddingTop: 12,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={close}
					disabled={busy}
				>
					{tc("actions.cancel")}
				</button>
				<button
					type="button"
					data-testid="project-reset-confirm"
					className={`${styles.btn} ${styles.btnPrimary}`}
					onClick={() => void confirm()}
					disabled={busy}
				>
					<RotateCcw size={14} />
					{busy ? te("projectReset.working") : te("projectReset.confirm")}
				</button>
			</div>
		</ModalShell>
	);
}
