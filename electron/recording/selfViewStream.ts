/**
 * The camera preview frames the Windows helper writes to the self-view pipe while it owns the
 * camera (`SelfViewPreviewPublisher`, webcam_preview.h). Each frame is a 16-byte header --
 * "OSV1", width and height (u16 LE), format (u8, 1 = RGBA), 3 reserved bytes, payload length
 * (u32 LE) -- then the payload. The pipe is a byte stream, so a frame can arrive split over
 * several chunks, or several frames in one.
 */

export const SELF_VIEW_HEADER_BYTES = 16;
export const SELF_VIEW_FORMAT_RGBA = 1;
/** Nothing the helper sends is bigger than 320 px a side; anything far past it is garbage. */
const MAX_SIDE = 4096;

export interface SelfViewFrame {
	width: number;
	height: number;
	/** Tightly packed RGBA, width * height * 4 bytes. */
	rgba: Buffer;
}

export class SelfViewFrameParser {
	private pending: Buffer = Buffer.alloc(0);
	private broken = false;

	/** The complete frames this chunk finishes. Throws once on a stream that is not frames. */
	push(chunk: Buffer): SelfViewFrame[] {
		if (this.broken) return [];
		this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
		const frames: SelfViewFrame[] = [];
		while (this.pending.length >= SELF_VIEW_HEADER_BYTES) {
			const header = this.pending;
			if (header.toString("latin1", 0, 4) !== "OSV1") {
				this.fail("bad magic");
			}
			const width = header.readUInt16LE(4);
			const height = header.readUInt16LE(6);
			const format = header.readUInt8(8);
			const length = header.readUInt32LE(12);
			if (
				format !== SELF_VIEW_FORMAT_RGBA ||
				width === 0 ||
				height === 0 ||
				width > MAX_SIDE ||
				height > MAX_SIDE ||
				length !== width * height * 4
			) {
				this.fail(`bad header ${width}x${height} format=${format} length=${length}`);
			}
			const end = SELF_VIEW_HEADER_BYTES + length;
			if (this.pending.length < end) break;
			// A copy: the pending buffer is reused for whatever follows.
			frames.push({
				width,
				height,
				rgba: Buffer.from(this.pending.subarray(SELF_VIEW_HEADER_BYTES, end)),
			});
			this.pending = this.pending.subarray(end);
		}
		return frames;
	}

	private fail(reason: string): never {
		this.broken = true;
		this.pending = Buffer.alloc(0);
		throw new Error(`self-view stream: ${reason}`);
	}
}

/**
 * At most one frame on its way to the self-view window. The helper sends ~15 a second; a
 * window that paints slower (hidden, busy, being dragged) gets the newest one when it has
 * painted the last, never a queue of stale ones.
 */
export class LatestFrameMailbox<T> {
	private inFlight = false;
	private waiting: T | null = null;

	/** The frame to send now, or null when one is still being painted (it is kept instead). */
	offer(frame: T): T | null {
		if (this.inFlight) {
			this.waiting = frame;
			return null;
		}
		this.inFlight = true;
		return frame;
	}

	/** The window painted the last one: the newest waiting frame, if any, goes now. */
	ack(): T | null {
		const next = this.waiting;
		this.waiting = null;
		this.inFlight = next !== null;
		return next;
	}

	reset(): void {
		this.inFlight = false;
		this.waiting = null;
	}
}
