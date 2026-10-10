import { describe, expect, it, vi } from "vitest";

const reply = vi.hoisted(() => ({ content: "" as string, fail: false }));
vi.mock("./deep-agent/chat-model", () => ({
	createOpenScreenChatModel: async () => ({
		invoke: async () => {
			if (reply.fail) throw new Error("401 bad key");
			return { content: reply.content };
		},
	}),
	messageContentToText: (content: unknown) => String(content),
}));

import { improveChapterTitles } from "./chapter-titles";

const base = { provider: "openai", model: "m", apiKey: "k" };
const chapters = [
	{ id: "0", draft: "Olá pessoal", transcript: "olá pessoal hoje vamos ver o Power Automate" },
	{
		id: "1",
		draft: "Agora vamos abrir",
		transcript: "agora vamos abrir o fluxo e criar um gatilho",
	},
];

describe("improveChapterTitles", () => {
	it("keeps the titles for the chapters asked about, tidied", async () => {
		reply.fail = false;
		reply.content =
			'```json\n[{"id":"0","text":"Introdução ao Power Automate."},{"id":"1","text":"Criando o   gatilho"},{"id":"9","text":"Inventado"}]\n```';
		const result = await improveChapterTitles({ ...base, chapters });
		expect(result).toEqual({
			success: true,
			titles: { "0": "Introdução ao Power Automate", "1": "Criando o gatilho" },
		});
	});

	it("reports a provider error, and a reply it cannot read", async () => {
		reply.fail = true;
		expect(await improveChapterTitles({ ...base, chapters })).toMatchObject({
			success: false,
			error: "401 bad key",
		});
		reply.fail = false;
		reply.content = "Desculpe, não posso ajudar.";
		expect((await improveChapterTitles({ ...base, chapters })).success).toBe(false);
	});
});
