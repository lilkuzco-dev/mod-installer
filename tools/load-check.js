#!/usr/bin/env node
// load-check — will this mod set actually LOAD?
//
// postship-check answers "does the folder match the manifest?" — hash for hash, exactly. It
// passed while the manifest shipped kinetics 0.1.1 alongside a cosmos that declares
// `"kinetics": ">=0.1.2"`. Both jars were precisely what the manifest said they were. The mod
// set was still one a client would refuse to start.
//
// That is the gap this closes: hash integrity and load compatibility are different properties,
// and shipping needs both. This reads every jar's own fabric.mod.json — including the nested
// jars Fabric mods bundle inside META-INF/jars — builds the set of everything provided, and
// checks that every declared dependency is satisfied by something in the set.
//
// It applies to every empire mod, not just the one that exposed it. A vibranium that starts
// depending on warfront, or a Modrinth mod whose new version raises its Fabric API floor, is the
// same failure and is caught the same way.
//
// Zero dependencies, CommonJS, Node 18+ — same constraints as the installer itself.
//
// Usage: node tools/load-check.js [--dir <mods-dir>] [--manifest <path>] [--side <name>] [--json]

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

// ---------------------------------------------------------------------------
//  Minimal zip reader
// ---------------------------------------------------------------------------
// A jar is a zip, and we need two or three small text files out of each one plus the ability to
// recurse into nested jars held in memory. Shelling out to `unzip` would work on this machine
// and nowhere else; a dependency would break the installer's zero-dependency rule. So: read the
// central directory, inflate the entries we want, ignore the rest.

function findEndOfCentralDirectory(buf) {
	// The EOCD record is at the end, after a comment of unknown length. Scan backwards for its
	// signature; the comment may not exceed 65535 bytes, so the search is bounded.
	const minimum = 22;
	const limit = Math.min(buf.length, 65535 + minimum);
	for (let i = buf.length - minimum; i >= buf.length - limit && i >= 0; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) return i;
	}
	return -1;
}

function listEntries(buf) {
	const eocd = findEndOfCentralDirectory(buf);
	if (eocd < 0) return [];

	let count = buf.readUInt16LE(eocd + 10);
	let offset = buf.readUInt32LE(eocd + 16);

	// Zip64: the 32-bit fields saturate and the real values live in a separate record. Fabric
	// API is large enough that this is not hypothetical.
	if (offset === 0xffffffff || count === 0xffff) {
		const locatorSig = 0x07064b50;
		for (let i = eocd - 20; i >= 0; i--) {
			if (buf.readUInt32LE(i) === locatorSig) {
				const zip64Start = Number(buf.readBigUInt64LE(i + 8));
				if (buf.readUInt32LE(zip64Start) === 0x06064b50) {
					count = Number(buf.readBigUInt64LE(zip64Start + 32));
					offset = Number(buf.readBigUInt64LE(zip64Start + 48));
				}
				break;
			}
		}
	}

	const entries = [];
	let p = offset;
	for (let i = 0; i < count && p + 46 <= buf.length; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) break;
		const method = buf.readUInt16LE(p + 10);
		const compressedSize = buf.readUInt32LE(p + 20);
		const nameLength = buf.readUInt16LE(p + 28);
		const extraLength = buf.readUInt16LE(p + 30);
		const commentLength = buf.readUInt16LE(p + 32);
		const localHeader = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
		entries.push({ name, method, compressedSize, localHeader });
		p += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

function readEntry(buf, entry) {
	const h = entry.localHeader;
	if (buf.readUInt32LE(h) !== 0x04034b50) return null;
	const nameLength = buf.readUInt16LE(h + 26);
	const extraLength = buf.readUInt16LE(h + 28);
	const start = h + 30 + nameLength + extraLength;

	if (entry.method === 0) return buf.subarray(start, start + entry.compressedSize);
	if (entry.method === 8) {
		try {
			return zlib.inflateRawSync(buf.subarray(start, start + entry.compressedSize));
		} catch {
			return null;
		}
	}
	return null;
}

function extract(buf, wanted) {
	for (const entry of listEntries(buf)) {
		if (entry.name === wanted) return readEntry(buf, entry);
	}
	return null;
}

function nestedJars(buf) {
	const out = [];
	for (const entry of listEntries(buf)) {
		if (entry.name.startsWith("META-INF/jars/") && entry.name.endsWith(".jar")) {
			const data = readEntry(buf, entry);
			if (data) out.push({ name: entry.name, data });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
//  Fabric version semantics
// ---------------------------------------------------------------------------

// Split a version into numeric parts plus a pre-release tag. Build metadata after "+" is
// ignored for ordering, exactly as semver says, which matters because Fabric API versions look
// like "0.157.0+26.2" and the part after the plus is a Minecraft version, not a precedence.
function parseVersion(raw) {
	if (typeof raw !== "string") return null;
	const [core, ...rest] = String(raw).trim().split("+");
	const [numbers, pre] = core.split("-");
	const parts = numbers.split(".").map((n) => {
		const v = Number.parseInt(n, 10);
		return Number.isNaN(v) ? n : v;
	});
	return { parts, pre: pre ?? null, raw, build: rest.join("+") || null };
}

function compareVersions(a, b) {
	const length = Math.max(a.parts.length, b.parts.length);
	for (let i = 0; i < length; i++) {
		const x = a.parts[i] ?? 0;
		const y = b.parts[i] ?? 0;
		if (typeof x === "number" && typeof y === "number") {
			if (x !== y) return x < y ? -1 : 1;
		} else {
			const sx = String(x);
			const sy = String(y);
			if (sx !== sy) return sx < sy ? -1 : 1;
		}
	}
	// A pre-release sorts BEFORE its release: 1.0.0-beta < 1.0.0.
	if (a.pre && !b.pre) return -1;
	if (!a.pre && b.pre) return 1;
	if (a.pre && b.pre && a.pre !== b.pre) return a.pre < b.pre ? -1 : 1;
	return 0;
}

// One predicate term. Fabric accepts "*", comparison operators, "~" (same minor), "^" (same
// major) and x-ranges like "1.2.x".
function matchesTerm(version, term) {
	term = term.trim();
	if (term === "" || term === "*") return true;
	if (!version) return false;

	const operatorMatch = term.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/);
	if (!operatorMatch) return false;
	const operator = operatorMatch[1] ?? "=";
	const target = operatorMatch[2].trim();

	// x-ranges: compare only the parts that are pinned.
	if (/[xX*]/.test(target)) {
		const wanted = parseVersion(target.replace(/[xX*]/g, "0"));
		const pinned = target.split(".").findIndex((p) => /^[xX*]$/.test(p));
		const depth = pinned < 0 ? wanted.parts.length : pinned;
		for (let i = 0; i < depth; i++) {
			if ((version.parts[i] ?? 0) !== (wanted.parts[i] ?? 0)) return false;
		}
		return true;
	}

	const wanted = parseVersion(target);
	if (!wanted) return false;
	const cmp = compareVersions(version, wanted);

	switch (operator) {
		case ">=": return cmp >= 0;
		case ">": return cmp > 0;
		case "<=": return cmp <= 0;
		case "<": return cmp < 0;
		case "=": return cmp === 0;
		case "~": {
			// Same major.minor, at least this patch.
			if (cmp < 0) return false;
			return (version.parts[0] ?? 0) === (wanted.parts[0] ?? 0)
				&& (version.parts[1] ?? 0) === (wanted.parts[1] ?? 0);
		}
		case "^": {
			// Same major, at least this version.
			if (cmp < 0) return false;
			return (version.parts[0] ?? 0) === (wanted.parts[0] ?? 0);
		}
		default: return false;
	}
}

// A requirement is a string or an array of strings. Within one string, spaces mean AND; across
// an array, entries mean OR. That is Fabric's rule, and getting it backwards would either pass
// everything or fail everything.
function satisfies(version, requirement) {
	const alternatives = Array.isArray(requirement) ? requirement : [requirement];
	return alternatives.some((alternative) =>
		String(alternative).trim().split(/\s+/).every((term) => matchesTerm(version, term)));
}

// ---------------------------------------------------------------------------
//  Reading mods
// ---------------------------------------------------------------------------

function parseModJson(buf) {
	const raw = extract(buf, "fabric.mod.json");
	if (!raw) return null;
	try {
		// Some mods ship a fabric.mod.json with a BOM or trailing commas; be forgiving about the
		// BOM, strict about the rest.
		return JSON.parse(raw.toString("utf8").replace(/^﻿/, ""));
	} catch (error) {
		return { __parseError: error.message };
	}
}

// Collect a jar and everything it bundles. `provides` aliases count as separate ids, because a
// mod depending on an alias is satisfied by the mod that declares it.
function collectMods(buf, file, into, depth = 0) {
	const json = parseModJson(buf);
	if (!json) return;
	if (json.__parseError) {
		into.malformed.push({ file, reason: json.__parseError });
		return;
	}
	if (typeof json.id !== "string") return;

	const record = {
		id: json.id,
		version: json.version,
		parsed: parseVersion(json.version),
		file,
		nested: depth > 0,
		environment: json.environment ?? "*",
		depends: json.depends ?? {},
		breaks: json.breaks ?? {},
		recommends: json.recommends ?? {},
	};
	into.mods.push(record);
	into.provided.set(json.id, record);

	for (const alias of Array.isArray(json.provides) ? json.provides : []) {
		if (typeof alias === "string" && !into.provided.has(alias)) {
			into.provided.set(alias, { ...record, id: alias, alias: true });
		}
	}

	// Recurse. Fabric API alone bundles dozens of modules this way, and kinetics bundles its
	// physics core - a check that ignored nested jars would report both as missing.
	for (const nested of nestedJars(buf)) {
		collectMods(nested.data, `${file} :: ${path.basename(nested.name)}`, into, depth + 1);
	}
}

// The platform's own ids. Without these, every mod appears to be missing Minecraft.
function platformProviders(manifest, javaVersion) {
	const provided = new Map();
	const add = (id, version) => {
		provided.set(id, { id, version, parsed: parseVersion(version), file: "<platform>",
			platform: true, depends: {}, breaks: {}, environment: "*" });
	};
	add("minecraft", manifest?.minecraft ?? "0");
	add("java", String(javaVersion));
	// The loader's own version is not in the manifest - it names the loader, not its version -
	// so it is read from the loader jar when present and left permissive otherwise.
	return provided;
}

// ---------------------------------------------------------------------------
//  The check
// ---------------------------------------------------------------------------

function environmentAllows(environment, side) {
	if (side === "all") return true;
	if (environment === "*" || environment == null) return true;
	return environment === side;
}

function check(mods, provided, side) {
	const problems = [];

	for (const mod of mods) {
		// A client-only mod is not loaded on a server, so its dependencies are not a server
		// problem. Checking it anyway would produce failures nobody can act on.
		if (!environmentAllows(mod.environment, side)) continue;

		for (const [id, requirement] of Object.entries(mod.depends ?? {})) {
			if (id === "fabricloader" || id === "fabric-loader") continue;   // supplied at runtime
			const target = provided.get(id);

			if (!target) {
				problems.push({
					severity: "error",
					mod: mod.id,
					file: mod.file,
					detail: `requires "${id}" ${JSON.stringify(requirement)}, which nothing in the `
						+ `manifest provides`,
				});
				continue;
			}
			if (!satisfies(target.parsed, requirement)) {
				problems.push({
					severity: "error",
					mod: mod.id,
					file: mod.file,
					detail: `requires "${id}" ${JSON.stringify(requirement)}, but the manifest `
						+ `ships ${id} ${target.version}`,
				});
			}
		}

		for (const [id, requirement] of Object.entries(mod.breaks ?? {})) {
			const target = provided.get(id);
			if (target && satisfies(target.parsed, requirement)) {
				problems.push({
					severity: "error",
					mod: mod.id,
					file: mod.file,
					detail: `declares it BREAKS with "${id}" ${JSON.stringify(requirement)}, and `
						+ `the manifest ships ${id} ${target.version}`,
				});
			}
		}

		for (const [id, requirement] of Object.entries(mod.recommends ?? {})) {
			const target = provided.get(id);
			if (!target || !satisfies(target.parsed, requirement)) {
				problems.push({
					severity: "warning",
					mod: mod.id,
					file: mod.file,
					detail: `recommends "${id}" ${JSON.stringify(requirement)}`
						+ (target ? `, manifest ships ${target.version}` : `, not present`),
				});
			}
		}
	}
	return problems;
}

// ---------------------------------------------------------------------------
//  CLI
// ---------------------------------------------------------------------------

function defaultModsDir() {
	const home = os.homedir();
	if (process.platform === "darwin") {
		return path.join(home, "Library", "Application Support", "minecraft", "mods");
	}
	if (process.platform === "win32") {
		return path.join(process.env.APPDATA ?? home, ".minecraft", "mods");
	}
	return path.join(home, ".minecraft", "mods");
}

async function main() {
	const argv = process.argv.slice(2);
	let dir = null;
	let manifestPath = "./mods.json";
	let side = "all";
	let asJson = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dir") dir = argv[++i];
		else if (arg === "--manifest") manifestPath = argv[++i];
		else if (arg === "--side") side = argv[++i];
		else if (arg === "--json") asJson = true;
		else if (!arg.startsWith("--") && manifestPath === "./mods.json") manifestPath = arg;
	}
	dir ??= defaultModsDir();

	let manifest = null;
	try {
		manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
	} catch {
		// A missing manifest only costs us the Minecraft version; the jars still carry the truth.
	}

	let files;
	try {
		files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".jar")).sort();
	} catch (error) {
		console.error(`load-check: cannot read ${dir}: ${error.message}`);
		process.exit(1);
	}

	const javaVersion = Number.parseInt(process.env.LOAD_CHECK_JAVA ?? "25", 10);
	const into = { mods: [], provided: platformProviders(manifest, javaVersion), malformed: [] };

	for (const file of files) {
		const buf = await fsp.readFile(path.join(dir, file));
		collectMods(buf, file, into);
	}

	const problems = check(into.mods, into.provided, side);
	const errors = problems.filter((p) => p.severity === "error");
	const warnings = problems.filter((p) => p.severity === "warning");

	if (asJson) {
		console.log(JSON.stringify({ dir, side, mods: into.mods.length, errors, warnings }, null, 2));
		process.exit(errors.length === 0 ? 0 : 1);
	}

	const topLevel = into.mods.filter((m) => !m.nested).length;
	console.log(`load-check: ${topLevel} mods (+${into.mods.length - topLevel} bundled), `
		+ `side=${side}, minecraft=${manifest?.minecraft ?? "unknown"}`);

	for (const bad of into.malformed) {
		console.log(`  !! ${bad.file}: unreadable fabric.mod.json — ${bad.reason}`);
	}
	for (const warning of warnings) {
		console.log(`  ~  ${warning.mod} (${warning.file})\n     ${warning.detail}`);
	}

	if (errors.length === 0) {
		console.log("");
		console.log(`load-check: PASS — every declared dependency is satisfied by the manifest`);
		process.exit(0);
	}

	console.log("");
	console.log(`!! LOAD CHECK FAILED — this mod set would not start`);
	console.log("");
	for (const error of errors) {
		console.log(`  ${error.mod}  (${error.file})`);
		console.log(`     ${error.detail}`);
	}
	console.log("");
	console.log(`${errors.length} unsatisfied dependenc${errors.length === 1 ? "y" : "ies"}. `
		+ `Fix the manifest before shipping.`);
	process.exit(1);
}

main().catch((error) => {
	console.error(`load-check: ${error.stack ?? error.message}`);
	process.exit(1);
});
