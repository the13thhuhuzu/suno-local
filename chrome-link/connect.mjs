import { pageRequest } from './page-request.mjs';

const $ = id => document.getElementById(id);
const tabId = Number(location.hash.slice(1));
let connection;
const status = message => { $('status').textContent = message; };

if (!Number.isInteger(tabId) || tabId < 1) {
  $('connect').disabled = true;
  status('请先切回已登录的 Suno 标签页，再点击工具栏里的 Suno Local Link 图标。');
}

$('connect').onclick = async () => {
  const text = $('address').value.trim();
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/#link-[a-f0-9]{64}$/.test(text)) {
    return status('请粘贴从工作台复制的完整本机连接地址。');
  }
  const url = new URL(text);
  const controller = connection = new AbortController();
  const headers = { Authorization: 'Bearer ' + url.hash.slice(6),
    'X-Suno-Link-Client': chrome.runtime.id, 'X-Suno-Link-Nonce': crypto.randomUUID(),
    'Content-Type': 'application/json' };
  async function local(path, options = {}) {
    const response = await fetch(url.origin + '/link/' + path, {
      ...options, headers, credentials: 'omit', redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) throw new Error('无法连接工作台，请重新复制连接地址。');
    return response.json();
  }
  try {
    $('connect').disabled = true;
    $('disconnect').disabled = false;
    $('address').value = '';
    const [{ result: proof }] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: pageRequest, args: ['/api/session/', 'GET'],
    });
    if (proof?.error || proof?.status !== 200) throw new Error('这个 Suno 标签页尚未通过会话检查。');
    while (!controller.signal.aborted) {
      const task = await local('pull');
      status('已连接。保持此页面打开，回到 Suno Local 开始上传。');
      if (task) {
        status('正在处理 Suno 请求。');
        let result;
        try {
          const args = [task.path, task.method];
          if (task.body !== undefined) args.push(task.body);
          [{ result }] = await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN', func: pageRequest, args,
          });
        } catch {
          result = { error: 'wrong-page' };
        }
        await local('result', { method: 'POST', body: JSON.stringify({ id: task.id, response: result }) });
      }
      await new Promise(resolve => setTimeout(resolve, 650));
    }
  } catch (error) {
    if (!controller.signal.aborted) status(error.message);
  } finally {
    if (connection === controller) connection = undefined;
    $('connect').disabled = false;
    $('disconnect').disabled = true;
  }
};

$('disconnect').onclick = () => {
  connection?.abort();
  status('已断开。');
};
