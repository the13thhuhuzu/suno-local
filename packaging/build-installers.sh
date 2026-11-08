#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
root="$PWD"
cache="$root/packaging/cache"
version="$(cat VERSION)"
dist="$root/dist/installers"
stage="$(mktemp -d "$root/packaging/cache/build.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$dist" "$stage/mac/bin" "$stage/mac/Third-Party" "$stage/mac-root" \
  "$stage/win/bin" "$stage/win/Third-Party" "$stage/nsis"

verify_inputs() {
  python3 - <<'PY'
from pathlib import Path
import sys
sys.path.insert(0, str(Path('packaging').resolve()))
import fetch
items = dict(fetch.node_assets)
items[fetch.mac_source] = fetch.mac_source_sha
items[fetch.lame_source] = fetch.lame_source_sha
items['makensis-3.13-arm64-tahoe.tar.gz'] = 'e7c507dc02c50a630db44948fc68ff4dea7c2bae64592d96d134952c2624ddc1'
for name, sha in items.items():
    path = fetch.cache / name
    if not path.is_file() or fetch.digest(path) != sha:
        raise SystemExit(f'Build input missing or incorrect: {name}. Run packaging/fetch.py.')
PY
}
verify_inputs
media="$cache/macos-ffmpeg-release-13.5"
if [ ! -x "$media/ffmpeg" ] || [ ! -x "$media/ffprobe" ]; then
  ./packaging/build-macos-ffmpeg.sh
fi
node_mac="node-v24.22.1-darwin-arm64"
node_win="node-v24.22.1-win-x64"
tar -xOf "$cache/$node_mac.tar.gz" "$node_mac/bin/node" > "$stage/mac/bin/node"
tar -xOf "$cache/$node_mac.tar.gz" "$node_mac/LICENSE" > "$stage/mac/Third-Party/Node-LICENSE.txt"
/usr/bin/bsdtar -xOf "$cache/$node_win.7z" "$node_win/node.exe" > "$stage/win/bin/node.exe"
/usr/bin/bsdtar -xOf "$cache/$node_win.7z" "$node_win/LICENSE" > "$stage/win/Third-Party/Node-LICENSE.txt"
win_media="$cache/windows-ffmpeg-x64"
if [ ! -f "$win_media/ffmpeg.exe" ] || [ ! -f "$win_media/ffprobe.exe" ]; then
  ./packaging/build-windows-ffmpeg.sh
fi
for tool in ffmpeg ffprobe; do
  cp "$media/$tool" "$stage/mac/bin/$tool"
  cp "$win_media/$tool.exe" "$stage/win/bin/$tool.exe"
done
chmod 755 "$stage/mac/bin/node" "$stage/mac/bin/ffmpeg" "$stage/mac/bin/ffprobe"
cp "$media/"*.txt "$stage/mac/Third-Party/"
cp "$win_media/"*.txt "$stage/win/Third-Party/"
cp packaging/licenses/*.txt "$stage/win/Third-Party/"

for platform in mac win; do
  cp packaging/Sources.txt "$stage/$platform/Third-Party/"
done

# Do not let Installer relocate an earlier development copy outside /Applications.
SUNO_MAC_PAYLOAD="$stage/mac" ./build.sh "$stage/mac-root/Suno Local.app"
/usr/bin/pkgbuild --analyze --root "$stage/mac-root" "$stage/components.plist"
python3 - "$stage/components.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    info = plistlib.load(f)
assert len(info) == 1 and info[0]['RootRelativeBundlePath'] == 'Suno Local.app'
info[0]['BundleIsRelocatable'] = False
info[0]['BundleOverwriteAction'] = 'upgrade'
with open(sys.argv[1], 'wb') as f:
    plistlib.dump(info, f)
PY
/usr/bin/pkgbuild --root "$stage/mac-root" --component-plist "$stage/components.plist" \
  --install-location /Applications --identifier local.sunoworkbench.mac.pkg \
  --version "$version" "$stage/SunoLocalPayload.pkg"
cat > "$stage/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Suno Local</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <domains enable_localSystem="true" enable_currentUserHome="false" enable_anywhere="false"/>
  <allowed-os-versions><os-version min="13.5"/></allowed-os-versions>
  <choices-outline><line choice="app"/></choices-outline>
  <choice id="app" visible="false"><pkg-ref id="local.sunoworkbench.mac.pkg"/></choice>
  <pkg-ref id="local.sunoworkbench.mac.pkg" version="$version">SunoLocalPayload.pkg</pkg-ref>
</installer-gui-script>
XML
mac_file="Suno-Local-$version-macOS-arm64.pkg"
win_file="Suno-Local-$version-Windows11-x64-Setup.exe"
/usr/bin/productbuild --distribution "$stage/distribution.xml" --package-path "$stage" "$stage/$mac_file"

tar -xf "$cache/makensis-3.13-arm64-tahoe.tar.gz" -C "$stage/nsis"
nsis="$stage/nsis/makensis/3.13"
export NSISDIR="$nsis/share/nsis"
./packaging/copy-app.sh "$stage/win"
"$nsis/bin/makensis" -V2 "-DOUTPUT=$stage/win/Suno Local.exe" packaging/launcher.nsi
"$nsis/bin/makensis" -V2 "-DOUTPUT=$stage/$win_file" "-DPAYLOAD=$stage/win" \
  "-DVERSION=$version" packaging/windows.nsi

mv -f "$stage/$mac_file" "$stage/$win_file" "$dist/"
(cd "$dist" && /usr/bin/shasum -a 256 "$mac_file" "$win_file" > SHA256SUMS.txt)
printf '%s\n' "$dist/$mac_file" "$dist/$win_file"
