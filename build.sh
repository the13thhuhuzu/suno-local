#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p dist
app="${1:-dist/Suno Local.app}"
version="$(cat VERSION)"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
resources="$(cd "$app/Contents/Resources" && pwd -P)"
./packaging/copy-app.sh "$resources"
if [ -n "${SUNO_MAC_PAYLOAD:-}" ]; then
  cp -R "$SUNO_MAC_PAYLOAD/bin" "$SUNO_MAC_PAYLOAD/Third-Party" "$resources/"
  /usr/bin/codesign --force --sign - "$resources/bin/node"
  /usr/bin/codesign --force --sign - "$resources/bin/ffmpeg"
  /usr/bin/codesign --force --sign - "$resources/bin/ffprobe"
  /usr/bin/codesign --verify "$resources/bin/node"
fi
cat > "$app/Contents/MacOS/Suno Local" <<'LAUNCH'
#!/bin/sh
set -eu
resources="$(cd "$(dirname "$0")/../Resources" && pwd -P)"
proxy="${SUNO_HTTP_PROXY:-${HTTPS_PROXY:-}}"
if [ -n "$proxy" ]; then
  export HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy"
  export https_proxy="$proxy" http_proxy="$proxy"
fi
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
node="$resources/bin/node"
if [ ! -x "$node" ]; then node=/usr/local/bin/node; fi
exec "$node" --use-env-proxy "$resources/app.mjs" "$@"
LAUNCH
chmod 755 "$app/Contents/MacOS/Suno Local"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Suno Local</string>
  <key>CFBundleDisplayName</key><string>Suno Local</string>
  <key>CFBundleExecutable</key><string>Suno Local</string>
  <key>CFBundleIdentifier</key><string>local.sunoworkbench.mac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
/usr/bin/plutil -lint "$app/Contents/Info.plist"
/usr/bin/codesign --force --sign - "$app"
/usr/bin/codesign --verify --deep --strict "$app"
printf '%s\n' "$(cd "$app" && pwd -P)"
