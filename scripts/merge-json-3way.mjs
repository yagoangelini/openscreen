// Three-way merge of conflicted JSON files (the locale files, above all) during a `git merge`.
//
//   node scripts/merge-json-3way.mjs src/i18n/locales/de/editor.json [...more]
//   node scripts/merge-json-3way.mjs $(git diff --name-only --diff-filter=U | grep "^src/i18n/")
//
// Reads base (:1:), ours (:2:) and theirs (:3:) from the index, key by key: the same on both
// sides -> that; changed on one side only -> that side; changed on both -> OURS (the fork's
// wording), and reported. A key one side added is kept; one side deleted and the other left
// alone is deleted. Order follows theirs, with keys only ours has placed after the key that
// precedes them in ours. Written with tabs and a trailing newline. `git add` the files after.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const show = (stage, file) => {
	try {
		return JSON.parse(execFileSync("git", ["show", `:${stage}:${file}`], { encoding: "utf8" }));
	} catch {
		return undefined;
	}
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reports = [];

function merge(base, ours, theirs, at) {
	if (isObject(ours) && isObject(theirs)) {
		const b = isObject(base) ? base : {};
		const keys = Object.keys(theirs);
		const oursKeys = Object.keys(ours);
		oursKeys.forEach((key, i) => {
			if (keys.includes(key)) return;
			let previous = i - 1;
			while (previous >= 0 && !keys.includes(oursKeys[previous])) previous--;
			keys.splice(previous >= 0 ? keys.indexOf(oursKeys[previous]) + 1 : 0, 0, key);
		});
		const out = {};
		for (const key of keys) {
			const inOurs = key in ours;
			const inTheirs = key in theirs;
			const inBase = key in b;
			if (inOurs && inTheirs) {
				out[key] = merge(b[key], ours[key], theirs[key], `${at}.${key}`);
			} else if (inOurs) {
				if (inBase && same(b[key], ours[key])) continue;
				if (inBase) reports.push(`${at}.${key}: deleted upstream, changed in the fork (kept)`);
				out[key] = ours[key];
			} else {
				if (inBase && same(b[key], theirs[key])) continue;
				if (inBase) reports.push(`${at}.${key}: deleted in the fork, changed upstream (kept)`);
				out[key] = theirs[key];
			}
		}
		return out;
	}
	if (same(ours, theirs)) return ours;
	if (same(ours, base)) return theirs;
	if (same(theirs, base)) return ours;
	reports.push(
		`${at}: both changed, kept the fork's | fork=${JSON.stringify(ours)} | upstream=${JSON.stringify(theirs)}`,
	);
	return ours;
}

for (const file of process.argv.slice(2)) {
	const ours = show(2, file);
	const theirs = show(3, file);
	if (ours === undefined || theirs === undefined) {
		console.error(`skipped ${file}: one side is missing from the index`);
		continue;
	}
	fs.writeFileSync(
		file,
		`${JSON.stringify(merge(show(1, file), ours, theirs, file), null, "\t")}\n`,
	);
}
for (const line of reports) console.log(line);
console.log(`done, ${reports.length} key(s) changed on both sides`);
