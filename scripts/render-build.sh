#!/usr/bin/env bash
set -euo pipefail

APP_DIR="masrofi_ai_v6_2"
ARCHIVE_FILE="masrofi_ai_v6_2.tar.gz"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[render-build] unpacking Masrofi AI archive..."
  cat archive/*.b64 | base64 -d > "$ARCHIVE_FILE"
  tar -xzf "$ARCHIVE_FILE"
fi

cd "$APP_DIR"
npm ci
npm run build
