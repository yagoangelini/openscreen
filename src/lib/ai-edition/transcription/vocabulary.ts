/**
 * The terms Whisper is told to expect: its initial prompt.
 *
 * Two sources, merged on every run: the user's standing list (a preference, with the
 * Microsoft 365 and AI names below as its default) and the project's "names and terms".
 * Unlike the glossary, which corrects words after the fact, this steers the decode
 * itself, and it is the larger win: on pt-BR tutorial speech read by the Windows voices,
 * this list took small from 8.6-10.5% word errors to 3.5-6.7% and large-v3-turbo from
 * 3.8-5.7% to 2.5-4.1%, with the product names right 78-90% of the time instead of
 * 57-82% (docs/HANDOFF.md). On a real take with none of these words in it, nothing was
 * inserted.
 *
 * The main process frames the result as `Glossary: <terms>.` (whisperServer.ts).
 */

/** Most important first: when the budget runs out, the end of the standing list goes. */
export const DEFAULT_VOCABULARY = [
	"Microsoft 365",
	"Microsoft 365 Copilot",
	"Copilot",
	"Copilot Studio",
	"Power Automate",
	"Power Apps",
	"Power BI",
	"Power Platform",
	"Dataverse",
	"SharePoint",
	"OneDrive",
	"Teams",
	"Outlook",
	"Excel",
	"Word",
	"PowerPoint",
	"Loop",
	"Planner",
	"Forms",
	"Entra ID",
	"Purview",
	"Intune",
	"Defender",
	"Azure",
	"Azure OpenAI",
	"Azure AI Foundry",
	"Fabric",
	"prompt",
	"agente",
	"agentes",
	"LLM",
	"GPT",
	"ChatGPT",
	"Claude",
	"IA generativa",
	"RAG",
	"MCP",
	"tenant",
	"licença E3",
	"E5",
].join(", ");

/**
 * Whisper keeps the last 224 tokens of a longer prompt (n_text_ctx / 2), which would cut
 * the "Glossary:" frame off the front and hand it a bare list, the case the frame exists
 * to avoid. Product names run about three characters a token, so 640 characters stays
 * under that with the frame.
 */
export const PROMPT_MAX_CHARS = 640;

function splitTerms(text: string | undefined): string[] {
	return (text ?? "")
		.split(/[,;\n]/)
		.map((term) => term.trim().replace(/\.+$/, ""))
		.filter(Boolean);
}

/**
 * The prompt for one run: the standing terms, then the project's (nearest the audio,
 * where Whisper weighs them most), each once whatever its case. The project's own terms
 * always stay; standing terms are dropped from the end of their list until it fits.
 * Undefined when there is nothing to say.
 */
export function buildTranscriptionPrompt(
	projectVocabulary: string | undefined,
	standingVocabulary: string | undefined,
): string | undefined {
	const project = splitTerms(projectVocabulary);
	const seen = new Set(project.map((term) => term.toLowerCase()));
	const standing = splitTerms(standingVocabulary).filter((term) => {
		const key = term.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const join = (terms: string[]) => terms.join(", ");
	while (standing.length > 0 && join([...standing, ...project]).length > PROMPT_MAX_CHARS) {
		standing.pop();
	}
	return join([...standing, ...project]) || undefined;
}
