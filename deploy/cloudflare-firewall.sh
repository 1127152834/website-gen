#!/usr/bin/env bash
set -euo pipefail

readonly V4_FILE="${CLOUDFLARE_V4_FILE:-/opt/website-gen/shared/cloudflare/ips-v4}"
readonly V6_FILE="${CLOUDFLARE_V6_FILE:-/opt/website-gen/shared/cloudflare/ips-v6}"
readonly CHAIN="WEBSITE_GEN_CF"
readonly BOOT_CHAIN="WEBSITE_GEN_CF_BOOT"
readonly PORTS="80,443"

log() {
  printf '[website-gen-firewall] %s\n' "$*"
}

die() {
  printf '[website-gen-firewall] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || die "run as root"

prepare_startup_gate() {
  local command
  for command in iptables ip6tables; do
    if ! "${command}" -w 30 -n -L DOCKER-USER >/dev/null 2>&1; then
      "${command}" -w 30 -N DOCKER-USER
      "${command}" -w 30 -A DOCKER-USER -j RETURN
    fi
    if ! "${command}" -w 30 -n -L "${BOOT_CHAIN}" >/dev/null 2>&1; then
      "${command}" -w 30 -N "${BOOT_CHAIN}"
    fi
    if ! "${command}" -w 30 -C "${BOOT_CHAIN}" -j DROP 2>/dev/null; then
      "${command}" -w 30 -A "${BOOT_CHAIN}" -j DROP
    fi
    if ! "${command}" -w 30 -C DOCKER-USER -p tcp -m multiport --dports "${PORTS}" \
      -m conntrack --ctstate DNAT --ctdir ORIGINAL -j "${BOOT_CHAIN}" 2>/dev/null; then
      "${command}" -w 30 -I DOCKER-USER 1 -p tcp -m multiport --dports "${PORTS}" \
        -m conntrack --ctstate DNAT --ctdir ORIGINAL -j "${BOOT_CHAIN}"
    fi
    # Docker normally owns this hook. Creating the standard hook before the
    # daemon starts prevents a restored container from bypassing the gate.
    if ! "${command}" -w 30 -C FORWARD -j DOCKER-USER 2>/dev/null; then
      "${command}" -w 30 -I FORWARD 1 -j DOCKER-USER
    fi
  done
  log "installed temporary fail-closed Docker startup gate"
}

remove_startup_gate() {
  local command rules
  for command in iptables ip6tables; do
    while "${command}" -w 30 -C DOCKER-USER -p tcp -m multiport --dports "${PORTS}" \
      -m conntrack --ctstate DNAT --ctdir ORIGINAL \
      -j "${BOOT_CHAIN}" 2>/dev/null; do
      "${command}" -w 30 -D DOCKER-USER -p tcp -m multiport --dports "${PORTS}" \
        -m conntrack --ctstate DNAT --ctdir ORIGINAL \
        -j "${BOOT_CHAIN}"
    done
    if "${command}" -w 30 -n -L "${BOOT_CHAIN}" >/dev/null 2>&1; then
      "${command}" -w 30 -F "${BOOT_CHAIN}"
      "${command}" -w 30 -X "${BOOT_CHAIN}"
    fi
    # -C/-L in conditionals can confuse a lock timeout with an absent rule.
    # A checked listing must prove the deny gate is detached before success.
    rules="$("${command}" -w 30 -S DOCKER-USER)" || die "cannot verify ${command} startup-gate removal"
    if [[ ${rules} == *"-j ${BOOT_CHAIN}"* ]]; then
      die "${command} startup deny gate is still attached; Docker remains fail-closed"
    fi
  done
  log "removed temporary Docker startup gate after permanent rules were verified"
}

if [[ ${1:-} == --prepare ]]; then
  prepare_startup_gate
  exit 0
fi
[[ $# -eq 0 ]] || die "usage: $0 [--prepare]"

[[ -s ${V4_FILE} ]] || die "missing or empty IPv4 list: ${V4_FILE}"
[[ -s ${V6_FILE} ]] || die "missing or empty IPv6 list: ${V6_FILE}"

validate_cidrs() {
  local file=$1
  local version=$2
  python3 - "$file" "$version" <<'PY'
import ipaddress
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expected_version = int(sys.argv[2])
lines = [line.strip() for line in path.read_text(encoding="ascii").splitlines() if line.strip()]
if not lines:
    raise SystemExit(f"{path}: list is empty")
if len(lines) != len(set(lines)):
    raise SystemExit(f"{path}: duplicate CIDR")
for value in lines:
    network = ipaddress.ip_network(value, strict=True)
    if network.version != expected_version:
        raise SystemExit(f"{path}: unexpected IPv{network.version} CIDR: {value}")
PY
}

validate_cidrs "${V4_FILE}" 4
validate_cidrs "${V6_FILE}" 6

remove_managed_allow_rules() {
  local command=$1
  local source
  local rules sources

  # A process substitution hides the producer's exit code from set -e. Read
  # and check first, or a lock timeout could leave obsolete trusted ranges.
  rules="$("${command}" -w 30 -S "${CHAIN}")" || die "cannot read ${command} managed rules"
  sources="$(sed -n "s/^-A ${CHAIN} -s \([^[:space:]]*\).* -j RETURN$/\1/p" <<< "${rules}")" \
    || die "cannot parse managed allow rules"

  while IFS= read -r source; do
    [[ -n ${source} ]] || continue
    "${command}" -w 30 -D "${CHAIN}" -s "${source}" -j RETURN
  done <<< "${sources}"
}

reconcile_family() {
  local command=$1
  local cidr_file=$2
  local family_label=$3

  if ! "${command}" -w 30 -n -L DOCKER-USER >/dev/null 2>&1; then
    if [[ ${family_label} == IPv6 ]]; then
      log "IPv6 DOCKER-USER is absent; production publishes Caddy on IPv4 only, so no IPv6 Docker listener exists"
      return 0
    fi
    die "Docker did not create the IPv4 DOCKER-USER chain"
  fi

  if ! "${command}" -w 30 -n -L "${CHAIN}" >/dev/null 2>&1; then
    "${command}" -w 30 -N "${CHAIN}"
  fi

  # Install the terminal deny before attaching the chain. During refresh it
  # remains in place while old allow rules are removed, so updates fail closed.
  if ! "${command}" -w 30 -C "${CHAIN}" -j DROP 2>/dev/null; then
    "${command}" -w 30 -A "${CHAIN}" -j DROP
  fi

  # Match only the original direction of host-published, DNATed connections.
  # Without these conntrack constraints, container egress to TCP 80/443 would
  # also enter the allowlist chain and be dropped.
  if ! "${command}" -w 30 -C DOCKER-USER -p tcp -m multiport --dports "${PORTS}" \
    -m conntrack --ctstate DNAT --ctdir ORIGINAL -j "${CHAIN}" 2>/dev/null; then
    "${command}" -w 30 -I DOCKER-USER 1 -p tcp -m multiport --dports "${PORTS}" \
      -m conntrack --ctstate DNAT --ctdir ORIGINAL -j "${CHAIN}"
  fi

  # Migrate the earlier unscoped owned rule only after the safe replacement is
  # active. Do not alter any other DOCKER-USER rules.
  while "${command}" -w 30 -C DOCKER-USER -p tcp -m multiport --dports "${PORTS}" \
    -j "${CHAIN}" 2>/dev/null; do
    "${command}" -w 30 -D DOCKER-USER -p tcp -m multiport --dports "${PORTS}" \
      -j "${CHAIN}"
  done

  remove_managed_allow_rules "${command}"
  while IFS= read -r cidr; do
    [[ -n ${cidr} ]] || continue
    "${command}" -w 30 -I "${CHAIN}" 1 -s "${cidr}" -j RETURN
  done < "${cidr_file}"

  log "enforced ${family_label} Cloudflare-only access to Docker-published TCP 80/443"
}

reconcile_family iptables "${V4_FILE}" IPv4
reconcile_family ip6tables "${V6_FILE}" IPv6
remove_startup_gate

log "firewall reconciliation complete"
