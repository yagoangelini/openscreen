import { open } from "node:fs/promises";

/** More top-level boxes than any real MP4 has: past this the file is not one. */
const MAX_TOP_LEVEL_BOXES = 64;

/**
 * Whether an MP4 or M4A file carries its index: a whole top-level `moov` box.
 *
 * A plain (non-fragmented) MP4 writer puts `moov` at the end, when it finalizes, so a
 * file whose writer died first holds every sample and no way to find them: not empty,
 * and not playable. The size of the file says nothing about that; walking its boxes
 * does, and costs a handful of 16-byte reads however long the recording is.
 */
export async function hasMp4Index(filePath: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(filePath, "r");
		const { size } = await handle.stat();
		const header = Buffer.alloc(16);
		let offset = 0;
		for (let boxes = 0; offset + 8 <= size && boxes < MAX_TOP_LEVEL_BOXES; boxes++) {
			const { bytesRead } = await handle.read(header, 0, 16, offset);
			if (bytesRead < 8) return false;
			let boxSize = header.readUInt32BE(0);
			const type = header.toString("latin1", 4, 8);
			if (boxSize === 1) {
				// A 64-bit size follows the type: what a long `mdat` uses.
				if (bytesRead < 16) return false;
				boxSize = Number(header.readBigUInt64BE(8));
			} else if (boxSize === 0) {
				// "To the end of the file": what a writer leaves in `mdat` before it finalizes.
				boxSize = size - offset;
			}
			if (type === "moov") return boxSize >= 8 && offset + boxSize <= size;
			if (boxSize < 8) return false;
			offset += boxSize;
		}
		return false;
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}
