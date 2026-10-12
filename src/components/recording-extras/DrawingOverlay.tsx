import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	DEFAULT_DRAWING_STYLE,
	type DrawingPhase,
	type DrawingStyle,
} from "@/lib/drawing/overlayState";
import {
	arrowHead,
	boxBetween,
	extendStroke,
	isWorthKeeping,
	liveStrokes,
	type Point,
	type Stroke,
	strokeOpacity,
	strokePaint,
} from "@/lib/drawing/strokes";

function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, opacity: number) {
	const paint = strokePaint(stroke);
	ctx.save();
	ctx.globalAlpha = opacity * paint.alpha;
	ctx.strokeStyle = stroke.color;
	ctx.fillStyle = stroke.color;
	ctx.lineWidth = paint.width;
	ctx.lineCap = stroke.tool === "highlighter" ? "square" : "round";
	ctx.lineJoin = "round";
	const [first, last] = [stroke.points[0], stroke.points.at(-1)];
	if (!first || !last) {
		ctx.restore();
		return;
	}
	ctx.beginPath();
	switch (stroke.tool) {
		case "pen":
		case "highlighter": {
			if (stroke.points.length === 1) {
				// A click: a dot the size of the line.
				ctx.arc(first.x, first.y, paint.width / 2, 0, Math.PI * 2);
				ctx.fill();
				break;
			}
			ctx.moveTo(first.x, first.y);
			// Through the midpoints, so a fast stroke is a curve and not a polygon.
			for (let i = 1; i < stroke.points.length - 1; i += 1) {
				const point = stroke.points[i];
				const next = stroke.points[i + 1];
				ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
			}
			ctx.lineTo(last.x, last.y);
			ctx.stroke();
			break;
		}
		case "arrow": {
			ctx.moveTo(first.x, first.y);
			ctx.lineTo(last.x, last.y);
			ctx.stroke();
			const [left, right] = arrowHead(first, last, paint.width);
			ctx.beginPath();
			ctx.moveTo(last.x, last.y);
			ctx.lineTo(left.x, left.y);
			ctx.lineTo(right.x, right.y);
			ctx.closePath();
			ctx.fill();
			break;
		}
		case "rectangle": {
			const box = boxBetween(first, last);
			ctx.strokeRect(box.x, box.y, box.width, box.height);
			break;
		}
		case "ellipse": {
			const box = boxBetween(first, last);
			ctx.ellipse(
				box.x + box.width / 2,
				box.y + box.height / 2,
				box.width / 2,
				box.height / 2,
				0,
				0,
				Math.PI * 2,
			);
			ctx.stroke();
			break;
		}
	}
	ctx.restore();
}

/**
 * The drawing layer: a transparent window over the recorded display (NOT content-protected,
 * so what is drawn is in the video). It only takes the mouse in drawing mode; the main process
 * makes it click-through otherwise. Finished strokes fade out after the toolbar's time.
 */
export function DrawingOverlay() {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const strokesRef = useRef<Stroke[]>([]);
	const currentRef = useRef<Stroke | null>(null);
	const nextIdRef = useRef(1);
	const styleRef = useRef<DrawingStyle>(DEFAULT_DRAWING_STYLE);
	const reportedVisibleRef = useRef(false);
	const frameRef = useRef<number | null>(null);
	const [phase, setPhase] = useState<DrawingPhase>("off");

	const reportVisible = useCallback((visible: boolean) => {
		if (visible === reportedVisibleRef.current) return;
		reportedVisibleRef.current = visible;
		window.recordingExtrasAPI?.reportStrokesVisible(visible);
	}, []);

	// One frame: prunes what faded, paints the rest, and keeps going while anything shows.
	const render = useCallback(() => {
		frameRef.current = null;
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const now = Date.now();
		const { fadeSeconds } = styleRef.current;
		strokesRef.current = liveStrokes(strokesRef.current, now, fadeSeconds);
		const scale = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(scale, 0, 0, scale, 0, 0);
		const all = currentRef.current
			? [...strokesRef.current, currentRef.current]
			: strokesRef.current;
		for (const stroke of all) {
			paintStroke(ctx, stroke, strokeOpacity(stroke, now, fadeSeconds));
		}
		reportVisible(all.length > 0);
		// Fading needs every frame; strokes that never fade need none until something changes.
		if (all.length > 0 && (fadeSeconds > 0 || currentRef.current)) {
			frameRef.current = requestAnimationFrame(render);
		}
	}, [reportVisible]);

	const schedule = useCallback(() => {
		if (frameRef.current === null) frameRef.current = requestAnimationFrame(render);
	}, [render]);

	useEffect(() => {
		const resize = () => {
			const canvas = canvasRef.current;
			if (!canvas) return;
			const scale = window.devicePixelRatio || 1;
			canvas.width = Math.round(window.innerWidth * scale);
			canvas.height = Math.round(window.innerHeight * scale);
			schedule();
		};
		resize();
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, [schedule]);

	useEffect(() => {
		const api = window.recordingExtrasAPI;
		if (!api) return;
		const apply = (state: { phase: DrawingPhase; style: DrawingStyle }) => {
			styleRef.current = state.style;
			setPhase(state.phase);
			if (state.phase !== "drawing" && currentRef.current) {
				// Left in the middle of a stroke: it is kept as drawn.
				const stroke = { ...currentRef.current, finishedAtMs: Date.now() };
				currentRef.current = null;
				if (isWorthKeeping(stroke)) strokesRef.current = [...strokesRef.current, stroke];
			}
			schedule();
		};
		void api
			.getDrawingState()
			.then(apply)
			.catch(() => undefined);
		const offState = api.onDrawingState(apply);
		const offCommand = api.onDrawingCommand((command) => {
			if (command === "clear") {
				strokesRef.current = [];
				currentRef.current = null;
			} else {
				strokesRef.current = strokesRef.current.slice(0, -1);
			}
			schedule();
		});
		return () => {
			offState();
			offCommand();
		};
	}, [schedule]);

	useEffect(
		() => () => {
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
		},
		[],
	);

	const pointAt = (event: ReactPointerEvent): Point => ({ x: event.clientX, y: event.clientY });

	const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		if (phase !== "drawing" || event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		const style = styleRef.current;
		currentRef.current = {
			id: nextIdRef.current++,
			tool: style.tool,
			color: style.color,
			width: style.width,
			points: [pointAt(event)],
			finishedAtMs: null,
		};
		schedule();
	};

	const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		const current = currentRef.current;
		if (!current) return;
		currentRef.current = extendStroke(current, pointAt(event));
		schedule();
	};

	const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		const current = currentRef.current;
		if (!current) return;
		currentRef.current = null;
		const stroke = { ...extendStroke(current, pointAt(event)), finishedAtMs: Date.now() };
		if (isWorthKeeping(stroke)) strokesRef.current = [...strokesRef.current, stroke];
		schedule();
	};

	return (
		<canvas
			ref={canvasRef}
			data-testid="drawing-overlay-canvas"
			data-phase={phase}
			className="fixed inset-0 h-screen w-screen select-none"
			style={{ cursor: phase === "drawing" ? "crosshair" : "default", touchAction: "none" }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
		/>
	);
}
