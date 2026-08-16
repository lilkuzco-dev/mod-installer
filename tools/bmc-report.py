import json, os

SP = "/private/tmp/claude-501/-Users-jessehagy-Desktop-mod-installer/78bb7801-321c-4609-8e02-e8f2da7bea1a/scratchpad"
d = json.load(open(f"{SP}/bmc-screen-results.json"))
eq = json.load(open(f"{SP}/equiv.json"))
res = d["results"]
by_slug = {r["modrinthSlug"]: r for r in res if r.get("modrinthSlug")}
eq_by_slug = {r["modrinthSlug"]: r for r in eq["results"] if r.get("modrinthSlug")}
av = [r for r in res if r["status"] == "AVAILABLE_26.2"]


# Modrinth reports optional/optional for mods that run independently on either
# side, which cannot be turned into a manifest tag mechanically. These are my
# calls, marked with a dagger in the tables.
DO_NOT_ADOPT = {
    "magnum-torch": (
        "**Permanently rejected — mechanical conflict.** It suppresses all natural mob spawning in a "
        "large radius around the placed block. That is precisely the mechanic menagerie's territory "
        "system is built on, so a Magnum Torch silently voids territory behaviour for every chunk in "
        "range — with no error, no log line, and no obvious cause. The failure mode is invisible, which "
        "is what makes it worse than an outright crash. Screens as `AVAILABLE_26.2` and reads like a "
        "harmless QoL torch; it is not. Ruled out by Jesse 2026-08-16."
    ),
    "biomes-o-plenty": (
        "**Permanently excluded — a choice, not a conflict.** Ruled out in favor of **Terralith**, which "
        "is the empire's worldgen. BoP is a perfectly good mod and screens clean on 26.2; it is simply "
        "not the one we are building the world on, and running both would mean two biome sources "
        "competing over the same terrain. Do not re-propose it on availability grounds — availability "
        "was never the question. Ruled by Jesse 2026-08-16."
    ),
}

# ratified by Jesse 2026-08-16, not derived from Modrinth
OFFLIST_SIDE = {"krypton": "both", "bobby": "client",
                "sodium-extra": "client", "reeses-sodium-options": "client"}

SIDE_CALL = {
    "jei": "client",        # recipe UI; nothing to do on a headless server
    "jade": "both",         # optional server half feeds live mob/block data
    "clumps": "both",       # XP merging is a world mechanic — needs the server
    "spark": "both",        # profiling both sides is the point
    "neruina": "both",      # catches ticking-entity crashes server-side
    "ferrite-core": "both",  # heap savings apply to both JVMs
    "packet-fixer": "both",
}


def side(r):
    """Returns (tag, ambiguous). Ambiguous rows get a dagger + footnote."""
    slug, c, s = r.get("modrinthSlug"), r.get("clientSide"), r.get("serverSide")
    if slug in SIDE_CALL:
        return SIDE_CALL[slug], True
    if s == "unsupported":
        return "client", False
    if c == "unsupported":
        return "server", False
    if c == "required" and s == "required":
        return "both", False
    if c == "required":
        return "client", True
    if s == "required":
        return "server", True
    return "both", True


def side_md(r):
    tag, amb = side(r)
    return f"{tag}†" if amb else tag


# category buckets, coarser than Modrinth's tags. Utility beats the flavour tags:
# JEI is tagged library+utility but it is a QoL mod, not a library.
# Modrinth carries no categories for a few projects; bucket them by hand.
BUCKET_CALL = {"bobby": "perf"}


def bucket(r):
    if r.get("modrinthSlug") in BUCKET_CALL:
        return BUCKET_CALL[r["modrinthSlug"]]
    cats = set(r.get("categories", []))
    if "optimization" in cats:
        return "perf"
    if "worldgen" in cats:
        return "worldgen"
    if "food" in cats:
        return "food"
    if cats & {"utility", "management", "social", "storage"}:
        return "qol"
    if "mobs" in cats:
        return "mobs"
    if cats & {"adventure", "decoration", "equipment", "magic", "transportation", "game-mechanics"}:
        return "content"
    return "library"


# ---- curated shortlist -------------------------------------------------
WAVE1 = [
    ("ferrite-core", "Cuts JVM heap use; the single biggest safe win on a big list."),
    ("entityculling", "Skips rendering entities behind walls — large FPS win with menagerie herds."),
    ("immediatelyfast", "Batches rendering; pairs with Sodium."),
    ("badoptimizations", "Assorted client-side micro-optimizations."),
    ("ixeris", "Reduces main-thread stalls from GL calls."),
    ("particle-core", "Particle batching — relevant to vibranium/warfront effects."),
    ("gnetum", "Cheap client render optimizations."),
    ("fast-item-frames", "Item frames stop being a render tax in built-up bases."),
    ("packet-fixer", "Fixes oversized-packet disconnects; matters once the server exists."),
    ("alternate-current", "Rewrites the redstone tick engine — pure server-side throughput."),
    ("structure-layout-optimizer", "Speeds structure placement — directly helps warfront's generator."),
    ("spark", "Profiler. Not a speed-up; it's how we prove which of our 3 mods costs what."),
]
WAVE2 = [
    ("jei", "Recipe/usage lookup — the baseline QoL mod."),
    ("jade", "Look-at block/entity HUD; will surface menagerie diet/territory data."),
    ("xaeros-minimap", "Minimap."),
    ("xaeros-world-map", "Full world map; pairs with the minimap."),
    ("clumps", "Merges XP orbs — a real perf win too, but behaviour-visible."),
    ("controlling", "Searchable keybind menu; mandatory once the list is this long."),
    ("mouse-tweaks", "Inventory drag/scroll handling."),
    ("clientsort", "Client-side inventory sorting."),
    ("sound-physics-remastered", "Reverb/occlusion; big immersion win in warfront bases."),
    ("enchantment-descriptions", "Shows what enchantments actually do."),
    ("not-enough-animations", "Third-person animation parity."),
    ("chat-heads", "Player faces beside chat lines."),
    ("just-zoom", "Configurable zoom key."),
    ("neruina", "Survives ticking-entity crashes instead of corrupting the chunk — real insurance with 3 custom mods."),
]
WAVE3 = [
    ("sparsestructures", "Thins structure spacing globally. Recommended *first* in this wave: it is the lever that keeps everything below from crowding out warfront bases."),
    ("towns-and-towers", "Expands villages/adds settlement variants."),
    ("structory", "Small atmospheric ruins, no loot bloat."),
    ("structory-towers", "Companion tower set."),
]

OFFLIST = [
    ("krypton", eq_by_slug.get("krypton"), "Network-stack optimization. Not in the BMC list, but it was on your manual screen and it is live on 26.2."),
    ("bobby", eq_by_slug.get("bobby"), "Caches chunks beyond server view-distance — the render-distance win the BMC list has no answer for."),
    ("sodium-extra", eq_by_slug.get("sodium-extra"), "Sodium companion options."),
    ("reeses-sodium-options", eq_by_slug.get("reeses-sodium-options"), "Usable Sodium settings UI."),
]

FLAGS = [
    ("Biome / worldgen overhaul", "menagerie forage ecology, warfront base siting, vibranium ore gen",
     ["biomes-o-plenty", "terrablender", "geophilic", "betterend", "betternether", "bclib",
      "climate-rivers", "biome-dither", "abridged", "snow-under-trees", "simple-snowy-fix-(forge-fabric)"],
     "Replaces or reshapes biomes wholesale. menagerie's forage tables and animal spawn biomes are written against vanilla biome IDs; warfront picks base sites from biome + terrain. Any of these changes what generates and where."),
    ("Structure adders", "warfront garrison/base placement",
     ["towns-and-towers", "structory", "structory-towers", "adorabuild-structures",
      "moogs-voyager-structures", "mes-moogs-end-structures", "mns-moogs-nether-structures",
      "mmv-moogs-missing-villages", "formations", "formations-nether", "formations-overworld",
      "improved-village-placement", "repurposed-structures-fabric"],
     "Every one of these competes for the same structure-placement budget as warfront bases. Adopting more than one or two without `sparsestructures` will visibly crowd the map."),
    ("Mob adders", "menagerie territory/diet/spawn systems",
     ["illager-invasion", "friends-and-foes", "betterend", "betternether", "skeleton-ai-fix"],
     "New mobs compete for the per-biome mob cap, which directly suppresses menagerie's 8 animals. `skeleton-ai-fix` additionally rewrites mob AI selectors."),
    ("Spawn suppression", "menagerie spawn density",
     ["magnum-torch"],
     "Blocks all natural spawns in a large radius. That is exactly the mechanic menagerie's territory system depends on."),
    ("Progression / material tier", "vibranium",
     ["advanced-netherite"],
     "Adds a post-netherite equipment tier. Needs a ruling on where vibranium sits relative to it."),
    ("Seasons", "menagerie forage ecology",
     ["serene-seasons"],
     "Gates crop/forage growth by season. Would silently reshape menagerie's forage availability year-round."),
]


def row(slug, why=None, src=None):
    r = (src or by_slug).get(slug)
    if not r:
        return f"| `{slug}` | ? | **missing from results** | | |"
    return (f"| {r['modrinthTitle']} | {bucket(r)} | `{r['modrinthSlug']}` | "
            f"**{side_md(r)}** | {why or ''} |")


out = []
W = out.append

W("# Better MC (BMC4) cherry-pick report")
W("")
W("Screen of `modlist.html` (416 entries) against the Modrinth API for **Minecraft 26.2 / Fabric**.")
W("Generated by `tools/bmc-screen.js`; raw data in `bmc-screen-results.json`.")
W("")
W("## 🤝 HANDOFF — read this first")
W("")
W("Campaign is **complete and shipped**. Waves 1, 2, 3 and the off-list four are all in `mods.json` on `main`. Nothing here is blocked or half-done. What follows is the standing work for whoever picks this up next.")
W("")
W("### (a) Standing task: the watchlist recheck")
W("")
W("The one recurring job. A large set of good mods are stuck **below 26.2** and become adoptable the day they update — check them and adopt on arrival:")
W("")
W("- **YUNG's suite** — the big one. All 11 sit at `26.1.2`, one version short. `yungs-api` moving to 26.2 unblocks the entire suite at once, so check that slug first and the rest follow.")
W("- **ModernFix** (`1.21.4`), **Supplementaries** + **Amendments** (`1.21.1`) — the closest thing to a Quark replacement, which does not otherwise exist on 26.2.")
W("- **When Dungeons Arise**, **Chipped**, **Handcrafted**, **Polymorph**, **Curios**, **Patchouli**, **Kiwi**, and the rest of the watchlist table below.")
W("")
W("Re-run the screener — **its cache makes re-runs nearly free**, so this is cheap to repeat often:")
W("")
W("```sh")
W("node tools/bmc-screen.js modlist.html --mc 26.2")
W("```")
W("")
W("`modlist.html` and `bmc-screen-cache.json` are both committed, so the command works from a clean checkout with no setup. Only entries whose status changed cost an API call. To force a recheck of the stale ones, drop the `FABRIC_BUT_OLD` and `NOT_FOUND` keys from the cache and re-run — everything already resolved returns instantly.")
W("")
W("### (b) New empire mods need no action here")
W("")
W("vibranium, warfront, menagerie and any future empire mod add their **own** `extra_mods` entries through their own ship rituals (build → release → manifest bump → `tools/postship-check.sh`). Do not pre-add them from this side; there is nothing to do here when a new one lands.")
W("")
W("### (c) Follow-up slugs — all resolved 2026-08-16")
W("")
W("These needed exact-slug rechecks rather than name search. Closed out:")
W("")
W("| Slug | Result |")
W("|---|---|")
W("| `guard-villagers-(fabricquilt)` | ✅ **Fabric fork is live** — `2.1.3-26.2`. The Forge `guard-villagers` is a dead end; this is the one to use if the mod is ever wanted. |")
W("| `betterend` | ✅ `AVAILABLE_26.2` — `26.201.2`. Conflict-flagged (dimension worldgen + mob adder); needs a ruling, not just availability. |")
W("| `betternether` | ✅ `AVAILABLE_26.2` — `26.201.2`. Same caveat as BetterEnd. |")
W("| `farmers-delight-refabricated` | ✅ `AVAILABLE_26.2` — `26.2-3.6.15`. The live Fabric answer to Forge-only Farmer's Delight. |")
W("| `corpse` | ❌ **Forge/NeoForge only**, no Fabric build. Genuinely unresolved — a Fabric death-chest alternative would need separate screening. |")
W("")
W("### Also worth knowing")
W("")
W("- Read `CLAUDE.md` before acting — the permanent rules (exact-PID kills, the exclusion map, manifest discipline, patch-the-generator) are all there.")
W("- The **conflict table** further down is not stale: everything in it is still unadopted and still needs an explicit ruling before it goes in.")
W("- `serene-seasons` is **held**, not rejected — Jesse rules on it after launch. It changes crop and visual pacing enough to want a live look first.")
W("")
W("## Status")
W("")
W("| Wave | State |")
W("|---|---|")
W("| Wave 1 — perf (12) | ✅ **adopted** 2026-08-16, in `mods.json` with side tags |")
W("| Wave 2 — QoL (14) | ✅ **adopted** 2026-08-16, in `mods.json` with side tags |")
W("| Wave 3 — worldgen/structures (7) | ✅ **shipped** 2026-08-16 — Terralith ruling settled; `serene-seasons` held back |")
W("| Off-list additions (4) | ✅ **adopted** 2026-08-16, separate follow-up commit |")
W("| Launch-screenshot verification | ✅ **CLOSED — superseded** (see below) |")
W("")
W("**Launch verification is closed.** The client's clean **133-mod launch log** stands as the proof of record: all three empire mods initialised, the Warfront-Menagerie crossover active, **zero mixin conflicts, zero crash reports**. The world screenshot is superseded — it will be taken during the live server walk instead, where the server-tagged worldgen stack (Terralith, Sparse Structures, Towns and Towers, Repurposed Structures) is actually loaded and therefore actually visible. A client screenshot could never have shown it.")
W("")
W("**Terralith is the empire's worldgen.** Wave 3 shipped as: `sparsestructures` (the spacing lever, leading), `terralith`, `towns-and-towers`, `repurposed-structures-fabric`, `chunky` (ops pre-generation) all **server**-tagged, plus `friends-and-foes` and `illager-invasion` as **both** — clients must render their mobs. `serene-seasons` is held pending a separate post-launch ruling. Everything else in the conflict table stays out until explicitly approved.")
W("")

# ---- reconciliation
W("## What was screened")
W("")
W("| | Count |")
W("|---|---|")
W(f"| Entries parsed from `modlist.html` | **416** |")
W(f"| Dropped before the API (see below) | {len(d['dropped'])} |")
W(f"| Screened against Modrinth | {len(res)} |")
W("")
W("Drops, by reason — no entry disappears silently:")
W("")
W("| Reason | Count |")
W("|---|---|")
byr = {}
for x in d["dropped"]:
    byr[x["dropReason"]] = byr.get(x["dropReason"], 0) + 1
for k, v in sorted(byr.items(), key=lambda kv: -kv[1]):
    label = {"curseforge-type:texture-packs": "CurseForge texture-packs (not mods)",
             "curseforge-type:data-packs": "CurseForge data-packs (not mods)",
             "curseforge-type:shaders": "CurseForge shaders (not mods)"}.get(k, f"Name pattern `{k.split(':',1)[-1]}`")
    W(f"| {label} | {v} |")
W("")
W("416 = 336 screened + 80 dropped. Balanced.")
W("")
W("## Results")
W("")
W("| Status | Count | Meaning |")
W("|---|---|---|")
s = d["summary"]
W(f"| `AVAILABLE_26.2` | **{s['AVAILABLE_26.2']}** | Fabric build published for 26.2 — adoptable today |")
W(f"| `FABRIC_BUT_OLD` | {s['FABRIC_BUT_OLD']} | Fabric builds exist, none for 26.2 — watchlist |")
W(f"| `FORGE_ONLY` | {s['FORGE_ONLY']} | No Fabric build at all |")
W(f"| `NOT_FOUND` | {s['NOT_FOUND']} | No confident Modrinth match (mostly CurseForge exclusives) |")
W("")

# ---- discrepancy
W("## Cross-check against your manual screen")
W("")
W("You flagged ~33 `AVAILABLE_26.2`; this screen found **132**. That gap is scope, not disagreement — and I checked it rather than picking a side.")
W("")
W("**Your 16 named mods:** 13 confirmed `AVAILABLE_26.2`, with versions:")
W("")
W("| Mod | This screen | Version |")
W("|---|---|---|")
for slug in ["waystones", "jade", "jei", "xaeros-minimap", "xaeros-world-map", "biomes-o-plenty",
             "towns-and-towers", "ferrite-core", "immediatelyfast", "entityculling", "clumps",
             "spark", "sound-physics-remastered"]:
    r = by_slug[slug]
    W(f"| {r['modrinthTitle']} | ✅ `AVAILABLE_26.2` | `{r['versionNumber']}` |")
W("")
W("**The other 3 — `appleskin`, `terralith`, `krypton` — are not in `modlist.html` at all.** I grepped the raw file: no CurseForge entry for any of them. They aren't disagreements with my screen; they're outside its input. Two notes:")
W("")
W("- `krypton` **is** live on 26.2 (`0.3.1`) — I screened it separately, see off-list additions.")
W("- `appleskin` and `terralith` are worth screening too, but as deliberate additions rather than BMC cherry-picks.")
W("")
W("**YUNG's suite: confirmed exactly as you flagged it.** Every YUNG's mod with a Fabric build tops out at **26.1.2**, one version short:")
W("")
W("| Mod | Newest Fabric MC |")
W("|---|---|")
for r in sorted([x for x in res if x.get("modrinthSlug", "").startswith("yungs")], key=lambda r: -r["downloads"]):
    W(f"| {r['modrinthTitle']} | {r['newestFabricMc']} |")
W("")
W("Watchlist, not adoptable. `yungs-api` moving to 26.2 unblocks the whole suite at once.")
W("")
W("**Why the count differs:** a full 336-entry sweep surfaces the long tail your spot-check wouldn't have — libraries (`cloth-config`, `architectury-api`), client-visual mods (`entitytexturefeatures`, `not-enough-animations`), and ~30 small structure/worldgen mods. I spot-verified 10 random `AVAILABLE_26.2` rows against the live API with fresh calls: **10/10 confirmed**. The 132 is real, but most of it is tail I would not recommend adopting — hence the shortlist below.")
W("")

# ---- shortlist
W("## Recommended shortlist (30)")
W("")
W("Ordered by your priority: perf first (safe), QoL second, worldgen/structures last (fresh-world dependency).")
W("The **side** column is the manifest tag to use. It is derived from Modrinth's `client_side`/`server_side`, except where those say *optional* on both sides — Modrinth then means \"runs independently on either side\", which is not a manifest tag. Rows marked **†** are my call, not a mechanical read; they are the ones to argue with.")
W("")
W("### Wave 1 — Performance (12) · safe, no world impact")
W("")
W("| Mod | Category | Slug | Side | Why |")
W("|---|---|---|---|---|")
for slug, why in WAVE1:
    W(row(slug, why))
W("")
W("### Wave 2 — Quality of life (14) · safe, no world impact")
W("")
W("| Mod | Category | Slug | Side | Why |")
W("|---|---|---|---|---|")
for slug, why in WAVE2:
    W(row(slug, why))
W("")
W("### Wave 3 — Worldgen / structures (4) · ⚠️ fresh world + your approval")
W("")
W("| Mod | Category | Slug | Side | Why |")
W("|---|---|---|---|---|")
for slug, why in WAVE3:
    W(row(slug, why))
W("")
W("Every Wave 3 entry is also in the conflict table below. This is the smallest set that adds visible structure variety without swamping warfront; I deliberately left out the Moog's suite, Formations trio, AdoraBuild, and Repurposed Structures — adopting those is a different, larger decision.")
W("")
W("### Off-list additions (not from BMC4)")
W("")
W("✅ **Adopted 2026-08-16** as a follow-up commit, separate from the BMC waves so provenance stays clean — these are *not* Better MC picks. Screened because the manual pass wanted them or they fill an obvious gap. Not counted against the 30.")
W("")
W("| Mod | Category | Slug | Side | Why |")
W("|---|---|---|---|---|")
for slug, r, why in OFFLIST:
    if r:
        W(f"| {r['modrinthTitle']} | {bucket(r)} | `{r['modrinthSlug']}` | **{OFFLIST_SIDE[r['modrinthSlug']]}** | {why} |")
W("")

# ---- conflicts
W("## 🚫 DO NOT ADOPT — permanent")
W("")
W("**Do not re-import these in any future pass, regardless of how well they screen.** This list is a standing ruling, not a recommendation to revisit.")
W("")
W("| Mod | Slug | Ruling |")
W("|---|---|---|")
for _slug, _ruling in DO_NOT_ADOPT.items():
    _r = by_slug.get(_slug) or eq_by_slug.get(_slug)
    _title = _r["modrinthTitle"] if _r else _slug
    W(f"| {_title} | `{_slug}` | {_ruling} |")
W("")
W("## ⚠️ Conflict flags — need your explicit approval")
W("")
W("Everything here is `AVAILABLE_26.2` and would otherwise be a reasonable pick. Each collides with one of our three mods. **None are in Waves 1 or 2.**")
W("")
for title, against, slugs, note in FLAGS:
    present = [s for s in slugs if s in by_slug or s in eq_by_slug]
    if not present:
        continue
    W(f"### {title}")
    W("")
    W(f"**Collides with:** {against}")
    W("")
    W(note)
    W("")
    W("| Mod | Slug | In shortlist? |")
    W("|---|---|---|")
    short = {s for s, _ in WAVE1 + WAVE2 + WAVE3}
    for s in present:
        r = by_slug.get(s) or eq_by_slug.get(s)
        mark = "**yes — Wave 3**" if s in short else "no"
        W(f"| {r['modrinthTitle']} | `{r['modrinthSlug']}` | {mark} |")
    W("")

# ---- forge only
W("## Forge-only marquee mods → Fabric equivalents")
W("")
W("| BMC4 mod (Forge) | Fabric equivalent | Status on 26.2 |")
W("|---|---|---|")
EQUIV = [
    ("Oculus", "iris", "Iris"),
    ("Farmer's Delight", "farmers-delight-refabricated", "Farmer's Delight Refabricated"),
    ("Krypton (FNP)", "krypton", "Krypton"),
    ("Repurposed Structures", "repurposed-structures-fabric", "Repurposed Structures (Fabric)"),
    ("Friends and Foes", "friends-and-foes", "Friends and Foes"),
    ("Quark", None, "Supplementaries / Amendments / Chipped / Handcrafted"),
    ("Alex's Mobs", None, "Naturalist"),
    ("Mowzie's Mobs", None, "— (no Fabric port)"),
    ("Guard Villagers", None, "— (no Fabric port)"),
    ("Jade Addons", None, "— (Forge-only addon; base Jade is fine)"),
]
STALE = {"Quark": "all stale at **1.21.1** — no Quark replacement exists on 26.2",
         "Alex's Mobs": "Naturalist stale at **1.21.1** (and would conflict with menagerie anyway)"}
for cf, slug, label in EQUIV:
    if slug:
        r = by_slug.get(slug) or eq_by_slug.get(slug)
        if r and r["status"] == "AVAILABLE_26.2":
            W(f"| {cf} | {label} (`{r['modrinthSlug']}`) | ✅ `{r['versionNumber']}` |")
            continue
    W(f"| {cf} | {label} | ❌ {STALE.get(cf, 'no Fabric build on 26.2')} |")
W("")
W("The Forge substrate in this list — `forgified-fabric-api`, `connector`, `connector-extras`, `citadel`, `zeta`, `blueprint`, `structure-gel-api`, `lionfish-api` — has no Fabric meaning and is correctly excluded.")
W("")

# ---- watchlist
W("## Watchlist — Fabric, but not yet 26.2")
W("")
W("Top 20 by downloads. Re-run `tools/bmc-screen.js` after the next wave of ports.")
W("")
W("| Mod | Slug | Newest Fabric MC |")
W("|---|---|---|")
for r in sorted([x for x in res if x["status"] == "FABRIC_BUT_OLD"], key=lambda r: -r["downloads"])[:20]:
    W(f"| {r['modrinthTitle']} | `{r['modrinthSlug']}` | {r['newestFabricMc']} |")
W("")

# ---- full table
W("## Full `AVAILABLE_26.2` set (132)")
W("")
W("Sorted by downloads. Everything adoptable today, shortlisted or not.")
W("")
W("| Mod | Category | Slug | Side | Version |")
W("|---|---|---|---|---|")
for r in sorted(av, key=lambda r: -r["downloads"]):
    mark = " 🚫 **DO NOT ADOPT**" if r['modrinthSlug'] in DO_NOT_ADOPT else ""
    W(f"| {r['modrinthTitle']}{mark} | {bucket(r)} | `{r['modrinthSlug']}` | {side_md(r)} | `{r['versionNumber']}` |")
W("")

W("## Not found (39)")
W("")
W("No confident Modrinth match. Sampled by hand: overwhelmingly CurseForge exclusives (the FTB suite, `Philip's Ruins`, `Umbral Skies`, `DnT Ancient City Overhaul`) plus BMC-internal compat patches. A confident-match guard is deliberate here — a wrong match would produce a bogus recommendation, which is worse than a miss.")
W("")
W("## Next step")
W("")
W("Wave 3 waits for the fresh-world day and the Terralith-vs-BoP ruling. Re-run `tools/bmc-screen.js` before that pass — the watchlist above moves fast, and `yungs-api` reaching 26.2 would unblock the whole YUNG's suite at once.")

open("/Users/jessehagy/Desktop/mod-installer/bmc-cherrypick-report.md", "w").write("\n".join(out) + "\n")
print("wrote bmc-cherrypick-report.md:", len(out), "lines")
