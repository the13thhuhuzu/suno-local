const $ = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('suno-local-token');
if (location.hash) {
  sessionStorage.setItem('suno-local-token', token);
  history.replaceState(null, '', '/');
}
let busy = false;
let sourceValid = false;
let latest = null;

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function setBusy(value) {
  busy = value;
  for (const id of ['login', 'source', 'download', 'quit']) $(id).disabled = value;
  $('upload').disabled = value || !sourceValid;
}
async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options, headers: { Authorization: 'Bearer ' + token },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || '本机工具连接失败。');
  }
  return response;
}
async function json(path, options) {
  return (await request(path, options)).json();
}
function sourceInfo(source) {
  sourceValid = Boolean(source && source.duration >= 9 && source.duration <= 720);
  if (!source) return;
  $('source-info').textContent = `${source.name} · ${source.duration.toFixed(1)} 秒` +
    (sourceValid ? ` · 6 段 × 约 ${(source.duration * 4 / 6).toFixed(1)} 秒上传音频` : ' · 不在分段模式范围内');
}
function showJob(job) {
  latest = job;
  if (!job) return;
  message(job.message, job.state === 'error');
  for (const [id, key] of [['project', 'projectUrl'], ['work', 'songUrl']]) {
    $(id).hidden = !job[key];
    if (job[key]) $(id).href = job[key];
  }
  $('save').hidden = !(job.state === 'done' && job.filename);
  $('result').hidden = $('project').hidden && $('work').hidden && $('save').hidden;
}
async function poll() {
  const status = await json('/status');
  sourceInfo(status.source);
  showJob(status.job);
  setBusy(status.job?.state === 'running');
  if (busy) setTimeout(() => poll().catch(error => { message(error.message, true); setBusy(false); }), 1000);
}
async function action(run) {
  if (busy) return;
  setBusy(true);
  try { await run(); } catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
async function start(path) {
  await action(async () => {
    showJob(await json(path, { method: 'POST' }));
  });
  if (latest?.state === 'running') {
    setBusy(true);
    await poll().catch(error => { message(error.message, true); setBusy(false); });
  }
}
$('login').onclick = () => action(async () => {
  const { address, connected } = await json('/link/address');
  $('pairing').hidden = false;
  $('link-address').value = address;
  $('link-address').focus();
  $('link-address').select();
  message(connected ? '已连接普通 Chrome 的 Suno 标签页。' : '复制本机地址，在已登录的 Suno 标签页打开 Suno Local Link。');
});
$('source').onchange = () => action(async () => {
  const file = $('source').files[0];
  if (!file) return;
  sourceValid = false;
  message('正在读取本地音频');
  sourceInfo(await json('/source?' + new URLSearchParams({ name: file.name }),
    { method: 'PUT', body: file }));
  message(sourceValid ? '本地音频已就绪。' : '可用官方上传处理这份音频。');
});
$('upload').onclick = () => start('/upload');
$('download').onclick = () => start('/download?' + new URLSearchParams({
  song: $('song').value.trim(), format: $('format').value,
}));
$('save').onclick = () => action(async () => {
  const url = URL.createObjectURL(await (await request('/file')).blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = latest.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});
$('quit').onclick = () => action(async () => {
  await json('/quit', { method: 'POST' });
  message('本机服务已关闭，可以关掉这个页面。');
});
if (token) poll().catch(error => message(error.message, true));
else { message('请从 macOS 应用启动。', true); setBusy(true); }
