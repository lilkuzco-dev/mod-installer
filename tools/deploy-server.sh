#!/usr/bin/env bash
#
# deploy-server.sh — manifest-driven deploy to the Empire server (MIA-PPG-1013).
#
#   a. resolve the manifest fresh into staging (installer --side server),
#      then prove the staged set would actually load before touching anything
#   b. exact-mirror staging -> remote /mods, DIFF-DRIVEN (never a blanket clear)
#   c. restart via panel API (or prompt if no API power access)
#   d. wait for boot, pull latest.log, verify EVERY manifest mod init + zero errors
#   e. parity check: remote listing vs staging, name AND size. Mismatch = exit 1.
#
# SAFETY CONTRACT (do not weaken):
#   1. Deletion is diff-driven only: rm exactly (remote minus staging).
#   2. Hard guard: installer nonzero OR staging empty => ABORT before any
#      remote command. A local bug must never become "delete every jar in Miami".
#   3. Compare by filename AND size, so a partial/corrupt upload can't pass
#      as current.
#   4. Parity check after restart is mandatory and fails loudly.
#
# SECRETS: this file is versioned in a git repo and contains none. The panel
# token is read from the environment or the macOS Keychain; every host, user,
# key path and server id lives in deploy.env, which stays OUTSIDE the repo (see
# DEPLOY_ENV below) and is read by absolute path. The token is never written to
# disk, never logged, and never placed in argv (it would be visible to `ps`);
# it is fed to curl over stdin via --config -.
#
# Usage:
#   export BLOOM_API_KEY=ptlc_...
#   tools/deploy-server.sh              # full deploy
#   tools/deploy-server.sh --dry-run    # resolve + diff + report, touch nothing remote
#   tools/deploy-server.sh --no-restart # mirror only, skip restart/log/parity
#
#   DEPLOY_ENV=/path/to/other.env tools/deploy-server.sh   # a different server

set -euo pipefail
LC_ALL=C
export LC_ALL

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
NO_RESTART=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --no-restart) NO_RESTART=1 ;;
    # Print the header comment block, however long it happens to be. This was a
    # hardcoded `sed -n '2,30p'` and it silently drifted the moment the header
    # grew — same class of bug as the mod list step (d) used to have.
    -h|--help)    awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' \
                      "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- presentation
bold=$(printf '\033[1m'); red=$(printf '\033[31m'); grn=$(printf '\033[32m')
ylw=$(printf '\033[33m'); rst=$(printf '\033[0m')
step() { printf '\n%s==> %s%s\n' "$bold" "$*" "$rst"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "$grn" "$rst" "$*"; }
warn() { printf '    %s!%s %s\n' "$ylw" "$rst" "$*"; }
die()  { printf '\n%sABORT:%s %s\n' "$red" "$rst" "$*" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/deploy-server.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ------------------------------------------------------------------ config
# CONFIG LIVES OUTSIDE THIS REPO, DELIBERATELY.
#
# This script is versioned; deploy.env is not, and must never be. It holds the
# host, port, user, ssh key path and panel server id — none of which belongs in
# a git history, and all of which is machine state rather than tooling. So the
# script travels with the repo and reads its config from the ops directory by
# absolute path. That split is the whole reason this block is not simply
# "$SCRIPT_DIR/deploy.env": when this file lived beside its config, moving it
# into the repo would have dragged the secrets in behind it.
DEPLOY_ENV="${DEPLOY_ENV:-$HOME/Desktop/mc-server/deploy.env}"
[ -f "$DEPLOY_ENV" ] || die "no deploy.env at $DEPLOY_ENV — copy deploy.env.example there and fill it in (or set DEPLOY_ENV)"

# Defence in depth: refuse a config that lives inside this repo, however it got
# there. A future copy made "just to test something" would otherwise be one
# `git add -A` away from a published host and key path, and the commit that
# leaks it would look entirely routine.
REPO_ROOT="$( cd "$SCRIPT_DIR" && git rev-parse --show-toplevel 2>/dev/null || true )"
if [ -n "$REPO_ROOT" ]; then
  env_abs="$( cd "$(dirname "$DEPLOY_ENV")" && pwd )/$(basename "$DEPLOY_ENV")"
  case "$env_abs" in
    "$REPO_ROOT"/*) die "deploy.env is inside the git repo ($env_abs) — refusing to source it; config must live outside version control" ;;
  esac
fi

# shellcheck disable=SC1091
. "$DEPLOY_ENV"

for v in SFTP_HOST SFTP_PORT SFTP_USER SSH_KEY REMOTE_MODS_DIR MANIFEST_REPO STAGING_DIR PANEL_URL; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || die "deploy.env: $v is empty"
done
[ -f "$SSH_KEY" ] || die "ssh key not found: $SSH_KEY (run ssh-keygen -t ed25519 and register the .pub in the panel)"
[ -d "$MANIFEST_REPO" ] || die "manifest repo not found: $MANIFEST_REPO"

# API token: the macOS Keychain is its only home on disk. Never in deploy.env,
# never in this script, never in a log. An explicitly exported BLOOM_API_KEY
# wins, so a one-off key can be tried without touching the Keychain entry.
if [ -z "${BLOOM_API_KEY:-}" ]; then
  BLOOM_API_KEY="$(security find-generic-password -s bloom-api -w 2>/dev/null || true)"
fi

sftp_run() {  # commands on stdin -> sftp batch
  sftp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
       -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
       -P "$SFTP_PORT" -i "$SSH_KEY" -b - "$SFTP_USER@$SFTP_HOST"
}

api() {  # method path [body] -> body + "\n" + http_code
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method"
    -H "Accept: Application/vnd.pterodactyl.v1+json"
    -H "Content-Type: application/json"
    -w '\n%{http_code}' "${PANEL_URL}${path}")
  [ -n "$body" ] && args+=(-d "$body")
  # key goes over stdin, never argv
  printf 'header = "Authorization: Bearer %s"\n' "$BLOOM_API_KEY" | curl --config - "${args[@]}"
}

# =============================================================== (a) RESOLVE
step "(a) Resolving manifest into staging — fresh every run"
info "repo:    $MANIFEST_REPO"
info "staging: $STAGING_DIR"

# MANIFEST DISCIPLINE (law): pull, then refuse to deploy from a dirty tree.
# A deploy resolved from uncommitted edits is not reproducible and cannot be
# tied to the commit hash that backup-pull.sh records beside each world.
step "(a0) Manifest discipline"
if ! ( cd "$MANIFEST_REPO" && git pull --ff-only 2>&1 | sed 's/^/      /' ); then
  die "git pull failed in $MANIFEST_REPO — resolve it before deploying"
fi
dirty=$( cd "$MANIFEST_REPO" && git status --porcelain | grep -v '^??' || true )
if [ -n "$dirty" ]; then
  printf '    %s✗%s uncommitted tracked changes in %s:\n' "$red" "$rst" "$MANIFEST_REPO"
  printf '%s\n' "$dirty" | sed 's/^/      /'
  die "DIRTY TREE — commit or stash before deploying (manifest discipline)"
fi
untracked=$( cd "$MANIFEST_REPO" && git status --porcelain | grep '^??' || true )
[ -n "$untracked" ] && warn "untracked files present (not blocking): $(printf '%s\n' "$untracked" | wc -l | tr -d ' ') item(s)"
MANIFEST_COMMIT=$( cd "$MANIFEST_REPO" && git rev-parse --short HEAD )
ok "tree clean at $MANIFEST_COMMIT"

if ! ( cd "$MANIFEST_REPO" && node mod-installer.js --dir "$STAGING_DIR" --side server ); then
  die "installer exited nonzero — GUARD 2 tripped, nothing remote was touched"
fi

# GUARD 2: empty-set protection, mirroring what v1.2.0 enforces locally.
shopt -s nullglob
staged_jars=("$STAGING_DIR"/*.jar)
shopt -u nullglob
[ "${#staged_jars[@]}" -gt 0 ] \
  || die "staging resolved to ZERO jars — GUARD 2 tripped, nothing remote was touched"
ok "staging holds ${#staged_jars[@]} jar(s)"

# ------------------------------------------------- (a2) BACKUP RETENTION
# The installer snapshots the mods folder on every run, ~43 MB a time, and nothing
# ever removed them: ten deploys had accumulated 346 MB beside the runbook. Keep the
# recent ones — they are the rollback path — and drop the rest. Every snapshot is
# re-resolvable from mods.json history anyway, so the deep tail buys nothing.
#
# This is the only place this script deletes anything local, so it is deliberately
# narrow. It matches the installer's exact `mods-backup-YYYYMMDD-HHMMSS` shape and
# nothing else, touches directories only, and prints every removal. A glob alone
# would be too wide — `mods-backup-*` would happily match a directory someone had
# renamed to park it, which is exactly the kind of "obviously fine" pattern match
# that rule 1 exists to forbid.
MODS_BACKUP_KEEP="${MODS_BACKUP_KEEP:-5}"
backup_root="$( dirname "$STAGING_DIR" )"
if [ "$MODS_BACKUP_KEEP" -gt 0 ] 2>/dev/null && [ -d "$backup_root" ] && [ "$backup_root" != "/" ]; then
  # Read with a while loop, not `mapfile` — macOS ships bash 3.2, where mapfile
  # does not exist and the script would die here at runtime.
  all_backups=()
  while IFS= read -r d; do
    [ -n "$d" ] && all_backups+=("$d")
  done < <(
    find "$backup_root" -maxdepth 1 -type d -name 'mods-backup-*' 2>/dev/null \
      | grep -E '/mods-backup-[0-9]{8}-[0-9]{6}$' | sort -r
  )
  if [ "${#all_backups[@]}" -gt "$MODS_BACKUP_KEEP" ]; then
    pruned=0; freed_from="${#all_backups[@]}"
    for old in "${all_backups[@]:$MODS_BACKUP_KEEP}"; do
      # Belt and braces: re-assert the path is inside the root and still matches
      # the exact shape before anything is removed.
      case "$old" in
        "$backup_root"/mods-backup-*) ;;
        *) warn "skipping unexpected path: $old"; continue ;;
      esac
      rm -rf "$old" && pruned=$(( pruned + 1 ))
    done
    ok "pruned $pruned old mods-backup dir(s), kept newest $MODS_BACKUP_KEEP of $freed_from"
  fi
fi

# ------------------------------------------------- (a1) LOAD COMPATIBILITY
# Hash integrity and load compatibility are different properties. postship-check
# proves the folder matches the manifest; this proves the set would actually
# start. It runs here, before a single byte goes to Miami, because the cheapest
# place to catch "these mods will not boot together" is on this machine.
step "(a1) Load compatibility of the staged set"
if ! ( cd "$MANIFEST_REPO" && node tools/load-check.js \
         --dir "$STAGING_DIR" --manifest ./mods.json --side server 2>&1 | sed 's/^/      /' ); then
  die "LOAD CHECK FAILED — the staged set would not start; nothing remote was touched"
fi
ok "staged set satisfies every declared dependency"

# name<TAB>size, sorted by name
for f in "${staged_jars[@]}"; do
  printf '%s\t%s\n' "$(basename "$f")" "$(stat -f %z "$f")"
done | sort -t"$(printf '\t')" -k1,1 > "$WORK/staging.tsv"
cut -f1 "$WORK/staging.tsv" > "$WORK/staging.names"

# ================================================== (b) DIFF AGAINST REMOTE
step "(b) Reading remote $REMOTE_MODS_DIR"
if ! printf 'ls -l %s\n' "$REMOTE_MODS_DIR" | sftp_run > "$WORK/remote.raw" 2>"$WORK/remote.err"; then
  cat "$WORK/remote.err" >&2
  die "SFTP listing failed — check host/port/user, and that the key is registered in the panel"
fi

# sftp `ls -l` mimics ls -l: perms links owner group SIZE mon day time NAME...
awk '/^-/ { size=$5; name=$9; for(i=10;i<=NF;i++) name=name" "$i;
            if (name ~ /\.jar$/) printf "%s\t%s\n", name, size }' \
    "$WORK/remote.raw" | sort -t"$(printf '\t')" -k1,1 > "$WORK/remote.tsv"
cut -f1 "$WORK/remote.tsv" > "$WORK/remote.names"
info "remote holds $(wc -l < "$WORK/remote.tsv" | tr -d ' ') jar(s)"

# GUARD 1: deletions are exactly (remote minus staging). Never a blanket clear.
comm -13 "$WORK/staging.names" "$WORK/remote.names" > "$WORK/to_delete"

# uploads: in staging but not remote, OR present both sides with a size mismatch
comm -23 "$WORK/staging.names" "$WORK/remote.names" > "$WORK/to_upload_new"
# GUARD 3: name AND size — a partial upload must not read as current.
join -t"$(printf '\t')" -j1 -o 0,1.2,2.2 "$WORK/staging.tsv" "$WORK/remote.tsv" \
  | awk -F'\t' '$2 != $3 { print $1 }' > "$WORK/to_upload_changed"
join -t"$(printf '\t')" -j1 -o 0,1.2,2.2 "$WORK/staging.tsv" "$WORK/remote.tsv" \
  | awk -F'\t' '$2 != $3 { printf "      %s (local %s B vs remote %s B)\n", $1, $2, $3 }' \
  > "$WORK/changed_detail"
cat "$WORK/to_upload_new" "$WORK/to_upload_changed" | sort -u > "$WORK/to_upload"

n_del=$(wc -l < "$WORK/to_delete" | tr -d ' ')
n_new=$(wc -l < "$WORK/to_upload_new" | tr -d ' ')
n_chg=$(wc -l < "$WORK/to_upload_changed" | tr -d ' ')
n_up=$(wc -l < "$WORK/to_upload" | tr -d ' ')

step "Deploy plan"
printf '    %-10s %s\n' "upload:" "$n_up ($n_new new, $n_chg size-mismatched)"
printf '    %-10s %s\n' "delete:" "$n_del (stale on remote, absent from manifest)"
[ "$n_new" -gt 0 ] && sed 's/^/      + /' "$WORK/to_upload_new"
[ "$n_chg" -gt 0 ] && cat "$WORK/changed_detail"
[ "$n_del" -gt 0 ] && sed 's/^/      - /' "$WORK/to_delete"

# Sanity rail: a diff proposing to delete everything remote while uploading
# nothing is the signature of a broken listing, not a real deploy.
if [ "$n_del" -gt 0 ] && [ "$n_del" -eq "$(wc -l < "$WORK/remote.names" | tr -d ' ')" ] && [ "$n_up" -eq 0 ]; then
  die "diff wants to delete EVERY remote jar and upload nothing — refusing (suspect a bad listing)"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  step "Dry run — nothing remote was changed"
  exit 0
fi

# =============================================================== (b) MIRROR
if [ "$n_up" -eq 0 ] && [ "$n_del" -eq 0 ]; then
  ok "remote already matches staging — no transfer needed"
else
  step "(b) Mirroring to $REMOTE_MODS_DIR"
  {
    printf 'cd %s\n' "$REMOTE_MODS_DIR"
    while IFS= read -r f; do [ -n "$f" ] && printf 'rm "%s"\n' "$f"; done < "$WORK/to_delete"
    while IFS= read -r f; do [ -n "$f" ] && printf 'put "%s/%s"\n' "$STAGING_DIR" "$f"; done < "$WORK/to_upload"
  } > "$WORK/mirror.sftp"

  if ! sftp_run < "$WORK/mirror.sftp" > "$WORK/mirror.log" 2>&1; then
    cat "$WORK/mirror.log" >&2
    die "mirror failed — remote may be half-updated; re-run before booting"
  fi
  ok "uploaded $n_up, deleted $n_del"
fi

# ============================================================== (c) RESTART
if [ "$NO_RESTART" -eq 1 ]; then
  warn "--no-restart: skipping restart, log check, and parity"
  exit 0
fi

step "(c) Restarting server"

# Fingerprint the CURRENT log before restarting, so step (d) can tell the new
# boot's log from the one already sitting there. See the note in (d).
#
# The fingerprint is the log's FIRST LINE, not a hash of the file. A hash of the
# whole file is worthless here: the outgoing server appends "Stopping server",
# "Saving chunks" and friends while it shuts down, so the old log's hash changes
# without a new boot having happened — which is precisely the false "it's fresh"
# this guard exists to prevent. The first line is written once when the log is
# created and never moves.
prev_boot_fp=""
if printf 'get %s %s\n' "$REMOTE_LOG_PATH" "$WORK/prev.log" | sftp_run >/dev/null 2>&1; then
  prev_boot_fp=$( head -1 "$WORK/prev.log" 2>/dev/null || true )
fi

RESTARTED=0
if [ -n "${BLOOM_API_KEY:-}" ]; then
  if [ -z "${PANEL_SERVER_ID:-}" ]; then
    info "PANEL_SERVER_ID empty — discovering via GET /api/client"
    resp=$(api GET /api/client) || true
    code=$(printf '%s' "$resp" | tail -n1)
    if [ "$code" = "200" ]; then
      printf '%s' "$resp" | sed '$d' | jq -r '.data[]?.attributes | "      \(.identifier)  \(.name)"' || true
      die "paste the correct identifier into deploy.env as PANEL_SERVER_ID and re-run"
    elif [ "$code" = "401" ] || [ "$code" = "403" ]; then
      die "panel API returned HTTP $code — STOP. The key needs rotating; tell the operator."
    else
      warn "server list failed (HTTP $code)"
    fi
  else
    resp=$(api POST "/api/client/servers/${PANEL_SERVER_ID}/power" '{"signal":"restart"}') || true
    code=$(printf '%s' "$resp" | tail -n1)
    case "$code" in
      204) ok "restart signal accepted (HTTP 204)"; RESTARTED=1 ;;
      401|403) die "panel API returned HTTP $code — STOP. The key needs rotating; tell the operator. (Nothing was rolled back: /mods is already mirrored, the server just was not restarted.)" ;;
      404) warn "HTTP 404 — PANEL_SERVER_ID '$PANEL_SERVER_ID' not found for this token" ;;
      *)   warn "unexpected HTTP $code from power endpoint" ;;
    esac
  fi
else
  warn "no API key — not in \$BLOOM_API_KEY and not in Keychain under service 'bloom-api'"
fi

if [ "$RESTARTED" -eq 0 ]; then
  printf '\n    %sMANUAL RESTART REQUIRED%s — restart in the panel, then press Enter.\n' "$bold" "$rst"
  read -r _
fi

# ============================================== (d) BOOT + LOG VERIFICATION
step "(d) Waiting for boot, then verifying mod init"
# The log must be from the NEW boot, not the one that was already there.
#
# Waiting only for 'Done' is a stale-evidence bug: 15s after the restart signal
# the server may still be shutting down, and latest.log still holds the PREVIOUS
# boot — which contains its own 'Done'. The gate would accept it instantly and
# then verify mod init against a boot that predates the deploy, reporting GREEN on
# evidence that cannot show the new jars at all. That is the same class of failure
# as the hardcoded mod list: a check that passes without covering what it guards.
#
# The window is real, not theoretical: shutdown is dominated by the world save, so
# it grows with the world. On a throwaway world it fits inside 15s; on a pregenned
# one it will not — which puts the failure squarely on the world-reset deploy, the
# run where being wrong costs the most.
deadline=$(( $(date +%s) + 300 ))
booted=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 15
  if printf 'get %s %s\n' "$REMOTE_LOG_PATH" "$WORK/latest.log" | sftp_run >/dev/null 2>&1; then
    cur_boot_fp=$( head -1 "$WORK/latest.log" 2>/dev/null || true )
    if [ -n "$prev_boot_fp" ] && [ "$cur_boot_fp" = "$prev_boot_fp" ]; then
      info "still shutting down (log is still the previous boot)..."
      continue
    fi
    if grep -q 'Done (.*)! For help' "$WORK/latest.log" 2>/dev/null; then booted=1; break; fi
  fi
  info "still booting..."
done
[ "$booted" -eq 1 ] || die "server did not report 'Done' from a NEW boot within 300s — check panel console"
ok "server booted (log is from a new boot, not the previous one)"

grep -q 'Done (.*)! For help' "$WORK/latest.log" && info "$(grep -o 'Done ([^)]*)' "$WORK/latest.log" | tail -1)"

deploy_fail=0

# ---------------------------------------------------------------- mod init
# Every mod the manifest resolves for this side must appear in the boot log.
#
# This used to read `for m in vibranium warfront menagerie`, and that hardcoded
# three was the hole the gate existed to close: the list never grew as mods were
# added, so a deploy shipping crude_empire, kinetics and cosmos checked none of
# them and would have printed DEPLOY GREEN with any of the three dead on the
# floor. The expected set is now derived from the jars actually staged, so it is
# correct by construction and cannot drift again.
#
# Ids come from load-check --ids, which reads each jar's own fabric.mod.json
# rather than guessing an id from a filename (lilkuzco-kinetics-0.1.3.jar
# declares "kinetics"). Nested/bundled jars are excluded: the loader lists them,
# but they are a mod's private business, not something the deploy asked for.
expected_ids="$WORK/expected-ids.txt"
if ! ( cd "$MANIFEST_REPO" && node tools/load-check.js \
         --dir "$STAGING_DIR" --manifest ./mods.json --side server --ids ) \
       > "$expected_ids" 2>"$WORK/ids.err"; then
  sed 's/^/      /' "$WORK/ids.err"
  die "could not derive expected mod ids from staging — refusing to claim the deploy is verified"
fi
expected_count=$( grep -c . "$expected_ids" || true )
[ "$expected_count" -gt 0 ] \
  || die "expected-id list came back empty — refusing to claim the deploy is verified"

# The loader prints "Loading N mods:" then one "\t- <id> <version>" per mod.
# Matching that block exactly beats grepping the whole file: a loose search for
# "cosmos" hits a filename in an unrelated line and reports a dead mod as alive.
# The block ends at the next timestamped log line, NOT at the first line that
# fails to look like a mod entry — bundled jars are listed under their parent as
# tree branches ("   \\-- cloth-basic-math 0.6.1"), and treating one of those as
# the end of the list stopped the parse after four mods.
# Top-level entries are "\t- <id> <version>"; the branch lines start with \\-- or
# |-- and so never match, which is exactly the nesting distinction we want.
awk '/Loading [0-9]+ mods:/ { inblock = 1; next }
     inblock && /^\[/ { inblock = 0 }
     inblock && /^[[:space:]]*-[[:space:]]/ { gsub(/^[[:space:]]*-[[:space:]]*/, ""); print $1 }
    ' "$WORK/latest.log" | sort -u > "$WORK/loaded-ids.txt"

loaded_count=$( grep -c . "$WORK/loaded-ids.txt" || true )
if [ "$loaded_count" -eq 0 ]; then
  die "could not read the loader's mod list from latest.log — cannot verify mod init"
fi

missing=$( comm -23 <(sort -u "$expected_ids") "$WORK/loaded-ids.txt" || true )
if [ -n "$missing" ]; then
  printf '    %s✗%s %s of %s expected mod(s) did NOT load:\n' \
    "$red" "$rst" "$(printf '%s\n' "$missing" | grep -c .)" "$expected_count"
  printf '%s\n' "$missing" | sed 's/^/      - /'
  deploy_fail=1
else
  ok "all $expected_count manifest mods present in log (of $loaded_count loaded)"
fi

if grep -Eqi 'Mixin apply.*failed|Could not execute entrypoint|incompatible mod set|Failed to load mods|ERROR.*fabricloader' "$WORK/latest.log"; then
  printf '    %s✗%s mod-loading errors in latest.log:\n' "$red" "$rst"
  grep -Ei 'Mixin apply.*failed|Could not execute entrypoint|incompatible mod set|Failed to load mods|ERROR.*fabricloader' "$WORK/latest.log" | head -20 | sed 's/^/      /'
  deploy_fail=1
else
  ok "no mod-loading errors"
fi

# ============================================================== (e) PARITY
step "(e) Parity check — remote vs staging (name AND size)"
printf 'ls -l %s\n' "$REMOTE_MODS_DIR" | sftp_run > "$WORK/verify.raw" 2>/dev/null \
  || die "parity check could not list remote"
awk '/^-/ { size=$5; name=$9; for(i=10;i<=NF;i++) name=name" "$i;
            if (name ~ /\.jar$/) printf "%s\t%s\n", name, size }' \
    "$WORK/verify.raw" | sort -t"$(printf '\t')" -k1,1 > "$WORK/verify.tsv"

if diff -u "$WORK/staging.tsv" "$WORK/verify.tsv" > "$WORK/parity.diff"; then
  ok "PARITY GREEN — $(wc -l < "$WORK/staging.tsv" | tr -d ' ') jar(s) match by name and size"
else
  printf '    %s✗ PARITY FAILED%s  (- staging, + remote)\n' "$red" "$rst"
  sed 's/^/      /' "$WORK/parity.diff"
  deploy_fail=1
fi

if [ "$deploy_fail" -ne 0 ]; then
  die "DEPLOY FAILED — see the ✗ lines above"
fi
printf '\n%s%sDEPLOY GREEN%s — mirror, boot, and parity all clean.\n' "$bold" "$grn" "$rst"
