#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null || ! command -v npm >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "Node.js 20+ and npm required; installing a local Node.js runtime."
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64) platform=linux-x64 ;;
    Linux:aarch64|Linux:arm64) platform=linux-arm64 ;;
    Darwin:x86_64) platform=darwin-x64 ;;
    Darwin:arm64) platform=darwin-arm64 ;;
    *) echo "Unsupported platform for automatic Node installation." >&2; exit 1 ;;
  esac
  command -v curl >/dev/null || { echo "curl is required for bootstrap." >&2; exit 1; }
  version=v22.22.0
  archive="node-$version-$platform.tar.gz"
  runtime="$PWD/node_modules/.om-runtime"
  mkdir -p "$runtime"
  if [[ ! -x "$runtime/node-$version-$platform/bin/node" ]]; then
    tmp="$(mktemp -d)"
    trap 'rm -rf -- "$tmp"' EXIT
    curl --fail --silent --show-error --location "https://nodejs.org/dist/$version/$archive" -o "$tmp/$archive"
    curl --fail --silent --show-error --location "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    (cd "$tmp"; grep -F "  $archive" SHASUMS256.txt > checksum; if command -v sha256sum >/dev/null; then sha256sum -c checksum; else shasum -a 256 -c checksum; fi)
    tar -xzf "$tmp/$archive" -C "$runtime"
  fi
  export PATH="$runtime/node-$version-$platform/bin:$PATH"
fi

# npm reconciles missing or changed dependencies on every launch.
if [[ -f package-lock.json && ! -d node_modules/.bin ]]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
npm run check
exec npm run dev
