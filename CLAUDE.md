# CLAUDE.md — permanent working rules for this repo

These are standing laws, not suggestions. They were each written after something
went wrong or after an explicit ruling. Read them before acting; do not re-derive
or re-litigate them.

## 1. Process cleanup: exact PID only, never pattern-match

**Kill only the exact PID you recorded when you launched the process.** If that PID
no longer matches a running process, conclude the process is already gone.

**Never widen to a pattern.** Do not run `pkill -f <pattern>`, `killall`, or any
match-based kill. This machine is Jesse's daily driver and he runs Minecraft on it
himself.

*Why:* on 2026-08-16, cleaning up a test client, a PID-targeted `kill` appeared to
fail (the test process had in fact already exited). Escalating to
`pkill -9 -f KnotClient` matched **Jesse's own Minecraft session** — the one he had
launched to take a screenshot — and force-killed it. A broad pattern kill on a
machine the user is actively using is a destructive action against their session,
not routine cleanup. It also dumped his live Minecraft `accessToken` into terminal
scrollback.

If a pattern match ever seems unavoidable, print what it matches and **stop** —
let Jesse decide.

## 2. The exclusion map — never re-propose these

These are permanent. They will keep screening as `AVAILABLE_26.2` and will keep
looking like reasonable picks. That is exactly why they are written down.

| Mod | Ruling |
|---|---|
| `biomes-o-plenty` | **Excluded by choice, not by conflict.** Terralith is the empire's worldgen. BoP is a good mod and screens clean; it is simply not the one the world is built on, and running both means two biome sources competing over the same terrain. **Do not re-propose it on availability grounds — availability was never the question.** |
| `magnum-torch` | **Do not adopt — mechanical conflict with Menagerie.** It suppresses all natural mob spawning in a large radius, which is precisely what Menagerie's territory system runs on. It voids territory behaviour for every chunk in range with **no error, no log line, and no crash** — the failure is invisible, which makes it worse than something that fails loudly. It reads like a harmless QoL torch. It is not. |
| `xaeros-minimap` | **Progression-gated.** The minimap and its client-side death waypoints must not be available by default. Mapping is reserved for future satellite technology. |
| `xaeros-world-map` | **Progression-gated.** A complete map must not be available by default. Mapping is reserved for future satellite technology. |

The authoritative copy lives in `tools/bmc-report.py` (`DO_NOT_ADOPT`), which renders
all entries into `bmc-cherrypick-report.md`. Add new exclusions **there**, not by hand-editing
the report — see rule 4.

## 3. Manifest discipline: deploys resolve only from committed manifests

A deploy — client sync or server mirror — must resolve from a manifest that is
**committed and pushed**. Never deploy from a dirty working tree or a local-only
edit.

`mods.json` on `main` is the single source of truth for every side. The server
session pulls it directly and `--side server` consumes the side tags verbatim, so an
uncommitted tag change silently means one thing locally and another on the server.

Corollaries:
- **A released version is immutable.** Once a version is published, changing what that version
  contains is forbidden — bump it instead. kinetics 0.1.3 was published, then had the outer moon's
  constants committed into it without a bump, so `0.1.3` named two different artifacts. The manifest
  shipped the one without them beside a cosmos that needed them, and **the load-compatibility gate
  could not see it**: cosmos declared `kinetics >=0.1.3` and 0.1.3 was present. A version predicate
  cannot catch a version that changed underneath it.
- **Before claiming a set is good to go, rebuild from committed source and compare the rebuild to
  the shipped jar with `node tools/jar-compare.js <shipped.jar> <rebuilt.jar>`.** That single check
  caught the above, and would have caught the earlier case where a release was built from
  uncommitted source. Two different failures, one cheap test.

  Compare with that tool rather than with `shasum`. Loom writes `Fabric-Loom-Client-Only-Entries`
  in `META-INF/MANIFEST.MF` in **set iteration order**, so two builds of byte-identical source can
  differ by the order of that one line — a different sha512 over an identical mod. Measured
  2026-08-20: `enchanted-forest 0.1.9` and `waldschatten 0.1.2` both failed a hash comparison
  against their own shipped release for exactly this reason and were in fact the committed source,
  while `hirelings 0.6.0` reproduced byte-for-byte. `jar-compare` reads every entry's CRC, so it
  answers the question actually being asked — *is this the same mod* — and it still fails loudly on
  a single changed class. A check that cries wolf is a check people learn to skip.
- Ship is not done when the release is live; ship is done when `tools/postship-check.sh`
  passes. See `SHIPPING.md`.
- Verify every `side` tag against Modrinth's `client_side`/`server_side` before
  committing it, rather than assuming. Where Modrinth reports `optional` on both
  sides there is no mechanical answer — make the call explicitly and mark it, so it
  can be revised by live evidence later (this is how `jei` was corrected
  `client` → `both`).
- **Superseded 2026-08-17:** this repo now *does* own the deploy tooling.
  `tools/deploy-server.sh` lives here, versioned, and enforces this rule — it refuses to
  deploy from a dirty tree. It reads its config from `~/Desktop/mc-server/deploy.env`,
  outside version control, and refuses to source any `deploy.env` found inside the repo.
  The world reset still belongs to the ops session; the *tool* it runs is this one.

## 4. Generated files: patch the generator, never the output

`bmc-cherrypick-report.md` is generated by `tools/bmc-report.py`. Hand-edits to the
`.md` are silently destroyed on the next regeneration — this already happened once
and a whole status section vanished with no error.

When changing the report, patch the generator and **assert your anchor strings match**
before writing. A `str.replace` that finds nothing is a silent no-op, which is a
postship-check-class bug: it reports success while changing nothing.

## 5. Shipping: hashes matching is not the same as mods starting

`tools/postship-check.sh` runs a **load-compatibility gate** as its final step, and a ship is
not done until it passes. Every jar's own `fabric.mod.json` — including the nested jars mods
bundle under `META-INF/jars/` — is read, and every declared `depends` must be satisfied by
something else in the manifest. `breaks` is checked too.

*Why:* on 2026-08-16 `postship-check` passed on a manifest that shipped `kinetics 0.1.1`
alongside a `cosmos` declaring `"kinetics": ">=0.1.2"`. Every hash was exactly what the manifest
said it should be, so all three existing steps were satisfied. **The mod set was still one every
client would refuse to start.** Hash integrity and load compatibility are different properties
and shipping needs both.

This applies to **every empire mod, not just cosmos**. The same failure arrives when vibranium
starts depending on warfront, or when a Modrinth mod's new version quietly raises its Fabric API
floor. It is the manifest that is wrong in every case, and the manifest is what the gate reads.

- Run it standalone as `node tools/load-check.js [--dir <mods>] [--side client|server|all]`.
- **The server mirror runs it too**, with `--side server`, before a deploy is considered
  good — including the world reset. That wiring now exists: `tools/deploy-server.sh` step (a1)
  runs it against the staged set *before a single byte is uploaded*, because the cheapest place
  to catch "these mods will not boot together" is the machine doing the staging.

## 6. No OS automation

No AppleScript, no `osascript`, no System Events, no synthetic keystrokes, no window
focusing. Jesse launches Minecraft clients himself. For status, print to stdout.

macOS window-content screenshots additionally require Screen Recording permission for
the terminal, which is **not** granted here — `screencapture` returns desktop wallpaper
only, so it cannot serve as visual proof regardless. Prove things with logs: mod
counts, init lines, mixin-failure counts, exit codes.

## 7. Unattended simulation runs on the server tick — never on an entity or block-entity tick

**Anything that must keep progressing while nobody is nearby MUST be driven by the server tick or
recomputed from an epoch. It may never hang off `Entity.tick()` or `BlockEntity.serverTick()`.**

Those methods do not run for unloaded chunks. A simulation attached to them does not fail loudly —
it silently does nothing, and everything downstream reports success while producing no result.

*Why:* this was learned **three separate times** in one campaign, each time costing a debugging
session, each time looking like a different bug:

1. **Rocket insertion** resolved from `RocketEntity.tick()`. A launch flown with nobody standing
   nearby completed with no insertion, no failure message and no satellite. Kinetics had integrated
   the whole flight from the service tick and the result was thrown away.
2. **Capsule recovery** resolved from the capsule's tick. A capsule enters four kilometres from
   where it lands, mostly over chunks nobody has loaded; the payload silently never dropped.
3. **The lunar ISRU roster** was built from block-entity ticks. A player who built four
   electrolysers at the pole and flew home found the base had produced nothing while they were
   away — and `BlockEntity.setRemoved()` fires on chunk *unload* as well as on breaking a block, so
   unregistering there shut the base down every time they walked out of range.

The fixes all have the same shape and are the pattern to copy: `LaunchTracker`, `RecoveryTracker`
and `LunarEconomyManager` all subscribe to `ServerTickEvents.END_SERVER_TICK`, and the orbital
registry goes further by never accumulating at all — it propagates from an epoch, so an orbit is
correct whether it was ticked or not.

Corollaries:
- Entities and block entities are **views**. If one never ticks, the only thing lost should be
  visuals.
- Register and unregister on **placement and removal** (`onPlace` / `affectNeighborsAfterRemoval`),
  which happen exactly once — never in `setRemoved`, which also fires on unload.
- Prefer **epoch-recompute over accumulation** wherever the maths allows it. State that cannot
  drift cannot drift while you are not looking.

## 8. Another session's uncommitted work: never absorb, never stash

Several sessions share this working tree. You **will** find changes in it that are not
yours — most often when manifest discipline (rule 3) blocks a deploy on a dirty tree and
the dirty file is someone else's.

**Commit it separately, attributed, and unmodified.** Then continue.

```
CLAUDE.md: unattended simulation runs on the server tick

Doctrine section written by the cosmos session and left uncommitted in the
working tree; committing it as its own change so it is not absorbed into an
unrelated commit. Content is theirs and unmodified.
```

The two tempting shortcuts are both wrong:

- **Absorbing it** — sweeping it into your own commit with `git add -A` or `git commit -a`.
  It attributes their work to your change, and it buries an unrelated edit under a message
  that does not describe it. Whoever runs `git log` later is misled, and the blame trail is
  gone.
- **Stashing it** — `git stash` to get a clean tree. It is silent, it is invisible to the
  session that owns the work, and a stash nobody knows about is indistinguishable from lost
  work. Never move another session's changes out of the tree to unblock yourself.

Corollaries:
- **Read the diff before you touch it.** Coherent, finished work gets committed. If it looks
  genuinely mid-edit — half a function, a syntax error, a debug print — stop and ask rather
  than committing something broken in their name.
- Stage by explicit path (`git add tools/foo.sh`), never `-A` or `-a`. The habit is what
  keeps absorption from happening by accident.
- This is etiquette between agents, not a technicality. The other session cannot see what you
  did to its tree, so the burden of being legible is entirely yours.

## 8b. Every mutation gets a commit or a claim — "done but uncommitted" is not an end state

Rule 8 makes the collision survivable. This one makes it rare.

**A session that finishes work commits it before yielding.** Leaving finished work sitting
in the shared tree is not a neutral act: it is a landmine for whoever deploys next, because
rule 3 blocks their deploy on your dirty tree and they must then adjudicate work they did
not write.

**If the work genuinely cannot be committed** — mid-edit, failing checks, a half-finished
refactor — leave a **claim**: an untracked `WIP-<topic>.md` at the repo root saying what is
in flight and which paths you own.

```markdown
# WIP — installer pre-flight gate
Session: cosmos    Started: 2026-08-17
Paths owned: mod-installer.js, build.js, tools/load-check.js
State: analyzeJars extracted, callers not yet migrated — `node --check` fails on build.js
Do not commit these on my behalf; stage around them.
```

The mechanism is chosen to fit the gate rather than fight it: `deploy-server.sh` **blocks**
on modified tracked files but only **warns** on untracked ones, so a claim file is loud in
`git status` and in every deploy's output, yet never blocks a ship.

Corollaries:
- **Do not gitignore `WIP-*.md`.** Ignored files do not appear as `??`, which would destroy
  the entire point — the marker exists to be discovered.
- A claim covers *broken* work. It is not a way to leave finished work uncommitted
  indefinitely; that is the thing this rule exists to stop.
- Delete your claim when you commit. A stale claim teaches the next session to ignore claims.
- Encountering a claim: stage around the paths it names, by explicit path (rule 8). Do not
  commit claimed work even if it looks finished — the owner said it is not.
- Encountering uncommitted work with **no** claim: rule 8 applies. Read it, and if it is
  coherent, commit it attributed.

*Escalation:* if collisions keep happening with this in place, raise it rather than working
around it — per-session git worktrees are the next step, and that machinery is deliberately
not built until this cheaper fix proves insufficient.

## 9. Client-side changes ship only after the render battery's screenshots are read

**For any change that draws something — a renderer, a model, a texture, a particle, a GUI — the
client render battery is part of the ship ritual, and `postship-check` does not count as green
until its screenshots have been looked at.**

Run it with `./gradlew runGametest` in the mod's repo; frames land in
`build/run-gametest/screenshots/`. **Read the images.** They are the evidence, and the whole point
is that they are the only evidence that can catch this class of bug.

*Why:* two cosmos releases passed **every** server-side check while visually broken.

- `0.1.0-A` registered no entity renderer at all. `EntityRenderDispatcher` returns null for an
  unregistered type and the render thread dereferences it, so launching a rocket was a **hard
  client crash**. The server logged a perfect flight.
- `0.1.0-D` fixed the crash with a renderer that drew nothing — correct as a crash fix — and
  shipped a **completely invisible rocket** for a whole release. Physics right, satellite
  deployed, logs clean, nothing to look at.

Hashes matching is not the same as mods starting (rule 5); mods starting is not the same as
anything being drawn.

Corollaries:
- **A texture writer that ignores the shape of its input is a coincidence, not a writer.** cosmos'
  PNG generator hardcoded 16x16 and silently truncated two 64x64 entity sheets to their top-left
  corner. Every block texture is 16x16, so nothing complained for months.
- **Give any part that is hard to photograph a model board.** A parachute is deployed for the last
  few seconds of a 4,000-block entry on an object ten pixels tall; verifying it from a real descent
  took six runs and never produced a legible frame. `cosmos showcapsule` stands one up next to the
  camera and answers "is this drawn" in seconds. Build the fast loop before spending hours on the
  slow one.
