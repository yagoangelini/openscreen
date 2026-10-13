import { FileWarning, FolderSearch, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import {
	dropMissingCameras,
	type MediaFileRef,
	mediaFilesOf,
	mediaSignature,
	missingMediaOf,
	relinkDocument,
} from "@/lib/ai-edition/missingMedia";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import styles from "./NewEditorShell.module.css";

export interface MissingMediaState {
	/** The open project's files that are gone; empty when everything is there. */
	missing: MediaFileRef[];
	/** False until the first check of the open project answered. */
	checked: boolean;
	recheck: () => void;
}

/**
 * Which of the open project's files are gone. Checked when a project opens, when its media
 * paths change, when the window gets focus back and when the recordings folder changes (a
 * take deleted from the library or from Explorer). Without a main process that can say,
 * everything counts as there.
 */
export function useMissingMedia(): MissingMediaState {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const signature = useMemo(() => mediaSignature(document), [document]);
	const [tick, setTick] = useState(0);
	const [result, setResult] = useState<{
		key: string;
		projectId: string | null;
		missing: MediaFileRef[];
	}>({ key: "", projectId: null, missing: [] });
	const api = typeof window === "undefined" ? undefined : window.electronAPI;
	const canCheck = Boolean(api?.mediaFilesExist);
	const recheck = useCallback(() => setTick((value) => value + 1), []);

	useEffect(() => {
		if (!api?.onRecordingsLibraryChanged) return;
		void api.recordingsLibraryWatch?.(true);
		const off = api.onRecordingsLibraryChanged(recheck);
		window.addEventListener("focus", recheck);
		return () => {
			off();
			window.removeEventListener("focus", recheck);
		};
	}, [api, recheck]);

	useEffect(() => {
		void tick;
		const current = useProjectStore.getState().document;
		const key = `${projectId}\n${signature}`;
		if (!canCheck || !current) {
			setResult({ key, projectId, missing: [] });
			return;
		}
		const files = mediaFilesOf(current);
		let cancelled = false;
		void window.electronAPI
			?.mediaFilesExist?.(files.map((file) => file.path))
			.then((answer) => {
				if (cancelled) return;
				setResult({
					key,
					projectId,
					missing: answer.success ? missingMediaOf(files, answer.exists) : [],
				});
			})
			.catch(() => {
				if (!cancelled) setResult({ key, projectId, missing: [] });
			});
		return () => {
			cancelled = true;
		};
	}, [canCheck, projectId, signature, tick]);

	return {
		missing: result.projectId === projectId ? result.missing : [],
		// A project already checked stays on screen while its paths are checked again (an
		// asset added, a relink); only a project that was never checked waits for the answer.
		checked: !canCheck || !projectId || result.projectId === projectId,
		recheck,
	};
}

/**
 * Shown in place of the preview and the timeline while the open project's recording is
 * gone. Three ways out: point at the file (Locate...), take it out of the project, or close
 * the project.
 */
export function MissingMediaPanel({
	missing,
	onResolved,
}: {
	missing: MediaFileRef[];
	onResolved: () => void;
}) {
	const t = useScopedT("editor");
	const [busy, setBusy] = useState(false);
	const screens = missing.filter((file) => file.role === "screen");

	const locate = async () => {
		const first = missing[0];
		if (!first) return;
		const picked = await window.electronAPI?.openVideoFilePicker();
		if (!picked?.success || !picked.path) return;
		const store = useProjectStore.getState();
		const document = store.document;
		if (!document) return;
		setBusy(true);
		try {
			const next = relinkDocument(document, first, picked.path);
			if (await store.saveDocument(next, { history: true })) {
				// Reloaded so the main process grants the files the document now names.
				await store.refresh();
				toast.success(t("missingMedia.relinked"));
			}
		} finally {
			setBusy(false);
			onResolved();
		}
	};

	const remove = async () => {
		const store = useProjectStore.getState();
		setBusy(true);
		try {
			for (const assetId of new Set(screens.map((file) => file.assetId))) {
				await store.removeAsset(assetId);
			}
			const after = useProjectStore.getState().document;
			if (after) {
				const next = dropMissingCameras(
					after,
					missing.filter((file) => !screens.some((screen) => screen.assetId === file.assetId)),
				);
				if (next !== after) await store.saveDocument(next, { history: true });
			}
			toast.success(t("missingMedia.removed"));
		} catch (error) {
			toast.error(t("missingMedia.removeFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
			onResolved();
		}
	};

	const close = () => {
		useProjectStore.getState().clear();
		onResolved();
	};

	return (
		<div
			data-testid="missing-media-panel"
			role="alertdialog"
			aria-labelledby="missing-media-title"
			style={{
				position: "absolute",
				inset: 0,
				display: "grid",
				placeItems: "center",
				padding: 24,
			}}
		>
			<div
				style={{
					maxWidth: 520,
					width: "100%",
					padding: 24,
					borderRadius: 16,
					background: "var(--surface)",
					border: "1px solid var(--border)",
					boxShadow: "0 12px 40px rgba(0,0,0,.18)",
				}}
			>
				<div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
					<FileWarning size={22} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }} />
					<div style={{ minWidth: 0 }}>
						<h2
							id="missing-media-title"
							style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--fg-emphasis)" }}
						>
							{t("missingMedia.title")}
						</h2>
						<p
							style={{ margin: "6px 0 12px", fontSize: 13, lineHeight: 1.5, color: "var(--fg-2)" }}
						>
							{t("missingMedia.body")}
						</p>
						<ul style={{ margin: "0 0 16px", padding: 0, listStyle: "none" }}>
							{missing.map((file) => (
								<li
									key={`${file.role}:${file.path}`}
									title={file.path}
									style={{
										fontSize: 12,
										color: "var(--muted)",
										padding: "4px 0",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
									}}
								>
									<strong style={{ color: "var(--fg-2)" }}>
										{file.role === "camera" ? t("missingMedia.camera") : t("missingMedia.screen")}
									</strong>{" "}
									{file.path}
								</li>
							))}
						</ul>
					</div>
				</div>
				<div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={close}
						disabled={busy}
						data-testid="missing-media-close"
					>
						<X size={14} />
						{t("missingMedia.close")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.dangerBtn}`}
						onClick={() => void remove()}
						disabled={busy}
						data-testid="missing-media-remove"
					>
						<Trash2 size={14} />
						{t("missingMedia.remove")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={() => void locate()}
						disabled={busy}
						data-testid="missing-media-locate"
					>
						<FolderSearch size={14} />
						{t("missingMedia.locate")}
					</button>
				</div>
			</div>
		</div>
	);
}
