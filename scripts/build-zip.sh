#!/usr/bin/env bash
# Build a distributable zip of the extension.
#
# The manifest must sit at the zip root (not inside a wrapped folder) or the
# Chrome Web Store rejects the upload and "Load unpacked" points at the wrong
# level. Output lands in dist/ and is gitignored — attach it to a GitHub
# Release rather than committing it.

set -euo pipefail

cd "$(dirname "$0")/.."

version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -1)
if [ -z "$version" ]; then
  echo "could not read version from manifest.json" >&2
  exit 1
fi

out="dist/airdraw-${version}.zip"
mkdir -p dist
rm -f "$out"

zip -r -q -X "$out" \
  manifest.json \
  rules.json \
  src \
  vendor \
  README.md \
  -x '*.DS_Store' '*/._*'

echo "$out"
unzip -l "$out" | tail -1
