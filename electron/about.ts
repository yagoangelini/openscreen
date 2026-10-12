// What the About box says, kept out of the dialog that shows it. Every fact is passed in
// rather than read from `app`/`process`, so the string can be pinned in a test from any
// platform — the same reason install-channel.ts takes an `InstallProbe`.
//
// The install channel is in there deliberately: it is the single fact that explains why a
// copy does or does not offer "Check for Updates" (see install-channel.ts), and the first
// thing worth knowing about a bug report from a build we did not install ourselves.

import type { InstallChannel } from "./install-channel";

/** This fork's home: where its releases, issues and source live. */
export const WEBSITE_URL = "https://github.com/yagoangelini/openscreen";
/** The project this fork continues, credited in every About box. */
export const UPSTREAM_URL = "https://github.com/getopenscreen/openscreen";
/** The brand spelling, for the surfaces we render ourselves. NOT `app.name`: that resolves to
 *  electron-builder's `productName` ("Openscreen") when packaged and to package.json's `name`
 *  ("openscreen") in dev, so the About box would disagree with its own title bar. */
export const PRODUCT_NAME = "OpenScreen";
/** Who makes this build: the fork's owner, also package.json's `author`. */
export const FORK_OWNER = "Yago Angelini";
/** Who makes the app it is based on, named as upstream names itself. */
export const UPSTREAM_AUTHORS = "Etienne Lescot / getopenscreen";
/** The fork's holder, then upstream's collective notice, and deliberately NOT the whole of
 *  LICENSE. LICENSE also names Siddharth Vaddem, who created the project (MIT obliges us to keep
 *  that notice on a codebase that still contains his code); this is the line every user sees,
 *  so it names who maintains the app.
 *
 *  "contributors" and not "OpenScreen": getopenscreen is a GitHub organisation, not a legal
 *  entity, and copyright cannot vest in something that does not exist. Each author keeps their
 *  own; this is shorthand for all of them.
 *
 *  Must stay byte-identical to `copyright` in electron-builder.json5, which feeds Info.plist's
 *  NSHumanReadableCopyright and the Windows LegalCopyright. That key is declared explicitly
 *  BECAUSE electron-builder otherwise derives those from package.json's `author` — a single
 *  name, which would drop upstream's notice from the binary this string appears in. */
export const COPYRIGHT = "© 2026 Yago Angelini · © 2025-2026 OpenScreen contributors — MIT License";

/** The two credit lines at the top of the About box, translated by the caller: who makes this
 *  build, and what it is based on. `t` gets the key under `common.about` and its variables. */
export function formatAboutCredits(
	t: (key: "credit" | "basedOn", vars: Record<string, string>) => string,
): string {
	return [
		t("credit", { product: PRODUCT_NAME, owner: FORK_OWNER }),
		t("basedOn", { product: PRODUCT_NAME, upstream: UPSTREAM_AUTHORS }),
	].join("\n");
}

/** macOS opens its own About panel (the app menu's `role: "about"`), so it is the one platform
 *  that must not be shown the message box we build, and the only one whose panel needs
 *  populating up front. Pure so both branches can be pinned from a Linux-only CI. */
export function usesNativeAboutPanel(platform: NodeJS.Platform): boolean {
	return platform === "darwin";
}

export interface AboutFacts {
	version: string;
	channel: InstallChannel;
	platform: NodeJS.Platform;
	arch: string;
	electron: string;
	chrome: string;
	node: string;
}

/** The block under "Openscreen <version>". Untranslated on purpose: every line is a version
 *  number, a platform identifier or a URL, and a pasted bug report reads the same whatever
 *  locale the reporter runs.
 *
 *  `COPYRIGHT` is deliberately NOT part of it: the macOS About panel has its own field for
 *  that line, and putting it here too would print it twice on the one platform that asked
 *  for it separately. The surface that shows the box adds it. */
export function formatAboutDetail(facts: AboutFacts): string {
	return [
		`Electron ${facts.electron} · Chromium ${facts.chrome} · Node ${facts.node}`,
		`${facts.platform} ${facts.arch} · ${facts.channel}`,
		WEBSITE_URL,
		UPSTREAM_URL,
	].join("\n");
}
