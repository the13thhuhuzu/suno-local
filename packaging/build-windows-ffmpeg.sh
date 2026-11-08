#!/bin/sh
set -eu
cd "$(dirname "$0")"
cache="$PWD/cache"
source="$cache/ffmpeg-9.0.2.tar.xz"
lame_source="$cache/lame-3.100.tar.gz"
out="$cache/windows-ffmpeg-x64"
export ZIG="$(command -v "${ZIG:-zig}")"
export ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-${TMPDIR:-/tmp}/suno-zig-cache}"
jobs="${JOBS:-8}"
work="$(mktemp -d "${TMPDIR:-/tmp}/suno-windows-media.XXXXXX")"
trap 'result=$?; if [ "$result" -ne 0 ] && [ -f "$work/ffmpeg-9.0.2/ffbuild/config.log" ]; then cp "$work/ffmpeg-9.0.2/ffbuild/config.log" "$cache/windows-ffmpeg-config.log"; fi; rm -rf "$work"' EXIT
mkdir -p "$work/result"
cat > "$work/cc" <<'WRAPPER'
#!/bin/sh
# shortcut: LLD keeps PE relocations with --dynamicbase, drop the GNU ld workaround.
for arg do
  shift
  case "$arg" in
    -Wl,--pic-executable,-e,mainCRTStartup) continue ;;
  esac
  set -- "$@" "$arg"
done
exec "$ZIG" cc -target x86_64-windows-gnu "$@"
WRAPPER
cat > "$work/ar" <<'WRAPPER'
#!/bin/sh
exec "$ZIG" ar "$@"
WRAPPER
cat > "$work/ranlib" <<'WRAPPER'
#!/bin/sh
exec "$ZIG" ranlib "$@"
WRAPPER
chmod +x "$work/cc" "$work/ar" "$work/ranlib"
printf '%s  %s\n' 8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e "$source" \
  ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e "$lame_source" | shasum -a 256 -c -
tar -xf "$lame_source" -C "$work"
cd "$work/lame-3.100"
CC="$work/cc" AR="$work/ar" RANLIB="$work/ranlib" \
  lt_cv_prog_gnu_ld=yes lt_cv_sys_max_cmd_len=131072 \
  ./configure --host=x86_64-w64-mingw32 --disable-dependency-tracking --disable-debug \
  --disable-frontend --disable-shared --enable-static --prefix="$work/lame"
make -j "$jobs"
make install
printf '#include <lame/lame.h>\nint main(void) { return lame_set_VBR_quality(lame_init(), 4); }\n' > "$work/lame-test.c"
"$work/cc" -I"$work/lame/include" "$work/lame-test.c" -L"$work/lame/lib" -lmp3lame -o "$work/lame-test.exe"
tar -xf "$source" -C "$work"
cd "$work/ffmpeg-9.0.2"
./configure --enable-cross-compile --target-os=mingw32 --arch=x86_64 \
  --cc="$work/cc" --ar="$work/ar" --ranlib="$work/ranlib" --windres=false --disable-stripping --disable-x86asm \
  --disable-autodetect --disable-everything --disable-network \
  --disable-doc --disable-debug --disable-ffplay --disable-avdevice \
  --disable-shared --enable-static --disable-gpl --disable-nonfree \
  --enable-libmp3lame --enable-protocol=file,pipe \
  --enable-demuxer=aac,aiff,flac,matroska,mov,mp3,ogg,wav \
  --enable-muxer=mp3,wav,null \
  --enable-decoder='aac,alac,flac,mp3,mp3float,opus,vorbis,pcm_*' \
  --enable-encoder=libmp3lame,pcm_s16le,pcm_s24le \
  --enable-parser=aac,flac,mpegaudio,opus,vorbis \
  --enable-filter=aresample,asetrate,aformat,anull,atrim,asetpts \
  --extra-cflags="-I$work/lame/include" --extra-ldflags="-L$work/lame/lib"
make -j "$jobs" ffmpeg.exe ffprobe.exe
cp ffmpeg.exe ffprobe.exe "$work/result/"
cp COPYING.LGPLv2.1 "$work/result/FFmpeg-LICENSE.txt"
cp "$work/lame-3.100/COPYING" "$work/result/LAME-LICENSE.txt"
{
  printf 'FFmpeg 9.0.2, LAME 3.100, Windows x86_64.\n'
  printf 'Built with packaging/build-windows-ffmpeg.sh.\n'
  "$ZIG" version
} > "$work/result/FFmpeg-build.txt"
mkdir -p "$out"
mv -f "$work/result/"* "$out/"
