#!/bin/sh
set -eu
destination="$1"
cd "$(dirname "$0")/.."
mkdir -p "$destination/chrome-link"
cp app.mjs audio.mjs suno.mjs browser-link.mjs index.html ui.js "$destination/"
cp chrome-link/manifest.json chrome-link/background.js chrome-link/connect.html \
  chrome-link/connect.mjs chrome-link/page-request.mjs "$destination/chrome-link/"
cp README.md README.zh-CN.md LICENSE "$destination/README.md"
