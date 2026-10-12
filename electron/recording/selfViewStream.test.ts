import { describe, expect, it } from "vitest";
import { LatestFrameMailbox, SELF_VIEW_HEADER_BYTES, SelfViewFrameParser } from "./selfViewStream";

/** A frame as webcam_preview.cpp's buildSelfViewPacket writes it. */
function packet(width: number, height: number, fill = 7, format = 1): Buffer {
	const payload = Buffer.alloc(width * height * 4, fill);
	const header = Buffer.alloc(SELF_VIEW_HEADER_BYTES);
	header.write("OSV1", 0, "latin1");
	header.writeUInt16LE(width, 4);
	header.writeUInt16LE(height, 6);
	header.writeUInt8(format, 8);
	header.writeUInt32LE(payload.length, 12);
	return Buffer.concat([header, payload]);
}

describe("SelfViewFrameParser", () => {
	it("reads a whole frame", () => {
		const frames = new SelfViewFrameParser().push(packet(320, 180));
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ width: 320, height: 180 });
		expect(frames[0].rgba.length).toBe(320 * 180 * 4);
	});

	it("joins a frame split over chunks, the header included", () => {
		const parser = new SelfViewFrameParser();
		const bytes = packet(4, 2, 9);
		expect(parser.push(bytes.subarray(0, 5))).toEqual([]);
		expect(parser.push(bytes.subarray(5, 20))).toEqual([]);
		const frames = parser.push(bytes.subarray(20));
		expect(frames).toHaveLength(1);
		expect([...frames[0].rgba]).toEqual(new Array(32).fill(9));
	});

	it("splits several frames out of one chunk, and keeps the tail", () => {
		const parser = new SelfViewFrameParser();
		const second = packet(2, 2, 2);
		const joined = Buffer.concat([packet(2, 2, 1), second, packet(2, 2, 3).subarray(0, 10)]);
		const frames = parser.push(joined);
		expect(frames.map((frame) => frame.rgba[0])).toEqual([1, 2]);
		expect(parser.push(packet(2, 2, 3).subarray(10)).map((frame) => frame.rgba[0])).toEqual([3]);
	});

	it("refuses a stream that is not frames, once", () => {
		const parser = new SelfViewFrameParser();
		expect(() => parser.push(Buffer.from("not a frame at all, really"))).toThrow(/bad magic/);
		expect(parser.push(packet(2, 2))).toEqual([]);
	});

	it("refuses a header whose length does not match its size", () => {
		const bad = packet(2, 2);
		bad.writeUInt32LE(99, 12);
		expect(() => new SelfViewFrameParser().push(bad)).toThrow(/bad header/);
	});

	it("refuses an unknown pixel format", () => {
		expect(() => new SelfViewFrameParser().push(packet(2, 2, 0, 2))).toThrow(/format=2/);
	});
});

describe("LatestFrameMailbox", () => {
	it("sends the first frame at once", () => {
		const mailbox = new LatestFrameMailbox<number>();
		expect(mailbox.offer(1)).toBe(1);
	});

	it("holds frames while one is being painted and sends only the newest", () => {
		const mailbox = new LatestFrameMailbox<number>();
		mailbox.offer(1);
		expect(mailbox.offer(2)).toBeNull();
		expect(mailbox.offer(3)).toBeNull();
		expect(mailbox.ack()).toBe(3);
		expect(mailbox.ack()).toBeNull();
		expect(mailbox.offer(4)).toBe(4);
	});

	it("starts over after a reset", () => {
		const mailbox = new LatestFrameMailbox<number>();
		mailbox.offer(1);
		mailbox.offer(2);
		mailbox.reset();
		expect(mailbox.ack()).toBeNull();
		expect(mailbox.offer(5)).toBe(5);
	});
});
