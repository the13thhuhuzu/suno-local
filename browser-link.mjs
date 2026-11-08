import { randomBytes, randomUUID } from 'node:crypto';
import { checkedSunoResponse } from './suno.mjs';

export function browserLink() {
  const secret = randomBytes(32).toString('hex');
  let peer;
  let lastSeen = 0;
  let pending;
  const connected = () => Date.now() - lastSeen < 6000;

  return {
    connected,
    address: host => `http://${host}/#link-${secret}`,
    async api(path, method = 'GET', body) {
      if (!connected()) throw new Error('请在已登录的 Suno 标签页点 Suno Local Link，再连接工作台。');
      if (pending) throw new Error('已有一个 Suno 请求正在处理。');
      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending = undefined;
          reject(new Error('Suno 请求未返回。请检查标签页，确认任务是否已在 Suno 创建。'));
        }, 37_000);
        pending = {
          task: { id: randomUUID(), path, method, body },
          issued: false,
          resolve(value) {
            clearTimeout(timeout);
            pending = undefined;
            resolve(value);
          },
        };
      });
      return checkedSunoResponse(response);
    },
    async handle(req, res, path, json) {
      const origin = req.headers.origin;
      const client = req.headers['x-suno-link-client'];
      const nonce = req.headers['x-suno-link-nonce'];
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
        return json({ error: '来源不匹配。' }, 403);
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS' && origin) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Suno-Link-Client, X-Suno-Link-Nonce');
        res.writeHead(204);
        return res.end();
      }
      if (req.headers.authorization !== 'Bearer ' + secret || !/^[a-p]{32}$/.test(client || '') ||
          !/^[a-f0-9-]{36}$/.test(nonce || '') || (origin && origin !== 'chrome-extension://' + client)) {
        return json({ error: '连接地址无效。' }, 403);
      }
      const identity = client + '/' + nonce;
      if (peer && peer !== identity && (connected() || pending)) {
        return json({ error: '另一个 Suno 标签页已连接。' }, 409);
      }
      if (path === '/link/pull' && req.method === 'GET') {
        peer = identity;
        lastSeen = Date.now();
        if (!pending || pending.issued) return json(null);
        pending.issued = true;
        return json(pending.task);
      }
      if (path === '/link/result' && req.method === 'POST' && peer === identity) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 128 * 1024) return json({ error: '响应过大。' }, 413);
          chunks.push(chunk);
        }
        try {
          const result = JSON.parse(Buffer.concat(chunks, size));
          if (!pending?.issued || result.id !== pending.task.id || !result.response ||
              !(typeof result.response.status === 'number' || typeof result.response.error === 'string')) {
            return json({ error: '请求已结束或响应不匹配。' }, 409);
          }
          lastSeen = Date.now();
          pending.resolve(result.response);
          return json({ ok: true });
        } catch {
          return json({ error: '响应格式无效。' }, 400);
        }
      }
      return json({ error: '连接端点不存在。' }, 404);
    },
  };
}
