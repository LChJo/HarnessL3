#!/usr/bin/env bash
set -euo pipefail
script_root=$(cd "$(dirname "$0")" && pwd)
source_root=$(cd "$script_root/../.." && pwd)
bash "$script_root/linux-env.sh"
case "$(uname -m)" in x86_64) node_arch=x64 ;; aarch64|arm64) node_arch=arm64 ;; *) exit 1 ;; esac
toolchain_cache="${XDG_CACHE_HOME:-$HOME/.cache}/harnessl3-validation"
export PATH="$toolchain_cache/node-v24.12.0-${node_arch}/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$toolchain_cache/playwright"
report_root="$source_root/.harness-local/implementation-20261105"
mkdir -p "$report_root"
if ! node "$source_root/node_modules/playwright/cli.js" install --with-deps chromium >"$report_root/linux-browser-install.log" 2>&1; then
  tail -n 30 "$report_root/linux-browser-install.log"
  exit 1
fi
printf 'Native Linux Chromium and dependencies installed in the validation environment.\n'
