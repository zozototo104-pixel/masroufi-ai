#!/usr/bin/env bash
set -euo pipefail

APP_DIR="masrofi_ai_v6_2"
ARCHIVE_BR="masrofi_ai_v6_2.tar.br"
ARCHIVE_TAR="masrofi_ai_v6_2.tar"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[render-build] unpacking Masrofi AI Brotli archive..."
  if [ ! -f archive/br-part07.b64 ]; then
    echo "[render-build] archive/br-part07.b64 is missing; deploy archive is incomplete" >&2
    exit 1
  fi
  cat archive/br-part*.b64 | base64 -d > "$ARCHIVE_BR"
  node -e "const fs=require('fs'); const zlib=require('zlib'); fs.writeFileSync('$ARCHIVE_TAR', zlib.brotliDecompressSync(fs.readFileSync('$ARCHIVE_BR')));"
  mkdir -p "$APP_DIR"
  tar -xf "$ARCHIVE_TAR" -C "$APP_DIR"
fi

cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npm run build
