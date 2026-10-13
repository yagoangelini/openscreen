import { describe, expect, it } from "vitest";
import { buildMediaCards, samePath } from "./mediaCards";

const take = (key: string, name: string, screen: string) => ({
	key,
	name,
	screenVideoPath: screen,
	files: [screen, screen.replace(/\.mp4$/, "-webcam.mp4")],
});
const asset = (id: string, originalPath: string, label = "", kind = "video") => ({
	id,
	label,
	originalPath,
	kind,
});

describe("buildMediaCards", () => {
	const aula = take("folder:Aula", "Aula", "C:\\Rec\\Aula\\recording-1.mp4");
	const outra = take("folder:Outra", "Outra", "C:\\Rec\\Outra\\recording-2.mp4");

	it("shows a take the project uses once, as the take, with the project's asset", () => {
		const cards = buildMediaCards(
			[outra, aula],
			[asset("a1", "c:/rec/aula/recording-1.mp4", "recording-1.mp4")],
		);
		expect(cards.map((card) => card.id)).toEqual([
			"recording:folder:Aula",
			"recording:folder:Outra",
		]);
		expect(cards[0]).toMatchObject({ kind: "recording", asset: { id: "a1" } });
		expect(cards[1]).toMatchObject({ kind: "recording", asset: null });
	});

	it("keeps imported media as cards of their own, and leaves audio out", () => {
		const cards = buildMediaCards(
			[aula],
			[
				asset("v", "D:\\Clips\\intro.mp4", "intro.mp4"),
				asset("m", "D:\\Music\\bed.mp3", "bed.mp3", "audio"),
			],
		);
		expect(cards.map((card) => [card.kind, card.id])).toEqual([
			["asset", "asset:v"],
			["recording", "recording:folder:Aula"],
		]);
	});

	it("filters on the take's name, the asset's label and the paths", () => {
		const assets = [asset("v", "D:\\Clips\\intro.mp4", "Abertura")];
		expect(buildMediaCards([aula, outra], assets, "aul").map((c) => c.id)).toEqual([
			"recording:folder:Aula",
		]);
		expect(buildMediaCards([aula, outra], assets, "ABERT").map((c) => c.id)).toEqual(["asset:v"]);
		expect(buildMediaCards([aula, outra], assets, "clips").map((c) => c.id)).toEqual(["asset:v"]);
		expect(buildMediaCards([aula, outra], assets, "  ")).toHaveLength(3);
	});

	it("matches one asset per take, even when two assets point at it", () => {
		const cards = buildMediaCards(
			[aula],
			[asset("a1", aula.screenVideoPath), asset("a2", aula.screenVideoPath)],
		);
		expect(cards.map((card) => card.id)).toEqual(["recording:folder:Aula", "asset:a2"]);
	});
});

describe("samePath", () => {
	it("ignores case and the kind of slash", () => {
		expect(samePath("C:\\A\\b.mp4", "c:/a/B.MP4")).toBe(true);
		expect(samePath("C:\\A\\b.mp4", "C:\\A\\c.mp4")).toBe(false);
	});
});
