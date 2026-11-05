#!/usr/bin/env bash
set -euo pipefail

# Install the pinned native toolchain into a separate validation cache; never change host Node.
node_version=v24.12.0
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo 'Unsupported native Linux architecture' >&2; exit 1 ;;
esac
toolchain_cache="${XDG_CACHE_HOME:-$HOME/.cache}/harnessl3-validation"
mkdir -p "$toolchain_cache"
toolchain_root="$toolchain_cache/node-${node_version}-${node_arch}"
if [[ ! -x "$toolchain_root/bin/node" ]]; then
  download_root=$(mktemp -d /tmp/harnessl3-node-download.XXXXXXXX)
  archive_name="node-${node_version}-linux-${node_arch}.tar.xz"
  curl --fail --location --silent --show-error "https://nodejs.org/dist/${node_version}/${archive_name}" --output "$download_root/$archive_name"
  curl --fail --location --silent --show-error "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" --output "$download_root/SHASUMS256.txt"
  (cd "$download_root"; awk -v name="$archive_name" '$2 == name { print }' SHASUMS256.txt | sha256sum --check --status)
  tar -xJf "$download_root/$archive_name" -C "$download_root"
  mv "$download_root/node-${node_version}-linux-${node_arch}" "$toolchain_root"
fi
[[ "$($toolchain_root/bin/node --version)" == "$node_version" ]]
printf 'NODE_ROOT=%s\n' "$toolchain_root"
"$toolchain_root/bin/node" -p 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})'
