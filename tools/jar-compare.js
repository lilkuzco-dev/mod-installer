#!/usr/bin/env node
// jar-compare — do these two jars contain the same mod?
//
// Rule 3's cheap test is "rebuild from committed source and compare the hash to the manifest".
// That test caught a real release built from uncommitted source, and it is worth keeping. But
// compared by sha512 alone it has a false-positive mode that will waste an afternoon:
//
//   Fabric Loom writes META-INF/MANIFEST.MF's `Fabric-Loom-Client-Only-Entries` in set
//   iteration order. Two builds of byte-identical source therefore produce jars whose only
//   difference is the ORDER of that one list — a couple of bytes, a different sha512, and
//   every class and resource inside identical.
//
// Measured on 2026-08-20: enchanted-forest 0.1.9 and waldschatten 0.1.2 both failed a naive
// hash comparison against their shipped release for exactly this reason, and both were in fact
// the committed source. hirelings 0.6.0, whose list happens to be short enough to land in the
// same order twice, reproduced byte-for-byte. A check that fires on jar ordering teaches people
// to ignore it, which is how it stops catching the case it exists for.
//
// So: compare CONTENT. Every entry's name, CRC32 and uncompressed size — the fields the zip
// central directory already carries, so nothing has to be inflated. A difference in any real
// file is reported and exits nonzero. A difference confined to the manifest is decoded and
// explained, and the client-only-entries reordering is recognised by name rather than waved
// through by a general "manifests always differ" rule.
//
// Zero dependencies, CommonJS, Node 18+ — same constraints as the installer.
//
// Usage: node tools/jar-compare.js <a.jar> <b.jar> [--verbose]
//
// Exit 0: the two jars hold the same mod.
// Exit 1: they do not, or one could not be read.

"use strict";

const fs = require("node:fs");
const zlib = require("node:zlib");

// ---------------------------------------------------------------------------
//  Central directory
// ---------------------------------------------------------------------------
// Only the central directory is read. It already carries the CRC32 of every entry, which is
// exactly the content fingerprint wanted here, so the compressed bytes are never touched
// except for the one manifest that may need explaining.

function findEndOfCentralDirectory(buf) {
	const minimum = 22;
	const limit = Math.min(buf.length, 65535 + minimum);
	for (let i = buf.length - minimum; i >= buf.length - limit && i >= 0; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) return i;
	}
	return -1;
}

function listEntries(buf) {
	const eocd = findEndOfCentralDirectory(buf);
	if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");

	let count = buf.readUInt16LE(eocd + 10);
	let offset = buf.readUInt32LE(eocd + 16);

	// Zip64: the 32-bit fields saturate and the real values live in a separate record.
	if (offset === 0xffffffff || count === 0xffff) {
		for (let i = eocd - 20; i >= 0; i--) {
			if (buf.readUInt32LE(i) === 0x07064b50) {
				const zip64Start = Number(buf.readBigUInt64LE(i + 8));
				if (buf.readUInt32LE(zip64Start) === 0x06064b50) {
					count = Number(buf.readBigUInt64LE(zip64Start + 32));
					offset = Number(buf.readBigUInt64LE(zip64Start + 48));
				}
				break;
			}
		}
	}

	const entries = new Map();
	let p = offset;
	for (let i = 0; i < count && p + 46 <= buf.length; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) break;
		const method = buf.readUInt16LE(p + 10);
		const crc = buf.readUInt32LE(p + 16);
		const compressedSize = buf.readUInt32LE(p + 20);
		const uncompressedSize = buf.readUInt32LE(p + 24);
		const nameLength = buf.readUInt16LE(p + 28);
		const extraLength = buf.readUInt16LE(p + 30);
		const commentLength = buf.readUInt16LE(p + 32);
		const localHeader = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
		entries.set(name, { name, method, crc, compressedSize, uncompressedSize, localHeader });
		p += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

function readEntry(buf, entry) {
	// The local header's name and extra lengths are authoritative for where the data starts;
	// they are not required to match the central directory's.
	const p = entry.localHeader;
	if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
	const nameLength = buf.readUInt16LE(p + 26);
	const extraLength = buf.readUInt16LE(p + 28);
	const start = p + 30 + nameLength + extraLength;
	const raw = buf.subarray(start, start + entry.compressedSize);
	return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

// ---------------------------------------------------------------------------
//  Jar manifests
// ---------------------------------------------------------------------------

// A jar manifest wraps at 72 bytes and continues with a single leading space. Unfolding first
// is the difference between comparing values and comparing where the line breaks landed.
function parseJarManifest(text) {
	const unfolded = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n /g, "");
	const out = new Map();
	for (const line of unfolded.split("\n")) {
		const at = line.indexOf(":");
		if (at > 0) out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
	}
	return out;
}

// Loom emits this one from an unordered set. Same members, any order, same jar.
const UNORDERED_MANIFEST_KEYS = new Set(["Fabric-Loom-Client-Only-Entries"]);

function sameUnorderedList(a, b) {
	const split = (s) => s.split(";").map((x) => x.trim()).filter(Boolean).sort();
	const [x, y] = [split(a), split(b)];
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

// ---------------------------------------------------------------------------

function main() {
	const argv = process.argv.slice(2);
	const verbose = argv.includes("--verbose");
	const paths = argv.filter((a) => !a.startsWith("--"));
	if (paths.length !== 2) {
		console.error("usage: node tools/jar-compare.js <a.jar> <b.jar> [--verbose]");
		process.exit(1);
	}

	const [pathA, pathB] = paths;
	const bufA = fs.readFileSync(pathA);
	const bufB = fs.readFileSync(pathB);
	const a = listEntries(bufA);
	const b = listEntries(bufB);

	const onlyA = [...a.keys()].filter((n) => !b.has(n)).sort();
	const onlyB = [...b.keys()].filter((n) => !a.has(n)).sort();
	const differing = [...a.keys()]
		.filter((n) => b.has(n))
		.filter((n) => a.get(n).crc !== b.get(n).crc || a.get(n).uncompressedSize !== b.get(n).uncompressedSize)
		.sort();

	console.log(`jar-compare: ${pathA}`);
	console.log(`             ${pathB}`);
	console.log(`  ${a.size} entries vs ${b.size} entries`);

	// A manifest-only difference gets explained rather than merely reported: it is the one
	// difference a reader is likely to be looking at during a release check, and "the build
	// stamp moved" and "the code changed" must never look the same on the way past.
	let manifestBenign = false;
	const MANIFEST = "META-INF/MANIFEST.MF";
	if (differing.length === 1 && differing[0] === MANIFEST && !onlyA.length && !onlyB.length) {
		const ma = parseJarManifest(readEntry(bufA, a.get(MANIFEST)).toString("utf8"));
		const mb = parseJarManifest(readEntry(bufB, b.get(MANIFEST)).toString("utf8"));
		const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort();
		const real = [];
		const reordered = [];
		for (const k of keys) {
			const [va, vb] = [ma.get(k), mb.get(k)];
			if (va === vb) continue;
			if (va !== undefined && vb !== undefined && UNORDERED_MANIFEST_KEYS.has(k) && sameUnorderedList(va, vb)) {
				reordered.push(k);
			} else {
				real.push([k, va, vb]);
			}
		}
		if (!real.length && reordered.length) {
			manifestBenign = true;
			console.log("");
			console.log("  Every file inside is identical. The manifests differ only by the order of:");
			for (const k of reordered) console.log(`    ${k}  (same ${ma.get(k).split(";").length} members, different order)`);
			console.log("  That is Loom writing an unordered set, not a difference in the mod.");
		} else if (real.length) {
			console.log("");
			console.log("  Only META-INF/MANIFEST.MF differs, and the difference is real:");
			for (const [k, va, vb] of real) {
				console.log(`    ${k}`);
				console.log(`      a: ${va ?? "(absent)"}`);
				console.log(`      b: ${vb ?? "(absent)"}`);
			}
		}
	}

	if (!manifestBenign && (onlyA.length || onlyB.length || differing.length)) {
		if (onlyA.length) {
			console.log(`\n  only in a (${onlyA.length}):`);
			for (const n of verbose ? onlyA : onlyA.slice(0, 20)) console.log(`    ${n}`);
			if (!verbose && onlyA.length > 20) console.log(`    … ${onlyA.length - 20} more (--verbose)`);
		}
		if (onlyB.length) {
			console.log(`\n  only in b (${onlyB.length}):`);
			for (const n of verbose ? onlyB : onlyB.slice(0, 20)) console.log(`    ${n}`);
			if (!verbose && onlyB.length > 20) console.log(`    … ${onlyB.length - 20} more (--verbose)`);
		}
		if (differing.length) {
			console.log(`\n  differing content (${differing.length}):`);
			for (const n of verbose ? differing : differing.slice(0, 20)) console.log(`    ${n}`);
			if (!verbose && differing.length > 20) console.log(`    … ${differing.length - 20} more (--verbose)`);
		}
		console.log("\njar-compare: DIFFERENT — these are not the same mod");
		process.exit(1);
	}

	console.log(manifestBenign
		? "\njar-compare: SAME CONTENT (build stamp differs, nothing else)"
		: "\njar-compare: IDENTICAL");
	process.exit(0);
}

try {
	main();
} catch (error) {
	console.error(error.stack ?? error.message);
	process.exit(1);
}
