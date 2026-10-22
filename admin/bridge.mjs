import http from 'node:http';
import { CloudError } from '../cloud/accounts.mjs';
import { ReviewPackages } from './review-packages.mjs';
import { extensionDigest } from '../cloud/extension-review.mjs';
import path from 'node:path';
import { bytes, filename, jsonBody, reason, send, uuid } from './common.mjs';

export function createAdminClient({ port = 4324 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid private administration port');
  return async (route, { token, method = 'GET', body, filename: name, source } = {}) => {
    if (!/^\/[a-z0-9/?=&%.,_+~-]*$/i.test(route)) throw new CloudError(400, '管理接口路径无效');
    const response = await fetch(`http://127.0.0.1:${port}/internal/admin${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { Cookie: 'qfh_session=' + token, 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...(name ? { 'X-QuizForge-Filename': encodeURIComponent(name) } : {}), ...(source ? { 'X-QFH-Source': encodeURIComponent(JSON.stringify(source)) } : {}) },
      ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new CloudError(response.status, data.error || '云端管理请求未完成');
    return data;
  };
}

export function createPracticeAdminBridge({ library, authenticate, hubPort = 4318, onAdminError, reviews: suppliedReviews }) {
  if (!library) throw new Error('Practice administration requires the pinned library runtime');
  const { db, accounts } = library, reviews = suppliedReviews || new ReviewPackages(library);
  const sync = user => {
    if (!uuid(user?.id) || typeof user.name !== 'string' || typeof user.email !== 'string' || ![0, 1].includes(user.admin)) throw new CloudError(503, 'Hub 用户信息无效');
    db.prepare("INSERT INTO users(id,email,name,password,admin,created) VALUES (?,?,?,'!external-auth',?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,admin=excluded.admin").run(user.id, user.email, user.name, user.admin, new Date().toISOString());
    return user;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.headers.host !== `127.0.0.1:${server.address().port}`) throw new CloudError(403, '仅允许服务内部访问');
      const token = /^qfh_session=([a-f0-9]{64})$/.exec(req.headers.cookie || '')?.[1];
      const identity = token && await authenticate(token);
      if (!identity?.admin) throw new CloudError(identity ? 403 : 401, '仅管理员可访问');
      const actor = sync(identity), url = new URL(req.url, 'http://localhost'), route = url.pathname.replace(/^\/internal\/admin/, '');
      if (!url.pathname.startsWith('/internal/admin/')) throw new CloudError(404, '管理接口不存在');
      const target = async id => {
        if (!uuid(id)) throw new CloudError(400, '用户编号无效');
        const response = await fetch(`http://127.0.0.1:${hubPort}/api/admin/users/${id}/profile`, { headers: { Cookie: 'qfh_session=' + token }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new CloudError(response.status, '无法核实接收用户');
        const { user } = await response.json(); return sync(user);
      };
      let value, status = 200;
      if (route === '/summary' && req.method === 'GET') {
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        value = { site: accounts.siteStatus(), defaults: accounts.defaults(), imports: db.prepare("SELECT COALESCE(SUM(json_array_length(catalog,'$.banks')),0) AS n FROM cloud_imports WHERE status='ready'").get().n, pendingExtensions: db.prepare("SELECT COUNT(*) AS n FROM extension_submissions WHERE status='pending'").get().n, reviewStorageBytes: db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM extension_submissions').get().n, transfers: db.prepare('SELECT requests,bytes FROM activity_transfers WHERE day=?').get(day) || { requests: 0, bytes: 0 } };
      }
      else if (route === '/accounts' && req.method === 'GET') {
        const ids = (url.searchParams.get('ids') || '').split(','); if (ids.length > 50 || ids.some(id => !uuid(id))) throw new CloudError(400, '用户列表无效');
        value = { accounts: Object.fromEntries(ids.map(id => [id, db.prepare('SELECT 1 FROM users WHERE id=?').get(id) ? accounts.status(id) : null])), defaults: accounts.defaults() };
      } else if (route === '/audit' && req.method === 'GET') value = { entries: accounts.audits(actor.id) };
      else if (route === '/defaults' && req.method === 'PUT') { const input = await jsonBody(req); const limits = { ...accounts.defaults(), storageBytes: input.storageBytes, dailyTrafficBytes: input.dailyTrafficBytes }; value = { defaults: accounts.updateDefaults(actor.id, limits, input.reason) }; }
      else if (/^\/users\/[a-f0-9-]+\/(limits|import)$/.test(route)) {
        const [, , id, action] = route.split('/'); await target(id);
        if (action === 'limits' && req.method === 'PUT') { const input = await jsonBody(req); value = accounts.updateLimits(actor.id, id, { storageBytes: input.storageBytes, dailyTrafficBytes: input.dailyTrafficBytes, monthlyTrafficBytes: null }, input.reason); }
        else if (action === 'import' && req.method === 'POST') {
          const name = filename(req); if (!/\.qbank$/i.test(name)) throw new CloudError(415, '请上传格式 3 的 .qbank');
          value = { item: await library.install(id, actor.id, await bytes(req), name, { kind: 'admin-delivery' }) }; status = 201;
        } else throw new CloudError(405, '请求方法不支持');
      } else if (route === '/submissions' && req.method === 'GET') value = { items: reviews.list() };
      else if (route === '/submissions' && req.method === 'POST') {
        let source; try { source = JSON.parse(decodeURIComponent(req.headers['x-qfh-source'] || encodeURIComponent('{"kind":"preaudit"}'))); } catch { throw new CloudError(400, '审核来源无效'); }
        if (!['preaudit', 'public'].includes(source.kind)) throw new CloudError(400, '审核来源无效');
        value = { item: await reviews.receive(actor, req, filename(req), source) }; status = 201;
      } else if (/^\/submissions\/[a-f0-9-]+(?:\/(file|decision))?$/.test(route)) {
        const [, , id, action] = route.split('/');
        if (!action && req.method === 'GET') value = { item: reviews.info(reviews.row(id)) };
        else if (action === 'file' && req.method === 'GET') value = reviews.file(id, url.searchParams.get('extension'), url.searchParams.get('path'), url.searchParams.get('download') === '1');
        else if (action === 'decision' && req.method === 'POST') value = { item: reviews.decide(actor, id, await jsonBody(req)) };
        else throw new CloudError(405, '请求方法不支持');
      } else if (route === '/extensions' && req.method === 'GET') {
        value = { entries: library.reviews.list().map(e => ({ ...e, name: db.prepare('SELECT name FROM extension_review_names WHERE digest=?').get(e.digest)?.name || e.extensionId })) };
      } else if (route === '/extensions/affected' && req.method === 'GET') {
        const digest = url.searchParams.get('digest'), page = Math.max(1, Math.min(100000, Math.trunc(Number(url.searchParams.get('page')) || 1)));
        if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new CloudError(400, '拓展摘要无效');
        const rows = db.prepare("SELECT c.id,c.user_id,c.title,u.name,u.email FROM cloud_imports c JOIN users u ON u.id=c.user_id WHERE c.status='ready' ORDER BY c.created DESC,c.id LIMIT 50 OFFSET ?").all((page - 1) * 50);
        const items = [], errors = [];
        for (const row of rows) {
          try { if (library.runtime.scanExtensions(path.join(library.location(row.user_id, row.id), 'extensions')).some(directory => extensionDigest(directory).digest === digest)) items.push(row); }
          catch { errors.push({ id: row.id, title: row.title }); }
        }
        value = { items, errors, page, checked: rows.length, total: db.prepare("SELECT COUNT(*) AS n FROM cloud_imports WHERE status='ready'").get().n };
      } else if (route === '/extensions/revoke' && req.method === 'POST') {
        const input = await jsonBody(req), note = reason(input.reason); library.reviews.revoke(actor.id, input.digest, note);
        accounts.audit(actor.id, null, 'extension-revoked', { digest: input.digest }, { status: 'revoked' }, note); value = { ok: true };
      } else throw new CloudError(404, '管理接口不存在');
      send(res, status, value);
    } catch (error) { req.resume(); if (error instanceof CloudError) send(res, error.status, { error: error.message }); else { onAdminError?.(error); send(res, 503, { error: '云端管理服务暂时无法处理请求，请稍后重试' }); } }
  });
  server.requestTimeout = 180000; server.headersTimeout = 10000;
  return { server, reviews };
}
