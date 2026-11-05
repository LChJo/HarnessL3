#!/usr/bin/env bash
set -euo pipefail

# Native Linux validation uses an isolated copy, including not-yet-committed files.
script_root=$(cd "$(dirname "$0")" && pwd)
source_root=$(cd "$script_root/../.." && pwd)
bash "$script_root/linux-env.sh"
case "$(uname -m)" in x86_64) node_arch=x64 ;; aarch64|arm64) node_arch=arm64 ;; *) exit 1 ;; esac
toolchain_cache="${XDG_CACHE_HOME:-$HOME/.cache}/harnessl3-validation"
export PATH="$toolchain_cache/node-v24.12.0-${node_arch}/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$toolchain_cache/playwright"
export BROWSER_CHANNEL=chromium
mkdir -p "$toolchain_cache/runs"
run_root=$(mktemp -d "$toolchain_cache/runs/harnessl3-native-linux-full.XXXXXXXX")
report_root="$source_root/.harness-local/validation/native-linux"
mkdir -p "$report_root"
printf 'RUN_ROOT=%s\n' "$run_root"
save_reports() {
  run_result=$?
  trap - EXIT
  for relative in .harness-local/validation .harness-local/artifacts web/validation; do
    if [[ -d "$run_root/$relative" ]]; then
      mkdir -p "$report_root/$relative"
      cp -R "$run_root/$relative/." "$report_root/$relative/"
    fi
  done
  printf 'exitCode=%s\nrunRoot=%s\nnode=%s\n' "$run_result" "$run_root" "$(node --version)" > "$report_root/result.txt"
  if [[ "$run_result" == 0 ]]; then
    resolved_run=$(realpath "$run_root")
    case "$resolved_run" in "$toolchain_cache"/runs/harnessl3-native-linux-full.*) rm -rf -- "$resolved_run" ;; *) echo 'Unsafe cleanup target' >&2; exit 1 ;; esac
  fi
  exit "$run_result"
}
trap save_reports EXIT
tar -C "$source_root" --exclude=node_modules --exclude=build --exclude=dist --exclude=.git --exclude=.harness-local --exclude='.env*' -cf - . | tar -C "$run_root" -xf -
cd "$run_root"
npm ci --ignore-scripts --no-audit --no-fund
npm run build
if [[ "${1:-}" != --package-only ]]; then
  npm test
  node scripts/v1/browser-smoke.mjs
fi
node scripts/v1/package-smoke.mjs
