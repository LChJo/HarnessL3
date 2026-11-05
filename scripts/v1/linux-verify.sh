#!/usr/bin/env bash
set -euo pipefail
script_root=$(cd "$(dirname "$0")" && pwd)
source_root=$(cd "$script_root/../.." && pwd)
bash "$script_root/linux-env.sh"
case "$(uname -m)" in x86_64) node_arch=x64 ;; aarch64|arm64) node_arch=arm64 ;; *) exit 1 ;; esac
export PATH="${XDG_CACHE_HOME:-$HOME/.cache}/harnessl3-validation/node-v24.12.0-${node_arch}/bin:$PATH"
run_root=$(mktemp -d /tmp/harnessl3-native-linux.XXXXXXXX)
printf 'RUN_ROOT=%s\n' "$run_root"
tar -C "$source_root" --exclude=node_modules --exclude=build --exclude=dist --exclude=.git --exclude=.harness-local --exclude='.env*' -cf - . | tar -C "$run_root" -xf -
cd "$run_root"
npm ci --ignore-scripts --no-audit --no-fund
npm run build:cli
set +e
node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=native-linux.xml "$@"
test_result=$?
set -e
mkdir -p "$source_root/.harness-local/implementation-20261105"
cp native-linux.xml "$source_root/.harness-local/implementation-20261105/native-linux-latest.xml"
exit "$test_result"
