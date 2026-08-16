#!/usr/bin/env node
// bmc-screen — auto-screen a CurseForge modlist.html against the Modrinth API.
//
// Reads a CurseForge-exported modlist.html, drops known noise (texture packs,
// Forge-only libraries, "(by X)" patch mods), then for every surviving
// candidate asks Modrinth whether a Fabric build exists for the target MC
// version. Classifies each as:
//
//   AVAILABLE_26.2  — fabric loader + target game version on some version
//   FABRIC_BUT_OLD  — fabric builds exist, none for the target version
//   FORGE_ONLY      — project exists, no fabric builds at all
//   NOT_FOUND       — no confident Modrinth match
//
// Results are cached per-slug so re-runs are cheap; delete the cache to refetch.
//
// Usage: node tools/bmc-screen.js <modlist.html> [--mc 26.2] [--out results.json]
//                                 [--cache cache.json] [--extra "name,name"]

const fs = require("node:fs");
const path = require("node:path");

const UA = "mod-installer/1.1.1 (github.com/lilkuzco-dev/mod-installer; bmc-screen)";
const API = "https://api.modrinth.com/v2";

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
let htmlPath = null;
let targetMc = "26.2";
let outPath = "bmc-screen-results.json";
let cachePath = "bmc-screen-cache.json";
const extraNames = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--mc") targetMc = argv[++i];
  else if (a === "--out") outPath = argv[++i];
  else if (a === "--cache") cachePath = argv[++i];
  else if (a === "--extra") extraNames.push(...argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
  else if (!a.startsWith("--") && !htmlPath) htmlPath = a;
}

if (!htmlPath && extraNames.length === 0) {
  console.error("usage: node tools/bmc-screen.js <modlist.html> [--mc 26.2] [--out f.json] [--extra \"name,name\"]");
  process.exit(1);
}

// ---------------------------------------------------------------- noise filter
//
// These never make it to the API: they cost requests and can never be adopted
// as manifest entries. Anything ambiguous is deliberately left IN so a human
// sees it in the report rather than having it silently disappear.

const NOISE_PATTERNS = [
  // resource / shader / data packs — not Modrinth "mod" projects we install
  /\bresource ?pack\b/i,
  /\btexture ?pack\b/i,
  /\bdata ?pack\b/i,
  /\bshaders?\b/i,
  /\b(faithful|bare bones|stay true|patrix)\b/i,
  // BMC's own per-mod compat patches — pack-internal, not standalone mods
  /\(by\s+txni\)/i,
  /\bbmc\d?\b/i,
  /\bbetter mc\b/i,
  // Forge/NeoForge-only library substrate — irrelevant on a Fabric client
  /\bkotlin for forge\b/i,
  /^blueprint$/i,
  /^citadel$/i,
  /^balm\b/i,
  /^zeta$/i,
  /\bpuzzles?[ -]?lib\b/i,
  /\bforge ?endertech ?lib\b/i,
  /\bgeckolib\b.*forge/i,
  /\bcorgi ?lib\b/i,
  /\bframework\b.*\(forge\)/i,
];

// Real mods whose names collide with the noise patterns above (shader *loaders*
// are mods; shader *packs* are not). An entry here is never dropped.
const NEVER_NOISE = [
  /^iris\b/i,
  /^oculus\b/i,
  /^optifine\b/i,
  /\bshader ?loader\b/i,
  /^continuity$/i,
  /^entity ?texture ?features\b/i,
  /^entity ?model ?features\b/i,
  /^animatica$/i,
  /^cit ?resewn$/i,
];

// Returns a human-readable drop reason, or null to keep. Every parsed entry gets
// one or the other so the report reconciles to the full input count — nothing
// disappears silently between the HTML and the table.
function dropReason(candidate) {
  if (candidate.cfType && candidate.cfType !== "mc-mods") return `curseforge-type:${candidate.cfType}`;
  const label = candidate.rawLabel ?? candidate.name;
  if (NEVER_NOISE.some((re) => re.test(label))) return null;
  const hit = NOISE_PATTERNS.find((re) => re.test(label));
  return hit ? `name-pattern:${hit.source}` : null;
}

// ---------------------------------------------------------------- html parse

function parseModlist(html) {
  const out = [];
  const seen = new Set();
  // CurseForge exports: <li><a href="https://www.curseforge.com/minecraft/mc-mods/SLUG">Name (by Author)</a></li>
  const anchor = /<a\b[^>]*href="([^"]*curseforge\.com\/minecraft\/([^"/?#]+)\/([^"/?#]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchor.exec(html)) !== null) {
    const url = m[1];
    const cfType = m[2];
    const slug = m[3];
    const raw = m[4].replace(/<[^>]+>/g, "").trim();
    const byMatch = raw.match(/^(.*?)\s*\(by\s+(.*?)\)\s*$/i);
    const name = decodeEntities((byMatch ? byMatch[1] : raw).trim());
    const author = byMatch ? decodeEntities(byMatch[2].trim()) : null;
    if (!name || seen.has(`${cfType}/${slug}`)) continue;
    seen.add(`${cfType}/${slug}`);
    out.push({ name, author, url, cfType, cfSlug: slug, rawLabel: decodeEntities(raw) });
  }
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------- http

let lastRequest = 0;
const MIN_INTERVAL_MS = 220; // Modrinth allows ~300 req/min; stay well under

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { allow404 = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastRequest + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();

    let res;
    try {
      res = await fetch(`${API}${pathname}`, { headers: { "User-Agent": UA } });
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status === 404 && allow404) return null;
    if (res.status === 429) {
      const retry = Number(res.headers.get("x-ratelimit-reset") ?? 5);
      await sleep((Number.isFinite(retry) ? retry : 5) * 1000);
      continue;
    }
    if (!res.ok) {
      if (attempt === 3) throw new Error(`${pathname} -> HTTP ${res.status}`);
      await sleep(1000 * (attempt + 1));
      continue;
    }
    return res.json();
  }
  throw new Error(`${pathname} -> exhausted retries`);
}

// ---------------------------------------------------------------- matching

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// CurseForge titles carry loader/platform decoration that Modrinth titles don't
// ("FerriteCore ((Neo)Forge)", "Jade [Forge/NeoForge/Fabric]"). Searching the raw
// string misses the project outright, so try progressively-stripped variants and
// accept a match against any of them.
function nameVariants(name) {
  const variants = [name];
  const loaderWords = /(neo\s*)?forge|fabric|quilt|rift|bukkit|spigot|paper/i;
  // drop bracketed/parenthesised groups that are just loader or platform lists
  const stripLoaderGroups = name
    .replace(/[([][^)\]]*[)\]]/g, (g) => (loaderWords.test(g) ? "" : g))
    .replace(/\s+/g, " ")
    .trim();
  variants.push(stripLoaderGroups);
  // drop every bracketed group, decorative or not
  variants.push(stripLoaderGroups.replace(/[([][^)\]]*[)\]]/g, "").replace(/\s+/g, " ").trim());
  // drop a trailing dash-subtitle ("Geophilic - Vanilla Biome Overhauls")
  const noSubtitle = variants[variants.length - 1].split(/\s+[–—:-]\s+/)[0].trim();
  variants.push(noSubtitle);
  // last resort: nested or unbalanced brackets ("FerriteCore ((Neo)Forge)") defeat
  // group-matching, so flatten all bracket punctuation and delete loader words
  // outright. Only reached after the stricter variants miss.
  variants.push(
    name
      .replace(/[()[\]]/g, " ")
      .replace(/\b(neoforge|neo\s*forge|forge|fabric|quilt|neo)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return [...new Set(variants.filter(Boolean))];
}

// A search hit only counts if its title/slug is a confident match for the
// CurseForge name — Modrinth search happily returns loosely-related projects,
// and a wrong match is worse than NOT_FOUND (it produces a bogus recommendation).
function isConfidentMatch(candidateName, hit) {
  const title = norm(hit.title ?? "");
  const slug = norm(hit.slug ?? "");
  return nameVariants(candidateName).some((variant) => {
    const want = norm(variant);
    if (!want) return false;
    if (title === want || slug === want) return true;
    // tolerate an edition/port suffix on either side ("Foo" vs "Foo Refabricated")
    if (title.startsWith(want) && title.length - want.length <= 14) return true;
    if (want.startsWith(title) && want.length - title.length <= 14) return true;
    if (slug.startsWith(want) && slug.length - want.length <= 14) return true;
    if (want.startsWith(slug) && want.length - slug.length <= 14) return true;
    return false;
  });
}

async function resolveProject(candidate) {
  // 1. CurseForge slugs very often match Modrinth slugs exactly — cheapest hit.
  if (candidate.cfSlug) {
    const direct = await api(`/project/${encodeURIComponent(candidate.cfSlug)}`, { allow404: true });
    if (direct && isConfidentMatch(candidate.name, direct)) return { project: direct, via: "slug" };
    if (direct) return { project: direct, via: "slug-loose" };
  }
  // 2. Fall back to search, restricted to mods. Try the raw CurseForge title
  //    first, then progressively de-decorated variants of it.
  const facets = encodeURIComponent(JSON.stringify([["project_type:mod"]]));
  let nearest = null;
  for (const variant of nameVariants(candidate.name)) {
    const search = await api(`/search?query=${encodeURIComponent(variant)}&facets=${facets}&limit=8`);
    const hits = search.hits ?? [];
    nearest ??= hits[0]?.title ?? null;
    const hit = hits.find((h) => isConfidentMatch(candidate.name, h));
    if (!hit) continue;
    const project = await api(`/project/${hit.project_id ?? hit.slug}`, { allow404: true });
    if (project) return { project, via: variant === candidate.name ? "search" : "search-variant" };
  }
  return { project: null, via: "search-miss", nearest };
}

function mcSortKey(v) {
  return v.split(".").map((n) => Number(n) || 0);
}

function newestMc(versions) {
  const all = new Set();
  for (const v of versions) for (const g of v.game_versions ?? []) all.add(g);
  const list = [...all].filter((g) => /^\d+(\.\d+)*$/.test(g));
  list.sort((a, b) => {
    const ka = mcSortKey(a), kb = mcSortKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (kb[i] ?? 0) - (ka[i] ?? 0);
    }
    return 0;
  });
  return list[0] ?? null;
}

async function screen(candidate) {
  const { project, via, nearest } = await resolveProject(candidate);
  if (!project) {
    return { ...candidate, status: "NOT_FOUND", via, nearestHit: nearest ?? null };
  }

  const base = {
    ...candidate,
    modrinthSlug: project.slug,
    modrinthTitle: project.title,
    categories: project.categories ?? [],
    clientSide: project.client_side,
    serverSide: project.server_side,
    downloads: project.downloads,
    via,
  };

  const versions = await api(`/project/${project.slug}/version`);
  const fabric = versions.filter((v) => (v.loaders ?? []).includes("fabric"));
  const onTarget = fabric.filter((v) => (v.game_versions ?? []).includes(targetMc));

  if (onTarget.length) {
    const best = onTarget[0];
    return {
      ...base,
      status: `AVAILABLE_${targetMc}`,
      versionNumber: best.version_number,
      versionType: best.version_type,
      datePublished: best.date_published,
      dependencies: (best.dependencies ?? [])
        .filter((d) => d.dependency_type === "required")
        .map((d) => d.project_id),
    };
  }
  if (fabric.length) {
    return { ...base, status: "FABRIC_BUT_OLD", newestFabricMc: newestMc(fabric) };
  }
  const anyLoaders = [...new Set(versions.flatMap((v) => v.loaders ?? []))];
  return { ...base, status: "FORGE_ONLY", loaders: anyLoaders, newestMc: newestMc(versions) };
}

// ---------------------------------------------------------------- main

(async () => {
  const candidates = [];
  if (htmlPath) {
    const html = fs.readFileSync(path.resolve(htmlPath), "utf8");
    candidates.push(...parseModlist(html));
  }
  for (const name of extraNames) {
    candidates.push({ name, author: null, url: null, cfSlug: null, rawLabel: name, injected: true });
  }

  const kept = [];
  const dropped = [];
  for (const c of candidates) {
    const reason = dropReason(c);
    if (reason) dropped.push({ ...c, dropReason: reason });
    else kept.push(c);
  }

  console.error(`parsed ${candidates.length} entries; screening ${kept.length}, dropped ${dropped.length} as noise`);
  const byReason = {};
  for (const d of dropped) byReason[d.dropReason] = (byReason[d.dropReason] ?? 0) + 1;
  for (const [r, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.error(`  drop ${String(n).padStart(3)}  ${r}`);
  }

  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
  const results = [];
  let n = 0;
  for (const c of kept) {
    n++;
    const key = c.cfSlug ?? `name:${norm(c.name)}`;
    if (cache[key]) {
      results.push(cache[key]);
      continue;
    }
    let r;
    try {
      r = await screen(c);
    } catch (err) {
      r = { ...c, status: "ERROR", error: String(err.message ?? err) };
    }
    cache[key] = r;
    results.push(r);
    if (n % 10 === 0) {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
      console.error(`  ${n}/${kept.length} … ${r.status.padEnd(16)} ${r.name}`);
    }
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  const summary = {};
  for (const r of results) summary[r.status] = (summary[r.status] ?? 0) + 1;

  fs.writeFileSync(outPath, JSON.stringify({ targetMc, summary, dropped, results }, null, 2));
  console.error("\n== summary ==");
  for (const [k, v] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(v).padStart(4)}  ${k}`);
  }
  console.error(`\nwrote ${outPath}`);
})();
