// The top bar's undo / redo arrows, each with the history behind it: a click is one step, as
// Ctrl+Z / Ctrl+Shift+Z; a right-click, a long press, Shift+F10 or the menu key lists the steps
// (nearest first, each with its name: "Mover zoom", "Cortar trecho", "Resposta da IA"...), and
// choosing one walks back -- or forward -- to it in ONE step (`undo(steps)` / `redo(steps)`).

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useScopedT } from "@/contexts/I18nContext";
import { type HistoryEntry, historyEntries } from "@/lib/ai-edition/store/undo";
import { moveMenuFocus } from "@/lib/menuKeyboard";
import styles from "./EditorShellV4.module.css";

/** Rows the menu lists before it folds the rest into "N older steps": a list longer than a
 *  screen is not a menu, and a jump that far back is more Ctrl+Z than choice. */
export const HISTORY_MENU_MAX_ROWS = 20;

/** How long a press must last to open the list instead of clicking (touch and pen). */
const LONG_PRESS_MS = 500;

export function HistoryButton({
	kind,
	enabled,
	label,
	shortcut,
	icon,
	onStep,
	onJump,
}: {
	kind: "undo" | "redo";
	enabled: boolean;
	label: string;
	shortcut?: string;
	icon: ReactNode;
	/** One step: the button's click. */
	onStep: () => void;
	/** `steps` steps at once: a row of the list. Absent, the list does not open. */
	onJump?: (steps: number) => void;
}) {
	const te = useScopedT("editor");
	const [open, setOpen] = useState(false);
	const [entries, setEntries] = useState<HistoryEntry[]>([]);
	const anchorRef = useRef<HTMLSpanElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The click that ends a long press opened the list: it must not also step.
	const swallowClick = useRef(false);

	const openList = () => {
		if (!onJump) return;
		const list = historyEntries()[kind];
		if (list.length === 0) return;
		setEntries(list);
		setOpen(true);
	};

	const cancelPress = () => {
		if (pressTimer.current) clearTimeout(pressTimer.current);
		pressTimer.current = null;
	};

	// A press still timing when the arrow unmounts must not open a list on nothing.
	useEffect(
		() => () => {
			if (pressTimer.current) clearTimeout(pressTimer.current);
		},
		[],
	);

	useEffect(() => {
		if (!open) return;
		const onDocMouseDown = (e: MouseEvent) => {
			if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
		};
		// As the app menu: on the document, and Escape goes back to the arrow and no further.
		const onDocKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("mousedown", onDocMouseDown);
		document.addEventListener("keydown", onDocKeyDown);
		menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
		return () => {
			document.removeEventListener("mousedown", onDocMouseDown);
			document.removeEventListener("keydown", onDocKeyDown);
		};
	}, [open]);

	const shown = entries.slice(0, HISTORY_MENU_MAX_ROWS);
	const hidden = entries.length - shown.length;
	const menuId = `history-menu-${kind}`;

	return (
		<span ref={anchorRef} className={styles.appMenuAnchor}>
			<Tooltip content={`${label} · ${te("history.listHint")}`} shortcut={shortcut}>
				{/* `aria-disabled`, not `disabled`: a natively disabled button takes no pointer
				    events, so the tooltip could never open on it. The click does nothing while it
				    is set. */}
				<button
					ref={triggerRef}
					type="button"
					className={styles.iconBtn}
					data-testid={`history-${kind}`}
					aria-label={label}
					aria-disabled={!enabled || undefined}
					aria-haspopup={onJump ? "menu" : undefined}
					aria-expanded={onJump ? open : undefined}
					aria-controls={open ? menuId : undefined}
					onClick={() => {
						if (swallowClick.current) {
							swallowClick.current = false;
							return;
						}
						if (enabled) onStep();
					}}
					onContextMenu={(e) => {
						e.preventDefault();
						cancelPress();
						openList();
					}}
					onPointerDown={(e) => {
						if (e.button !== 0 || e.pointerType === "mouse") return;
						cancelPress();
						pressTimer.current = setTimeout(() => {
							pressTimer.current = null;
							swallowClick.current = true;
							openList();
						}, LONG_PRESS_MS);
					}}
					onPointerUp={cancelPress}
					onPointerLeave={cancelPress}
					onPointerCancel={cancelPress}
					onKeyDown={(e) => {
						if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
							e.preventDefault();
							openList();
						}
					}}
				>
					{icon}
				</button>
			</Tooltip>
			{open ? (
				<div
					ref={menuRef}
					id={menuId}
					data-testid={`history-menu-${kind}`}
					className={`${styles.appMenu} ${styles.historyMenu}`}
					role="menu"
					aria-label={te(kind === "undo" ? "history.undoTitle" : "history.redoTitle")}
					onKeyDown={moveMenuFocus}
				>
					<div className={styles.historyMenuTitle} aria-hidden>
						{te(kind === "undo" ? "history.undoTitle" : "history.redoTitle")}
					</div>
					{shown.map((entry) => (
						<button
							key={entry.steps}
							type="button"
							role="menuitem"
							className={styles.appMenuRow}
							data-testid="history-entry"
							onClick={() => {
								setOpen(false);
								onJump?.(entry.steps);
							}}
						>
							<span className={styles.historyMenuLabel}>{te(`history.labels.${entry.label}`)}</span>
							{/* How far the row is, as a signed count: no plural to translate. */}
							<span className={styles.appMenuVersion} aria-hidden>
								{kind === "undo" ? `−${entry.steps}` : `+${entry.steps}`}
							</span>
						</button>
					))}
					{hidden > 0 ? (
						<div className={styles.historyMenuMore}>{te("history.more", { count: hidden })}</div>
					) : null}
				</div>
			) : null}
		</span>
	);
}
