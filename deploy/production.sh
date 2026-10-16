#!/usr/bin/env bash
# Sourced server-side helper; no network calls or changes merely by sourcing.
set -euo pipefail

PROD_ROOT=/opt/website-gen

production_die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

production_lock() {
  # Shared by deployment, import, backup and restore. Held until shell exits.
  exec 9>"$PROD_ROOT/shared/operations.lock"
  flock -n 9 || production_die 'Another deployment/import/backup/restore is running.'
}

production_env() {
  # Never source an env file as executable shell and never echo its full content.
  local key=$1
  awk -v key="$key" 'index($0,key "=")==1 {v=substr($0,length(key)+2); sub(/\r$/, "", v); print v; found=1; exit} END {if(!found) exit 1}' "$PROD_ROOT/shared/.env"
}

production_init() {
  local candidate=${1:?release path required}
  RELEASE=$(realpath -e "$candidate") || production_die 'Release path does not exist.'
  [[ $RELEASE == "$PROD_ROOT"/releases/* && -f $RELEASE/deploy/docker-compose.prod.yml ]] || production_die 'Invalid release directory.'
  [[ -f $PROD_ROOT/shared/.env && ! -L $PROD_ROOT/shared/.env ]] || production_die 'Missing regular shared/.env.'
  export RELEASE_ID
  RELEASE_ID=$(basename "$RELEASE")
  COMPOSE=(docker compose --project-name website-gen --project-directory "$RELEASE" --env-file "$PROD_ROOT/shared/.env" -f "$RELEASE/deploy/docker-compose.prod.yml")
}

compose() { "${COMPOSE[@]}" "$@"; }

production_validate() {
  local mode password
  [[ $(production_env HOST) == 0.0.0.0 && $(production_env PORT) == 8787 && $(production_env TRUST_PROXY) == 1 ]] || production_die 'Require HOST=0.0.0.0 PORT=8787 TRUST_PROXY=1.'
  [[ $(production_env SITE_ADDRESS) == tool.aoeen.com ]] || production_die 'Require SITE_ADDRESS=tool.aoeen.com.'
  mode=$(production_env CF_SSL_MODE)
  [[ $mode == full || $mode == strict ]] || production_die 'CF_SSL_MODE must be full or strict.'
  password=$(production_env ADMIN_PASSWORD)
  [[ ${#password} -ge 12 && $password != CHANGE_ME* ]] || production_die 'Set a strong ADMIN_PASSWORD in shared/.env (at least 12 characters).'
  unset password
  [[ -s $PROD_ROOT/shared/cloudflare/cloudflare.caddy ]] || production_die 'Run server-bootstrap.sh first (missing Cloudflare trust list).'
  if [[ $mode == strict ]]; then
    [[ -s $PROD_ROOT/shared/certs/origin.pem && -s $PROD_ROOT/shared/certs/origin.key ]] || production_die 'Strict mode requires shared/certs/origin.pem and origin.key.'
    openssl x509 -in "$PROD_ROOT/shared/certs/origin.pem" -noout -checkend 86400 >/dev/null || production_die 'Origin certificate expired or expires within 24 hours.'
    openssl x509 -in "$PROD_ROOT/shared/certs/origin.pem" -noout -checkhost tool.aoeen.com >/dev/null || production_die 'Origin certificate does not cover tool.aoeen.com.'
  fi
  printf 'Validating production Compose and Caddy (%s); env values are not printed.\n' "$mode"
  compose config --quiet || return 1
  compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
}

production_health() {
  local cid status attempt code
  printf 'Waiting for app health and HTTPS origin readiness...\n'
  for ((attempt=1; attempt<=60; attempt++)); do
    cid=$(compose ps -q app) || return 1
    status='missing'
    if [[ -n $cid ]]; then status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid") || return 1; fi
    if [[ $status == healthy ]]; then
      # Local origin intentionally has a non-public certificate in BOTH modes.
      # This verifies origin routing only, not Cloudflare edge TLS or firewall.
      code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 --noproxy '*' --insecure --resolve tool.aoeen.com:443:127.0.0.1 https://tool.aoeen.com/_origin_health) || code=000
      if [[ $code == 200 ]]; then
        printf 'Verified: app healthy; Caddy HTTPS /_origin_health returned %s.\n' "$code"
        return 0
      fi
    fi
    sleep 3
  done
  printf 'ERROR: Health timeout. Inspect production logs; public Cloudflare reachability was not tested.\n' >&2
  return 1
}

production_up() {
  production_validate || return 1
  printf 'Building and starting release %s (persistent volume preserved).\n' "$RELEASE_ID"
  compose up -d --build --wait --wait-timeout 180 || return 1
  production_health
}

production_status() {
  compose ps
  # Bootstrap passwords must not leak through automated status output.
  printf 'Last Caddy log lines (app logs are deliberately not dumped; may contain secrets):\n'
  compose logs --no-color --tail 20 caddy
}
