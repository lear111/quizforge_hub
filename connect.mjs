import { randomBytes, randomUUID, createHash } from 'node:crypto';

// Hub account connection for local Web and Android clients (docs/HUB_CONNECT_AI.md).
// Authorization code + PKCE (RFC 8252 / RFC 7636); device tokens only reach the
// device and official AI endpoints, never cookies or other Hub APIs.
const sha256 = value => createHash('sha256').update(value).digest();
const hex = value => sha256(value).toString('hex');
const PARAMS = ['v', 'client', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'device_name'];
const TOKEN = /^qfd_[A-Za-z0-9_-]{43}$/;
const DAY = 86400000, IDLE_LIMIT = 180 * DAY, CODE_TTL = 120000, REQUEST_TTL = 600000, MAX_DEVICES = 10;
// Device and AI endpoints answer {error:{code,message,...}} as the protocol defines.
export class ConnectError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; } }
const fail = (status, message, code = 'CONNECT_REQUEST_REJECTED', extra) => { throw new ConnectError(status, code, message, extra); };
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function allowedRedirect(client, uri) {
  if (client === 'android') return uri === 'quizforge://hub/connect';
  if (client !== 'web') return false;
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{3,4})\/hub\/connect\/callback$/.exec(uri);
  return !!match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535;
}
export function deviceName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return name && Array.from(name).length <= 40 ? name : null;
}
// Validates the authorize query. Each parameter appears exactly once and no others.
export function authorizeParams(searchParams) {
  const keys = [...searchParams.keys()];
  if (keys.length !== PARAMS.length || new Set(keys).size !== keys.length || keys.some(key => !PARAMS.includes(key))) return null;
  const value = Object.fromEntries(PARAMS.map(key => [key, searchParams.get(key)]));
  if (value.v !== '1' || !['web', 'android'].includes(value.client) || !allowedRedirect(value.client, value.redirect_uri)) return null;
  if (!/^[A-Za-z0-9._~-]{22,256}$/.test(value.state) || !/^[A-Za-z0-9_-]{43}$/.test(value.code_challenge) || value.code_challenge_method !== 'S256') return null;
  const name = deviceName(value.device_name);
  return name ? { client: value.client, redirectUri: value.redirect_uri, state: value.state, challenge: value.code_challenge, deviceName: name } : null;
}

export function createConnect({ db, enabled, identity, throttle, json, bodyJson, dailyLimit, modelLabel, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS connect_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, client TEXT NOT NULL, created TEXT NOT NULL, last_used INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS connect_devices_user ON connect_devices(user_id, revoked);
    CREATE TABLE IF NOT EXISTS connect_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, device_name TEXT NOT NULL, expires INTEGER NOT NULL);`);
  const pending = new Map();
  const sweep = () => {
    const time = now();
    for (const [key, entry] of pending) if (entry.expires <= time) pending.delete(key);
    db.prepare('DELETE FROM connect_codes WHERE expires<=?').run(time);
  };
  const blocked = userId => !!db.prepare('SELECT 1 FROM user_blocks WHERE user_id=?').get(userId);
  const redirect = (uri, query) => uri + '?' + new URLSearchParams(query).toString();

  // Device-token identity for /api/connect/me|logout and the AI gateway. Ignores cookies.
  function device(req) {
    const raw = /^Bearer (qfd_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    const error = () => fail(401, '设备登录已失效，请在 AI 设置中重新登录', 'DEVICE_TOKEN_INVALID');
    if (!raw || !TOKEN.test(raw)) error();
    const time = now();
    const row = db.prepare('SELECT d.*,u.name AS user_name FROM connect_devices d JOIN users u ON u.id=d.user_id WHERE d.token=? AND d.revoked=0').get(hex(raw));
    if (!row || row.last_used <= time - IDLE_LIMIT || blocked(row.user_id)) error();
    if (time - row.last_used > 60000) db.prepare('UPDATE connect_devices SET last_used=? WHERE id=?').run(time, row.id);
    return row;
  }
  const deviceDto = row => ({ id: row.id, name: row.name, client: row.client, created: row.created, ...(row.last_used ? { lastUsed: new Date(row.last_used).toISOString() } : {}) });

  function consentPage(request, entry, user) {
    const client = entry.client === 'web' ? '电脑上的 QuizForge' : 'Android 上的 QuizForge';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接设备 · QuizForge</title><link rel="icon" type="image/png" href="/quizforge-icon.png"><link rel="stylesheet" href="/styles.css"><script type="module" src="/connect.js"></script></head><body><main id="app" class="connect-page"><section class="panel connect-panel" data-request="${esc(request)}"><h1>允许这台设备使用官方 AI 评分？</h1><dl class="connect-facts"><dt>设备</dt><dd>${esc(entry.deviceName)}（${client}）</dd><dt>账号</dt><dd>${esc(user.name)}</dd><dt>权限</dt><dd>使用官方 AI 评分，次数计入你的账号额度（每天 ${dailyLimit} 次）。设备不能访问你的题库、评论或账号设置。</dd></dl><p class="connect-note">评分时，题目、答案和图片会经由 QuizForge 服务器发送给模型服务商（${esc(modelLabel)}），服务器不保存这些内容。你可以随时在“我的分享”页撤销这台设备。</p><div class="connect-actions"><button class="button" data-decision="allow">允许</button><button class="text-button" data-decision="deny">拒绝</button></div><p class="form-error" role="alert"></p></section></main></body></html>`;
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (!(path === '/connect/authorize' || path.startsWith('/api/connect/'))) return false;
    if (!enabled) fail(404, '官方 AI 暂未开放', 'OFFICIAL_AI_DISABLED');
    sweep();
    if (path === '/connect/authorize' && req.method === 'GET') {
      let key = url.searchParams.get('request'), entry = key && [...url.searchParams.keys()].length === 1 && /^[a-f0-9]{64}$/.test(key) ? pending.get(key) : null;
      if (!entry) {
        if (url.searchParams.has('request')) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end('<!doctype html><meta charset="utf-8"><title>请求已过期</title><p>连接请求已过期，请回到 QuizForge 重新点击“登录”。</p>'); return true; }
        const params = authorizeParams(url.searchParams);
        if (!params) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end('<!doctype html><meta charset="utf-8"><title>连接请求无效</title><p>连接请求无效，请回到 QuizForge 重新点击“登录”。</p>'); return true; }
        throttle(req, 'connect-authorize', 30);
        if (pending.size > 5000) fail(503, '服务繁忙，请稍后再试');
        key = randomBytes(32).toString('hex'); entry = { ...params, expires: now() + REQUEST_TTL }; pending.set(key, entry);
      }
      const user = identity(req);
      if (!user) { res.writeHead(303, { Location: '/manage/#connect-login/' + key, 'Cache-Control': 'no-store' }).end(); return true; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(consentPage(key, entry, user)); return true;
    }
    if (path === '/api/connect/authorize' && req.method === 'POST') {
      const user = identity(req) || fail(401, '请先登录');
      throttle(req, 'connect-decision', 20, user.id);
      const input = await bodyJson(req);
      const entry = typeof input.request === 'string' ? pending.get(input.request) : null;
      if (!entry) fail(410, '连接请求已过期，请回到 QuizForge 重新点击“登录”');
      if (!['allow', 'deny'].includes(input.decision)) fail(400, '请选择允许或拒绝');
      pending.delete(input.request);
      if (input.decision === 'deny') { json(res, 200, { redirect: redirect(entry.redirectUri, { error: 'access_denied', state: entry.state }) }); return true; }
      if (blocked(user.id)) fail(403, '账号已停用，无法连接设备');
      const code = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO connect_codes VALUES (?,?,?,?,?,?,?)').run(hex(code), user.id, entry.client, entry.redirectUri, entry.challenge, entry.deviceName, now() + CODE_TTL);
      json(res, 200, { redirect: redirect(entry.redirectUri, { code, state: entry.state }) }); return true;
    }
    if (path === '/api/connect/token' && req.method === 'POST') {
      throttle(req, 'connect-token', 20);
      const input = await bodyJson(req);
      const keys = Object.keys(input).sort().join(',');
      if (keys !== 'client,code,code_verifier,redirect_uri,v' || input.v !== 1) fail(400, '换取设备令牌的请求无效', 'INVALID_GRANT');
      const code = typeof input.code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.code) ? hex(input.code) : null;
      const grant = code && db.prepare('SELECT * FROM connect_codes WHERE code=?').get(code);
      if (grant) db.prepare('DELETE FROM connect_codes WHERE code=?').run(code);
      const verifier = typeof input.code_verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier) ? input.code_verifier : null;
      if (!grant || grant.expires <= now() || grant.client !== input.client || grant.redirect_uri !== input.redirect_uri || !verifier || sha256(verifier).toString('base64url') !== grant.challenge || blocked(grant.user_id)) fail(400, '授权已过期或无效，请重新登录', 'INVALID_GRANT');
      const token = 'qfd_' + randomBytes(32).toString('base64url'), id = randomUUID(), time = now(), created = new Date(time).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO connect_devices (id,user_id,token,name,client,created,last_used) VALUES (?,?,?,?,?,?,?)').run(id, grant.user_id, hex(token), grant.device_name, grant.client, created, time);
        const extra = db.prepare('SELECT id FROM connect_devices WHERE user_id=? AND revoked=0 ORDER BY last_used DESC, created DESC LIMIT -1 OFFSET ?').all(grant.user_id, MAX_DEVICES);
        for (const row of extra) db.prepare('UPDATE connect_devices SET revoked=1 WHERE id=?').run(row.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const user = db.prepare('SELECT name FROM users WHERE id=?').get(grant.user_id);
      json(res, 200, { token, device: { id, name: grant.device_name, client: grant.client, created }, user: { name: user.name } }); return true;
    }
    if (path === '/api/connect/me' && req.method === 'GET') {
      const row = device(req);
      json(res, 200, { user: { name: row.user_name }, device: deviceDto({ ...row, last_used: 0 }), ai: usage(row.user_id) }); return true;
    }
    if (path === '/api/connect/logout' && req.method === 'POST') {
      const row = device(req);
      db.prepare('UPDATE connect_devices SET revoked=1 WHERE id=?').run(row.id);
      res.writeHead(204, { 'Cache-Control': 'no-store' }).end(); return true;
    }
    if (path === '/api/connect/devices' && req.method === 'GET') {
      const user = identity(req) || fail(401, '请先登录');
      const rows = db.prepare('SELECT * FROM connect_devices WHERE user_id=? AND revoked=0 AND last_used>? ORDER BY last_used DESC').all(user.id, now() - IDLE_LIMIT);
      json(res, 200, { devices: rows.map(deviceDto) }); return true;
    }
    const match = /^\/api\/connect\/devices\/([a-f0-9-]{36})$/.exec(path);
    if (match && ['PUT', 'DELETE'].includes(req.method)) {
      const user = identity(req) || fail(401, '请先登录');
      throttle(req, 'connect-devices', 30, user.id);
      const row = db.prepare('SELECT * FROM connect_devices WHERE id=? AND user_id=? AND revoked=0').get(match[1], user.id) || fail(404, '设备不存在或已撤销');
      if (req.method === 'DELETE') { db.prepare('UPDATE connect_devices SET revoked=1 WHERE id=?').run(row.id); json(res, 200, { ok: true }); return true; }
      const name = deviceName((await bodyJson(req)).name) || fail(400, '设备名称请填写 1–40 个字符');
      db.prepare('UPDATE connect_devices SET name=? WHERE id=?').run(name, row.id);
      json(res, 200, { device: deviceDto({ ...row, name }) }); return true;
    }
    fail(404, '页面不存在');
  }
  let usage = () => ({ enabled: false });
  return { handle, device, setUsage(fn) { usage = fn; } };
}
