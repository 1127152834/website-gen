#!/usr/bin/env bash
set -euo pipefail

readonly DEPLOY_USER="tiancheng"
readonly APP_ROOT="/opt/website-gen"
readonly SHARED_DIR="${APP_ROOT}/shared"
readonly CLOUDFLARE_DIR="${SHARED_DIR}/cloudflare"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly FIREWALL_SOURCE="${SCRIPT_DIR}/cloudflare-firewall.sh"
readonly FIREWALL_TARGET="/usr/local/sbin/website-gen-cloudflare-firewall"
readonly BACKUP_ROOT="/var/backups/website-gen-bootstrap"

readonly CF_V4_URL="https://www.cloudflare.com/ips-v4"
readonly CF_V6_URL="https://www.cloudflare.com/ips-v6"

readonly FALLBACK_V4='173.245.48.0/20
103.21.244.0/22
103.22.200.0/22
103.31.4.0/22
141.101.64.0/18
108.162.192.0/18
190.93.240.0/20
188.114.96.0/20
197.234.240.0/22
198.41.128.0/17
162.158.0.0/15
104.16.0.0/13
104.24.0.0/14
172.64.0.0/13
131.0.72.0/22'

readonly FALLBACK_V6='2400:cb00::/32
2606:4700::/32
2803:f800::/32
2405:b500::/32
2405:8100::/32
2a06:98c0::/29
2c0f:f248::/32'

log() {
  printf '[website-gen-bootstrap] %s\n' "$*"
}

die() {
  printf '[website-gen-bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || die "run with sudo: sudo bash deploy/server-bootstrap.sh"
[[ -f ${FIREWALL_SOURCE} ]] || die "missing companion script: ${FIREWALL_SOURCE}"
id "${DEPLOY_USER}" >/dev/null 2>&1 || die "required user does not exist: ${DEPLOY_USER}"

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

snapshot_dir="${BACKUP_ROOT}/$(date -u +%Y%m%dT%H%M%SZ)-$$"
log "snapshotting existing deployment configuration and firewall state to ${snapshot_dir}"
install -d -m 0700 -o root -g root "${snapshot_dir}"
for config_path in \
  /etc/apt/apt.conf.d/20auto-upgrades \
  /etc/apt/apt.conf.d/52website-gen-unattended-security \
  /etc/apt/sources.list.d/docker.list \
  /etc/apt/keyrings/docker.gpg \
  /etc/default/ufw \
  /etc/systemd/system/docker.service.d/website-gen-firewall.conf \
  /etc/systemd/system/website-gen-cloudflare-firewall.service \
  /etc/cron.d/website-gen-backup \
  /etc/logrotate.d/website-gen-backup \
  "${FIREWALL_TARGET}" \
  "${CLOUDFLARE_DIR}/ips-v4" \
  "${CLOUDFLARE_DIR}/ips-v6" \
  "${CLOUDFLARE_DIR}/cloudflare.caddy"; do
  if [[ -e ${config_path} ]]; then
    cp -a --parents -- "${config_path}" "${snapshot_dir}"
  fi
done
if command -v iptables-save >/dev/null 2>&1; then
  iptables-save > "${snapshot_dir}/iptables-save.txt"
fi
if command -v ip6tables-save >/dev/null 2>&1; then
  ip6tables-save > "${snapshot_dir}/ip6tables-save.txt"
fi
if command -v ufw >/dev/null 2>&1; then
  ufw status numbered > "${snapshot_dir}/ufw-status.txt" || true
fi

# Serialize bootstrap, deploy, import, and backup operations on the same lock.
install -d -m 0755 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${APP_ROOT}" "${SHARED_DIR}"
if [[ ! -e ${SHARED_DIR}/operations.lock ]]; then
  install -m 0600 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" /dev/null "${SHARED_DIR}/operations.lock"
else
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${SHARED_DIR}/operations.lock"
  chmod 0600 "${SHARED_DIR}/operations.lock"
fi
exec 9<> "${SHARED_DIR}/operations.lock"
flock -n 9 || die "another website-gen deploy, import, backup, or bootstrap operation is running"
log "acquired ${SHARED_DIR}/operations.lock"

log "updating Ubuntu packages non-interactively"
apt-get update
apt-get -y -o Dpkg::Options::=--force-confold full-upgrade
apt-get install -y ca-certificates cron curl gnupg gzip iproute2 iptables logrotate nano openssl python3 tar unattended-upgrades ufw util-linux

. /etc/os-release
[[ ${ID:-} == ubuntu ]] || die "this bootstrap supports Ubuntu only"
[[ ${VERSION_ID:-} == 22.04 ]] || log "warning: designed for Ubuntu 22.04; detected ${VERSION_ID:-unknown}"

log "configuring UTC and unattended security upgrades"
timedatectl set-timezone UTC
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52website-gen-unattended-security <<'EOF'
Unattended-Upgrade::Origins-Pattern {
        "origin=Ubuntu,codename=${distro_codename}-security,label=Ubuntu";
};
EOF
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service
systemctl enable --now cron.service

log "installing Docker Engine and Compose plugin from Docker's official apt repository"
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location --connect-timeout 10 --max-time 60 https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor --yes --output /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
arch="$(dpkg --print-architecture)"
codename="${VERSION_CODENAME:-jammy}"
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
  "${arch}" "${codename}" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker --version
docker compose version

log "granting ${DEPLOY_USER} Docker access (a new login is required before group membership is visible)"
usermod -aG docker "${DEPLOY_USER}"

log "creating the release, shared-state, certificate, and backup directories"
install -d -m 0755 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" \
  "${APP_ROOT}" "${APP_ROOT}/releases" "${SHARED_DIR}" "${CLOUDFLARE_DIR}"
install -d -m 0700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${APP_ROOT}/backups"
install -d -m 0700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${SHARED_DIR}/certs"

validate_cidr_file() {
  local file=$1
  local version=$2
  local minimum_count=$3
  python3 - "$file" "$version" "$minimum_count" <<'PY'
import ipaddress
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expected_version = int(sys.argv[2])
minimum_count = int(sys.argv[3])
lines = [line.strip() for line in path.read_text(encoding="ascii").splitlines() if line.strip()]
if len(lines) < minimum_count or len(lines) != len(set(lines)):
    raise SystemExit(1)
for value in lines:
    network = ipaddress.ip_network(value, strict=True)
    if network.version != expected_version:
        raise SystemExit(1)
PY
}

refresh_cloudflare_list() {
  local url=$1
  local fallback=$2
  local version=$3
  local minimum_count=$4
  local destination=$5
  local candidate
  candidate="$(mktemp)"

  if curl --fail --silent --show-error --location --connect-timeout 10 --max-time 20 "${url}" --output "${candidate}" \
    && validate_cidr_file "${candidate}" "${version}" "${minimum_count}"; then
    log "refreshed Cloudflare IPv${version} ranges from ${url}"
  else
    log "Cloudflare IPv${version} refresh unavailable or invalid; using embedded fallback"
    printf '%s\n' "${fallback}" > "${candidate}"
    validate_cidr_file "${candidate}" "${version}" "${minimum_count}" \
      || die "embedded Cloudflare IPv${version} fallback failed validation"
  fi

  sed '/^[[:space:]]*$/d' "${candidate}" > "${candidate}.clean"
  install -m 0644 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${candidate}.clean" "${destination}"
  rm -f -- "${candidate}" "${candidate}.clean"
}

log "refreshing the Cloudflare address allowlists"
old_lists_dir="$(mktemp -d)"
trap 'rm -rf -- "${old_lists_dir}"' EXIT
[[ ! -s ${CLOUDFLARE_DIR}/ips-v4 ]] || cp -- "${CLOUDFLARE_DIR}/ips-v4" "${old_lists_dir}/ips-v4"
[[ ! -s ${CLOUDFLARE_DIR}/ips-v6 ]] || cp -- "${CLOUDFLARE_DIR}/ips-v6" "${old_lists_dir}/ips-v6"
refresh_cloudflare_list "${CF_V4_URL}" "${FALLBACK_V4}" 4 15 "${CLOUDFLARE_DIR}/ips-v4"
refresh_cloudflare_list "${CF_V6_URL}" "${FALLBACK_V6}" 6 7 "${CLOUDFLARE_DIR}/ips-v6"

log "writing Caddy's trusted Cloudflare proxy configuration"
{
  printf '# Generated by deploy/server-bootstrap.sh; do not edit manually.\n'
  printf 'trusted_proxies static'
  while IFS= read -r cidr; do printf ' %s' "${cidr}"; done < "${CLOUDFLARE_DIR}/ips-v4"
  while IFS= read -r cidr; do printf ' %s' "${cidr}"; done < "${CLOUDFLARE_DIR}/ips-v6"
  printf '\n'
} > "${CLOUDFLARE_DIR}/cloudflare.caddy.tmp"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "${CLOUDFLARE_DIR}/cloudflare.caddy.tmp"
chmod 0644 "${CLOUDFLARE_DIR}/cloudflare.caddy.tmp"
mv -f -- "${CLOUDFLARE_DIR}/cloudflare.caddy.tmp" "${CLOUDFLARE_DIR}/cloudflare.caddy"

log "configuring UFW (SSH everywhere; HTTP/S only from Cloudflare)"
sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
ufw allow 22/tcp comment 'website-gen SSH'
ufw default deny incoming
ufw default allow outgoing
# Remove only generic web allows if they exist; do not reset UFW or unrelated rules.
ufw --force delete allow 80/tcp >/dev/null 2>&1 || true
ufw --force delete allow 443/tcp >/dev/null 2>&1 || true
for old_list in "${old_lists_dir}/ips-v4" "${old_lists_dir}/ips-v6"; do
  [[ -s ${old_list} ]] || continue
  while IFS= read -r cidr; do
    ufw --force delete allow from "${cidr}" to any port 80 proto tcp >/dev/null 2>&1 || true
    ufw --force delete allow from "${cidr}" to any port 443 proto tcp >/dev/null 2>&1 || true
  done < "${old_list}"
done
while IFS= read -r cidr; do
  ufw allow from "${cidr}" to any port 80 proto tcp comment 'website-gen Cloudflare HTTP'
  ufw allow from "${cidr}" to any port 443 proto tcp comment 'website-gen Cloudflare HTTPS'
done < "${CLOUDFLARE_DIR}/ips-v4"
while IFS= read -r cidr; do
  ufw allow from "${cidr}" to any port 80 proto tcp comment 'website-gen Cloudflare HTTP'
  ufw allow from "${cidr}" to any port 443 proto tcp comment 'website-gen Cloudflare HTTPS'
done < "${CLOUDFLARE_DIR}/ips-v6"
ufw --force enable
ufw status verbose

log "installing fail-closed DOCKER-USER filtering for Docker-published HTTP/S"
install -m 0755 -o root -g root "${FIREWALL_SOURCE}" "${FIREWALL_TARGET}"
install -d -m 0755 -o root -g root /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/website-gen-firewall.conf <<EOF
[Service]
ExecStartPre=${FIREWALL_TARGET} --prepare
ExecStartPost=${FIREWALL_TARGET}
EOF
systemctl disable --now website-gen-cloudflare-firewall.service >/dev/null 2>&1 || true
rm -f -- /etc/systemd/system/website-gen-cloudflare-firewall.service
systemctl daemon-reload
# ExecStartPre installs a temporary DNAT gate at DOCKER-USER (and ensures the
# standard FORWARD hook exists); ExecStartPost replaces it with the scoped
# Cloudflare allowlist before Docker becomes ready.
systemctl restart docker

log "installing the daily root backup cron entry"
cat > /etc/cron.d/website-gen-backup <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * root /bin/bash /opt/website-gen/current/deploy/backup.sh >> /var/log/website-gen-backup.log 2>&1
EOF
chmod 0644 /etc/cron.d/website-gen-backup
cat > /etc/logrotate.d/website-gen-backup <<'EOF'
/var/log/website-gen-backup.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root adm
}
EOF
chmod 0644 /etc/logrotate.d/website-gen-backup

log "bootstrap complete"
log "IMPORTANT: production Compose must publish Caddy as explicit IPv4 0.0.0.0:80/443 bindings, must not publish UDP, and must not publish the app port"
