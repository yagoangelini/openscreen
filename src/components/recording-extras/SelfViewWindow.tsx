import { Circle, Square, VideoOff } from "lucide-react";
import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
	type WheelEvent,
} from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { useCameraPreviewStream } from "@/hooks/useCameraPreviewStream";
import type {
	SelfViewFrameMessage,
	SelfViewShape,
	SelfViewSnapshot,
} from "@/lib/recordingExtrasApi";

const RESIZE_STEP = 24;

/**
 * The crop, for both sources. A `clip-path`, not `overflow: hidden` plus a border radius:
 * Chromium can hand a playing <video> to the compositor as its own layer, and that layer
 * was not clipped by the parent's rounded corners. Before a take the self-view showed the
 * camera as a full square, with the faint ring that used to be drawn on top marking where
 * the crop should have been; during a take (frames painted on a canvas) it was cropped.
 * Now both are painted on the same canvas and clipped the same way.
 */
export function selfViewShapeStyle(shape: SelfViewShape): CSSProperties {
	return shape === "circle"
		? { borderRadius: "50%", clipPath: "circle(50% at 50% 50%)" }
		: { borderRadius: "18%", clipPath: "inset(0 round 18%)" };
}

/** Draws `source` into `canvas` the way `object-fit: cover` would, mirrored like a mirror. */
function paintCover(
	canvas: HTMLCanvasElement,
	source: CanvasImageSource,
	sourceWidth: number,
	sourceHeight: number,
) {
	const ctx = canvas.getContext("2d");
	if (!ctx || sourceWidth <= 0 || sourceHeight <= 0) return false;
	const scale = window.devicePixelRatio || 1;
	const width = Math.round(canvas.clientWidth * scale);
	const height = Math.round(canvas.clientHeight * scale);
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	const cover = Math.max(width / sourceWidth, height / sourceHeight);
	const drawWidth = sourceWidth * cover;
	const drawHeight = sourceHeight * cover;
	ctx.setTransform(-1, 0, 0, 1, width, 0);
	ctx.imageSmoothingQuality = "medium";
	ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
	return true;
}

/** A helper frame (RGBA bytes) through a scratch canvas, then like any other source. */
function paintFrame(
	canvas: HTMLCanvasElement,
	scratch: HTMLCanvasElement,
	frame: SelfViewFrameMessage,
) {
	if (scratch.width !== frame.width || scratch.height !== frame.height) {
		scratch.width = frame.width;
		scratch.height = frame.height;
	}
	const scratchCtx = scratch.getContext("2d");
	const ctx = canvas.getContext("2d");
	if (!scratchCtx || !ctx) return;
	const pixels = new Uint8ClampedArray(
		frame.rgba.buffer as ArrayBuffer,
		frame.rgba.byteOffset,
		frame.rgba.byteLength,
	);
	scratchCtx.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
	paintCover(canvas, scratch, frame.width, frame.height);
}

/**
 * The floating camera self-view: the user sees themselves, the video never does (the window is
 * content-protected). Between takes it opens the camera itself; during a take the recording
 * helper owns the camera, so it lets go and paints the small frames the helper sends. Both
 * end up on the same canvas, mirrored, covering the window and clipped to the same shape, so
 * what the user sees before a take is what they see during it.
 */
export function SelfViewWindow() {
	const t = useScopedT("launch");
	const [state, setState] = useState<SelfViewSnapshot | null>(null);
	const [hasFrame, setHasFrame] = useState(false);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const scratchRef = useRef<HTMLCanvasElement | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const dragRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);

	useEffect(() => {
		const api = window.recordingExtrasAPI;
		if (!api) return;
		void api
			.getSelfViewState()
			.then(setState)
			.catch(() => undefined);
		return api.onSelfViewState(setState);
	}, []);

	const source = state?.source;
	const ownCamera = source === "camera";
	const { stream, error } = useCameraPreviewStream({
		enabled: Boolean(state && ownCamera),
		deviceId: state?.deviceId ?? undefined,
	});

	// A new source has painted nothing yet: the placeholder until it does. The take's
	// helper is about to open the camera: the stream above is already stopped (its effect
	// ran first), so the main process may spawn it.
	useEffect(() => {
		setHasFrame(false);
		if (source === "helper") window.recordingExtrasAPI?.selfViewCameraReleased();
	}, [source]);

	// Between takes: the camera's own frames, painted onto the canvas as they arrive. The
	// <video> only decodes; it is never what the user sees (see selfViewShapeStyle).
	useEffect(() => {
		const video = videoRef.current;
		if (!video || !stream) return;
		video.srcObject = stream;
		let cancelled = false;
		let handle = 0;
		const usesFrameCallback = typeof video.requestVideoFrameCallback === "function";
		const paint = () => {
			if (cancelled) return;
			const canvas = canvasRef.current;
			if (canvas && video.readyState >= 2) {
				if (paintCover(canvas, video, video.videoWidth, video.videoHeight)) setHasFrame(true);
			}
			handle = usesFrameCallback
				? video.requestVideoFrameCallback(paint)
				: window.requestAnimationFrame(paint);
		};
		video.play?.()?.catch(() => undefined);
		paint();
		return () => {
			cancelled = true;
			if (usesFrameCallback) video.cancelVideoFrameCallback(handle);
			else window.cancelAnimationFrame(handle);
			video.srcObject = null;
		};
	}, [stream]);

	useEffect(() => {
		const api = window.recordingExtrasAPI;
		if (!api) return;
		return api.onSelfViewFrame((frame) => {
			const canvas = canvasRef.current;
			if (canvas) {
				scratchRef.current ??= document.createElement("canvas");
				paintFrame(canvas, scratchRef.current, frame);
				setHasFrame(true);
			}
			api.ackSelfViewFrame();
		});
	}, []);

	const api = window.recordingExtrasAPI;
	const shape = state?.shape ?? "circle";

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { x: event.screenX, y: event.screenY, pointerId: event.pointerId };
		api?.selfViewDragStart();
	};
	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		api?.selfViewDragTo(event.screenX - drag.x, event.screenY - drag.y);
	};
	const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
		dragRef.current = null;
		api?.selfViewDragEnd();
	};
	const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
		const step = event.deltaY < 0 ? RESIZE_STEP : -RESIZE_STEP;
		api?.selfViewResize(window.innerWidth + step);
	};

	const placeholder = !hasFrame || (ownCamera && (!stream || Boolean(error)));

	return (
		<div
			data-testid="self-view"
			data-source={source ?? "camera"}
			data-shape={shape}
			className="group relative h-screen w-screen cursor-grab select-none overflow-hidden bg-[#0b0d10] active:cursor-grabbing"
			style={selfViewShapeStyle(shape)}
			title={t("selfView.windowTip")}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
			onWheel={handleWheel}
		>
			{/* Decoder only: one transparent pixel, so the compositor never shows it. */}
			<video
				ref={videoRef}
				data-testid="self-view-decoder"
				className="pointer-events-none absolute top-0 left-0 h-px w-px opacity-0"
				aria-hidden="true"
				autoPlay
				muted
				playsInline
			/>
			<canvas
				ref={canvasRef}
				data-testid="self-view-canvas"
				className="absolute inset-0 h-full w-full"
			/>
			{placeholder ? (
				<div className="absolute inset-0 flex items-center justify-center text-[#6b7480]">
					<VideoOff size={28} />
				</div>
			) : null}
			<button
				type="button"
				data-testid="self-view-shape"
				aria-label={shape === "circle" ? t("selfView.makeRounded") : t("selfView.makeCircle")}
				title={shape === "circle" ? t("selfView.makeRounded") : t("selfView.makeCircle")}
				className="absolute bottom-[14%] left-1/2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full bg-black/60 text-white/85 opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
				onPointerDown={(event) => event.stopPropagation()}
				onClick={() => api?.setSelfViewShape(shape === "circle" ? "rounded" : "circle")}
			>
				{shape === "circle" ? <Square size={14} /> : <Circle size={14} />}
			</button>
		</div>
	);
}
