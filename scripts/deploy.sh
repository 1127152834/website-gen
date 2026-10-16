#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly PROD_ROOT="/opt/website-gen"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# Git Bash otherwise rewrites remote POSIX arguments for native Windows OpenSSH.
remote_ssh() {
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' command ssh \
    -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 "$@"
}

validate_connection_value() {
  local name="$1" value="$2"
  [[ -n "$value" ]] || die "$name is required"
  [[ "$value" =~ ^[A-Za-z0-9._:@%+-]+$ ]] || die "$name contains unsupported characters"
}

mode="deploy"
case "${1:-}" in
  "") ;;
  --rollback) mode="rollback"; shift ;;
  *) die "usage: $0 [--rollback]" ;;
esac
(( $# == 0 )) || die "usage: $0 [--rollback]"

require_command ssh
validate_connection_value DEPLOY_HOST "${DEPLOY_HOST:-}"
validate_connection_value DEPLOY_USER "${DEPLOY_USER:-}"
readonly REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"

if [[ "$mode" == "rollback" ]]; then
  log "rolling back ${REMOTE} to the previous release"
  remote_ssh "$REMOTE" 'bash -s' -- "$PROD_ROOT" <<'REMOTE_ROLLBACK'
set -euo pipefail
umask 077
root="$1"
initial_current="$(readlink -f "$root/current" 2>/dev/null || true)"
[[ -n "$initial_current" && -d "$initial_current" ]] || { echo '[rollback] current release is missing' >&2; exit 1; }
# shellcheck source=/dev/null
source "$initial_current/deploy/production.sh"
production_lock
current="$(readlink -f "$root/current" 2>/dev/null || true)"
previous="$(readlink -f "$root/previous" 2>/dev/null || true)"
[[ -n "$current" && -d "$current" ]] || { echo '[rollback] current release is missing' >&2; exit 1; }
[[ -n "$previous" && -d "$previous" && "$previous" != "$current" ]] || { echo '[rollback] previous release is missing' >&2; exit 1; }
production_init "$current"
tmp_link="$root/.current.rollback.$$"
trap 'rm -f "$tmp_link"' EXIT
ln -s "$previous" "$tmp_link"
mv -Tf "$tmp_link" "$root/current"
ln -sfn "$current" "$root/previous"
if ! ( production_init "$previous" && production_up ); then
  echo '[rollback] previous release failed; restoring original current release' >&2
  ln -sfn "$current" "$root/current"
  ln -sfn "$previous" "$root/previous"
  production_init "$current"
  production_up || true
  exit 1
fi
production_status
echo "[rollback] active release: $previous"
REMOTE_ROLLBACK
  exit 0
fi

require_command git
require_command gzip
require_command scp
require_command tar
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
git rev-parse --verify HEAD >/dev/null
for required in deploy/production.sh deploy/docker-compose.prod.yml deploy/env.production.example; do
  git cat-file -e "HEAD:$required" 2>/dev/null || die "$required is not present in committed HEAD"
done
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "warning: working-tree/index changes are excluded; deploying committed HEAD only"
fi
tree_names="$(git ls-tree -r --name-only HEAD)"
if grep -Eq '(^|/)\.env$|^poc/out/|^release/|^data/|^\.worktrees/|^deploy/certs(/|$)|^deploy/\.local-(baseline|verification)(/|$)' <<<"$tree_names"; then
  die "committed HEAD contains a forbidden deployment path"
fi
unset tree_names
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_name="${timestamp}-$$"
archive="$(mktemp "${TMPDIR:-/tmp}/website-gen-${release_name}.XXXXXX.tar.gz")"
trap 'rm -f "$archive"' EXIT

log "packaging committed HEAD as ${release_name} (working-tree changes are intentionally excluded)"
git archive --format=tar HEAD | gzip -9 >"$archive"

log "creating remote incoming directory"
remote_ssh "$REMOTE" "mkdir -p '$PROD_ROOT/incoming' '$PROD_ROOT/releases' '$PROD_ROOT/shared'"
remote_archive="$PROD_ROOT/incoming/${release_name}.tar.gz"
log "uploading archive to ${REMOTE}:${remote_archive}"
scp -q "$archive" "$REMOTE:$remote_archive"

log "activating release and waiting for production health checks"
remote_ssh "$REMOTE" 'bash -s' -- "$PROD_ROOT" "$release_name" "$remote_archive" <<'REMOTE_DEPLOY'
set -euo pipefail
umask 077
root="$1"
release_name="$2"
archive="$3"
release="$root/releases/$release_name"

[[ "$release_name" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || { echo '[deploy] invalid release name' >&2; exit 1; }
[[ ! -e "$release" ]] || { echo "[deploy] release already exists: $release" >&2; exit 1; }
mkdir -m 0755 "$release"
cleanup_archive() { rm -f "$archive"; }
trap cleanup_archive EXIT
tar -xzf "$archive" -C "$release"
[[ -f "$release/deploy/production.sh" && -f "$release/deploy/docker-compose.prod.yml" ]] || {
  echo '[deploy] archive lacks production deployment files' >&2
  exit 1
}
[[ ! -e "$release/deploy/certs" && ! -L "$release/deploy/certs" ]] || {
  echo '[deploy] deploy/certs must not be present in the archive' >&2
  exit 1
}

# shellcheck source=/dev/null
source "$release/deploy/production.sh"
production_lock
old_current="$(readlink -f "$root/current" 2>/dev/null || true)"
old_previous="$(readlink -f "$root/previous" 2>/dev/null || true)"

if [[ ! -f "$root/shared/.env" ]]; then
  install -m 0600 "$release/deploy/env.production.example" "$root/shared/.env"
  echo "[deploy] created $root/shared/.env from the template; it will never be overwritten"
fi
mkdir -p -m 0700 "$root/shared/certs"
ln -s "$root/shared/certs" "$release/deploy/certs"
production_init "$release"
if ! ( production_validate ); then
  echo '[deploy] production configuration is not ready; release was not activated' >&2
  rm -rf --one-file-system "$release"
  exit 1
fi

tmp_link="$root/.current.deploy.$$"
trap 'cleanup_archive; rm -f "$tmp_link"' EXIT
ln -s "$release" "$tmp_link"
mv -Tf "$tmp_link" "$root/current"
if [[ -n "$old_current" && -d "$old_current" && "$old_current" != "$release" ]]; then
  ln -sfn "$old_current" "$root/previous"
fi

if ! ( production_init "$release" && production_up ); then
  echo '[deploy] new release failed; restoring the former current release' >&2
  if [[ -n "$old_current" && -d "$old_current" ]]; then
    ln -sfn "$old_current" "$root/current"
    if [[ -n "$old_previous" && -d "$old_previous" ]]; then
      ln -sfn "$old_previous" "$root/previous"
    else
      rm -f "$root/previous"
    fi
    production_init "$old_current"
    production_up || true
  else
    compose down --remove-orphans || true
    rm -f "$root/current"
  fi
  rm -rf --one-file-system "$release"
  exit 1
fi

production_status
echo "[deploy] active release: $release"

# Retain exactly three releases at most, counting current/previous as pinned.
current_target="$(readlink -f "$root/current" 2>/dev/null || true)"
previous_target="$(readlink -f "$root/previous" 2>/dev/null || true)"
mapfile -t releases < <(find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
declare -A keep=()
keep_count=0
for candidate in "$current_target" "$previous_target"; do
  if [[ -n "$candidate" && -d "$candidate" && -z "${keep[$candidate]:-}" ]]; then
    keep["$candidate"]=1
    ((keep_count += 1))
  fi
done
for name in "${releases[@]}"; do
  candidate="$root/releases/$name"
  if (( keep_count < 3 )) && [[ -z "${keep[$candidate]:-}" ]]; then
    keep["$candidate"]=1
    ((keep_count += 1))
  fi
done
for name in "${releases[@]}"; do
  candidate="$root/releases/$name"
  if [[ -z "${keep[$candidate]:-}" ]]; then
    echo "[deploy] removing expired release: $name"
    rm -rf --one-file-system "$candidate"
  fi
done
REMOTE_DEPLOY

log "deployment complete"
