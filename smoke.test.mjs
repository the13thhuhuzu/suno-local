import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { durationOf, encodeParts, segmentPlan } from './audio.mjs';
import { startApp } from './app.mjs';
import { downloadSong, parseSongLink, uploadToSuno } from './suno.mjs';
import { pageRequest } from './chrome-link/page-request.mjs';

test('local audio through multipart upload and Studio render contract', async () => {
  const work = await mkdtemp(join(tmpdir(), 'suno-local-smoke-'));
  try {
    const source = join(work, 'source.wav');
    await promisify(execFile)('/opt/homebrew/bin/ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i',
      'aevalsrc=0.15*sin(2*PI*(240*t+15*t*t)):s=44100:d=12', source,
    ]);
    assert.throws(() => segmentPlan(721), /12 分钟/);
    const parts = await encodeParts(source, work, 'demo', () => {});
    assert.equal(parts.length, 6);
    const readBand = async file => {
      const { stdout } = await promisify(execFile)('/opt/homebrew/bin/ffmpeg', [
        '-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-t', '1',
        '-f', 's16le', 'pipe:1',
      ], { encoding: 'buffer' });
      let crossings = 0;
      for (let i = 2; i < stdout.length; i += 2) {
        if (stdout.readInt16LE(i - 2) <= 0 && stdout.readInt16LE(i) > 0) crossings++;
      }
      return crossings;
    };
    const frequencies = [];
    for (const part of parts) {
      assert.equal(part.start, part.index * 2);
      assert.ok(Math.abs(await durationOf(part.path) - 8) < 0.1);
      frequencies.push(await readBand(part.path));
    }
    frequencies.forEach((hz, i) => assert.ok(Math.abs(hz - (61 + i * 15)) < 5, frequencies));
    let upload = 0;
    let projectCreated = false;
    let renderBody;
    const api = async (path, method, body) => {
      if (path === '/api/session/') return { ok: true };
      if (path === '/api/uploads/audio/') {
        assert.equal(projectCreated, true);
        return { id: 'upload-' + ++upload, url: 'https://bucket.s3.amazonaws.com/', fields: { policy: 'mock' } };
      }
      if (path.endsWith('/upload-finish/')) {
        assert.equal(body.upload_type, 'file_upload');
        return {};
      }
      if (path.endsWith('/initialize-clip/')) return { clip_id: 'clip-0' + upload };
      if (path.startsWith('/api/uploads/audio/')) return { status: 'complete' };
      if (path.startsWith('/api/studio/create-project?')) {
        projectCreated = true;
        return { id: 'project-01' };
      }
      if (path === '/api/studio/save-project') {
        assert.equal(body.project_id, 'project-01');
        assert.deepEqual(body.state.tracks.map(track => track.clips.length), [3, 3]);
        return {};
      }
      if (path === '/api/studio/render-state') {
        renderBody = body;
        return { clips: [{ id: 'render-01' }] };
      }
      if (path === '/api/clip/render-01') return { status: 'complete' };
      assert.fail(`Unexpected request ${method} ${path}`);
    };
    const post = async (url, options) => {
      assert.equal(url.hostname, 'bucket.s3.amazonaws.com');
      assert.equal(options.body.get('policy'), 'mock');
      assert.ok(options.body.get('file').size > 1000);
      return new Response(null, { status: 204 });
    };
    await assert.rejects(uploadToSuno(async path => {
      assert.match(path, /^\/api\/studio\/create-project\?/);
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }, parts, 'demo', () => {}, () => assert.fail('Audio transferred without Studio permission')), /Studio 权限/);
    const result = await uploadToSuno(api, parts, 'demo', () => {}, post);
    assert.equal(upload, 6);
    assert.equal(result.songUrl, 'https://suno.com/song/render-01');
    assert.ok(Math.abs(renderBody.end_beats - 23.7) < 0.001);
    const clips = renderBody.state.tracks.flatMap(track => track.clips);
    assert.ok(clips.every(clip => clip.transposition === 24 && clip.warp.enabled === false));
    assert.equal(clips.filter(clip => clip.fadeInBeats === 0.06).length, 5);

    const plaintext = await readFile(parts[0].path);
    const key = randomBytes(16), iv = randomBytes(16), id = 'render-01', glt = 'fixture-guest-token';
    const wrapping = createHash('sha256').update(glt).digest();
    const wrap = bytes => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', wrapping, nonce);
      cipher.setAAD(Buffer.from(id));
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString('base64url');
    };
    const cipher = createCipheriv('aes-128-ctr', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const get = async (url, options) => {
      if (url.includes('cloudfront')) return new Response(encrypted);
      if (url.endsWith('/api/mango/rights')) {
        assert.equal(options.method, 'POST');
        assert.equal(JSON.parse(options.body).content_params.content_id, id);
        return Response.json({ glt, key: wrap(key), iv: wrap(iv) });
      }
      assert.fail('Unexpected media host.');
    };
    assert.throws(() => parseSongLink('https://suno.com.evil.test/song/render-01'));
    const downloaded = await downloadSong('https://suno.com/song/render-01', get);
    assert.deepEqual(downloaded.bytes, plaintext);

    const { server, url } = await startApp({ open: false, readSong: link => downloadSong(link, get) });
    try {
      const origin = new URL(url).origin;
      const headers = { Authorization: 'Bearer ' + new URL(url).hash.slice(1) };
      assert.equal((await fetch(origin + '/status')).status, 403);
      assert.equal((await fetch(origin + '/status', { headers: { ...headers, Origin: 'https://other.test' } })).status, 403);
      assert.match(await (await fetch(origin)).text(), /Suno Local/);
      const loaded = await fetch(origin + '/source?name=demo.wav', {
        method: 'PUT', headers, body: await readFile(source),
      });
      assert.equal(loaded.status, 200, await loaded.clone().text());
      assert.equal((await loaded.json()).duration, 12);
      assert.deepEqual(await pageRequest('/api/account/', 'GET'), { error: 'invalid-route' });
      assert.equal((await fetch(origin + '/upload', { method: 'POST', headers })).status, 409);
      const address = (await (await fetch(origin + '/link/address', { headers })).json()).address;
      const peer = {
        Authorization: 'Bearer ' + new URL(address).hash.slice(6),
        Origin: 'chrome-extension://' + 'a'.repeat(32),
        'X-Suno-Link-Client': 'a'.repeat(32),
        'X-Suno-Link-Nonce': randomUUID(),
      };
      const pull = (auth = peer) => fetch(origin + '/link/pull', { headers: auth });
      assert.equal((await pull(headers)).status, 403);
      assert.equal(await (await pull()).json(), null);
      assert.equal((await pull({ ...peer, 'X-Suno-Link-Nonce': randomUUID() })).status, 409);
      assert.equal((await fetch(origin + '/upload', { method: 'POST', headers })).status, 202);
      const task = await (await pull()).json();
      assert.equal(task.path, '/api/session/');
      assert.equal(await (await pull()).json(), null);
      const reply = await fetch(origin + '/link/result', { method: 'POST', headers: peer,
        body: JSON.stringify({ id: task.id, response: { status: 401 } }) });
      assert.equal(reply.status, 200);
      assert.match((await (await fetch(origin + '/status', { headers })).json()).job.message, /登录未就绪/);
      const download = await fetch(origin + '/download?' + new URLSearchParams({
        song: 'https://suno.com/song/render-01', format: 'wav',
      }), { method: 'POST', headers });
      assert.equal(download.status, 202);
      let status;
      for (let attempt = 0; attempt < 50; attempt++) {
        status = (await (await fetch(origin + '/status', { headers })).json()).job;
        if (status.state !== 'running') break;
        await delay(100);
      }
      assert.equal(status.state, 'done', status.message);
      const result = await fetch(origin + '/file', { headers });
      assert.equal(result.headers.get('content-type'), 'audio/wav');
      assert.equal(Buffer.from(await result.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
