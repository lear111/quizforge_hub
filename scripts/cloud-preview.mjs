// Isolated synthetic preview behind SSH forwarding. This entry never reads the
// production mail configuration or database and is never used by server.mjs.
import http from 'node:http';
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { createApp } from '../server.mjs';

if (process.env.PREVIEW_SYNTHETIC_DATA !== '1' || !process.env.DATA_DIR) throw new Error('Explicit isolated preview configuration required');
const requested = path.resolve(process.env.DATA_DIR);
if (path.basename(requested) !== 'quizforge-hub-cloud-test') throw new Error('Preview data directory must be named quizforge-hub-cloud-test');
await mkdir(requested, { recursive: true });
const dataDir = await realpath(requested);
if (path.basename(dataDir) !== 'quizforge-hub-cloud-test') throw new Error('Preview data directory cannot redirect to another directory');
const port = Number(process.env.PREVIEW_PORT || 4320);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
const origin = new URL(process.env.PREVIEW_ORIGIN || 'http://localhost:4321');
if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Preview must be accessed through a local SSH tunnel');
const { server: backend } = await createApp({ dataDir, cloudEnabled: true, cloudRuntimeDir: process.env.CLOUD_RUNTIME_DIR, downloadNotice: false, secureCookies: false, cookieName: 'qfh_cloud_test_session', publicOrigin: origin.origin,
  mailProvider: { ready: false }, monthlyBudgetBytes: 64 * 1024 ** 2,
  cloud: { siteStorageBytes: 1024 ** 3, defaults: { storageBytes: 256 * 1024 ** 2, dailyTrafficBytes: 32 * 1024 ** 2, monthlyTrafficBytes: 64 * 1024 ** 2 } },
});
await new Promise((resolve, reject) => { backend.once('error', reject); backend.listen(0, '127.0.0.1', resolve); });
const backendOrigin = `http://127.0.0.1:${backend.address().port}`;
const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'));
const cookies = {};
try {
  for (const [role, name, admin] of [['admin', '演示管理员', 1], ['reader', '演示普通用户', 0]]) {
    const email = `cloud-preview-${role}@example.test`, password = randomBytes(32).toString('hex'), salt = randomBytes(16).toString('hex');
    const digest = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
    db.prepare('INSERT INTO users(id,email,name,password,admin,created) VALUES (?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET password=excluded.password,admin=excluded.admin').run(randomUUID(), email, name, digest, admin, new Date().toISOString());
    const response = await fetch(backendOrigin + '/api/auth/login', { method: 'POST', headers: { Origin: origin.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (!response.ok) throw new Error('Cannot initialize synthetic preview account');
    cookies[role] = response.headers.get('set-cookie').split(';')[0]; await response.body?.cancel();
  }
} catch (error) { await new Promise(resolve => backend.close(resolve)); throw error; }
finally { db.close(); }

const banner = '<aside class="cloud-preview-banner"><strong>隔离测试环境 · 仅含合成数据</strong><span> 当前为演示账户，请勿填写真实 API Key 或上传个人资料。</span><button type="button" data-preview-role="admin">演示管理员</button><button type="button" data-preview-role="reader">演示普通用户</button></aside>';
const previewScript = "document.addEventListener('click',async event=>{const button=event.target.closest('[data-preview-role]');if(!button)return;button.disabled=true;const response=await fetch('/__preview/identity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:button.dataset.previewRole})});if(response.ok)location.reload();else button.disabled=false;});";
const preview = http.createServer({ maxHeaderSize: 16384, requestTimeout: 45000 }, async (req, res) => {
  try {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { res.writeHead(403).end(); return; }
    if (!req.url.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400).end(); return; }
    res.setHeader('X-QuizForge-Preview', 'isolated-synthetic-data');
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin.origin) { res.writeHead(403).end('Preview origin rejected'); req.resume(); return; }
    if (req.url === '/__preview.js' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(previewScript); return; }
    if (req.url === '/__preview/identity' && req.method === 'POST') {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 100) { res.writeHead(413).end(); return; } }
      let role; try { role = JSON.parse(text).role; } catch { res.writeHead(400).end(); return; }
      if (!Object.hasOwn(cookies, role)) { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `qfh_preview_role=${role}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600` }).end('{"ok":true}'); return;
    }
    if (req.url.startsWith('/api/auth/')) { res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: '隔离预览使用演示账户，请通过顶部按钮切换身份' })); req.resume(); return; }
    const role = /(?:^|;\s*)qfh_preview_role=reader(?:;|$)/.test(req.headers.cookie || '') ? 'reader' : 'admin';
    const headers = { Cookie: cookies[role] };
    for (const field of ['origin', 'content-type', 'content-length']) if (req.headers[field]) headers[field] = req.headers[field];
    await new Promise((resolve, reject) => {
      const upstream = http.request({ hostname: '127.0.0.1', port: backend.address().port, method: req.method, path: req.url, headers, timeout: 45000 }, incoming => {
        const forwarded = { ...incoming.headers }; delete forwarded['set-cookie']; delete forwarded['content-length']; delete forwarded['transfer-encoding']; delete forwarded['cache-control'];
        if (String(incoming.headers['content-type']).startsWith('text/html') && req.method !== 'HEAD') {
          let html = ''; incoming.setEncoding('utf8');
          incoming.on('data', chunk => { html += chunk; if (html.length > 2 * 1024 ** 2) upstream.destroy(new Error('Preview page too large')); });
          incoming.once('end', () => { res.writeHead(incoming.statusCode, forwarded).end(html.replace('</head>', '<script type="module" src="/__preview.js"></script><link rel="stylesheet" href="/cloud/cloud.css"></head>').replace('<body>', '<body>' + banner)); resolve(); });
          incoming.once('error', reject);
        } else { res.writeHead(incoming.statusCode, forwarded); pipeline(incoming, res).then(resolve, reject); }
      });
      upstream.once('error', reject); upstream.once('timeout', () => upstream.destroy(new Error('Preview upstream timeout')));
      req.once('aborted', () => upstream.destroy()); req.pipe(upstream);
    });
  } catch { if (res.headersSent) res.destroy(); else res.writeHead(502).end('Preview request unavailable'); }
});
await new Promise((resolve, reject) => { preview.once('error', reject); preview.listen(port, '127.0.0.1', resolve); });
console.log(`Isolated cloud preview ready on loopback port ${port}; access through ${origin.origin}/cloud/`);
let stopping;
const stop = () => stopping ??= Promise.all([preview, backend].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop().then(() => process.exit(0)));
