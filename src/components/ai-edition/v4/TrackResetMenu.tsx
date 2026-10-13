// A timeline lane's context menu: right-click a lane (or the clip row) for "Restaurar" of that
// track, or of the whole project. The lanes have no header to hang a menu on, so the lane itself
// is the target. Each row asks first (ProjectResetDialog) and is one Ctrl+Z; the same resets
// are in the OpenScreen menu for the keyboard.

import { RotateCcw } from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { ProjectResetScope } from "@/lib/ai-edition/document/projectReset";
import { moveMenuFocus } from "@/lib/menuKeyboard";
import { requestProjectReset } from "../projectReset";
import styles from "./EditorShellV4.module.css";

type TrackScope = Exclude<ProjectResetScope, "all">;

export function useTrackResetMenu(enabled: boolean) {
	const te = useScopedT("editor");
	const [menu, setMenu] = useState<{ scope: TrackScope; x: number; y: number } | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	const onContextMenuFor = useCallback(
		(scope: TrackScope) => (e: MouseEvent) => {
			if (!enabled) return;
			e.preventDefault();
			e.stopPropagation();
			setMenu({ scope, x: e.clientX, y: e.clientY });
		},
		[enabled],
	);

	useEffect(() => {
		if (!menu) return;
		const onDocMouseDown = (e: globalThis.MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
		};
		const onDocKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setMenu(null);
		};
		document.addEventListener("mousedown", onDocMouseDown);
		document.addEventListener("keydown", onDocKeyDown);
		menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
		return () => {
			document.removeEventListener("mousedown", onDocMouseDown);
			document.removeEventListener("keydown", onDocKeyDown);
		};
	}, [menu]);

	const pick = (scope: ProjectResetScope) => () => {
		setMenu(null);
		requestProjectReset(scope);
	};

	const node = menu ? (
		<div
			ref={menuRef}
			role="menu"
			data-testid="track-reset-menu"
			aria-label={te("projectReset.menu")}
			className={styles.appMenu}
			// Fixed at the pointer, kept inside the window.
			style={{
				position: "fixed",
				left: Math.min(menu.x, window.innerWidth - 260),
				top: Math.min(menu.y, window.innerHeight - 110),
				bottom: "auto",
			}}
			onKeyDown={moveMenuFocus}
		>
			<button
				type="button"
				role="menuitem"
				className={styles.appMenuRow}
				data-testid={`track-reset-${menu.scope}`}
				onClick={pick(menu.scope)}
			>
				<RotateCcw size={15} />
				{te(`projectReset.${menu.scope}.menu`)}
			</button>
			<button
				type="button"
				role="menuitem"
				className={styles.appMenuRow}
				data-testid="track-reset-all"
				onClick={pick("all")}
			>
				<RotateCcw size={15} />
				{te("projectReset.all.menu")}
			</button>
		</div>
	) : null;

	return { onContextMenuFor, menu: node };
}
