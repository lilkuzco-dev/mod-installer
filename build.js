#!/usr/bin/env node
// build.js — produce standalone, double-clickable executables using Node's built-in
// Single Executable Application (SEA) feature. No npm dependencies: the official
// `postject` injector is run once via npx, exactly as the Node docs prescribe.
//
// Outputs (gitignored):
//   dist/mod-installer      — binary for the platform this script runs on
//   dist/mod-installer.exe  — Windows x64, cross-built by downloading the matching
//                             official node.exe from nodejs.org (skipped if offline)
//
// The group manifest URL below is baked into the binaries as the no-argument
// default; a URL or local path passed on the command line still overrides it.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_URL = "https://raw.githubusercontent.com/lilkuzco-dev/mod-installer/main/mods.json";

const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const ROOT = __dirname;
const BUILD = path.join(ROOT, "build");
const DIST = path.join(ROOT, "dist");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// Fold tools/load-check.js into the entry script. A SEA carries one CommonJS file and
// resolves no relative require(), so the gate has to travel as source. It is wrapped in
// the CommonJS shape it already expects, which leaves `require.main === module` false
// inside the wrapper — so the bundled copy exports and never runs its own CLI.
function inlineLoadCheck() {
  const source = fs.readFileSync(path.join(ROOT, "tools", "load-check.js"), "utf8")
    .replace(/^#![^\n]*\n/, ""); // a shebang is a syntax error once this is a function body
  if (!source.includes("module.exports")) {
    throw new Error(`tools/load-check.js exports nothing — the bundled gate would be empty`);
  }
  return `(function () { const module = { exports: {} }; const exports = module.exports;\n${source}\nreturn module.exports; })()`;
}

// Every substitution is asserted before it is made. A str.replace that matches nothing is
// a silent no-op: the build would succeed and ship a binary with no manifest URL baked in,
// or — worse, because it fails invisibly — no load gate.
function bake(source, marker, replacement) {
  if (!source.includes(marker)) throw new Error(`Marker line "${marker}" not found in mod-installer.js`);
  return source.replace(marker, replacement);
}

function makeBlob() {
  let source = fs.readFileSync(path.join(ROOT, "mod-installer.js"), "utf8");
  source = bake(source, "const BAKED_MANIFEST_URL = null;", `const BAKED_MANIFEST_URL = ${JSON.stringify(MANIFEST_URL)};`);
  source = bake(source, "const INLINED_LOAD_CHECK = null;", `const INLINED_LOAD_CHECK = ${inlineLoadCheck()};`);
  fs.writeFileSync(path.join(BUILD, "sea-entry.js"), source);
  fs.writeFileSync(
    path.join(BUILD, "sea-config.json"),
    JSON.stringify({ main: "sea-entry.js", output: "sea-prep.blob", disableExperimentalSEAWarning: true }, null, 2) + "\n",
  );
  run(process.execPath, ["--experimental-sea-config", "sea-config.json"], { cwd: BUILD });
  return path.join(BUILD, "sea-prep.blob");
}

function injectBlob(binary, blob, isMachO) {
  run(npx, [
    "--yes",
    "postject",
    binary,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    SENTINEL_FUSE,
    ...(isMachO ? ["--macho-segment-name", "NODE_SEA"] : []),
  ]);
}

function buildHost(blob) {
  if (process.platform === "win32") {
    const out = path.join(DIST, "mod-installer.exe");
    fs.copyFileSync(process.execPath, out);
    injectBlob(out, blob, false);
    return out;
  }
  const out = path.join(DIST, "mod-installer");
  fs.copyFileSync(process.execPath, out);
  fs.chmodSync(out, 0o755);
  if (process.platform === "darwin") {
    run("codesign", ["--remove-signature", out]);
    injectBlob(out, blob, true);
    run("codesign", ["--sign", "-", out]); // ad-hoc signature; required on Apple Silicon
  } else {
    injectBlob(out, blob, false);
  }
  return out;
}

// The SEA blob contains only the script (no V8 snapshot), so it is platform-independent
// and can be injected into an official Windows node.exe from this machine.
async function crossBuildWindows(blob) {
  const dir = `node-${process.version}-win-x64`;
  const nodeExe = path.join(BUILD, dir, "node.exe");
  if (!fs.existsSync(nodeExe)) {
    const url = `https://nodejs.org/dist/${process.version}/${dir}.zip`;
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
    const zipPath = path.join(BUILD, `${dir}.zip`);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    run("unzip", ["-q", "-o", zipPath, `${dir}/node.exe`, "-d", BUILD]);
  }
  const out = path.join(DIST, "mod-installer.exe");
  fs.copyFileSync(nodeExe, out);
  injectBlob(out, blob, false);
  return out;
}

(async () => {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) throw new Error(`Building requires Node 20+ for SEA support (you have ${process.version})`);
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  const blob = makeBlob();
  console.log(`Built ${buildHost(blob)}`);
  if (process.platform !== "win32") {
    try {
      console.log(`Built ${await crossBuildWindows(blob)}`);
    } catch (err) {
      console.warn(`Skipped Windows cross-build: ${err.message}`);
      console.warn(`Run "npm run build" on a Windows machine with Node 20+ to build the .exe there.`);
    }
  }
})().catch((err) => {
  console.error(`Build failed: ${err.message}`);
  process.exit(1);
});
