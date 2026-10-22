import http from 'node:http';
import { pipeline } from 'node:stream/promises';

const prefix = '/cloud-test';
const publicOrigin = 'https://quizforge.treenewbee.cloud';
const previewOrigin = 'http://localhost:4321';
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

// API strings must retain their original meaning: the practice adapter adds its
// own bank prefix before this browser wrapper adds the public mount prefix.
export const bootstrap = `(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, location.href);
    if (url.origin === location.origin && !url.pathname.startsWith('${prefix}/') && /^(?:\\/api\\/|\\/__preview\\/)/.test(url.pathname)) {
      url.pathname = '${prefix}' + url.pathname;
      input = input instanceof Request ? new Request(url, input) : url.href;
    }
    return original(input, options);
  };
})();`;

export function rewritePreview(text, contentType) {
  // Only executable/static responses are transformed; API JSON and bank files
  // are never rewritten. Empty '/' strings and API request paths stay intact.
  text = text.replace(/\b(href|src|action|data-image)=(['"])\/(?!\/|cloud-test(?:\/|\2))/g, `$1=$2${prefix}/`);
  if (/javascript/.test(contentType)) {
    text = text.replace(/(['"`])\/(cloud(?:\/|(?=['"`]))|manage\/|media\/|__preview(?:[./]))/g, `$1${prefix}/$2`);
    text = text.replace(/(\.href\s*=\s*['"`])\/api\//g, `$1${prefix}/api/`);
  }
  if (/text\/css/.test(contentType)) text = text.replace(/url\((['"]?)\/(?!\/|cloud-test\/)/g, `url($1${prefix}/`);
  if (/text\/html/.test(contentType)) text = text.replace(/<head>/i, `<head><script src="${prefix}/__gateway.js"></script>`);
  return text;
}

function denied(req, res, status, message) {
  req.resume();
  const json = req.url.startsWith(`${prefix}/api/`) || req.url.startsWith(`${prefix}/__preview/`);
  res.writeHead(status, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8' });
  res.end(json ? JSON.stringify({ error: message }) : `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QuizForge Hub · 云端测试</title><h1>QuizForge Hub 云端测试</h1><p>${message}</p><p>此测试环境仅向 Hub 管理员开放，使用独立的演示账户和测试数据。</p><p><a href="${publicOrigin}/manage/#library">先登录 Hub 管理员账户</a></p><p><a href="${prefix}/cloud/">登录后进入云端测试</a></p></html>`);
}

export function createPublicPreview({ authPort = 4318, upstreamPort = 4320 } = {}) {
  let active = 0;
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 135000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!loopback(req.socket.remoteAddress) || req.headers.host !== new URL(publicOrigin).host) return denied(req, res, 403, '访问地址无效');
    if (!req.url.startsWith(`${prefix}/`) && req.url !== prefix) return denied(req, res, 404, '页面不存在');
    if (active >= 16) return denied(req, res, 503, '测试环境繁忙，请稍后重试');
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return denied(req, res, 405, '请求方法不支持');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== publicOrigin) return denied(req, res, 403, '请求来源无效');
    const localPath = req.url.slice(prefix.length) || '/';
    let normalized;
    try { normalized = new URL(localPath, 'http://localhost'); } catch { return denied(req, res, 400, '请求地址无效'); }
    if (localPath.startsWith('//') || normalized.origin !== 'http://localhost' || normalized.pathname !== localPath.split('?')[0]) return denied(req, res, 400, '请求地址无效');
    active++;
    try {
      const sessions = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith('qfh_session='));
      if (sessions.length !== 1 || !/^qfh_session=[A-Za-z0-9_-]{16,256}$/.test(sessions[0])) return denied(req, res, 401, '请先在 Hub 登录管理员账户，然后返回此页。');
      // Read-only existing production authentication, checked on every request.
      // Never copy the production session into the synthetic preview backend.
      const identity = await fetch(`http://127.0.0.1:${authPort}/api/me`, {
        headers: { Cookie: sessions[0] }, redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!identity.ok || identity.headers.get('content-length') > 32768) throw new Error('Authentication unavailable');
      const account = await identity.json();
      if (!account.user) return denied(req, res, 401, '登录已失效，请重新登录 Hub。');
      if (account.user.admin !== 1) return denied(req, res, 403, '当前账户没有测试管理员权限。');
      if (localPath === '/') { req.resume(); res.writeHead(302, { Location: `${prefix}/cloud/` }).end(); return; }
      if (localPath === '/__gateway.js' && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(req.method === 'HEAD' ? '' : bootstrap); return;
      }
      const headers = { Host: 'localhost:4321' };
      for (const field of ['content-type', 'content-length', 'accept', 'x-quizforge-practice-session', 'x-quizforge-question-stamp', 'x-quizforge-transient-resource', 'x-quizforge-token']) if (req.headers[field]) headers[field] = req.headers[field];
      if (req.headers.origin) headers.Origin = previewOrigin;
      if (/(?:^|;\s*)qfh_preview_role=reader(?:;|$)/.test(req.headers.cookie || '')) headers.Cookie = 'qfh_preview_role=reader';
      await new Promise((resolve, reject) => {
        const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: localPath, method: req.method, headers, timeout: 135000 }, incoming => {
          const forwarded = { ...incoming.headers };
          for (const field of ['content-length', 'transfer-encoding', 'connection', 'cache-control', 'set-cookie']) delete forwarded[field];
          if (incoming.headers['set-cookie']) forwarded['set-cookie'] = incoming.headers['set-cookie'].filter(cookie => cookie.startsWith('qfh_preview_role=')).map(cookie => cookie.replace(/Path=\//i, `Path=${prefix}/`) + '; Secure');
          if (forwarded.location?.startsWith('/') && !forwarded.location.startsWith('//')) forwarded.location = prefix + forwarded.location;
          else if (forwarded.location) { incoming.destroy(); reject(new Error('Unexpected redirect')); return; }
          const type = String(incoming.headers['content-type'] || '');
          if (/(?:text\/html|javascript|text\/css)/.test(type) && req.method !== 'HEAD') {
            if (incoming.headers['content-encoding']) { incoming.destroy(); reject(new Error('Unexpected encoded response')); return; }
            let text = ''; incoming.setEncoding('utf8');
            incoming.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 8 * 1024 ** 2) incoming.destroy(new Error('Response too large')); });
            incoming.once('error', reject);
            incoming.once('end', () => { res.writeHead(incoming.statusCode, forwarded).end(rewritePreview(text, type)); resolve(); });
          } else { res.writeHead(incoming.statusCode, forwarded); pipeline(incoming, res).then(resolve, reject); }
        });
        upstream.once('error', reject); upstream.once('timeout', () => upstream.destroy(new Error('Upstream timeout')));
        req.once('aborted', () => upstream.destroy()); req.pipe(upstream);
      });
    } catch {
      if (res.headersSent) res.destroy(); else denied(req, res, 502, '测试服务暂时不可用，请稍后重试');
    } finally { active--; }
  });
  return server;
}
