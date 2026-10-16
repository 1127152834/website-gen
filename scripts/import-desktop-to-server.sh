#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly PROD_ROOT="/opt/website-gen"
force_replace=0
desktop_quit=0
desktop_dir=""

log() { printf '[desktop-import] %s\n' "$*"; }
die() { printf '[desktop-import] ERROR: %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
# Keep remote /opt paths intact when Git Bash invokes native Windows OpenSSH.
remote_ssh() {
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' command ssh \
    -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 "$@"
}

while (( $# )); do
  case "$1" in
    --force-replace) force_replace=1 ;;
    --desktop-quit-confirmed) desktop_quit=1 ;;
    --desktop-dir)
      shift
      (( $# )) || die "--desktop-dir requires a path"
      desktop_dir="$1"
      ;;
    *) die "usage: $0 --desktop-quit-confirmed [--desktop-dir PATH] [--force-replace]" ;;
  esac
  shift
done
(( desktop_quit )) || die "fully quit the desktop app, then re-run with --desktop-quit-confirmed"

for command in git gzip node ssh scp tar cygpath; do require_command "$command"; done
[[ -n "${DEPLOY_HOST:-}" ]] || die "DEPLOY_HOST is required"
[[ -n "${DEPLOY_USER:-}" ]] || die "DEPLOY_USER is required"
[[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9._:@%+-]+$ ]] || die "DEPLOY_HOST contains unsupported characters"
[[ "$DEPLOY_USER" =~ ^[A-Za-z0-9._+-]+$ ]] || die "DEPLOY_USER contains unsupported characters"
[[ -z "${WEBSITE_GEN_MASTER_KEY:-}" ]] || die "unset WEBSITE_GEN_MASTER_KEY; this import must use staging/master.key"
readonly REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
staging="$(mktemp -d "${TMPDIR:-/tmp}/website-gen-import.XXXXXX")"
archive="$(mktemp "${TMPDIR:-/tmp}/website-gen-import.XXXXXX.tar.gz")"
remote_archive=""
remote_uploaded=0
cleanup() {
  rm -rf "$staging"
  rm -f "$archive"
  unset IMPORT_ADMIN_PASSWORD
  if (( remote_uploaded )) && [[ -n "$remote_archive" ]]; then
    if ! remote_ssh "$REMOTE" "rm -f '$remote_archive'" >/dev/null 2>&1; then
      printf '[desktop-import] WARNING: could not remove the uploaded staging archive; the next import expires uploads older than 24 hours\n' >&2
    fi
  fi
}
trap cleanup EXIT

native_path() {
  if [[ "$1" =~ ^/ ]]; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}
staging_native="$(cygpath -w "$staging")"
desktop_args=()
if [[ -n "$desktop_dir" ]]; then desktop_args=(--desktop-dir "$(native_path "$desktop_dir")"); fi

IMPORT_ADMIN_PASSWORD="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))")"
export IMPORT_ADMIN_PASSWORD
log "creating a fresh local staging data directory"
node scripts/prepare-desktop-import.ts --data-dir "$staging_native"
log "importing the stopped desktop workspace into the staging admin account"
node scripts/import-desktop-data.ts --data-dir "$staging_native" --user admin "${desktop_args[@]}"
node scripts/rebase-desktop-import.ts --data-dir "$staging_native"
tar -czf "$archive" -C "$staging" admin.sqlite users master.key
gzip -t "$archive"
printf '[desktop-import] temporary admin password (shown once): %s\n' "$IMPORT_ADMIN_PASSWORD"
unset IMPORT_ADMIN_PASSWORD

timestamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
remote_archive="$PROD_ROOT/shared/import-${timestamp}.tar.gz"
log "uploading staged admin.sqlite, users/, and master.key"
remote_uploaded=1
scp -q "$archive" "$REMOTE:$remote_archive"

log "stopping the app, installing the staged data, and verifying health"
remote_ssh "$REMOTE" 'bash -s' -- "$PROD_ROOT" "$remote_archive" "$timestamp" "$force_replace" <<'REMOTE_IMPORT'
set -euo pipefail
umask 077
root="$1"
archive="$2"
timestamp="$3"
force_replace="$4"
release="$(readlink -f "$root/current" 2>/dev/null || true)"
[[ -n "$release" && -d "$release" ]] || { echo '[desktop-import] no deployed current release' >&2; exit 1; }
[[ -f "$archive" ]] || { echo '[desktop-import] uploaded archive is missing' >&2; exit 1; }
# shellcheck source=/dev/null
source "$release/deploy/production.sh"
production_init "$release"
production_lock
find "$root/shared" -maxdepth 1 -type f -name 'import-*.tar.gz' -mmin +1440 -print -delete

app_may_be_stopped=0
mutation_started=0
success=0
backup=""
recover_on_exit() {
  rc=$?
  trap - EXIT
  rm -f "$archive" || true
  if (( success )); then exit "$rc"; fi
  if (( app_may_be_stopped )); then
    if (( mutation_started )); then
      echo '[desktop-import] failure after data mutation; restoring the former data state' >&2
      if compose stop app; then
        if [[ -n "$backup" && -f "$backup" ]]; then
          if ! docker run --rm --user 0 -v "$volume_name:/data" -v "$backup:/backup.tar.gz:ro" "$image" sh -c \
            'set -eu; find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf /backup.tar.gz -C /data'; then
            echo '[desktop-import] CRITICAL: full-volume restore failed; app remains stopped' >&2
            exit "$rc"
          fi
        else
          if ! docker run --rm --user 0 -v "$volume_name:/data" "$image" sh -c \
            'set -eu; rm -rf /data/.desktop-import /data/admin.sqlite /data/admin.sqlite-shm /data/admin.sqlite-wal /data/users /data/master.key'; then
            echo '[desktop-import] CRITICAL: cleanup of fresh-volume import failed; app remains stopped' >&2
            exit "$rc"
          fi
        fi
      else
        echo '[desktop-import] CRITICAL: cannot stop app; refusing destructive restore' >&2
        exit "$rc"
      fi
    fi
    if ! compose up -d app; then
      echo '[desktop-import] CRITICAL: app restart failed' >&2
    fi
  fi
  exit "$rc"
}
trap recover_on_exit EXIT

master_override="$(production_env WEBSITE_GEN_MASTER_KEY || true)"
[[ -z "$master_override" ]] || {
  echo '[desktop-import] WEBSITE_GEN_MASTER_KEY must be empty in shared/.env; imported master.key must be authoritative' >&2
  exit 1
}

image="$(compose images -q app | head -n 1)"
[[ -n "$image" ]] || { echo '[desktop-import] app image is not built; deploy first' >&2; exit 1; }
volume_name="website-gen-data"

echo '[desktop-import] validating the uploaded archive before stopping the app'
gzip -t "$archive"
docker run --rm --user 0 -v "$archive:/import.tar.gz:ro" "$image" sh -c '
  set -eu
  mkdir -m 0700 /tmp/import-check
  tar -xzf /import.tar.gz -C /tmp/import-check
  test -f /tmp/import-check/admin.sqlite
  test -f /tmp/import-check/master.key
  test -d /tmp/import-check/users
  node -e '\''const {readFileSync}=require("node:fs"); const {DatabaseSync}=require("node:sqlite"); const key=readFileSync("/tmp/import-check/master.key","utf8").trim(); if(Buffer.from(key,"base64").length!==32) process.exit(2); const db=new DatabaseSync("/tmp/import-check/admin.sqlite",{readOnly:true}); const row=db.prepare("select username,must_change_password from users where role=? and disabled=0").get("admin"); db.close(); if(!row || row.username!=="admin" || row.must_change_password!==1) process.exit(3);'\''
'
has_admin=0
if docker run --rm --user 0 -v "$volume_name:/data" "$image" sh -c 'test -f /data/admin.sqlite'; then has_admin=1; fi
if (( has_admin && ! force_replace )); then
  echo '[desktop-import] data volume already contains admin.sqlite; use --force-replace to back it up and replace it' >&2
  exit 1
fi

app_may_be_stopped=1
compose stop app
# Snapshot even an apparently empty volume: interrupted initializations can
# leave a master.key or user files without admin.sqlite.
{
  mkdir -p "$root/backups"
  chmod 0700 "$root/backups"
  backup="$root/backups/pre-import-${timestamp}.tar.gz"
  deploy_uid="$(id -u)"
  deploy_gid="$(id -g)"
  [[ "$deploy_uid" =~ ^[0-9]+$ && "$deploy_gid" =~ ^[0-9]+$ ]] || { echo '[desktop-import] invalid deploy uid/gid' >&2; exit 1; }
  backup_name="$(basename "$backup")"
  echo "[desktop-import] backing up existing volume to $backup"
  if ! docker run --rm --user 0 -v "$volume_name:/data:ro" -v "$root/backups:/backup" "$image" \
    sh -c 'set -eu; umask 077; tar -czf "/backup/$3" -C /data .; chown "$1:$2" "/backup/$3"; chmod 0600 "/backup/$3"' sh "$deploy_uid" "$deploy_gid" "$backup_name"; then
    echo '[desktop-import] backup failed' >&2
    exit 1
  fi
  if ! ( gzip -t "$backup" && cd "$root/backups" && sha256sum "$backup_name" >"$backup_name.sha256" && sha256sum -c "$backup_name.sha256" ); then
    echo '[desktop-import] backup verification failed' >&2
    exit 1
  fi
}

mutation_started=1
docker run --rm --user 0 -v "$volume_name:/data" -v "$archive:/import.tar.gz:ro" "$image" sh -c \
  'set -eu; stage="/data/.desktop-import"; rm -rf "$stage"; mkdir -m 0700 "$stage"; tar -xzf /import.tar.gz -C "$stage"; test -f "$stage/admin.sqlite"; test -f "$stage/master.key"; test -d "$stage/users"; rm -rf /data/admin.sqlite /data/admin.sqlite-shm /data/admin.sqlite-wal /data/users /data/master.key; mv "$stage/admin.sqlite" "$stage/users" "$stage/master.key" /data/; rmdir "$stage"; chown 1000:1000 /data; chown -R 1000:1000 /data/admin.sqlite /data/users /data/master.key; chmod 600 /data/master.key'

compose up -d app
production_health
success=1
production_status
echo '[desktop-import] import complete; the admin must change the temporary password at first login'
REMOTE_IMPORT
remote_uploaded=0

log "desktop data import complete"
