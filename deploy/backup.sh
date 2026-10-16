#!/usr/bin/env bash
# Daily online SQLite snapshots. Run as root (cron); does NOT stop the app.
set -euo pipefail
umask 077
ROOT=/opt/website-gen
[[ $EUID -eq 0 ]] || { printf 'Run with sudo.\n' >&2; exit 1; }
RELEASE=$(realpath -e "$ROOT/current")
# shellcheck source=deploy/production.sh
source "$RELEASE/deploy/production.sh"
production_init "$RELEASE"
production_lock
mkdir -p "$ROOT/backups"
chown tiancheng:tiancheng "$ROOT/backups"
chmod 700 "$ROOT/backups"
stamp=$(date -u +%Y%m%dT%H%M%S)-$$
stage=$(mktemp -d "$ROOT/backups/.incomplete-$stamp-XXXXXX")
archive="$ROOT/backups/website-gen-$stamp.tar.gz"
container="website-gen-backup-$stamp"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf -- "$stage"
  rm -f -- "$archive.part"
}
trap cleanup EXIT
chown 1000:1000 "$stage"
image=$(compose images -q app)
[[ -n $image ]] || production_die 'App image is not available; deploy first.'
docker volume inspect website-gen-data >/dev/null
export WEBSITE_GEN_MASTER_KEY
WEBSITE_GEN_MASTER_KEY=$(production_env WEBSITE_GEN_MASTER_KEY)
printf 'Taking online, per-database consistent SQLite backups (app remains running).\n'
timeout --foreground --kill-after=30s 15m docker run --rm --name "$container" --network none --user 1000:1000 \
  --env WEBSITE_GEN_MASTER_KEY \
  --mount type=volume,source=website-gen-data,target=/source,readonly \
  --mount "type=bind,source=$stage,target=/backup" \
  --mount "type=bind,source=$RELEASE/deploy/backup-data.mjs,target=/backup-data.mjs,readonly" \
  "$image" node /backup-data.mjs
unset WEBSITE_GEN_MASTER_KEY
if [[ $(production_env CF_SSL_MODE) == strict ]]; then
  if ! openssl x509 -in "$ROOT/shared/certs/origin.pem" -noout -checkend 2592000 >/dev/null; then
    printf 'WARNING: Origin Certificate expires within 30 days or cannot be read. Renew and recreate Caddy.\n' >&2
  fi
fi
chown -R root:root "$stage"
printf 'Creating private archive with master.key and user work files.\n'
tar -czf "$archive.part" -C "$stage" .
gzip -t "$archive.part"
mv "$archive.part" "$archive"
sha256sum "$archive" > "$archive.sha256"
printf 'Verified backup: %s\n' "$archive"
printf 'Removing completed scheduled backups older than 14 days.\n'
find "$ROOT/backups" -maxdepth 1 -type f \( -name 'website-gen-*.tar.gz' -o -name 'website-gen-*.tar.gz.sha256' \) -mmin +20160 -print -delete
