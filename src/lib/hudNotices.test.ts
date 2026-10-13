// @vitest-environment jsdom
// What the HUD's click-through hit test treats as clickable. The low-disk toast's close
// cross used to sit outside it: the cursor poll never made the window take the mouse
// there, so a real click on the cross went to the app underneath.
import { describe, expect, it } from "vitest";
import {
	HUD_TOAST_DURATION_MS,
	hudToastDismissDelayMs,
	isHudInteractiveTarget,
	isPersistentToast,
	PERSISTENT_TOAST_CLASS,
	persistentToast,
} from "./hudNotices";

function mount(html: string) {
	document.body.innerHTML = html;
	return (selector: string) => document.querySelector(selector);
}

describe("isHudInteractiveTarget", () => {
	it("takes the HUD's own controls", () => {
		const $ = mount(`<div data-hud-interactive="true"><button id="rec"></button></div>`);
		expect(isHudInteractiveTarget($("#rec"))).toBe(true);
	});

	it("takes a sonner toast and its close cross", () => {
		const $ = mount(`
			<section><ol data-sonner-toaster="true" id="list">
				<li data-sonner-toast="" data-removed="false" id="toast">
					<button data-close-button="true" id="close"></button>
				</li>
			</ol></section>`);
		expect(isHudInteractiveTarget($("#close"))).toBe(true);
		expect(isHudInteractiveTarget($("#toast"))).toBe(true);
		// The list around the toasts spans the window and must stay click-through.
		expect(isHudInteractiveTarget($("#list"))).toBe(false);
	});

	it("leaves a toast on its way out (invisible, still in the DOM) click-through", () => {
		const $ = mount(`
			<ol data-sonner-toaster="true"><li data-sonner-toast="" data-removed="true">
				<button data-close-button="true" id="close"></button>
			</li></ol>`);
		expect(isHudInteractiveTarget($("#close"))).toBe(false);
	});

	it("leaves the transparent reserve and nothing at all click-through", () => {
		const $ = mount(`<div id="root"><div id="reserve"></div></div>`);
		expect(isHudInteractiveTarget($("#reserve"))).toBe(false);
		expect(isHudInteractiveTarget(null)).toBe(false);
	});
});

describe("HUD toast lifetime", () => {
	it("closes every toast after 3 s", () => {
		expect(HUD_TOAST_DURATION_MS).toBe(3000);
		expect(hudToastDismissDelayMs({})).toBe(3000);
		expect(hudToastDismissDelayMs({ className: "something-else" })).toBe(3000);
	});

	it("keeps a persistent failure, and keeps the caller's own options", () => {
		const options = persistentToast({ description: "Timed out", className: "mine" });
		expect(options.description).toBe("Timed out");
		expect(options.duration).toBe(Number.POSITIVE_INFINITY);
		expect(options.className).toBe(`mine ${PERSISTENT_TOAST_CLASS}`);
		expect(isPersistentToast(options)).toBe(true);
		expect(hudToastDismissDelayMs(options)).toBeNull();
		expect(persistentToast().className).toBe(PERSISTENT_TOAST_CLASS);
	});
});
