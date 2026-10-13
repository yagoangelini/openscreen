// Rewriting the media paths a document (or any JSON the app keeps) points at, after the
// files moved: a recording renamed in the library, or relinked by "Locate...".
//
// Pure, and shared on purpose. The main process rewrites the project files on disk, the
// session manifest, the take journal and the media-links registry; the editor rewrites the
// document it holds in memory and its undo history. If the two disagreed on what a path
// "inside the moved folder" is, an open project would save the old paths straight back.
//
// Only absolute paths are touched, and only ones the mapper claims. Windows paths compare
// without case and with either separator, like the file system does.

/** The new path for `value`, or null when it did not move. */
export type PathMapper = (value: string) => string | null;

const WINDOWS_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const POSIX_PATH = /^\//;

function isAbsoluteMediaPath(value: string): boolean {
	return WINDOWS_PATH.test(value) || POSIX_PATH.test(value);
}

function isWindowsStyle(value: string): boolean {
	return WINDOWS_PATH.test(value) || value.includes("\\");
}

/** Collapses separators to the path's own style and drops a trailing one. */
function tidy(value: string, windows: boolean): string {
	const separator = windows ? "\\" : "/";
	let collapsed = windows ? value.replace(/[\\/]+/g, "\\") : value.replace(/\/+/g, "/");
	// A UNC path keeps its two leading separators.
	if (windows && /^[\\/]{2}/.test(value)) collapsed = `\\${collapsed}`;
	const isRoot = /^[a-zA-Z]:\\$/.test(collapsed) || collapsed === "/";
	return !isRoot && collapsed.endsWith(separator) ? collapsed.slice(0, -1) : collapsed;
}

/**
 * Everything at or under `fromDir` moves to the same place under `toDir`. `fromDir`
 * itself maps to `toDir`.
 */
export function folderMoveMapper(fromDir: string, toDir: string): PathMapper {
	const windows = isWindowsStyle(fromDir);
	const separator = windows ? "\\" : "/";
	const from = tidy(fromDir, windows);
	const fromKey = windows ? from.toLowerCase() : from;
	const to = tidy(toDir, isWindowsStyle(toDir));
	return (value) => {
		if (!isAbsoluteMediaPath(value) || isWindowsStyle(value) !== windows) return null;
		const candidate = tidy(value, windows);
		const key = windows ? candidate.toLowerCase() : candidate;
		if (key === fromKey) return to;
		if (!key.startsWith(fromKey + separator)) return null;
		return to + candidate.slice(from.length);
	};
}

/** Exactly these files moved, each to its own new path. */
export function filesMoveMapper(moves: ReadonlyArray<readonly [string, string]>): PathMapper {
	const table = new Map<string, string>();
	for (const [from, to] of moves) {
		const windows = isWindowsStyle(from);
		const key = tidy(from, windows);
		table.set(windows ? key.toLowerCase() : key, to);
	}
	return (value) => {
		if (!isAbsoluteMediaPath(value)) return null;
		const windows = isWindowsStyle(value);
		const key = tidy(value, windows);
		return table.get(windows ? key.toLowerCase() : key) ?? null;
	};
}

/** Tries each mapper in turn; the first that claims a path wins. */
export function combineMappers(...mappers: PathMapper[]): PathMapper {
	return (value) => {
		for (const mapper of mappers) {
			const mapped = mapper(value);
			if (mapped !== null) return mapped;
		}
		return null;
	};
}

/**
 * `value` with every string the mapper claims replaced, walking arrays and plain objects.
 * Returns the same reference when nothing changed, so a caller can skip a write; anything
 * that changed is a fresh copy (the input is never mutated).
 */
export function rewriteMediaPaths<T>(value: T, mapper: PathMapper): { value: T; changed: number } {
	let changed = 0;
	const walk = (node: unknown): unknown => {
		if (typeof node === "string") {
			const mapped = mapper(node);
			if (mapped !== null && mapped !== node) {
				changed += 1;
				return mapped;
			}
			return node;
		}
		if (Array.isArray(node)) {
			let copy: unknown[] | null = null;
			node.forEach((item, index) => {
				const next = walk(item);
				if (next !== item) {
					copy ??= node.slice();
					copy[index] = next;
				}
			});
			return copy ?? node;
		}
		if (node && typeof node === "object" && Object.getPrototypeOf(node) === Object.prototype) {
			let copy: Record<string, unknown> | null = null;
			for (const [key, item] of Object.entries(node)) {
				const next = walk(item);
				if (next !== item) {
					copy ??= { ...(node as Record<string, unknown>) };
					copy[key] = next;
				}
			}
			return copy ?? node;
		}
		return node;
	};
	const next = walk(value) as T;
	return { value: next, changed };
}

/** Every absolute path string inside `value` (for "which projects use this recording"). */
export function collectMediaPaths(value: unknown, into: string[] = []): string[] {
	if (typeof value === "string") {
		if (isAbsoluteMediaPath(value)) into.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) collectMediaPaths(item, into);
	} else if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectMediaPaths(item, into);
	}
	return into;
}

/** Whether `value` is `dir` or under it, by the same rules as {@link folderMoveMapper}. */
export function isPathUnder(value: string, dir: string): boolean {
	return folderMoveMapper(dir, dir)(value) !== null;
}
