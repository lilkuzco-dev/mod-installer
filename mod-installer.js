#!/usr/bin/env node
// mod-installer — keep a Minecraft mods folder in sync with a shared manifest, via Modrinth.
// Zero dependencies; requires Node 18+ (built-in fetch).
// CommonJS on purpose: Node's Single Executable Application feature (see build.js)
// only accepts a CommonJS entry script.

const { createHash } = require("node:crypto");
const { createReadStream, createWriteStream } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const VERSION = "1.2.0";
const API = "https://api.modrinth.com/v2";
const USER_AGENT = `mod-installer/${VERSION} (friend-group Minecraft mod sync; Node.js CLI)`;
const DOWNLOAD_CONCURRENCY = 3;

// In standalone binaries, build.js replaces null with the group's manifest URL so
// running with no arguments syncs against the shared list.
const BAKED_MANIFEST_URL = null;

const USAGE = `mod-installer — sync a Minecraft mods folder from a shared manifest via Modrinth

Usage:
  ${BAKED_MANIFEST_URL ? "mod-installer" : "node mod-installer.js"} [manifest-url-or-path] [options]

  With no manifest argument, ${BAKED_MANIFEST_URL ?? "./mods.json"} is used.

Options:
  --dir <path>   Mods folder to sync (default: the auto-detected .minecraft/mods
                 for this OS). Point this at your server's mods folder for servers.
  --side <which> Which side to install for: client (default), server, or all.
                 Entries tagged "both" always install; "client"/"server" entries
                 install only for their own side. "all" ignores the tags.
  --dry-run      Show what would be added/kept/removed without changing anything
  --no-remove    Add and update mods, but never delete jars that aren't in the manifest
  --version      Print the version and exit
  -h, --help     Show this help

Manifest format:
  { "minecraft": "1.21.1", "loader": "fabric", "mods": ["fabric-api", "sodium"] }
  A "mods" entry is either a bare Modrinth slug (side defaults to "both") or an
  object tagging the side it belongs on:
  { "slug": "sodium", "side": "client" }        // client | server | both
  Optionally "extra_mods": directly-hosted jars, synced and verified like the rest,
  and side-taggable the same way:
  [{ "filename": "my-mod.jar", "url": "https://...", "sha512": "<128 hex chars>",
     "side": "both" }]

Servers:
  mod-installer --dir /srv/mc/mods --side server`;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// Side tags a manifest entry may carry, and the filters --side accepts. They are
// deliberately different sets: "both" describes an entry, "all" describes a sync.
const ENTRY_SIDES = new Set(["client", "server", "both"]);
const SIDE_FILTERS = new Set(["client", "server", "all"]);

// An entry installs when the sync wants everything, when the entry belongs on
// both sides, or when it is tagged for exactly the side being synced.
const sideMatches = (entrySide, filter) => filter === "all" || entrySide === "both" || entrySide === filter;

function parseArgs(argv) {
  const opts = { manifest: null, dir: null, dryRun: false, noRemove: false, side: "client" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      opts.dir = argv[++i];
      if (!opts.dir) fail("--dir requires a path");
    } else if (arg === "--side") {
      const value = argv[++i];
      if (!value) fail("--side requires one of: client, server, all");
      opts.side = value.toLowerCase();
      if (!SIDE_FILTERS.has(opts.side)) fail(`--side must be one of: client, server, all (got "${value}")`);
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--no-remove") opts.noRemove = true;
    else if (arg === "--version") {
      console.log(`mod-installer ${VERSION}`);
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) fail(`Unknown flag: ${arg}\n\n${USAGE}`);
    else if (opts.manifest) fail("Only one manifest argument is allowed");
    else opts.manifest = arg;
  }
  return opts;
}

function defaultModsDir() {
  const home = os.homedir();
  switch (process.platform) {
    case "win32": {
      const appdata = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
      return path.join(appdata, ".minecraft", "mods");
    }
    case "darwin":
      return path.join(home, "Library", "Application Support", "minecraft", "mods");
    default:
      return path.join(home, ".minecraft", "mods");
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, tries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (err) {
      lastError = new Error(`Network error fetching ${url}: ${err.message}`);
      if (attempt < tries) {
        await sleep(1000 * attempt);
        continue;
      }
      throw lastError;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(res.status === 429 ? (retryAfter || 5) * 1000 : 1000 * attempt);
      continue;
    }
    const err = new Error(`HTTP ${res.status} fetching ${url}`);
    err.status = res.status;
    throw err;
  }
  throw lastError;
}

async function api(route) {
  const res = await fetchWithRetry(API + route);
  return res.json();
}

// A "mods" entry is either a bare slug (v1.1 manifests, and anything that simply
// belongs on both sides) or an object carrying an explicit side tag. Both shapes
// normalize to { slug, side } so the rest of the installer only sees one form.
function normalizeModEntry(raw, where) {
  if (typeof raw === "string") {
    if (!raw) throw new Error(`${where} must be a non-empty Modrinth slug`);
    return { slug: raw, side: "both" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be a Modrinth slug string or a { "slug", "side" } object`);
  }
  if (typeof raw.slug !== "string" || !raw.slug) {
    throw new Error(`${where}.slug must be a non-empty Modrinth slug`);
  }
  return { slug: raw.slug, side: normalizeSide(raw.side, where) };
}

function normalizeSide(side, where) {
  if (side === undefined) return "both";
  if (typeof side !== "string" || !ENTRY_SIDES.has(side.toLowerCase())) {
    throw new Error(`${where}.side must be "client", "server", or "both" (got ${JSON.stringify(side)})`);
  }
  return side.toLowerCase();
}

// Duplicate slugs are harmless when they agree; when they disagree the manifest
// is ambiguous about where the mod belongs, and guessing would silently install
// (or skip) it on a side someone did not intend.
function dedupeModEntries(entries) {
  const bySlug = new Map();
  for (const entry of entries) {
    const seen = bySlug.get(entry.slug);
    if (!seen) bySlug.set(entry.slug, entry);
    else if (seen.side !== entry.side) {
      throw new Error(
        `Manifest lists "${entry.slug}" more than once with conflicting sides ("${seen.side}" and "${entry.side}")`,
      );
    }
  }
  return [...bySlug.values()];
}

async function loadManifest(source) {
  let text;
  let label;
  if (source && /^https?:\/\//i.test(source)) {
    label = source;
    const res = await fetchWithRetry(source).catch((err) => {
      throw new Error(`Could not fetch manifest from ${source}: ${err.message}`);
    });
    text = await res.text();
  } else {
    label = source ?? "./mods.json";
    try {
      text = await fs.readFile(source ?? "mods.json", "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(`Manifest not found at ${label}. Pass a manifest URL/path, or create mods.json here.`);
      }
      throw err;
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`Manifest at ${label} is not valid JSON`);
  }
  if (typeof manifest.minecraft !== "string" || !manifest.minecraft) {
    throw new Error(`Manifest is missing "minecraft" (e.g. "1.21.1")`);
  }
  if (typeof manifest.loader !== "string" || !manifest.loader) {
    throw new Error(`Manifest is missing "loader" (e.g. "fabric")`);
  }
  if (!Array.isArray(manifest.mods) || manifest.mods.length === 0) {
    throw new Error(`Manifest "mods" must be a non-empty array of Modrinth slugs or { "slug", "side" } entries`);
  }
  manifest.loader = manifest.loader.toLowerCase();
  manifest.mods = dedupeModEntries(
    manifest.mods.map((entry, i) => normalizeModEntry(entry, `Manifest mods[${i}]`)),
  );
  if (manifest.extra_mods === undefined) {
    manifest.extra_mods = [];
  } else {
    if (!Array.isArray(manifest.extra_mods)) throw new Error(`Manifest "extra_mods" must be an array`);
    for (const [i, extra] of manifest.extra_mods.entries()) {
      const where = `Manifest extra_mods[${i}]`;
      if (typeof extra !== "object" || extra === null) throw new Error(`${where} must be an object`);
      if (typeof extra.url !== "string" || !/^https?:\/\//i.test(extra.url)) throw new Error(`${where}.url must be an http(s) URL`);
      if (typeof extra.sha512 !== "string" || !/^[0-9a-f]{128}$/i.test(extra.sha512)) throw new Error(`${where}.sha512 must be 128 hex characters`);
      if (typeof extra.filename !== "string" || !extra.filename.toLowerCase().endsWith(".jar") || /[/\\]/.test(extra.filename)) {
        throw new Error(`${where}.filename must be a bare .jar filename (no directories)`);
      }
      extra.sha512 = extra.sha512.toLowerCase();
      extra.side = normalizeSide(extra.side, where);
    }
  }
  return { manifest, label };
}

// Resolve every manifest slug plus all transitive "required" dependencies into a
// flat install set, deduped by Modrinth project id. Sequential on purpose — a
// friend-group mod list is small and this keeps us polite to the API.
// modEntries is the side-filtered subset of manifest.mods; dependencies inherit
// their parent's side implicitly, since a filtered-out root is never resolved
// and so never pulls its libraries in.
async function resolveInstallSet(manifest, modEntries) {
  const filter =
    `?game_versions=${encodeURIComponent(JSON.stringify([manifest.minecraft]))}` +
    `&loaders=${encodeURIComponent(JSON.stringify([manifest.loader]))}`;
  const resolved = new Map(); // project id -> install entry
  const seenRefs = new Set(); // slugs and ids we've already handled

  async function resolveOne(ref, requiredBy) {
    if (seenRefs.has(ref)) return;
    let project;
    try {
      project = await api(`/project/${ref}`);
    } catch (err) {
      if (err.status === 404) {
        throw new Error(
          requiredBy
            ? `Dependency "${ref}" (required by ${requiredBy}) was not found on Modrinth`
            : `Mod "${ref}" was not found on Modrinth — check the slug in the manifest`,
        );
      }
      throw err;
    }
    seenRefs.add(ref);
    if (resolved.has(project.id)) return;
    seenRefs.add(project.id);
    seenRefs.add(project.slug);

    const versions = await api(`/project/${project.id}/version${filter}`);
    if (!Array.isArray(versions) || versions.length === 0) {
      const via = requiredBy ? ` (required by ${requiredBy})` : "";
      throw new Error(
        `No compatible version of "${project.title}" (${project.slug})${via} exists for Minecraft ${manifest.minecraft} on ${manifest.loader}`,
      );
    }
    versions.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
    // Prefer stable builds: the newest release, falling back to the newest beta,
    // then alpha, only when no stabler channel exists for this game version + loader.
    const version =
      versions.find((v) => v.version_type === "release") ??
      versions.find((v) => v.version_type === "beta") ??
      versions[0];
    const file = version.files?.find((f) => f.primary) ?? version.files?.[0];
    if (!file) throw new Error(`Modrinth lists no files for ${project.title} ${version.version_number}`);
    if (!file.hashes?.sha512) throw new Error(`Modrinth returned no SHA-512 hash for ${file.filename}`);

    resolved.set(project.id, {
      projectId: project.id,
      slug: project.slug,
      title: project.title,
      versionNumber: version.version_number,
      filename: file.filename,
      url: file.url,
      sha512: file.hashes.sha512,
      size: file.size ?? 0,
      requiredBy,
    });
    const channelNote = version.version_type === "release" ? "" : `  [${version.version_type} — no release build available]`;
    console.log(`  ${project.title} ${version.version_number}${channelNote}${requiredBy ? `  (dependency of ${requiredBy})` : ""}`);

    for (const dep of version.dependencies ?? []) {
      if (dep.dependency_type !== "required") continue;
      let depRef = dep.project_id;
      if (!depRef && dep.version_id) {
        const depVersion = await api(`/version/${dep.version_id}`).catch(() => null);
        depRef = depVersion?.project_id;
      }
      if (depRef) await resolveOne(depRef, project.title);
    }
  }

  for (const entry of modEntries) await resolveOne(entry.slug, null);
  return [...resolved.values()];
}

// Direct-URL jars from "extra_mods": same sync/verify semantics, no dependency
// resolution (the manifest's Modrinth list is assumed to cover any deps).
function extraModEntries(extras) {
  return extras.map((extra) => {
    console.log(`  ${extra.filename}  (direct URL)`);
    return {
      projectId: null,
      slug: extra.filename,
      title: extra.filename,
      versionNumber: "",
      filename: extra.filename,
      url: extra.url,
      sha512: extra.sha512,
      size: 0, // unknown until downloaded
      requiredBy: null,
      direct: true,
    };
  });
}

function checkFilenameCollisions(entries) {
  const byFilename = new Map();
  for (const entry of entries) {
    const clash = byFilename.get(entry.filename);
    if (clash) throw new Error(`Filename collision: "${entry.filename}" comes from both ${clash.title} and ${entry.title}`);
    byFilename.set(entry.filename, entry);
  }
}

function sha512File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

// Compare the resolved install set against what's on disk.
async function buildPlan(modsDir, entries) {
  let dirEntries = null; // null = folder doesn't exist
  try {
    dirEntries = await fs.readdir(modsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const existingJars = (dirEntries ?? [])
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".jar"))
    .map((d) => d.name);

  const wanted = new Set(entries.map((e) => e.filename));
  const adds = [];
  const keeps = [];
  const replaces = []; // present but hash doesn't match the expected file
  for (const entry of entries) {
    if (!existingJars.includes(entry.filename)) {
      adds.push(entry);
    } else if ((await sha512File(path.join(modsDir, entry.filename))) === entry.sha512) {
      keeps.push(entry);
    } else {
      replaces.push(entry);
    }
  }
  const removes = existingJars.filter((name) => !wanted.has(name));
  return { adds, keeps, replaces, removes, folderEntries: dirEntries?.length ?? 0, folderExists: dirEntries !== null };
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function downloadVerified(entry, modsDir) {
  const dest = path.join(modsDir, entry.filename);
  const partial = `${dest}.partial`;
  let problem;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithRetry(entry.url);
      if (!res.body) throw new Error("empty response body");
      const hash = createHash("sha512");
      await pipeline(
        Readable.fromWeb(res.body),
        async function* (source) {
          for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(partial),
      );
      const digest = hash.digest("hex");
      if (digest === entry.sha512) {
        await fs.rename(partial, dest);
        return;
      }
      problem = `SHA-512 mismatch (expected ${entry.sha512.slice(0, 16)}…, got ${digest.slice(0, 16)}…)`;
    } catch (err) {
      problem = err.message;
    }
    await fs.rm(partial, { force: true });
    if (attempt === 1) console.log(`  retrying ${entry.filename}: ${problem}`);
  }
  throw new Error(`Failed to download ${entry.filename} (${entry.title}): ${problem}`);
}

// Run worker over every item with limited concurrency; attempt everything,
// then fail with all collected errors at once.
async function runPool(items, limit, worker) {
  let next = 0;
  const errors = [];
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (err) {
        errors.push(err);
      }
    }
  });
  await Promise.all(lanes);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("\n"));
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const { manifest, label } = await loadManifest(opts.manifest ?? BAKED_MANIFEST_URL);
  console.log(`Manifest: ${label}`);
  const selectedMods = manifest.mods.filter((m) => sideMatches(m.side, opts.side));
  const selectedExtras = manifest.extra_mods.filter((e) => sideMatches(e.side, opts.side));
  const skipped = manifest.mods.length + manifest.extra_mods.length - selectedMods.length - selectedExtras.length;

  console.log(`Target:   Minecraft ${manifest.minecraft} / ${manifest.loader} — ${manifest.mods.length} mod(s) listed`);
  console.log(`Side:     ${opts.side}${skipped ? ` — ${skipped} entr${skipped === 1 ? "y" : "ies"} tagged for the other side, skipped` : ""}`);

  // Without this guard an all-other-side manifest would resolve to an empty
  // install set, and the sync would read that as "remove every jar".
  if (selectedMods.length + selectedExtras.length === 0) {
    throw new Error(`No mods match --side ${opts.side} — every manifest entry is tagged for the other side`);
  }

  console.log(`\nResolving versions and dependencies on Modrinth...`);
  const entries = await resolveInstallSet(manifest, selectedMods);
  const depCount = entries.filter((e) => e.requiredBy).length;
  entries.push(...extraModEntries(selectedExtras));
  checkFilenameCollisions(entries);
  const notes = [
    depCount ? `${depCount} pulled in as dependencies` : "",
    selectedExtras.length ? `${selectedExtras.length} direct-URL` : "",
  ].filter(Boolean).join(", ");
  console.log(`Install set: ${entries.length} mod(s)${notes ? ` (${notes})` : ""}`);

  const modsDir = path.resolve(opts.dir ?? defaultModsDir());
  console.log(`\nMods folder: ${modsDir}`);
  const plan = await buildPlan(modsDir, entries);

  console.log(`Plan: ${plan.adds.length} to add, ${plan.keeps.length} to keep, ${plan.replaces.length} to replace, ${plan.removes.length} to remove${opts.noRemove && plan.removes.length ? " (skipped: --no-remove)" : ""}`);
  const describe = (e) => (e.direct ? "direct URL" : `${e.title} ${e.versionNumber}`);
  for (const e of plan.adds) console.log(`  + add      ${e.filename}  (${describe(e)}${e.size ? `, ${fmtSize(e.size)}` : ""})`);
  for (const e of plan.replaces) console.log(`  ~ replace  ${e.filename}  (on disk but hash differs; will re-download)`);
  for (const e of plan.keeps) console.log(`  = keep     ${e.filename}  (${describe(e)}, hash verified)`);
  for (const name of plan.removes) console.log(`  - remove   ${name}${opts.noRemove ? "  (kept: --no-remove)" : ""}`);

  if (opts.dryRun) {
    console.log(`\nDry run — nothing was changed.`);
    return;
  }

  const removals = opts.noRemove ? [] : plan.removes;
  const downloads = [...plan.adds, ...plan.replaces];
  if (downloads.length === 0 && removals.length === 0) {
    console.log(`\nAlready in sync — nothing to do.`);
    return;
  }

  let backupDir = null;
  if (plan.folderExists && plan.folderEntries > 0) {
    backupDir = path.join(path.dirname(modsDir), `mods-backup-${timestamp()}`);
    await fs.cp(modsDir, backupDir, { recursive: true });
    console.log(`\nBacked up mods folder to ${backupDir}`);
  } else {
    console.log(`\nNo existing mods to back up.`);
  }
  await fs.mkdir(modsDir, { recursive: true });

  if (downloads.length > 0) {
    const totalSize = downloads.reduce((sum, e) => sum + e.size, 0);
    const sizeNote = downloads.every((e) => e.size > 0) ? `, ${fmtSize(totalSize)} total` : "";
    console.log(`Downloading ${downloads.length} file(s)${sizeNote}...`);
    await runPool(downloads, DOWNLOAD_CONCURRENCY, async (entry) => {
      await downloadVerified(entry, modsDir);
      console.log(`  + ${entry.filename}  (SHA-512 verified)`);
    });
  }
  for (const name of removals) {
    await fs.rm(path.join(modsDir, name));
    console.log(`  - ${name}  removed`);
  }

  console.log(
    `\nDone: ${downloads.length} added/updated, ${plan.keeps.length} kept, ${removals.length} removed.` +
      (opts.noRemove && plan.removes.length ? ` ${plan.removes.length} unmanaged jar(s) left in place (--no-remove).` : ""),
  );
  if (backupDir) console.log(`Backup: ${backupDir}`);
}

// In the standalone binary on Windows, a double-click opens a console window that
// vanishes the instant the process exits — hold it open so the output stays readable.
async function finish(code) {
  if (BAKED_MANIFEST_URL && process.platform === "win32" && process.stdin.isTTY) {
    process.stdout.write("\nPress Enter to close...");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    process.stdin.pause();
  }
  process.exitCode = code;
}

main().then(
  () => finish(0),
  (err) => {
    console.error(`\nError: ${err.message}`);
    return finish(1);
  },
);
