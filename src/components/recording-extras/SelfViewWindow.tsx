import { Circle, Square, VideoOff } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
	type WheelEvent,
} from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { useCameraPreviewStream } from "@/hooks/useCameraPreviewStream";
import type { SelfViewFrameMessage, SelfViewSnapshot } from "@/lib/recordingExtrasApi";

const RESIZE_STEP = 24;

/** Draws `frame` into `canvas` the way `object-fit: cover` would, mirrored like a mirror. */
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
	const scale = window.devicePixelRatio || 1;
	const width = Math.round(canvas.clientWidth * scale);
	const height = Math.round(canvas.clientHeight * scale);
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	const cover = Math.max(width / frame.width, height / frame.height);
	const drawWidth = frame.width * cover;
	const drawHeight = frame.height * cover;
	ctx.setTransform(-1, 0, 0, 1, width, 0);
	ctx.imageSmoothingQuality = "medium";
	ctx.drawImage(scratch, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

/**
 * The floating camera self-view: the user sees themselves, the video never does (the window is
 * content-protected). Between takes it opens the camera itself; during a take the recording
 * helper owns the camera, so it lets go and paints the small frames the helper sends.
 */
export function SelfViewWindow() {
	const t = useScopedT("launch");
	const [state, setState] = useState<SelfViewSnapshot | null>(null);
	const [hasHelperFrame, setHasHelperFrame] = useState(false);
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

	const ownCamera = state?.source === "camera";
	const { stream, error } = useCameraPreviewStream({
		enabled: Boolean(state && ownCamera),
		deviceId: state?.deviceId ?? undefined,
	});

	// The take's helper is about to open the camera: the stream above is already stopped
	// (its effect ran first), so the main process may spawn it.
	useEffect(() => {
		if (state?.source !== "helper") {
			setHasHelperFrame(false);
			return;
		}
		window.recordingExtrasAPI?.selfViewCameraReleased();
	}, [state?.source]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.srcObject = stream;
		return () => {
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
				setHasHelperFrame(true);
			}
			api.ackSelfViewFrame();
		});
	}, []);

	const api = window.recordingExtrasAPI;
	const shape = state?.shape ?? "circle";
	const radius = shape === "circle" ? "50%" : "18%";

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

	const showVideo = ownCamera && stream && !error;
	const showCanvas = !ownCamera;
	const placeholder = (ownCamera && (!stream || error)) || (!ownCamera && !hasHelperFrame);

	return (
		<div
			data-testid="self-view"
			data-source={state?.source ?? "camera"}
			className="group relative h-screen w-screen cursor-grab select-none overflow-hidden bg-[#0b0d10] active:cursor-grabbing"
			style={{ borderRadius: radius }}
			title={t("selfView.windowTip")}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
			onWheel={handleWheel}
		>
			<video
				ref={videoRef}
				className="absolute inset-0 h-full w-full object-cover"
				style={{ transform: "scaleX(-1)", display: showVideo ? "block" : "none" }}
				autoPlay
				muted
				playsInline
			/>
			<canvas
				ref={canvasRef}
				className="absolute inset-0 h-full w-full"
				style={{ display: showCanvas ? "block" : "none" }}
			/>
			{placeholder ? (
				<div className="absolute inset-0 flex items-center justify-center text-[#6b7480]">
					<VideoOff size={28} />
				</div>
			) : null}
			<div
				className="pointer-events-none absolute inset-0 border-2 border-white/15"
				style={{ borderRadius: radius }}
			/>
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
