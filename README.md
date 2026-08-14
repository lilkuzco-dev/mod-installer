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

Point `--dir` directly at the server's mods folder:

```sh
node mod-installer.js --dir /srv/minecraft/mods https://raw.githubusercontent.com/lilkuzco-dev/mod-installer/main/mods.json
```

Note: the manifest is one list for everyone, so client-only mods in it (e.g. Sodium) will also be installed on the server. Fabric servers simply ignore client-only mods at launch, but if you'd rather keep the server lean, maintain a second, smaller manifest for it.

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

### Direct-URL mods (`extra_mods`)

Mods that aren't on Modrinth (like our own [Vibranium](https://github.com/lilkuzco-dev/vibranium)) can be added via the optional `extra_mods` field, pointing at any directly-hosted jar — a GitHub release asset is perfect:

```json
"extra_mods": [
  {
    "filename": "vibranium-1.1.0.jar",
    "url": "https://github.com/lilkuzco-dev/vibranium/releases/download/v1.1.0/vibranium-1.1.0.jar",
    "sha512": "f8a9634ceea0…"
  }
]
```

They join the same install set as the Modrinth mods: identical full-sync semantics (kept when hash-verified, replaced when changed, removed when dropped from the manifest) and the same mandatory SHA-512 verification — compute the hash with `shasum -a 512 the-mod.jar`. Two caveats: no dependency resolution for these (list any deps in the Modrinth `mods` array), and installer versions before 1.1.0 ignore the field (and will remove those jars on sync), so make sure everyone updates.

## Flags

| Flag | Effect |
|------|--------|
| `--dir <path>` | Sync this mods folder instead of the auto-detected one |
| `--dry-run` | Print planned adds/keeps/removes; change nothing |
| `--no-remove` | Add and update mods, but never delete jars not in the manifest |
| `--version` | Print the version and exit |
| `-h`, `--help` | Show usage |

## What a sync does

1. Resolves each slug to the newest **release-channel** Modrinth version matching your `minecraft` + `loader`, falling back to the newest beta, then alpha, only when no stable release exists (the output flags any non-release picks). Required dependencies are added recursively (deduped), with the same channel preference. Fails with a clear error naming the mod if no compatible version exists.
2. Backs up your current mods folder to a sibling `mods-backup-<timestamp>/` before touching anything.
3. Makes the folder match the resolved set exactly: downloads missing jars, keeps ones that already match (verified by SHA-512), re-downloads corrupted ones, and **removes jars not in the list** (unless `--no-remove` — use that if you keep personal local mods).
4. Verifies every download against Modrinth's SHA-512 hash; retries once on mismatch, then fails loudly with a non-zero exit code.

Non-jar files and subfolders (configs, etc.) are never touched. If something goes wrong, copy your `mods-backup-*` folder back over `mods/`.

## Building the standalone binaries (for the list maintainer)

```sh
npm run build
```

This uses Node's built-in [Single Executable Application](https://nodejs.org/api/single-executable-applications.html) feature — no pkg, no npm dependencies (the official `postject` injector is fetched once via `npx`, exactly as the Node docs prescribe). Requires Node 20+ and network access. Output lands in `dist/` (gitignored):

- `dist/mod-installer` — macOS binary (matches the architecture of the Mac that built it)
- `dist/mod-installer.exe` — Windows x64, **cross-built from macOS/Linux** by downloading the matching official `node.exe` from nodejs.org and injecting the same script blob

Both binaries have the raw GitHub URL of this repo's `mods.json` baked in as the default, so friends can run them with no arguments (or a double-click). Passing a manifest URL or local path still overrides the default.

To build on Windows natively instead: install Node 20+, then run `npm run build` there — the same script copies the local `node.exe` and injects the blob (no code-signing step needed).
