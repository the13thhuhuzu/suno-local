import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { durationOf, encodeParts, segmentPlan, transcode } from './audio.mjs';
import { downloadSong, parseSongLink, uploadToSuno } from './suno.mjs';
import { browserLink } from './browser-link.mjs';

const maxSource = 512 * 1024 * 1024;
const allowedExtensions = new Set(['.aac', '.aif', '.aiff', '.flac', '.m4a', '.mp3', '.ogg', '.wav', '.opus']);
const mime = { mp3: 'audio/mpeg', wav: 'audio/wav' };
const cleanTitle = title => title.replace(/[\u0000-\u001f/\\]/g, ' ').trim().slice(0, 120) || 'Suno audio';

export async function startApp({
  open = true,
  readSong = downloadSong,
} = {}) {
  const assets = new URL('.', import.meta.url);
  const html = await readFile(new URL('index.html', assets));
  const js = await readFile(new URL('ui.js', assets));
  const token = randomBytes(32).toString('hex');
  const link = browserLink();
  const work = await mkdtemp(join(tmpdir(), 'suno-local-'));
  let host;
  let job = null;
  let source = null;
  let sourceBusy = false;

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const json = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.host !== host) {
      return json({ error: '此工具只接受本机窗口的请求。' }, 403);
    }
    const url = new URL(req.url, `http://${host}`);
    const path = url.pathname;
    if (['/link/pull', '/link/result'].includes(path)) {
      return link.handle(req, res, path, json).catch(() => {
        if (!res.headersSent && !res.destroyed) json({ error: '连接请求失败。' }, 400);
      });
    }
    if (req.headers.origin && req.headers.origin !== `http://${host}`) {
      return json({ error: '此工具只接受本机窗口的请求。' }, 403);
    }
    if (req.method === 'GET' && ['/', '/ui.js'].includes(path)) {
      res.writeHead(200, { 'Content-Type': path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
      return res.end(path === '/' ? html : js);
    }
    if (req.headers.authorization !== 'Bearer ' + token) return json({ error: '请从应用重新打开工具。' }, 403);
    const busy = () => sourceBusy || job?.state === 'running';
    const start = (message, run) => {
      const current = job = { state: 'running', message };
      const progress = (message, extra = {}) => Object.assign(current, { message }, extra);
      Promise.resolve().then(() => run(progress)).then(result => {
        Object.assign(current, result, { state: 'done' });
      }).catch(error => Object.assign(current, { state: 'error', message: error.message }));
      return json(current, 202);
    };
    try {
      if (req.method === 'GET' && path === '/status') return json({ job, source, connected: link.connected() });
      if (req.method === 'GET' && path === '/link/address') {
        return json({ address: link.address(host), connected: link.connected() });
      }
      if (req.method === 'PUT' && path === '/source') {
        if (busy()) return json({ error: '正在处理任务。' }, 409);
        const name = basename(url.searchParams.get('name') || '');
        const ext = extname(name).toLowerCase();
        if (!allowedExtensions.has(ext)) return json({ error: '请选择 WAV、MP3、M4A、AIFF、FLAC、AAC、OGG 或 OPUS。' }, 400);
        const size = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(size) || size < 1 || size > maxSource) {
          return json({ error: '音频文件需小于 512 MB。' }, 413);
        }
        sourceBusy = true;
        const input = join(work, randomBytes(12).toString('hex') + ext);
        let count = 0;
        const limit = new Transform({
          transform(chunk, encoding, callback) {
            count += chunk.length;
            callback(count > maxSource ? new Error('文件过大。') : null, chunk);
          },
        });
        try {
          await pipeline(req, limit, createWriteStream(input, { mode: 0o600, flags: 'wx' }), { end: true });
          const duration = await durationOf(input);
          const title = cleanTitle(basename(name, extname(name)));
          const previous = source;
          source = { path: input, name: title, duration };
          if (previous) await rm(previous.path, { force: true });
          return json(source);
        } catch {
          await rm(input, { force: true });
          return json({ error: '无法读取这份音频，请换一个本地音频文件。' }, 400);
        } finally {
          sourceBusy = false;
        }
      }
      if (req.method === 'POST' && path === '/upload') {
        if (busy()) return json({ error: '正在处理任务。' }, 409);
        if (!source) return json({ error: '请先选一份音频。' }, 400);
        if (!link.connected()) return json({ error: '请先连接已登录的 Suno 标签页。' }, 409);
        segmentPlan(source.duration);
        const { name, path: input } = source;
        return start('正在检查登录状态', async progress => {
          await link.api('/api/session/');
          const dir = await mkdtemp(join(work, 'parts-'));
          try {
            const parts = await encodeParts(input, dir, name, progress);
            const result = await uploadToSuno(link.api, parts, name, progress);
            return { ...result, message: result.pending ? '任务已提交，请在 Suno 查看渲染结果。' : '整首渲染完成。' };
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        });
      }
      if (req.method === 'POST' && path === '/download') {
        if (busy()) return json({ error: '正在处理任务。' }, 409);
        const link = parseSongLink(url.searchParams.get('song'));
        const format = url.searchParams.get('format');
        if (!Object.hasOwn(mime, format)) return json({ error: '请选择 MP3 或 WAV。' }, 400);
        return start('正在读取作品音源', async progress => {
          const audio = await readSong(link.url);
          const input = join(work, 'stream.' + audio.extension);
          const output = join(work, 'download.' + format);
          const filename = cleanTitle('Suno-' + audio.id) + '.' + format;
          await writeFile(input, audio.bytes, { mode: 0o600 });
          try {
            if (audio.extension !== format) {
              progress('正在转换为 ' + format.toUpperCase());
              await transcode(input, output, format);
            } else {
              await writeFile(output, audio.bytes, { mode: 0o600 });
            }
          } finally {
            await rm(input, { force: true });
          }
          return { message: '音频已准备好，点击保存。', filename, format };
        });
      }
      if (req.method === 'GET' && path === '/file' && job?.state === 'done' && job.filename) {
        const path = join(work, 'download.' + job.format);
        const info = await stat(path);
        res.writeHead(200, { 'Content-Type': mime[job.format], 'Content-Length': info.size });
        return await pipeline(createReadStream(path), res);
      }
      if (req.method === 'POST' && path === '/quit') {
        if (busy()) return json({ error: '任务正在运行，请等它结束。' }, 409);
        json({ ok: true });
        server.close();
        return;
      }
      return json({ error: '页面不存在。' }, 404);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json({ error: error.message }, 400);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  host = `127.0.0.1:${server.address().port}`;
  const url = `http://${host}/#${token}`;
  server.once('close', () => rm(work, { recursive: true, force: true }).catch(() => {}));
  if (open) {
    const report = error => { if (error) console.error('无法打开界面。'); };
    if (process.platform === 'win32') {
      execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`],
        { windowsHide: true, windowsVerbatimArguments: true }, report);
    } else {
      execFile('/usr/bin/open', [url], report);
    }
  }
  return { server, url };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { server } = await startApp({ open: !process.argv.includes('--no-open') });
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}
