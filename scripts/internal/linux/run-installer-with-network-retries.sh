#!/usr/bin/env bash
# CI only: retry the real, atomic installer after a transient download/DNS error.
# Never skip dependency installation or turn a persistent failure into success.
set -euo pipefail

if [[ "$#" != 1 || ! -f "$1" ]]; then
  printf '%s\n' 'Usage: run-installer-with-network-retries.sh <installer.sh>' >&2
  exit 2
fi

installer="$1"
attempt_directory="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/memmy-linux-installer.XXXXXX")"
printf 'Installer attempt logs: %s\n' "$attempt_directory"

recover_ubuntu_mirror() {
  node "$(dirname "${BASH_SOURCE[0]}")/ci-ubuntu-mirror.mjs" 2>&1 | tee "$attempt_directory/mirror-recovery.log"
}

# Avoid spending ten minutes in apt before recovering a known unavailable
# default Ubuntu DNS name. Only the hosted-runner adapter can modify apt URIs.
if [[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]; then
  case "${EXPECTED_ARCH:-}" in
    x64) ubuntu_host=azure.archive.ubuntu.com ;;
    arm64) ubuntu_host=ports.ubuntu.com ;;
    *) printf '%s\n' 'Unexpected hosted Linux smoke architecture.' >&2; exit 2 ;;
  esac
  if ! timeout --signal=TERM --kill-after=1s 5 getent ahosts "$ubuntu_host" >/dev/null 2>&1; then
    printf 'Default Ubuntu mirror DNS preflight failed for %s; verifying a signed HTTPS mirror.\n' "$ubuntu_host"
    recover_ubuntu_mirror
  fi
fi

for attempt in 1 2 3; do
  log="$attempt_directory/attempt-$attempt.log"
  printf 'Running Linux installer (attempt %s/3, timeout 600s)\n' "$attempt"
  set +e
  timeout --signal=TERM --kill-after=10s 600 bash "$installer" 2>&1 | tee "$log"
  statuses=("${PIPESTATUS[@]}")
  set -e
  status="${statuses[0]}"
  if [[ "${statuses[1]}" != 0 ]]; then
    printf '%s\n' 'Cannot preserve installer output; refusing to accept this attempt.' >&2
    exit "${statuses[1]}"
  fi
  if [[ "$status" == 0 ]]; then
    exit 0
  fi
  if ! grep -Eiq 'Temporary failure resolving|Temporary failure in name resolution|Could not resolve|curl: \(6\)|EAI_AGAIN|ENOTFOUND|Connection timed out|Connection reset by peer|Network is unreachable' "$log"; then
    printf 'Installer failed with exit %s without a transient network error; not retrying.\n' "$status" >&2
    exit "$status"
  fi
  if [[ "$attempt" == 3 ]]; then
    printf '%s\n' '::error title=Linux installer network failure::The real installer failed after all three bounded attempts. See the installer failure artifact for the original errors.' >&2
    exit "$status"
  fi
  printf '%s\n' '::warning title=Transient installer network failure::Dependency installation failed due to DNS/network access; preserving the error and retrying the real installer.' >&2
  # Read-only DNS diagnostics; the optional recovery below only changes the
  # ephemeral runner's Ubuntu apt source after verifying its archive signature.
  for host in azure.archive.ubuntu.com ports.ubuntu.com registry.npmjs.org; do
    printf 'DNS diagnostic for %s\n' "$host"
    timeout --signal=TERM --kill-after=1s 5 getent ahosts "$host" || true
  done
  if [[ "$attempt" == 1 && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \
    && grep -Eq 'azure\.archive\.ubuntu\.com|ports\.ubuntu\.com' "$log"; then
    recover_ubuntu_mirror
  fi
  sleep "$((attempt * 5))"
done
