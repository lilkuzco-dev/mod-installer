# tools/

Tooling for the manifest and the servers it feeds. Everything here is versioned
and covered by manifest discipline — `deploy-server.sh` refuses to deploy from a
dirty tree, so a change in this directory has to be committed before it can ship.

| | |
|---|---|
| `deploy-server.sh` | Deploys the manifest to the Empire server, then proves it worked |
| `load-check.js` | Resolves declared dependencies across a set of jars; `--ids` lists top-level mod ids. Also the library behind the installer's own pre-flight gate — `require()` it for `analyzeJars(paths, {manifest, side})` |
| `postship-check.sh` | The ship gate — a release is not shipped until this passes |
| `bmc-screen.js`, `bmc-report.py` | Big-Mod-Compendium cherry-pick screening |

## Where the ops runbook lives

**`~/Desktop/mc-server/SERVER.md`** — deliberately not in this repo, and not
duplicated here. It documents machine state: host and panel identifiers, world
paths, backup layout, soak results, incident history. That is a description of
one machine at one moment rather than tooling, it goes stale the instant the
machine changes, and a second copy in git would go stale silently. Read it there.

That directory is also the ops home: `deploy.env`, `backup-pull.sh`, staging, and
the mod backups all live beside it.

## Configuration and secrets

**No secrets in this repo, ever.** `deploy-server.sh` is versioned; its config is
not. Host, port, user, ssh key path and panel server id live in
`~/Desktop/mc-server/deploy.env`, which the script reads by absolute path
(override with `DEPLOY_ENV=... tools/deploy-server.sh`). The panel API token has
one home on disk, the macOS Keychain under service `bloom-api`, and is passed to
curl over stdin so it never appears in `ps`.

The script refuses to source any `deploy.env` found inside this repository, on
the theory that a copy made "just to test something" is otherwise one `git add -A`
away from a published host and key path — in a commit that would look routine.

**The config shape is documented in `~/Desktop/mc-server/deploy.env.example`** —
every key, with commentary, and no real values. It sits beside the real file
rather than in this repo on purpose: versioning the shape is worth something, but
not at the risk of a filled-in copy appearing here later, which is the same
mistake the guard above exists to catch.

## The two deploy gates

Worth knowing about, because they are what makes a `DEPLOY GREEN` mean anything:

- **(a1) load compatibility**, before a single byte is uploaded. Hash integrity
  and load compatibility are different properties: `postship-check` proves the
  folder matches the manifest, this proves the set would actually start.
  `mod-installer.js` now runs the same check itself, over the set it is about to
  write, on **every** sync — client and server alike, and inside the standalone
  binary, which `build.js` inlines `load-check.js` into. So this step is belt and
  braces rather than the only line of defence, and the client path a friend runs
  has the same guarantee the deploy does: if the set would not start, nothing is
  touched. Keep (a1) anyway — it gates the *staged* set that gets uploaded, which
  is the thing the server will actually boot.
- **(d) mod init**, after the restart. Every mod the manifest resolves for that
  side must appear in the boot log, and the expected list is *derived from the
  staged jars* rather than hardcoded. It reads each jar's own `fabric.mod.json`,
  so ids are right even when the filename disagrees (`lilkuzco-kinetics-0.1.3.jar`
  declares `kinetics`).

Step (d) once read `for m in vibranium warfront menagerie`. That list never grew
as mods were added, so a deploy shipping three newer mods checked none of them and
would have reported GREEN with any of them dead on the floor. A gate that can pass
while the thing it guards has failed is worse than no gate, because it is believed.
Both gates now fail loudly and neither can drift as mods are added.
