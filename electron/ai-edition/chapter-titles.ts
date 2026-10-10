// YouTube chapter titles through the configured chat LLM.
//
// The chapters themselves are built locally (`src/lib/ai-edition/chapters.ts`): where
// they start, and a draft title from the first words spoken. This only rewrites the
// titles, given what is said in each chapter, in one tool-free call -- same shape as
// the caption translation next to it. Nothing touches the document: the renderer puts
// the titles in the chapter text box for the user to edit and copy.

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { parseTranslationReply } from "./caption-translate";
import { createOpenScreenChatModel, messageContentToText } from "./deep-agent/chat-model";

export interface ChapterTitleInput {
	id: string;
	/** The local draft: the first words spoken. */
	draft: string;
	/** What is said during the chapter, trimmed to a few hundred characters. */
	transcript: string;
}

export interface ChapterTitlesOptions {
	chapters: ChapterTitleInput[];
	/** The video's language, as a name or a code ("pt-BR", "Portuguese"). */
	language?: string;
	provider: string;
	model: string;
	apiKey: string;
	baseUrl?: string;
	reasoningEffort?: string;
	signal?: AbortSignal;
}

export interface ChapterTitlesResult {
	success: boolean;
	/** chapter id -> title. */
	titles: Record<string, string>;
	error?: string;
}

const SYSTEM_PROMPT = [
	"You write YouTube chapter titles for a screen-recorded tutorial.",
	"You are given a JSON array of chapters, each with an `id`, a `draft` title and the `transcript` of what is said in it.",
	"Write one short, specific title per chapter: what the viewer learns or does there.",
	"",
	"Rules:",
	"- Reply with JSON only: an array of objects with exactly the keys `id` and `text`. No prose, no code fences.",
	"- One entry per chapter, with the SAME `id`. Never merge, split, drop or reorder chapters.",
	"- At most 60 characters. No numbering, no timestamps, no emoji, no trailing period.",
	"- Write in the language of the transcript. Keep product names exactly as spoken (Power Automate, SharePoint, Copilot).",
	"- When the transcript says nothing useful, tidy the draft instead of inventing.",
].join("\n");

const MAX_TITLE_CHARS = 80;

export async function improveChapterTitles(
	options: ChapterTitlesOptions,
): Promise<ChapterTitlesResult> {
	if (options.chapters.length === 0) return { success: true, titles: {} };
	let reply = "";
	try {
		const model = await createOpenScreenChatModel({
			provider: options.provider,
			model: options.model,
			apiKey: options.apiKey,
			baseUrl: options.baseUrl,
			reasoningEffort: options.reasoningEffort,
		});
		const language = options.language ? ` The video is in ${options.language}.` : "";
		const result = await model.invoke(
			[
				new SystemMessage(SYSTEM_PROMPT),
				new HumanMessage(
					`Write the chapter titles.${language}\n\n${JSON.stringify(
						options.chapters.map((c) => ({ id: c.id, draft: c.draft, transcript: c.transcript })),
					)}`,
				),
			],
			{ signal: options.signal },
		);
		reply = messageContentToText(result.content);
	} catch (error) {
		return {
			success: false,
			titles: {},
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const parsed = parseTranslationReply(reply);
	const titles: Record<string, string> = {};
	for (const chapter of options.chapters) {
		const title = parsed[chapter.id]
			?.replace(/\s+/g, " ")
			.replace(/[.。]$/, "")
			.trim();
		if (title) titles[chapter.id] = title.slice(0, MAX_TITLE_CHARS);
	}
	if (Object.keys(titles).length === 0) {
		return { success: false, titles, error: "Could not read the model's reply as chapter titles." };
	}
	return { success: true, titles };
}
