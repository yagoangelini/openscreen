// @vitest-environment jsdom
// The chat side of agent turns. With "Pedir aprovação antes de aplicar" on (the
// default) a reply that edits the project renders as a proposal and the document
// is untouched until "Apply"; applied, the reply offers "Undo this reply", which
// reverts the whole reply in one step. With the setting off the reply applies at
// once, as before, and still offers the same undo.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";

const llmConfig: { current: Record<string, unknown> } = { current: {} };
const chatRun = vi.fn();
const save = vi.fn();

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			llmGetSnapshot: () =>
				Promise.resolve({
					config: llmConfig.current,
					connectedProviders: ["anthropic"],
					availableProviders: [],
					credentialSummary: [],
				}),
			chatListSessions: () =>
				Promise.resolve([
					{
						id: "session-1",
						title: "Conversa 1",
						messageCount: 0,
						createdAt: "2026-10-01T00:00:00Z",
					},
				]),
			chatSelectSession: () =>
				Promise.resolve({
					id: "session-1",
					projectId: "proj_1",
					title: "Conversa 1",
					createdAt: "2026-10-01T00:00:00Z",
					updatedAt: "2026-10-01T00:00:00Z",
					messages: [],
				}),
			chatRun: (...args: unknown[]) => chatRun(...args),
			chatBudget: () => Promise.resolve(null),
			save: (...args: unknown[]) => save(...args),
		},
	},
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => toastSuccess(...args),
		error: (...args: unknown[]) => toastError(...args),
		warning: (...args: unknown[]) => toastWarning(...args),
	},
}));

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({
		locale: "en",
		setLocale: () => {
			/* fixed locale */
		},
	}),
	useScopedT: () => (key: string) => key,
}));

const before = createEmptyDocument({
	title: "Tutorial",
	projectId: "proj_1",
	createdAt: "2026-01-01T00:00:00.000Z",
});
const edited: AxcutDocument = {
	...before,
	project: { ...before.project, title: "Tutorial (editado)" },
	zoomRanges: [],
};

beforeEach(async () => {
	chatRun.mockReset().mockResolvedValue({
		success: true,
		assistantMessage: {
			id: "reply-1",
			role: "assistant",
			content: "Pronto: renomeei o projeto.",
			createdAt: "2026-10-01T00:00:01Z",
			toolCalls: [{ name: "renameProject", summary: "renamed the project" }],
		},
		document: edited,
	});
	save.mockReset().mockImplementation(async (document: unknown) => ({ success: true, document }));
	toastSuccess.mockClear();
	toastError.mockClear();
	toastWarning.mockClear();
	Element.prototype.scrollTo = () => {
		/* no scrolling in jsdom */
	};
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => {
			/* unsubscribe */
		},
	};
	const { useProjectStore } = await import("@/lib/ai-edition/store/projectStore");
	const { clearHistory } = await import("@/lib/ai-edition/store/undo");
	const { useAgentTurnStore } = await import("@/lib/ai-edition/store/agentTurns");
	clearHistory();
	useAgentTurnStore.setState({ turns: {} });
	useProjectStore.setState({ projectId: "proj_1", document: before, revision: 1, dirty: false });
});

afterEach(() => {
	cleanup();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

async function renderAndSend() {
	const { EditorDialogsProvider } = await import("@/contexts/EditorDialogsContext");
	const { ChatStripPanel } = await import("./LeftPanel");
	const { TooltipProvider } = await import("@/components/ui/tooltip");
	const view = render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<ChatStripPanel />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
	const composer = await waitFor(
		() => {
			const el = view.container.querySelector("textarea");
			expect(el).not.toBeNull();
			expect(el).not.toBeDisabled();
			return el as HTMLTextAreaElement;
		},
		{ timeout: 10_000 },
	);
	fireEvent.change(composer, { target: { value: "Renomeie o projeto" } });
	await act(async () => {
		fireEvent.keyDown(composer, { key: "Enter" });
	});
	await waitFor(() => expect(view.getByText("Pronto: renomeei o projeto.")).toBeInTheDocument());
	return view;
}

async function projectTitle() {
	const { useProjectStore } = await import("@/lib/ai-edition/store/projectStore");
	return useProjectStore.getState().document?.project.title;
}

describe("ChatStripPanel agent turns", () => {
	it("stages the reply by default: a proposal, nothing written, until Apply", async () => {
		llmConfig.current = { provider: "anthropic", model: "claude" };
		const view = await renderAndSend();

		expect(view.getByRole("region", { name: "chat.turnPendingTitle" })).toBeInTheDocument();
		expect(view.getByText(/chat\.plannedPrefix renamed the project/)).toBeInTheDocument();
		expect(view.getByText(/chat\.turnChange\.other/)).toBeInTheDocument();
		expect(save).not.toHaveBeenCalled();
		expect(await projectTitle()).toBe("Tutorial");

		await act(async () => {
			fireEvent.click(view.getByRole("button", { name: /chat\.turnApply/ }));
		});
		await waitFor(() => expect(save).toHaveBeenCalledOnce());
		expect(await projectTitle()).toBe("Tutorial (editado)");
		const undoButton = await waitFor(() => view.getByRole("button", { name: /chat\.turnUndo/ }));
		expect(undoButton).toHaveAttribute("aria-disabled", "false");

		await act(async () => {
			fireEvent.click(undoButton);
		});
		expect(await projectTitle()).toBe("Tutorial");
		expect(toastSuccess).toHaveBeenCalledWith("chat.turnUndone");
	});

	it("discarding a staged reply writes nothing", async () => {
		llmConfig.current = { provider: "anthropic", model: "claude" };
		const view = await renderAndSend();

		await act(async () => {
			fireEvent.click(view.getByRole("button", { name: "chat.turnDiscard" }));
		});
		expect(view.queryByRole("region", { name: "chat.turnPendingTitle" })).toBeNull();
		expect(view.getByText("chat.turnDiscarded")).toBeInTheDocument();
		expect(save).not.toHaveBeenCalled();
		expect(await projectTitle()).toBe("Tutorial");
	});

	it("applies at once with approval turned off, and still offers the one-step undo", async () => {
		llmConfig.current = { provider: "anthropic", model: "claude", requireAgentEditApproval: false };
		const view = await renderAndSend();

		await waitFor(() => expect(save).toHaveBeenCalledOnce());
		expect(await projectTitle()).toBe("Tutorial (editado)");
		expect(view.queryByRole("region", { name: "chat.turnPendingTitle" })).toBeNull();
		expect(view.getByText(/chat\.appliedPrefix renamed the project/)).toBeInTheDocument();
		expect(await waitFor(() => view.getByRole("button", { name: /chat\.turnUndo/ }))).toBeVisible();
	});
});
