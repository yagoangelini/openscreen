import { describe, expect, it } from "vitest";
import {
	detectSensitive,
	type OcrSample,
	parseOcrScan,
	parseSensitiveTerms,
	redactionAnnotations,
	replaceAutoRedactions,
	scannedUpToSec,
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

	it("reads every common way of writing a phone number", () => {
		expect(kinds(line(["+55", "11", "91234", "5678"]))).toEqual([["phone", "+55 11 91234 5678"]]);
		expect(kinds(line(["Fixo:", "11", "3456-7890"]))).toEqual([["phone", "11 3456-7890"]]);
		expect(kinds(line(["Cel", "91234-5678"]))).toEqual([["phone", "91234-5678"]]);
	});

	it("blurs a tenant's own hosts, never the public Power Platform ones", () => {
		expect(kinds(line(["https://make.powerapps.com/environments"]))).toEqual([]);
		expect(kinds(line(["apps.powerapps.com/play"]))).toEqual([]);
		expect(kinds(line(["https://org1a2b.crm.dynamics.com/main.aspx"]))).toEqual([
			["tenant", "org1a2b.crm.dynamics.com"],
		]);
		expect(kinds(line(["contoso.powerappsportals.com"]))).toEqual([
			["tenant", "contoso.powerappsportals.com"],
		]);
	});

	it("does not take a long ID or run number for a phone", () => {
		expect(kinds(line(["Execução", "08585512345678901234"]))).toEqual([]);
		expect(kinds(line(["ID", "11912345678"]))).toEqual([]);
		expect(kinds(line(["Criado", "2026-10-10", "12:30"]))).toEqual([]);
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

	it("stops one interval past a scan that was cut short, not at the end of the take", () => {
		const spans = trackDetections({
			durationSec: 3600,
			intervalSec: 2,
			samples: [blank(0), email(2), email(4)],
			complete: false,
		});
		expect(spans.map((s) => [s.startSec, s.endSec])).toEqual([[0, 6]]);
	});
});

describe("scannedUpToSec", () => {
	it("is the whole take for a finished scan, and the last sample for a cut-short one", () => {
		const samples = [
			{ t: 0, same: true },
			{ t: 2, same: true },
		];
		expect(scannedUpToSec({ durationSec: 60, intervalSec: 2, samples })).toBe(60);
		expect(scannedUpToSec({ durationSec: 60, intervalSec: 2, samples, complete: false })).toBe(2);
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
		expect(scan.complete).toBe(true);
	});

	it("marks a scan with no closing line as cut short", () => {
		const scan = parseOcrScan(
			[
				'{"type":"info","width":1920,"height":1080,"durationSec":3600,"language":"pt-BR"}',
				'{"type":"same","t":0.0}',
			].join("\n"),
		);
		expect(scan.complete).toBe(false);
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

describe("custom sensitive terms", () => {
	const custom = (sample: OcrSample, terms: string[]) =>
		detectSensitive(sample, terms).map((d) => [d.kind, d.text]);

	it("reads the list one per line or comma, ignoring repeats and terms too short", () => {
		expect(parseSensitiveTerms("Contoso\n João Silva , ab\nCONTOSO\n\n123.456")).toEqual([
			"Contoso",
			"João Silva",
			"123.456",
		]);
	});

	it("matches ignoring case and accents, across two words and inside one", () => {
		expect(custom(line(["Olá,", "JOAO", "SILVA"]), ["João Silva"])).toEqual([
			["custom", "JOAO SILVA"],
		]);
		expect(custom(line(["Projeto", "fabrikam-interno"]), ["Fabrikam"])).toEqual([
			["custom", "fabrikam"],
		]);
		expect(custom(line(["Conta", "4021-77"]), ["4021"])).toEqual([["custom", "4021"]]);
		expect(custom(line(["nada", "aqui"]), ["Fabrikam"])).toEqual([]);
	});

	it("blurs the whole OCR word a term was found inside", () => {
		const [found] = detectSensitive(line(["Projeto", "fabrikam-interno"]), ["fabrikam"]);
		// The second word: x 0.16, 0.05 wide.
		expect(found.box.x).toBeCloseTo(0.16, 5);
		expect(found.box.w).toBeCloseTo(0.05, 5);
	});

	it("leaves to the built-in patterns what they already blur", () => {
		expect(custom(line(["ana@contoso.com"]), ["contoso"])).toEqual([["email", "ana@contoso.com"]]);
	});

	it("is followed across frames like any other detection", () => {
		const scan = parseOcrScan(
			[
				'{"type":"info","durationSec":10}',
				'{"type":"frame","t":0,"words":[[0.1,0.1,0.1,0.02,"Fabrikam"]],"lines":[[0,1]]}',
				'{"type":"same","t":2}',
				'{"type":"frame","t":4,"words":[],"lines":[]}',
				'{"type":"done"}',
			].join("\n"),
		);
		expect(trackDetections(scan)).toEqual([]);
		expect(trackDetections(scan, ["fabrikam"])).toMatchObject([
			{ kind: "custom", startSec: 0, endSec: 4 },
		]);
	});
});

describe("replaceAutoRedactions", () => {
	const base = createEmptyDocument({ projectId: "p", title: "t" });
	const clip = (id: string, assetId: string, at: number) => ({
		id,
		assetId,
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: at,
		timelineEndSec: at + 10,
		wordRefs: [],
		origin: "system" as const,
		reason: "",
	});
	const span = (text: string) => ({
		kind: "custom" as const,
		text,
		box: { x: 0.1, y: 0.1, w: 0.1, h: 0.02 },
		startSec: 1,
		endSec: 3,
	});
	let n = 0;
	const makeId = (prefix: string) => `${prefix}_${++n}`;

	it("replaces the automatic blurs of the scanned assets and keeps the user's own", () => {
		const document = {
			...base,
			assets: [
				{ id: "a1", kind: "video", label: "1", originalPath: "C:/1.mp4", cameraTrack: null },
				{ id: "a2", kind: "video", label: "2", originalPath: "C:/2.mp4", cameraTrack: null },
			],
			timeline: { ...base.timeline, clips: [clip("c1", "a1", 0), clip("c2", "a2", 10)] },
		} as AxcutDocument;
		const old1 = redactionAnnotations(document, "a1", [span("old")], makeId);
		const old2 = redactionAnnotations(document, "a2", [span("other")], makeId);
		const manual = { ...old1[0], id: "manual", annotationSource: undefined };
		const withBlurs = { ...document, annotations: [...old1, ...old2, manual] } as AxcutDocument;

		const result = replaceAutoRedactions(
			withBlurs,
			new Map([["a1", [span("new"), { ...span("x"), startSec: 5, endSec: 6 }]]]),
			makeId,
		);
		expect(result).toMatchObject({ removed: 1, added: 2 });
		const ids = result.document.annotations.map((a) => a.id);
		expect(ids).toContain("manual");
		expect(ids).toContain(old2[0].id);
		expect(ids).not.toContain(old1[0].id);
		expect(result.document.annotations).toHaveLength(4);
	});

	it("clears the suggestions when the new scan finds nothing", () => {
		const document = {
			...base,
			assets: [
				{ id: "a1", kind: "video", label: "1", originalPath: "C:/1.mp4", cameraTrack: null },
			],
			timeline: { ...base.timeline, clips: [clip("c1", "a1", 0)] },
		} as AxcutDocument;
		const old = redactionAnnotations(document, "a1", [span("old")], makeId);
		const result = replaceAutoRedactions(
			{ ...document, annotations: old } as AxcutDocument,
			new Map([["a1", []]]),
			makeId,
		);
		expect(result).toMatchObject({ removed: 1, added: 0 });
		expect(result.document.annotations).toEqual([]);
	});
});
