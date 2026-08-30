#!/usr/bin/env bash
set -euo pipefail

APP_DIR="masrofi_ai_v6_2"
ARCHIVE_FILE="masrofi_ai_v6_2.tar.gz"
FULL_ARCHIVE_B64="archive/masrofi_ai_v6_2.tar.gz.b64"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[render-build] unpacking Masrofi AI archive..."
  if [ -f "$FULL_ARCHIVE_B64" ]; then
    base64 -d "$FULL_ARCHIVE_B64" > "$ARCHIVE_FILE"
  else
    cat archive/part*.b64 | base64 -d > "$ARCHIVE_FILE"
  fi
  tar -xzf "$ARCHIVE_FILE"
fi

cd "$APP_DIR"
npm ci
npm run build
