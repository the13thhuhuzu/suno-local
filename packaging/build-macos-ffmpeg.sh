#!/bin/sh
set -eu
cd "$(dirname "$0")"
cache="$PWD/cache"
source="$cache/ffmpeg-9.0.2.tar.xz"
out="$cache/macos-ffmpeg-release-13.5"
lame_source="$cache/lame-3.100.tar.gz"
printf '%s  %s\n' 8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e "$source" | shasum -a 256 -c -
printf '%s  %s\n' ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e "$lame_source" | shasum -a 256 -c -
work="$(mktemp -d "${TMPDIR:-/tmp}/suno-macos-media.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/result"
export MACOSX_DEPLOYMENT_TARGET=13.5
tar -xf "$lame_source" -C "$work"
cd "$work/lame-3.100"
./configure --disable-dependency-tracking --disable-debug --disable-frontend \
  --disable-shared --enable-static --prefix="$work/lame"
make -j 8
make install
tar -xf "$source" -C "$work"
cd "$work/ffmpeg-9.0.2"
./configure --disable-autodetect --disable-everything --disable-network \
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
make -j 8 ffmpeg ffprobe
cp ffmpeg ffprobe "$work/result/"
cp COPYING.LGPLv2.1 "$work/result/FFmpeg-LICENSE.txt"
cp "$work/lame-3.100/COPYING" "$work/result/LAME-LICENSE.txt"
"$work/result/ffmpeg" -version > "$work/result/FFmpeg-build.txt"
if rg -q -- '--enable-nonfree' "$work/result/FFmpeg-build.txt"; then exit 1; fi
mkdir -p "$out"
mv -f "$work/result/"* "$out/"
