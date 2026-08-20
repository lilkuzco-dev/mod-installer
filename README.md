# mod-installer

Keeps a friend group's Minecraft Java clients (and optionally a server) in sync with **one shared mod list**. Everyone runs one command; the script resolves the newest compatible version of each mod on [Modrinth](https://modrinth.com), pulls in required dependencies automatically, and makes the mods folder match the list exactly.

No accounts, no database, no telemetry. Zero npm dependencies — just Node 18+.

## For friends

**With Node 18+ installed**, this one-liner syncs your mods against the group list — run it again whenever the list changes:

```sh
curl -fsSL https://raw.githubusercontent.com/lilkuzco-dev/mod-installer/main/mod-installer.js | node - https://raw.githubusercontent.com/lilkuzco-dev/mod-installer/main/mods.json
```

Append ` --dry-run` to preview what would change without touching anything.

Nothing changes when the list gains new kinds of mods: the manifest can include directly-hosted jars (like the group's own Vibranium mod) alongside Modrinth ones, and the same command installs and verifies everything.

**Without Node**, download the standalone app from the [releases page](https://github.com/lilkuzco-dev/mod-installer/releases/latest): `mod-installer` for macOS (Apple Silicon) or `mod-installer.exe` for Windows x64. Just double-click it; the group's mod list is built in.

> macOS blocks unsigned apps downloaded from the internet: the first time, right-click the file → Open → Open (or run `xattr -d com.apple.quarantine ./mod-installer`). On an Intel Mac, use the Node one-liner above instead — the binary is Apple Silicon only.

## Shipping a mod update

The full convention lives in [SHIPPING.md](SHIPPING.md). The short version: after any
release + manifest push, run `tools/postship-check.sh` — it syncs, verifies the folder
converges, and re-hashes every direct-URL jar against the manifest. **Ship is not done
when the release is live; ship is done when postship-check passes.**

### Server deploy is part of the ritual

Since the Empire server exists, `postship-check.sh` is no longer the last step. A
release is shipped when the server is *running* it and parity proves it:

1. `tools/postship-check.sh` → green
2. `./deploy-server.sh` → `DEPLOY GREEN`
3. the parity line reads `PARITY GREEN`

`tools/deploy-server.sh` re-resolves the manifest from a **clean, pushed** tree, proves
the staged set would actually load before uploading a byte, exact-mirrors it to the
server's `/mods`, restarts via the panel API, verifies every manifest mod appears in
the boot log, and then compares the remote folder against the resolved set by filename
**and** size. Any mismatch exits nonzero. Its config lives outside the repo, in
`~/Desktop/mc-server/deploy.env`.

(This branch was opened on 2026-08-16, when that script still lived in the `mc-server`
working directory. It moved into this repo the following day and grew the pre-upload
load gate; the three steps above are unchanged.)

The same reasoning as the original rule: the v0.2.0 incident happened because a
machine was running a jar nobody had synced. A server nobody redeployed is that
same failure with more players attached.

## Running from a checkout

```sh
node mod-installer.js --dry-run     # show what would change, touch nothing
node mod-installer.js               # actually sync
```

With no arguments it reads `./mods.json` and syncs your default Minecraft mods folder:

| OS      | Mods folder |
|---------|-------------|
| Windows | `%APPDATA%\.minecraft\mods` |
| macOS   | `~/Library/Application Support/minecraft/mods` |
| Linux   | `~/.minecraft/mods` |

You can also pass a manifest URL or a path to a local manifest file as the first argument.

## Server usage

Point `--dir` at the server's mods folder and add `--side server`:

```sh
node mod-installer.js --dir /srv/minecraft/mods --side server https://raw.githubusercontent.com/lilkuzco-dev/mod-installer/main/mods.json
```

`--side server` installs only the entries tagged `server` or `both`, so client-only mods
like Sodium never land on the server. One manifest still serves everyone — see
[side tags](#side-tags) below.

## The manifest

```json
{
  "minecraft": "1.21.1",
  "loader": "fabric",
  "mods": ["fabric-api", "lithium", "sodium"]
}
```

- `minecraft` — the game version everyone plays.
- `loader` — `fabric`, `forge`, `neoforge`, or `quilt`. (The script installs mods only; install the loader itself separately.)
- `mods` — Modrinth **slugs**: the last part of the mod page URL, e.g. `https://modrinth.com/mod/sodium` → `sodium`.

You don't need to list dependencies (like Fabric API) — required dependencies are resolved and installed automatically.

### Side tags

A `mods` entry can also be an object saying which side the mod belongs on, so the same
manifest can drive both the clients and the dedicated server:

```json
"mods": [
  { "slug": "fabric-api", "side": "both" },
  { "slug": "lithium",    "side": "both" },
  { "slug": "sodium",     "side": "client" }
]
```

- `side` is `client`, `server`, or `both`; it defaults to `both`, so a bare `"sodium"` string still works exactly as before.
- `--side client` (the default) installs `client` + `both` entries.
- `--side server` installs `server` + `both` entries.
- `--side all` ignores the tags and installs everything.

`extra_mods` entries take the same optional `side` field. Dependencies inherit their
parent's side: a `server`-only mod's libraries are never resolved during a client sync.

> **Updating from 1.1.x:** installers before 1.2.0 reject object-form `mods` entries with
> `Manifest "mods" must be a non-empty array of Modrinth slugs`. Once the shared manifest
> uses side tags, everyone needs the 1.2.0 script or binary. The failure is loud and
> changes nothing on disk, so an out-of-date friend gets an error rather than a bad sync.

### Direct-URL mods (`extra_mods`)

Mods that aren't on Modrinth (like our own [Vibranium](https://github.com/lilkuzco-dev/vibranium)) can be added via the optional `extra_mods` field, pointing at any directly-hosted jar — a GitHub release asset is perfect:

```json
"extra_mods": [
  {
    "filename": "vibranium-1.2.0.jar",
    "url": "https://github.com/lilkuzco-dev/vibranium/releases/download/v1.2.0/vibranium-1.2.0.jar",
    "sha512": "bd7643ff74ec…"
  }
]
```

They join the same install set as the Modrinth mods: identical full-sync semantics (kept when hash-verified, replaced when changed, removed when dropped from the manifest) and the same mandatory SHA-512 verification — compute the hash with `shasum -a 512 the-mod.jar`. Two caveats: no dependency resolution for these (list any deps in the Modrinth `mods` array), and installer versions before 1.1.0 ignore the field (and will remove those jars on sync), so make sure everyone updates.

## Flags

| Flag | Effect |
|------|--------|
| `--dir <path>` | Sync this mods folder instead of the auto-detected one |
| `--side <which>` | `client` (default), `server`, or `all` — which side's entries to install |
| `--dry-run` | Print planned adds/keeps/removes; change nothing |
| `--no-remove` | Add and update mods, but never delete jars not in the manifest |
| `--version` | Print the version and exit |
| `-h`, `--help` | Show usage |

## What a sync does

1. Resolves each slug to the newest **release-channel** Modrinth version matching your `minecraft` + `loader`, falling back to the newest beta, then alpha, only when no stable release exists (the output flags any non-release picks). Required dependencies are added recursively (deduped), with the same channel preference. Fails with a clear error naming the mod if no compatible version exists.
2. Downloads everything it needs into a sibling `mods-staging-<timestamp>/`, **outside** your mods folder, verifying each file against Modrinth's SHA-512 hash; retries once on mismatch, then fails loudly with a non-zero exit code.
3. **Load check.** Reads every staged and kept jar's own `fabric.mod.json` — including the nested jars mods bundle under `META-INF/jars/` — and requires that every declared `depends` is satisfied by something else in the set, and that no declared `breaks` is present. If the set would not start, the sync stops here and **your mods folder is left exactly as it was**.
4. Only then backs up your current mods folder to a sibling `mods-backup-<timestamp>/` and makes it match the resolved set exactly: moves the staged jars in, keeps ones that already match, and **removes jars not in the list** (unless `--no-remove` — use that if you keep personal local mods).

Non-jar files and subfolders (configs, etc.) are never touched. If something goes wrong, copy your `mods-backup-*` folder back over `mods/`.

Step 3 is why a bad manifest cannot reach you as a Fabric startup error. "Your folder matches the manifest" and "these mods will start together" are different properties — a set can be byte-perfect and still be one the loader refuses. The check runs even when the folder is already in sync, because that is exactly where a manifest that outgrew its own jars sits unnoticed until launch. `--dry-run` skips it: it reads the jars, which a dry run never downloads.

## Building the standalone binaries (for the list maintainer)

```sh
npm run build
```

This uses Node's built-in [Single Executable Application](https://nodejs.org/api/single-executable-applications.html) feature — no pkg, no npm dependencies (the official `postject` injector is fetched once via `npx`, exactly as the Node docs prescribe). Requires Node 20+ and network access. Output lands in `dist/` (gitignored):

- `dist/mod-installer` — macOS binary (matches the architecture of the Mac that built it)
- `dist/mod-installer.exe` — Windows x64, **cross-built from macOS/Linux** by downloading the matching official `node.exe` from nodejs.org and injecting the same script blob

Both binaries have the raw GitHub URL of this repo's `mods.json` baked in as the default, so friends can run them with no arguments (or a double-click). Passing a manifest URL or local path still overrides the default.

To build on Windows natively instead: install Node 20+, then run `npm run build` there — the same script copies the local `node.exe` and injects the blob (no code-signing step needed).
