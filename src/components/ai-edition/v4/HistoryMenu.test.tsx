// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/contexts/I18nContext";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { clearHistory } from "@/lib/ai-edition/store/undo";
import { pushHistory } from "@/lib/ai-edition/store/undoStack";
import { HISTORY_MENU_MAX_ROWS, HistoryButton } from "./HistoryMenu";

const doc = createEmptyDocument({ projectId: "p1", title: "Projeto" });

function renderButton(onJump = vi.fn(), onStep = vi.fn()) {
	render(
		<I18nProvider>
			<TooltipProvider>
				<HistoryButton
					kind="undo"
					enabled
					label="Undo"
					icon={<span>u</span>}
					onStep={onStep}
					onJump={onJump}
				/>
			</TooltipProvider>
		</I18nProvider>,
	);
	return { onJump, onStep, button: screen.getByTestId("history-undo") };
}

describe("HistoryButton", () => {
	beforeEach(() => {
		clearHistory();
		useProjectStore.setState({ projectId: "p1", document: doc });
	});

	it("steps once on click, and lists the named steps on right-click", () => {
		pushHistory({ projectId: "p1", doc, label: "addZoom" });
		pushHistory({ projectId: "p1", doc, label: "agentTurn" });
		const { onJump, onStep, button } = renderButton();
		fireEvent.click(button);
		expect(onStep).toHaveBeenCalledTimes(1);
		fireEvent.contextMenu(button);
		const rows = screen.getAllByTestId("history-entry");
		expect(rows.map((r) => r.textContent)).toEqual(["AI reply−1", "Add zoom−2"]);
		fireEvent.click(rows[1]);
		expect(onJump).toHaveBeenCalledWith(2);
		expect(screen.queryByTestId("history-menu-undo")).toBeNull();
	});

	it("opens from the keyboard and folds a long history", () => {
		for (let i = 0; i < HISTORY_MENU_MAX_ROWS + 5; i++) {
			pushHistory({ projectId: "p1", doc, label: "moveZoom" });
		}
		const { button } = renderButton();
		fireEvent.keyDown(button, { key: "F10", shiftKey: true });
		expect(screen.getAllByTestId("history-entry")).toHaveLength(HISTORY_MENU_MAX_ROWS);
		expect(screen.getByTestId("history-menu-undo").textContent).toContain("5 older steps");
		// The first row has the focus, and Escape closes.
		expect(document.activeElement).toBe(screen.getAllByTestId("history-entry")[0]);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByTestId("history-menu-undo")).toBeNull();
	});
});
