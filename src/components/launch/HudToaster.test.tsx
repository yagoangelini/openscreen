// @vitest-environment jsdom
// The HUD's toasts: each one closes 3 s after it appears whatever duration its caller asked
// for (the low-disk warning asked for 15 s and covered the user's screen that long), except
// the failures marked persistent; and the close cross works (it calls sonner's dismiss).
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { HUD_TOAST_DURATION_MS, persistentToast } from "@/lib/hudNotices";
import { HudToaster } from "./HudToaster";

function renderToaster() {
	return render(
		<I18nProvider>
			<HudToaster />
		</I18nProvider>,
	);
}

/**
 * Advances time in small steps, each in its own act(): sonner's dismissal is a chain
 * (rAF, a state update, an effect, a 200 ms exit timer), and one act() around the whole
 * span would hold the effects until its end.
 */
async function flush(ms = 50) {
	for (let left = ms; left > 0; left -= 50) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(Math.min(50, left));
		});
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame"] });
});

afterEach(async () => {
	toast.dismiss();
	await flush(1000);
	vi.useRealTimers();
});

describe("HudToaster", () => {
	it("closes a toast after 3 s even when it asked for 15 s", async () => {
		renderToaster();
		toast.warning("Pouco espaço em disco", { duration: 15_000 });
		await flush();
		expect(screen.getByText("Pouco espaço em disco")).toBeInTheDocument();

		await flush(HUD_TOAST_DURATION_MS - 200);
		expect(screen.getByText("Pouco espaço em disco")).toBeInTheDocument();

		await flush(1000);
		expect(screen.queryByText("Pouco espaço em disco")).not.toBeInTheDocument();
	});

	it("closes an endless toast too (the muted-mic warning)", async () => {
		renderToaster();
		toast.error("Seu microfone parece mudo", { id: "mic", duration: Number.POSITIVE_INFINITY });
		await flush(HUD_TOAST_DURATION_MS + 1000);
		expect(screen.queryByText("Seu microfone parece mudo")).not.toBeInTheDocument();
	});

	it("gives a toast shown again under the same id the full 3 s again", async () => {
		renderToaster();
		toast.error("Seu microfone parece mudo", { id: "mic" });
		await flush(2000);
		toast.error("Seu microfone parece mudo", { id: "mic" });
		await flush(2000);
		expect(screen.getByText("Seu microfone parece mudo")).toBeInTheDocument();
		await flush(2000);
		expect(screen.queryByText("Seu microfone parece mudo")).not.toBeInTheDocument();
	});

	it("keeps a persistent failure until it is closed, and its cross closes it", async () => {
		renderToaster();
		toast.error("Não deu para parar a gravação", persistentToast());
		await flush(HUD_TOAST_DURATION_MS * 5);
		expect(screen.getByText("Não deu para parar a gravação")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /close notification/i }));
		await flush(1000);
		expect(screen.queryByText("Não deu para parar a gravação")).not.toBeInTheDocument();
	});

	it("sits just above the bar, centred", async () => {
		renderToaster();
		toast("Marcador adicionado");
		await flush();
		const list = document.querySelector("[data-sonner-toaster]") as HTMLElement;
		expect(list).toHaveAttribute("data-x-position", "center");
		expect(list).toHaveAttribute("data-y-position", "bottom");
		expect(list.style.getPropertyValue("--offset-bottom")).toBe("var(--hud-toast-bottom, 96px)");
	});
});
