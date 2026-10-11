// This fork speaks Brazilian Portuguese natively: with no stored choice every window starts
// in pt-BR, whatever the system language. A key pt-BR lacks falls back to English, which is
// also the reference set `scripts/i18n-check.mjs` compares every locale against.
export const DEFAULT_LOCALE = "pt-BR" as const;
export const FALLBACK_LOCALE = "en" as const;
export const SUPPORTED_LOCALES = [
	"pt-BR",
	"en",
	"ar",
	"cs",
	"de",
	"es",
	"fr",
	"it",
	"ja-JP",
	"ko-KR",
	"ru",
	"tr",
	"vi",
	"zh-CN",
	"zh-TW",
] as const;
export const I18N_NAMESPACES = [
	"common",
	"dialogs",
	"editor",
	"launch",
	"settings",
	"shortcuts",
	"timeline",
] as const;

export type Locale = string;
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export const LOCALE_STORAGE_KEY = "openscreen-locale";
