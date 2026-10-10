import { describe, expect, it } from "vitest";
import {
	detectSensitive,
	type OcrSample,
	parseOcrScan,
	redactionAnnotations,
	trackDetections,
} from "./redaction";
import { type AxcutDocument, createEmptyDocument } from "./schema";

/** One OCR line of words laid left to right, 0.05 wide each. */
function line(texts: string[], y = 0.4, startIndex = 0): OcrSample {
	return {
		t: 0,
		words: texts.map((text, i) => [0.1 + i * 0.06, y, 0.05, 0.02, text]),
		lines: [[startIndex, texts.length]],
	};
}

const kinds = (sample: OcrSample) => detectSensitive(sample).map((d) => [d.kind, d.text]);

describe("detectSensitive", () => {
	it("finds e-mails, tenant domains, GUIDs, secrets and phone numbers", () => {
		expect(kinds(line(["Signed", "in", "as", "ana.souza@contoso.com"]))).toEqual([
			["email", "ana.souza@contoso.com"],
		]);
		expect(kinds(line(["https://contoso.sharepoint.com/sites/rh"]))).toEqual([
			["tenant", "contoso.sharepoint.com"],
		]);
		expect(kinds(line(["admin@contoso.onmicrosoft.com"]))).toEqual([
			["tenant", "contoso.onmicrosoft.com"],
		]);
		expect(kinds(line(["Tenant", "ID", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"]))).toEqual([
			["guid", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
		]);
		expect(kinds(line(["Bearer", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123"]))[0]?.[0]).toBe(
			"secret",
		);
		expect(kinds(line(["Ligue", "(11)", "91234-5678"]))).toEqual([["phone", "(11) 91234-5678"]]);
	});

	it("leaves ordinary text alone", () => {
		expect(kinds(line(["Novo", "fluxo", "de", "aprovação", "2026"]))).toEqual([]);
		expect(kinds(line(["ccb-bi@p"]))).toEqual([]);
		expect(kinds(line(["PowerAutomateDesktopFlowRunner"]))).toEqual([]);
	});

	it("boxes every word a match spans", () => {
		const [phone] = detectSensitive(line(["Tel", "(11)", "91234-5678"]));
		expect(phone.box.x).toBeCloseTo(0.16);
		expect(phone.box.x + phone.box.w).toBeCloseTo(0.27);
	});
});

describe("trackDetections", () => {
	const email = (t: number, y = 0.4): OcrSample => ({ ...line(["joao@fabrikam.com"], y), t });
	const blank = (t: number): OcrSample => ({ t, words: [], lines: [] });

	it("spans an address from the sample before it appears to the sample after it leaves", () => {
		const spans = trackDetections({
			durationSec: 20,
			intervalSec: 2,
			samples: [blank(0), blank(2), email(4), { t: 6, same: true }, email(8), blank(10), blank(12)],
		});
		expect(spans.map((s) => [s.kind, s.startSec, s.endSec])).toEqual([["email", 2, 10]]);
	});

	it("keeps it to the end of the take when it never leaves, and splits a move", () => {
		const spans = trackDetections({
			durationSec: 9,
			intervalSec: 2,
			samples: [email(0), email(2), email(4, 0.8), email(6, 0.8)],
		});
		expect(spans.map((s) => [s.startSec, s.endSec, s.box.y])).toEqual([
			[0, 4, 0.4],
			[2, 9, 0.8],
		]);
	});
});

describe("parseOcrScan", () => {
	it("reads the helper's lines and skips what it cannot", () => {
		const scan = parseOcrScan(
			[
				'{"type":"info","width":1920,"height":1080,"durationSec":12.5,"language":"pt-BR"}',
				'{"type":"frame","t":2.0,"words":[[0.1,0.2,0.1,0.02,"oi"],["bad"]],"lines":[[0,1]]}',
				"not json",
				'{"type":"same","t":0.0}',
				'{"type":"done","frames":2,"read":1,"ocrMs":10}',
			].join("\n"),
		);
		expect(scan.durationSec).toBe(12.5);
		expect(scan.samples.map((s) => [s.t, s.same === true, s.words?.length])).toEqual([
			[0, true, undefined],
			[2, false, 1],
		]);
	});
});

describe("redactionAnnotations", () => {
	it("blurs each span where the timeline plays it, in footage space, marked as automatic", () => {
		const base = createEmptyDocument({ projectId: "p", title: "t" });
		const document = {
			...base,
			assets: [
				{
					id: "a1",
					kind: "video",
					label: "take",
					originalPath: "C:/take.mp4",
					cameraTrack: null,
				},
			],
			timeline: {
				...base.timeline,
				clips: [
					{
						id: "c1",
						assetId: "a1",
						sourceStartSec: 10,
						sourceEndSec: 40,
						timelineStartSec: 0,
						timelineEndSec: 30,
						wordRefs: [],
						origin: "system",
						reason: "t",
					},
				],
			},
		} as AxcutDocument;
		let n = 0;
		const [blur] = redactionAnnotations(
			document,
			"a1",
			[
				{
					kind: "email",
					text: "x@y.com",
					box: { x: 0.4, y: 0.38, w: 0.1, h: 0.02 },
					startSec: 12,
					endSec: 20,
				},
			],
			(prefix) => `${prefix}_${++n}`,
		);
		expect(blur).toMatchObject({
			type: "blur",
			startMs: 2000,
			endMs: 10_000,
			annotationSource: "auto-redact",
			clipId: "c1",
		});
		expect(blur.space).toBeUndefined();
		expect(blur.position.x).toBeLessThan(40);
		expect(blur.position.x + blur.size.width).toBeGreaterThan(50);
	});
});
