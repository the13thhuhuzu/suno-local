import { createHash, createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { timeline } from './audio.mjs';

const apiOrigin = 'https://studio-api-prod.suno.com';
const idPattern = /^[a-z0-9_-]{6,128}$/i;
const audioOrigins = ['https://d2lwuy8qc234o3.cloudfront.net', 'https://cdn1.suno.ai', 'https://cdn2.suno.ai'];

function sunoPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['suno.com', 'www.suno.com'].includes(url.host) &&
      !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function parseSongLink(value) {
  const url = sunoPage(value);
  const match = url?.pathname.match(/^\/(song|s)\/([a-z0-9_-]{6,128})\/?$/i);
  if (!match) throw new Error('请粘贴 Suno 的作品链接。');
  return { kind: match[1].toLowerCase(), id: match[2], url: `https://suno.com/${match[1]}/${match[2]}` };
}

export function checkedSunoResponse(response) {
  if (response?.error === 'login' || response?.status === 401) {
    throw new Error('Suno 登录未就绪。请回到连接的 Chrome 标签页确认已登录。');
  }
  if (response?.error) throw new Error('无法从连接的标签页访问 Suno。请检查页面和网络。');
  if (!response || response.status < 200 || response.status >= 300) {
    const error = new Error(`Suno 请求失败（HTTP ${response?.status || '?'}）。`);
    error.status = response?.status;
    throw error;
  }
  return response.data;
}

function requireId(value, error) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error(error);
  return value;
}

export async function uploadToSuno(api, parts, title, progress, post = fetch, pause = delay) {
  progress('正在创建 Suno Studio 工程');
  const project = await api(`/api/studio/create-project?title=${encodeURIComponent(title)}`, 'POST')
    .catch(error => {
      if (error.status === 403) throw new Error('Suno 拒绝创建 Studio 工程。请确认当前账号有 Studio 权限。');
      throw error;
    });
  const projectId = requireId(project?.id, 'Suno 未返回 Studio 工程编号。');
  const projectUrl = `https://suno.com/studio/${projectId}`;
  progress('Studio 工程已创建，开始上传片段', { projectUrl });
  const uploaded = [];
  for (const part of parts) {
    progress(`正在上传第 ${part.index + 1} / ${parts.length} 段`);
    const initial = await api('/api/uploads/audio/', 'POST', { extension: 'mp3' });
    const id = requireId(initial?.id, 'Suno 未返回有效上传编号。');
    const url = new URL(initial.url);
    if (url.protocol !== 'https:' || !/(^|\.)s3[.-][a-z0-9-]+\.amazonaws\.com$|(^|\.)s3\.amazonaws\.com$/i.test(url.hostname) ||
        url.username || url.password || url.port) {
      throw new Error('Suno 返回了无法识别的上传地址。');
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(initial.fields || {})) {
      if (typeof value === 'string') form.append(key, value);
    }
    const name = `part-${part.index + 1}.mp3`;
    form.append('file', new Blob([await readFile(part.path)], { type: 'audio/mpeg' }), name);
    const transfer = await post(url, { method: 'POST', body: form, redirect: 'error',
      signal: AbortSignal.timeout(120_000) });
    if (!transfer.ok) throw new Error(`第 ${part.index + 1} 段传输失败（HTTP ${transfer.status}）。`);
    const path = `/api/uploads/audio/${id}/`;
    await api(path + 'upload-finish/', 'POST', { upload_type: 'file_upload', upload_filename: name });
    let clip;
    for (let attempt = 0; attempt < 40; attempt++) {
      const item = await api(path);
      if (['error', 'failed'].includes(item?.status)) {
        throw new Error(`Suno 未能处理第 ${part.index + 1} 段音频。`);
      }
      if (['complete', 'completed'].includes(item?.status)) {
        const created = await api(path + 'initialize-clip/', 'POST', {});
        clip = created?.clip_id || created?.clipId || created?.clip?.id ||
          item?.clip_id || item?.clipId || item?.clip?.id;
        if (!clip) {
          for (let wait = 0; wait < 12 && !clip; wait++) {
            await pause(2500);
            const updated = await api(path);
            clip = updated?.clip_id || updated?.clipId || updated?.clip?.id || updated?.suno_clip_id;
          }
        }
        break;
      }
      await pause(3000);
    }
    uploaded.push({ ...part, clipId: requireId(clip, '片段处理未完成，请先到 Suno 资料库查看。') });
  }
  progress('正在把片段写入 Suno Studio');
  const { state, endBeats, downbeats } = timeline(uploaded, title);
  await api('/api/studio/save-project', 'POST', { project_id: projectId, state, title });
  progress('工程已保存，正在请求整首渲染', { projectUrl });
  const render = await api('/api/studio/render-state', 'POST', {
    title, lyrics: '', state, project_id: projectId, from_studio_project_id: projectId,
    start_beats: 0, end_beats: endBeats, downbeats, web_client_pathname: '/studio',
    export_mode: 'rendered_context_window',
  });
  const clipId = requireId(render?.id || render?.clips?.[0]?.id, 'Suno 未返回整首渲染编号。');
  const songUrl = `https://suno.com/song/${clipId}`;
  progress('渲染任务已提交，正在等 Suno 处理', { projectUrl, songUrl });
  for (let attempt = 0; attempt < 44; attempt++) {
    const info = await api(`/api/clip/${clipId}`).catch(error => {
      if (error.status === 404) return null;
      throw error;
    });
    const status = info?.clip?.status || info?.status;
    if (['complete', 'completed'].includes(status)) return { projectUrl, songUrl };
    if (['error', 'failed'].includes(status)) throw new Error('Suno 报告整首渲染失败。');
    await pause(5000);
  }
  return { projectUrl, songUrl, pending: true };
}

export function unwrapAudio(contentId, rights, bytes) {
  const token = rights?.glt;
  if (typeof token !== 'string' || !token || token.length > 8192) throw new Error('播放授权缺失。');
  const wrappingKey = createHash('sha256').update(token).digest();
  const unwrap = input => {
    if (typeof input !== 'string' || input.length > 4096) throw new Error('播放授权格式异常。');
    const packed = Buffer.from(input, 'base64url');
    if (packed.length <= 28) throw new Error('播放授权不完整。');
    const cipher = createDecipheriv('aes-256-gcm', wrappingKey, packed.subarray(0, 12));
    cipher.setAAD(Buffer.from(contentId));
    cipher.setAuthTag(packed.subarray(-16));
    return Buffer.concat([cipher.update(packed.subarray(12, -16)), cipher.final()]);
  };
  const key = unwrap(rights.key);
  const iv = unwrap(rights.iv);
  if (![16, 24, 32].includes(key.length) || iv.length !== 16) throw new Error('播放密钥格式异常。');
  const cipher = createDecipheriv(`aes-${key.length * 8}-ctr`, key, iv);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

function mediaType(bytes) {
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  if (bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224) return 'mp3';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  return '';
}

async function boundedBytes(response, limit) {
  if (!response.ok) throw new Error(`音源返回 HTTP ${response.status}。`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('响应超过工具的大小上限。');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

export async function downloadSong(value, get = fetch) {
  let link = parseSongLink(value);
  if (link.kind === 's') {
    for (let tries = 0; link.kind === 's' && tries < 4; tries++) {
      const response = await get(link.url, { redirect: 'manual', signal: AbortSignal.timeout(12_000) });
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || response.status < 300 || response.status >= 400) break;
      link = parseSongLink(new URL(location, link.url).href);
    }
    if (link.kind !== 'song') throw new Error('短链接无法解析，请在 Suno 打开后复制作品页链接。');
  }
  const { id } = link;
  for (const [index, origin] of audioOrigins.entries()) {
    try {
      const path = index === 0 ? `/1/clip/${id}.m4a` : `/${id}.mp3`;
      let bytes = await boundedBytes(await get(origin + path, {
        redirect: 'error', signal: AbortSignal.timeout(90_000),
      }), 128 * 1024 * 1024);
      if (index === 0) try {
        const rights = await boundedBytes(await get(apiOrigin + '/api/mango/rights', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json', Origin: 'https://suno.com',
            Referer: 'https://suno.com/', 'browser-token': JSON.stringify({
              token: Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString('base64'),
            }), 'device-id': 'mac-local-audio' },
          body: JSON.stringify({ content_params: { content_id: id, content_type: 'clip' } }),
        }), 32 * 1024);
        const clear = unwrapAudio(id, JSON.parse(rights), bytes);
        if (mediaType(clear)) bytes = clear;
      } catch {}
      const extension = mediaType(bytes);
      if (extension) return { bytes, extension, id };
    } catch {
      // Each source is independent; the next candidate can still serve an intact file.
    }
  }
  throw new Error('这首歌的音源不可用。请检查作品链接、网络或改用 Suno 官方导出。');
}
