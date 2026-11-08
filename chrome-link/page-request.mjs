export async function pageRequest(path, method, body) {
  const route = String(path).split('?')[0];
  const id = '[a-z0-9_-]{6,128}';
  const allowed = method === 'GET'
    ? new RegExp('^/api/(session/|uploads/audio/' + id + '/|clip/' + id + ')$', 'i')
    : method === 'POST'
      ? new RegExp('^/api/(uploads/audio/(' + id + '/(upload-finish|initialize-clip)/)?|studio/(create-project|save-project|render-state))$', 'i')
      : null;
  if (!allowed?.test(route)) return { error: 'invalid-route' };
  if (location.protocol !== 'https:' || !['suno.com', 'www.suno.com'].includes(location.host)) {
    return { error: 'wrong-page' };
  }
  let token;
  try {
    token = await Promise.race([window.Clerk?.session?.getToken(),
      new Promise(resolve => setTimeout(resolve, 5000))]);
  } catch {}
  if (!token) {
    const candidates = document.cookie.split(';').map(x => x.trim())
      .filter(x => x.startsWith('__session=')).map(x => x.slice('__session='.length));
    token = candidates.find(candidate => {
      try {
        const claims = JSON.parse(atob(decodeURIComponent(candidate).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return claims.exp > Date.now() / 1000;
      } catch { return false; }
    });
    if (token) token = decodeURIComponent(token);
  }
  if (!token) return { error: 'login' };
  try {
    const result = await fetch('https://studio-api-prod.suno.com' + path, {
      method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json',
        'device-id': (localStorage.getItem('ajs_anonymous_id') || '').replace(/"/g, '') ||
          (window.sunoLocalDeviceId ||= crypto.randomUUID()),
        'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(25_000),
    });
    const raw = route === '/api/session/' ? null : await result.json().catch(() => null);
    const data = raw && {
      id: raw.id, clip_id: raw.clip_id, clipId: raw.clipId, suno_clip_id: raw.suno_clip_id,
      status: raw.status, clip: raw.clip && { id: raw.clip.id, status: raw.clip.status },
      clips: Array.isArray(raw.clips) ? raw.clips.slice(0, 1).map(clip => ({ id: clip.id })) : undefined,
      ...(route === '/api/uploads/audio/' && method === 'POST' ? { url: raw.url, fields: raw.fields } : {}),
    };
    return { status: result.status, data };
  } catch {
    return { error: 'network' };
  }
}
