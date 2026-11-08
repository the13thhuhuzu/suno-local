import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
function audioTool(name) {
  const filename = name + (process.platform === 'win32' ? '.exe' : '');
  const bundled = fileURLToPath(new URL('./bin/' + filename, import.meta.url));
  const brew = '/opt/homebrew/bin/' + filename;
  return process.env['SUNO_' + name.toUpperCase()] ||
    (existsSync(bundled) ? bundled : existsSync(brew) ? brew : filename);
}
const ffmpeg = audioTool('ffmpeg');
const ffprobe = audioTool('ffprobe');
const localAudio = ['-protocol_whitelist', 'file,pipe', '-format_whitelist',
  'aac,aiff,flac,mov,mp4,m4a,3gp,3g2,mj2,mp3,ogg,wav,matroska,webm'];

async function convert(args) {
  try {
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      timeout: 300_000, windowsHide: true,
    });
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? '找不到 FFmpeg。' : '音频处理失败，请检查输入格式。');
  }
}

export async function durationOf(path) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', ...localAudio, '-select_streams', 'a:0',
    '-show_entries', 'stream=duration:format=duration',
    '-of', 'json', path,
  ], { timeout: 20_000, windowsHide: true });
  const info = JSON.parse(stdout);
  if (!info.streams?.length) throw new Error('这个文件没有可读取的音轨。');
  const duration = Number(info.streams[0].duration) || Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取音频时长。');
  return duration;
}

export function segmentPlan(duration) {
  if (!Number.isFinite(duration) || duration < 9 || duration > 720) {
    throw new Error('分段模式支持 9 秒至 12 分钟的音频。');
  }
  return Array.from({ length: 6 }, (_, index) => ({
    index, start: index * duration / 6, duration: duration / 6, ratio: 4,
  }));
}

export async function encodeParts(source, folder, name, onProgress) {
  const duration = await durationOf(source);
  const parts = [];
  for (const segment of segmentPlan(duration)) {
    const label = `${name} · ${segment.index + 1}`;
    const path = join(folder, `part-${segment.index + 1}.mp3`);
    onProgress(`正在编码第 ${segment.index + 1} / 6 段`);
    await convert([
      '-ss', String(segment.start), ...localAudio, '-i', source,
      '-t', String(segment.duration * segment.ratio),
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '44100',
      '-af', 'aresample=44100,asetrate=11025,aresample=44100',
      '-c:a', 'libmp3lame', '-b:a', '192k', '-y', path,
    ]);
    parts.push({ ...segment, label, path });
  }
  return parts;
}

export async function transcode(source, output, format) {
  await convert([...localAudio, '-i', source, '-map', '0:a:0', '-vn',
    ...(format === 'wav' ? ['-c:a', 'pcm_s24le'] : ['-c:a', 'libmp3lame', '-b:a', '320k']),
    '-y', output]);
}

export function timeline(parts, title) {
  const bps = 2;
  const fade = 0.03;
  const tracks = ['#3985df', '#8959cb'].map((color, index) => ({
    type: 'audio', id: randomUUID(), name: `Track ${index + 1}`, color, icon: 'Audio',
    clips: [], clipCreationIntents: [], height: 160, input: null,
    mute: false, solo: false, arm: false, amplitude: 1, balance: 0,
    instrument: { type: 'song' }, takeLanes: [], takeLanesExpanded: false, soloTakeLaneId: null,
    routingMode: 'linear', faderAutomation: {}, signalChain: [],
  }));
  let end = 0;
  parts.forEach((part, index) => {
    const track = tracks[index % 2];
    const start = index ? end - fade : 0;
    end = start + part.duration;
    track.clips.push({
      type: 'audio', id: randomUUID(), clipId: part.clipId, uploadId: null,
      asset: { type: 'clip', id: part.clipId }, name: part.label, color: track.color,
      startBeats: start * bps, endBeats: end * bps, readStartBeats: 0,
      fadeInBeats: index ? fade * bps : 0,
      fadeOutBeats: index < parts.length - 1 ? fade * bps : 0, fadeInCurve: 1, fadeOutCurve: 1,
      transposition: 12 * Math.log2(part.ratio), formantCorrection: 0, amplitude: 1,
      mute: false, reversed: false, streaming: false, warp: { enabled: false },
      loop: { enabled: false, startBeats: 0, endBeats: part.duration * part.ratio * bps },
    });
  });
  const state = {
    title, amplitude: 1, metadata: {}, majorVersion: 1, tracks, sections: {},
    lyricsCorrectionsByClipId: {}, markersRegistry: {}, routing: {}, masterRoutingMode: 'linear',
    masterSignalChain: [], midiCcMappings: {},
    timing: { type: 'manual', bps, bpsAutomation: [], firstBeatSeconds: 0 },
    timeSignatureChanges: [{ startBeats: 0, subdivisionsPerBar: 4, beatsPerSubdivision: 1 }],
    metronome: { enabled: false, amplitude: 1 }, recording: { countInBars: 0, preRollBars: 0 },
    loop: { enabled: false, startBeats: 0, endBeats: 32 }, songFadeInBeats: 0, songFadeOutBeats: 0,
    editorPointerModes: { audio: 'select', midi: 'select' },
    selection: {
      anchorBeats: 0, focusBeats: 0, trackIds: tracks.map(track => track.id),
      focusedTrackId: tracks[0].id, focusedArea: 'timeline',
    },
  };
  const endBeats = end * bps;
  const downbeats = Array.from({ length: Math.max(1, Math.floor(endBeats)) },
    (_, beat) => [beat / bps, beat % 4 + 1]);
  return { state, endBeats, downbeats };
}
