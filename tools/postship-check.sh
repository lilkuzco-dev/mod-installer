#!/bin/bash
# postship-check — the ship gate.
#
# A release is not shipped when the GitHub release is live; it is shipped when
# the local mods folder provably matches the manifest. This script:
#   1. runs the installer sync,
#   2. re-runs it --dry-run and requires "Already in sync",
#   3. independently re-hashes every extra_mods jar against the manifest sha512,
# and exits nonzero with a loud mismatch table on any divergence.
#
# Usage: tools/postship-check.sh [manifest-url-or-path] [--dir <mods-dir>]
# All arguments pass through to mod-installer.js; defaults match the installer
# (./mods.json, auto-detected .minecraft/mods).

set -o pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

echo "== postship-check: installer sync =="
if ! node mod-installer.js "$@"; then
  echo ""
  echo "!! POSTSHIP CHECK FAILED — installer sync errored" >&2
  exit 1
fi

echo ""
echo "== postship-check: convergence (dry-run must be a no-op) =="
DRY_OUT="$(node mod-installer.js "$@" --dry-run 2>&1)"
DRY_EXIT=$?
echo "$DRY_OUT" | tail -n 12
# in-sync dry-run output: a zero-change plan ("Already in sync" is only printed
# outside dry-run mode, which exits earlier on its own branch)
if [ $DRY_EXIT -ne 0 ] || ! echo "$DRY_OUT" | grep -qE "Plan: 0 to add, [0-9]+ to keep, 0 to replace, 0 to remove|Already in sync"; then
  echo ""
  echo "!! POSTSHIP CHECK FAILED — mods folder does not converge to the manifest" >&2
  echo "!! (a second sync still wants changes; see plan above)" >&2
  exit 1
fi

echo ""
echo "== postship-check: independent sha512 diff (extra_mods) =="
node - "$@" <<'NODEEOF'
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// mirror the installer's defaults: ./mods.json, auto-detected .minecraft/mods
const argv = process.argv.slice(2);
let manifestArg = null, dir = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dir") dir = argv[++i];
  else if (!argv[i].startsWith("--") && !manifestArg) manifestArg = argv[i];
}
const manifestPath = manifestArg ?? "./mods.json";
if (/^https?:/.test(manifestPath)) {
  console.error("remote manifests: pass a local path for the sha512 diff step");
  process.exit(1);
}
if (!dir) {
  const home = os.homedir();
  dir =
    process.platform === "darwin" ? path.join(home, "Library", "Application Support", "minecraft", "mods")
    : process.platform === "win32" ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), ".minecraft", "mods")
    : path.join(home, ".minecraft", "mods");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const extras = manifest.extra_mods ?? [];
const rows = [];
let failed = false;

for (const e of extras) {
  const p = path.join(dir, e.filename);
  let status, detail;
  if (!fs.existsSync(p)) {
    status = "MISSING"; detail = "file not in mods folder";
    failed = true;
  } else {
    const actual = createHash("sha512").update(fs.readFileSync(p)).digest("hex");
    if (actual === e.sha512) {
      status = "OK"; detail = "sha512 " + actual.slice(0, 16) + "…";
    } else {
      status = "MISMATCH"; detail = `expected ${e.sha512.slice(0, 16)}… got ${actual.slice(0, 16)}…`;
      failed = true;
    }
  }
  rows.push([e.filename, status, detail]);
}

// stray direct-URL-looking jars that shadow a manifest mod under another version
const extraNames = new Set(extras.map((e) => e.filename));
const stems = new Set(extras.map((e) => e.filename.replace(/-[\d].*$/, "")));
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".jar"))) {
  const stem = f.replace(/-[\d].*$/, "");
  if (!extraNames.has(f) && stems.has(stem)) {
    rows.push([f, "STRAY", "same mod, version not in manifest"]);
    failed = true;
  }
}

const w = Math.max(3, ...rows.map((r) => r[0].length));
console.log("JAR".padEnd(w) + "  " + "STATUS".padEnd(9) + "DETAIL");
console.log("-".repeat(w + 40));
for (const [n, s, d] of rows) console.log(n.padEnd(w) + "  " + s.padEnd(9) + d);

if (failed) {
  console.error("\n!! POSTSHIP CHECK FAILED — mods folder diverges from manifest name+version+sha512");
  process.exit(1);
}
console.log("\npostship-check: PASS — mods folder matches the manifest");
NODEEOF
exit $?
