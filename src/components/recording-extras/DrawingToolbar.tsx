import {
	Circle,
	GripVertical,
	Highlighter,
	MoveUpRight,
	Pencil,
	Square,
	Timer,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import {
	DEFAULT_DRAWING_STYLE,
	DRAWING_COLORS,
	DRAWING_FADE_OPTIONS,
	DRAWING_TOOLS,
	DRAWING_WIDTHS,
	type DrawingStyle,
	type DrawingTool,
} from "@/lib/drawing/overlayState";

const TOOL_ICONS: Record<DrawingTool, ReactNode> = {
	pen: <Pencil size={16} />,
	arrow: <MoveUpRight size={16} />,
	rectangle: <Square size={16} />,
	ellipse: <Circle size={16} />,
	highlighter: <Highlighter size={16} />,
};

const buttonClass =
	"flex h-8 min-w-8 items-center justify-center rounded-[9px] px-1 text-[#c3cad3] transition-colors hover:bg-white/10 hover:text-white";
const activeClass = "bg-white/15 text-white";

/**
 * The drawing tools, in a window of their own that is content-protected (like the HUD): the
 * buttons are never in the video, the strokes they make are. Shown only in drawing mode.
 */
export function DrawingToolbar() {
	const t = useScopedT("launch");
	const [style, setStyle] = useState<DrawingStyle>(DEFAULT_DRAWING_STYLE);
	const [windowCapture, setWindowCapture] = useState(false);

	useEffect(() => {
		const api = window.recordingExtrasAPI;
		if (!api) return;
		const apply = (state: { style: DrawingStyle; windowCapture: boolean }) => {
			setStyle(state.style);
			setWindowCapture(state.windowCapture);
		};
		void api
			.getDrawingState()
			.then(apply)
			.catch(() => undefined);
		return api.onDrawingState(apply);
	}, []);

	const update = (patch: Partial<DrawingStyle>) => {
		setStyle((current) => ({ ...current, ...patch }));
		void window.recordingExtrasAPI?.setDrawingStyle(patch).catch(() => undefined);
	};

	const fadeIndex = DRAWING_FADE_OPTIONS.indexOf(
		style.fadeSeconds as (typeof DRAWING_FADE_OPTIONS)[number],
	);
	const nextFade = DRAWING_FADE_OPTIONS[(fadeIndex + 1) % DRAWING_FADE_OPTIONS.length];
	const fadeLabel =
		style.fadeSeconds > 0
			? t("drawing.fadeAfter", { seconds: style.fadeSeconds })
			: t("drawing.fadeNever");

	return (
		<div className="flex h-screen w-screen select-none flex-col items-center bg-transparent pt-1">
			<div
				data-testid="drawing-toolbar"
				className="flex items-center gap-1 rounded-[14px] border border-white/10 bg-[#14171c]/95 px-1.5 py-1 shadow-xl"
			>
				<span
					className="flex h-8 w-5 cursor-grab items-center justify-center text-[#6b7480]"
					style={{ WebkitAppRegion: "drag" } as CSSProperties}
					title={t("drawing.move")}
				>
					<GripVertical size={14} />
				</span>
				{DRAWING_TOOLS.map((tool) => (
					<button
						key={tool}
						type="button"
						data-testid={`drawing-tool-${tool}`}
						aria-pressed={style.tool === tool}
						aria-label={t(`drawing.tools.${tool}`)}
						title={t(`drawing.tools.${tool}`)}
						className={`${buttonClass} ${style.tool === tool ? activeClass : ""}`}
						onClick={() => update({ tool })}
					>
						{TOOL_ICONS[tool]}
					</button>
				))}
				<span className="mx-1 h-5 w-px bg-white/10" />
				{DRAWING_COLORS.map((color) => (
					<button
						key={color}
						type="button"
						aria-pressed={style.color === color}
						aria-label={t("drawing.color", { color })}
						title={t("drawing.color", { color })}
						className={`${buttonClass} ${style.color === color ? activeClass : ""}`}
						onClick={() => update({ color })}
					>
						<span
							className="block h-4 w-4 rounded-full border border-white/40"
							style={{ background: color }}
						/>
					</button>
				))}
				<span className="mx-1 h-5 w-px bg-white/10" />
				{DRAWING_WIDTHS.map((width) => (
					<button
						key={width}
						type="button"
						aria-pressed={style.width === width}
						aria-label={t("drawing.width", { width })}
						title={t("drawing.width", { width })}
						className={`${buttonClass} ${style.width === width ? activeClass : ""}`}
						onClick={() => update({ width })}
					>
						<span
							className="block rounded-full bg-current"
							style={{ width: width + 2, height: width + 2 }}
						/>
					</button>
				))}
				<span className="mx-1 h-5 w-px bg-white/10" />
				<button
					type="button"
					data-testid="drawing-fade"
					aria-label={fadeLabel}
					title={fadeLabel}
					className={`${buttonClass} gap-1 px-2 text-xs tabular-nums`}
					onClick={() => update({ fadeSeconds: nextFade })}
				>
					<Timer size={15} />
					{style.fadeSeconds > 0 ? `${style.fadeSeconds}s` : "∞"}
				</button>
				<button
					type="button"
					aria-label={t("drawing.undo")}
					title={t("drawing.undo")}
					className={buttonClass}
					onClick={() => window.recordingExtrasAPI?.sendDrawingCommand("undo")}
				>
					<Undo2 size={16} />
				</button>
				<button
					type="button"
					data-testid="drawing-clear"
					aria-label={t("drawing.clear")}
					title={t("drawing.clear")}
					className={buttonClass}
					onClick={() => window.recordingExtrasAPI?.sendDrawingCommand("clear")}
				>
					<Trash2 size={16} />
				</button>
				<button
					type="button"
					data-testid="drawing-exit"
					aria-label={t("drawing.exit")}
					title={t("drawing.exit")}
					className={`${buttonClass} hover:bg-[rgba(248,113,113,0.16)] hover:text-[#f87171]`}
					onClick={() => window.recordingExtrasAPI?.exitDrawing()}
				>
					<X size={16} />
				</button>
			</div>
			{windowCapture ? (
				<div
					data-testid="drawing-window-capture-note"
					className="mt-1 max-w-[740px] rounded-[10px] bg-[#7c2d12]/95 px-3 py-1 text-center text-[11px] leading-snug text-[#fde7d9] shadow"
				>
					{t("drawing.windowCaptureNote")}
				</div>
			) : null}
		</div>
	);
}
