#!/usr/bin/env bash
# Local, read-only syntax/lint gate. No SSH, Docker, env-file or data access.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
files=(deploy/server-bootstrap.sh deploy/cloudflare-firewall.sh deploy/production.sh
  deploy/backup.sh deploy/check-scripts.sh scripts/deploy.sh scripts/import-desktop-to-server.sh)
for file in "${files[@]}"; do
  printf 'bash -n %s\n' "$file"
  bash -n "$file"
done

check_remote() {
  local file=$1 marker=$2
  printf 'bash -n remote heredoc %s (%s)\n' "$marker" "$file"
  # bash -n on the outer script does not parse the body sent to remote bash.
  awk -v marker="$marker" '
    $0 == marker {exit}
    active {print}
    index($0, "<<\047" marker "\047") {active=1; found=1}
    END {if (!found) exit 2}
  ' "$file" | bash -n
}
check_remote scripts/deploy.sh REMOTE_DEPLOY
check_remote scripts/deploy.sh REMOTE_ROLLBACK
check_remote scripts/import-desktop-to-server.sh REMOTE_IMPORT

if command -v shellcheck >/dev/null 2>&1; then
  printf 'Running ShellCheck...\n'
  shellcheck -x "${files[@]}"
else
  printf 'ShellCheck not installed; lint skipped (bash syntax checks passed).\n'
fi
printf 'Deployment shell syntax checks passed.\n'
