import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { mailSettings, createMailProvider } from './mail.mjs';
import { createEmailCodes, EmailCodeError } from './email-codes.mjs';
import { createInvitations, createInvitationPolicy, InvitationError } from './invitations.mjs';
import { createReviewNotifications } from './review-notifications.mjs';
import { createLocalImport } from './local-import.mjs';
import { CloudAccounts, CloudError } from './cloud/accounts.mjs';
import { cloudRoute } from './cloud/routes.mjs';
import { CloudLibrary } from './cloud/library.mjs';
import { ActivityMetrics } from './admin/metrics.mjs';
import { createHubAdmin } from './admin/hub.mjs';
import { createAdminClient } from './admin/bridge.mjs';
import { ReviewPackages } from './admin/review-packages.mjs';
import { createConnect, ConnectError } from './connect.mjs';
import { createOfficialAi, officialAiSettings, shanghaiDay } from './official-ai.mjs';
import { createOfficialAiConfig, masterKey } from './official-ai-config.mjs';
import { createAiPoints } from './ai-points.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const derive = promisify(scrypt);
const MB = 1024 * 1024;
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new ApiError(status, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();
const text = (value, label, max, required = true) => {
  if (typeof value !== 'string') fail(400, `${label}格式不正确`);
  const result = value.trim();
  if ((required && !result) || result.length > max) fail(400, `${label}请填写 1–${max} 个字符`);
  return result;
};

export async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(root, 'data'));
  const uploadDir = path.join(dataDir, 'files');
  await mkdir(uploadDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS packs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, summary TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, tags TEXT NOT NULL, version TEXT NOT NULL, downloads INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS packs_updated ON packs(updated);
    CREATE INDEX IF NOT EXISTS files_pack ON files(pack_id);
    CREATE INDEX IF NOT EXISTS comments_pack ON comments(pack_id, created);
  `);
  // A legacy published pack also enters review when moderation is first enabled.
  const columns = new Set(db.prepare('PRAGMA table_info(packs)').all().map(c => c.name));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [name, definition] of Object.entries({ status: "TEXT NOT NULL DEFAULT 'pending'", revision: 'INTEGER NOT NULL DEFAULT 1', review_note: "TEXT NOT NULL DEFAULT ''", reviewed_by: 'TEXT', reviewed_at: 'TEXT' })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE packs ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS pack_reviews (id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE, revision INTEGER NOT NULL, decision TEXT NOT NULL, note TEXT NOT NULL, reviewer_id TEXT NOT NULL REFERENCES users(id), created TEXT NOT NULL)`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const reviewEmail = options.reviewEmail ?? process.env.REVIEW_EMAIL ?? '';
  const provider = options.mailProvider || createMailProvider(mailSettings());
  const reviewNotifier = createReviewNotifications(db, options.reviewNotificationProvider || provider, reviewEmail, options.now);
  const emailCodes = createEmailCodes(db, provider, options.now);
  const invitations = createInvitations(db, options.now);
  const metrics = new ActivityMetrics(db, options.now);
  const adminEnabled = options.adminEnabled ?? process.env.ADMIN_ENABLED === '1';
  const invitationPolicy = createInvitationPolicy(db, options.invitationRequired ?? process.env.INVITATION_REQUIRED === '1');
  const practiceOrigin = options.practiceOrigin ?? process.env.PRACTICE_ORIGIN ?? '';
  if (practiceOrigin && (new URL(practiceOrigin).origin !== practiceOrigin || new URL(practiceOrigin).protocol !== 'https:')) throw new Error('Invalid practice origin');
  const secureCookies = options.secureCookies ?? process.env.COOKIE_SECURE === '1';
  const cookieName = options.cookieName ?? 'qfh_session';
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(cookieName)) throw new Error('Invalid session cookie name');
  const sessionPattern = new RegExp('(?:^|;\\s*)' + cookieName + '=([a-f0-9]{64})(?:;|$)');
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  const archiveLimit = Number(process.env.MAX_ARCHIVE_MB || 20) * MB;
  const monthlyBudget = Number(options.monthlyBudgetBytes ?? Number(process.env.MONTHLY_FILE_BUDGET_GB || 150) * 1e9);
  const localImportEnabled = options.localImportEnabled ?? process.env.LOCAL_IMPORT_ENABLED === '1';
  const cloudEnabled = options.cloudEnabled ?? process.env.CLOUD_ENABLED === '1';
  const cloudAccounts = cloudEnabled ? new CloudAccounts(db, {
    ...options.cloud,
    timeZone: options.cloud?.timeZone ?? process.env.BILLING_TIMEZONE ?? 'Asia/Shanghai',
    siteStorageBytes: options.cloud?.siteStorageBytes ?? Number(process.env.CLOUD_SITE_STORAGE_MB || 5120) * MB,
    defaults: options.cloud?.defaults ?? { storageBytes: Number(process.env.CLOUD_STORAGE_MB || 256) * MB, dailyTrafficBytes: Number(process.env.CLOUD_DAILY_TRAFFIC_MB || 256) * MB, monthlyTrafficBytes: Number(process.env.CLOUD_MONTHLY_TRAFFIC_MB || 1024) * MB },
  }) : null;
  const runtimeDirectory = options.cloudRuntimeDir ?? process.env.CLOUD_RUNTIME_DIR;
  const cloudLibrary = cloudAccounts && runtimeDirectory ? await CloudLibrary.create(db, cloudAccounts, dataDir, runtimeDirectory, { unifiedWorkspace: !!options.practiceHome, hubAi: options.hubAi ?? null }) : null;
  const reviewPackages = cloudLibrary ? new ReviewPackages(cloudLibrary) : null;
  db.exec('CREATE TABLE IF NOT EXISTS traffic (period TEXT PRIMARY KEY, bytes INTEGER NOT NULL)');
  const month = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.BILLING_TIMEZONE || 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
  const reserveTraffic = (req, size, reserve = true, anonymous = false) => {
    const period = month();
    const ip = process.env.TRUST_PROXY === '1' ? String(req.headers['x-real-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress;
    const day = `${iso().slice(0, 10)}:${hash(ip || '')}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      const used = db.prepare('SELECT bytes FROM traffic WHERE period=?').get(period)?.bytes || 0;
      const daily = db.prepare('SELECT bytes FROM traffic WHERE period=?').get(day)?.bytes || 0;
      if (used + size > monthlyBudget) fail(429, '本月附件下载预算已用完，请下月再来或联系管理员');
      if (daily + size > Number(process.env.IP_DAILY_FILE_MB || 1000) * MB) fail(429, '今天的附件下载额度已用完，请明天再来');
      const user = !anonymous && cloudAccounts && identity(req);
      if (reserve && user) cloudAccounts.reserveTraffic(user.id, size, { transaction: false });
      if (reserve) for (const key of [period, day]) db.prepare('INSERT INTO traffic VALUES (?,?) ON CONFLICT(period) DO UPDATE SET bytes=bytes+excluded.bytes').run(key, size);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (reserve) metrics.transfer(size);
  };
  const limits = new Map();
  let uploading = false;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of limits) if (entry.until < now) limits.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  }, 60000);
  sweep.unref();
  const identity = req => {
    if (options.identityProvider) return req.externalHubIdentity || null;
    const raw = sessionPattern.exec(req.headers.cookie || '')?.[1];
    if (!raw) return null;
    return db.prepare('SELECT u.id,u.name,u.email,u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.user_id=u.id)').get(hash(raw), Date.now()) || null;
  };
  const requireUser = req => identity(req) || fail(401, '请先登录');
  const requireAdmin = req => { const user = requireUser(req); if (!user.admin) fail(403, '仅管理员可审核题库'); return user; };
  const throttle = (req, group, max, userId = '') => {
    const ip = process.env.TRUST_PROXY === '1' ? String(req.headers['x-real-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress;
    const key = `${group}:${userId || ip}`;
    let item = limits.get(key);
    if (!item || item.until < Date.now()) {
      if (limits.size > 10000) fail(503, '服务繁忙，请稍后再试');
      item = { count: 0, until: Date.now() + 60000 }; limits.set(key, item);
    }
    if (++item.count > max) fail(429, '操作太频繁，请稍后再试');
  };
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) { req.resume(); reject(new ApiError(413, '上传内容超过大小限制')); return; }
    let size = 0; const chunks = [];
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) { req.off('data', onData); req.resume(); chunks.length = 0; reject(new ApiError(413, '上传内容超过大小限制')); }
      else chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
    req.once('aborted', () => reject(new ApiError(400, '请求已中断')));
  });
  const bodyJson = async req => {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, '请使用 JSON 请求');
    try { const value = JSON.parse((await readBody(req, 24000)).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '请求内容应为对象'); return value; }
    catch (e) { if (e instanceof ApiError) throw e; fail(400, '请求内容格式错误'); }
  };
  const cookie = (res, token, expires = 30 * 86400) => res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expires}${secureCookies ? '; Secure' : ''}`);
  const session = (res, userId) => {
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), userId, Date.now() + 30 * 86400000);
    cookie(res, token);
  };
  const packRow = id => db.prepare('SELECT p.*,u.name AS author FROM packs p JOIN users u ON u.id=p.user_id WHERE p.id=?').get(id) || fail(404, '题库不存在或已下架');
  const readable = (req, row) => {
    const user = identity(req);
    if (row.status !== 'approved' && row.user_id !== user?.id && !user?.admin) fail(404, '题库不存在或尚未通过审核');
    return row;
  };
  const packDto = row => {
    const files = db.prepare('SELECT id,kind,name,mime,size,sha256 FROM files WHERE pack_id=? ORDER BY rowid').all(row.id);
    return { ...row, tags: JSON.parse(row.tags), archive: files.find(f => f.kind === 'archive'), screenshots: files.filter(f => f.kind === 'image'), commentCount: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE pack_id=?').get(row.id).n };
  };
  const owned = (req, row, adminAllowed = false) => {
    const user = requireUser(req);
    if (row.user_id !== user.id && !(adminAllowed && user.admin)) fail(403, '只能管理自己发布的内容');
    return user;
  };
  const validateFile = async (file, kind) => {
    const name = text(path.basename(file.name.replaceAll('\\', '/')), '文件名', 180);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!bytes.length || bytes.length > (kind === 'archive' ? archiveLimit : 3 * MB)) fail(400, kind === 'archive' ? `压缩包须为 1 字节–${archiveLimit / MB} MB` : '每张截图须小于 3 MB');
    let mime;
    if (kind === 'archive') {
      const ext = path.extname(name).toLowerCase();
      const zip = bytes.subarray(0, 2).equals(Buffer.from('PK')) && [0x0403, 0x0605, 0x0807].includes(bytes.length >= 4 ? bytes.readUInt16LE(2) : 0);
      const seven = bytes.subarray(0, 6).equals(Buffer.from('377abcaf271c', 'hex'));
      const rar = bytes.subarray(0, 7).equals(Buffer.from('526172211a0700', 'hex')) || bytes.subarray(0, 8).equals(Buffer.from('526172211a070100', 'hex'));
      if (!((['.zip', '.qbank'].includes(ext) && zip) || (ext === '.7z' && seven) || (ext === '.rar' && rar))) fail(400, '仅支持文件头匹配的 ZIP、7Z、RAR 或 QBank 压缩包');
      mime = 'application/octet-stream';
    } else {
      const ext = path.extname(name).toLowerCase();
      if (ext === '.png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mime = 'image/png';
      if (['.jpg', '.jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
      if (ext === '.webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
      if (!mime) fail(400, '截图仅支持 PNG、JPEG、WebP 图片');
    }
    return { id: randomUUID(), kind, name, mime, size: bytes.length, sha256: hash(bytes), bytes };
  };
  const handleUpload = async (req, res, packId) => {
    const user = requireUser(req);
    const previous = packId ? packRow(packId) : null;
    if (previous) owned(req, previous);
    throttle(req, 'upload', 6, user.id);
    if (uploading) fail(503, '另一个文件正在上传，请稍后重试');
    uploading = true;
    const written = [];
    try {
      if (!/^multipart\/form-data;/i.test(req.headers['content-type'] || '')) fail(415, '请选择题库文件上传');
      const bytes = await readBody(req, archiveLimit + 19 * MB);
      let form;
      try { form = await new Request('http://local/upload', { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: bytes }).formData(); }
      catch { fail(400, '上传表单无法解析'); }
      const values = { title: text(form.get('title'), '题库名称', 80), summary: text(form.get('summary'), '题库简介', 240), description: text(form.get('description'), '详细介绍', 12000), category: previous?.category || '其他', version: text(form.get('version') || '1.0', '版本', 30), tags: text(form.get('tags') || '', '标签', 100, false).split(/[,，]/).map(v => v.trim()).filter(Boolean).slice(0, 5) };
      if (form.get('rights') !== 'yes') fail(400, '请确认你有权分享这些内容');
      const existing = previous ? db.prepare('SELECT * FROM files WHERE pack_id=?').all(previous.id) : [];
      let keep;
      try { keep = JSON.parse(form.get('keepScreenshots') || '[]'); } catch { fail(400, '截图列表格式错误'); }
      if (!Array.isArray(keep) || keep.some(id => !existing.some(f => f.id === id && f.kind === 'image'))) fail(400, '截图列表无效');
      keep = [...new Set(keep)];
      const images = form.getAll('screenshots').filter(f => typeof f !== 'string' && f.size);
      if (images.length + keep.length > 6) fail(400, '最多上传 6 张截图');
      const archive = form.get('archive');
      const hasArchive = archive && typeof archive !== 'string' && archive.size > 0;
      if (!previous && !hasArchive) fail(400, '请选择题库压缩包');
      const newFiles = [];
      if (hasArchive) newFiles.push(await validateFile(archive, 'archive'));
      for (const image of images) newFiles.push(await validateFile(image, 'image'));
      const removed = existing.filter(f => f.kind === 'archive' ? hasArchive : !keep.includes(f.id));
      const delta = newFiles.reduce((n, f) => n + f.size, 0) - removed.reduce((n, f) => n + f.size, 0);
      const userSize = db.prepare('SELECT COALESCE(SUM(f.size),0) AS n FROM files f JOIN packs p ON p.id=f.pack_id WHERE p.user_id=?').get(user.id).n;
      const total = db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM files').get().n;
      if (userSize + delta > Number(process.env.USER_QUOTA_MB || 500) * MB || total + delta > Number(process.env.TOTAL_QUOTA_MB || 5000) * MB) fail(400, '存储配额已满，请联系管理员');
      const id = previous?.id || randomUUID(); const now = iso();
      for (const f of newFiles) { await writeFile(path.join(uploadDir, f.id), f.bytes, { flag: 'wx' }); written.push(f.id); }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (previous) db.prepare("UPDATE packs SET title=?,summary=?,description=?,category=?,tags=?,version=?,updated=?,status='pending',revision=revision+1,review_note='',reviewed_by=NULL,reviewed_at=NULL WHERE id=?").run(values.title, values.summary, values.description, values.category, JSON.stringify(values.tags), values.version, now, id);
        else db.prepare('INSERT INTO packs (id,user_id,title,summary,description,category,tags,version,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, user.id, values.title, values.summary, values.description, values.category, JSON.stringify(values.tags), values.version, now, now);
        for (const f of removed) db.prepare('DELETE FROM files WHERE id=?').run(f.id);
        for (const f of newFiles) db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run(f.id, id, f.kind, f.name, f.mime, f.size, f.sha256);
        reviewNotifier.enqueue();
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      written.length = 0;
      for (const f of removed) await unlink(path.join(uploadDir, f.id)).catch(() => {});
      // Notification delivery never makes a successfully saved submission fail.
      if (reviewNotifier) reviewNotifier.wake();
      json(res, previous ? 200 : 201, { pack: packDto(packRow(id)) });
    } finally {
      for (const id of written) await unlink(path.join(uploadDir, id)).catch(() => {});
      uploading = false;
    }
  };
  const resolveCloudPack = (packId, revision) => {
    if (typeof packId !== 'string' || !/^[a-f0-9-]{36}$/.test(packId) || !Number.isSafeInteger(revision) || revision < 1) fail(400, '题库版本无效');
    const row = packRow(packId);
    if (row.status !== 'approved') fail(404, '题库不存在或尚未公开');
    if (row.revision !== revision) fail(409, '公共题库已更新，请刷新后重新下载到云端');
    const file = db.prepare("SELECT * FROM files WHERE pack_id=? AND kind='archive'").get(packId) || fail(404, '题库文件不存在');
    if (!file.name.toLowerCase().endsWith('.qbank')) fail(422, '此附件不是 .qbank 文件，暂不能下载到云端');
    return { file: path.join(uploadDir, file.id), filename: file.name, source: { kind: 'hub', packId, revision, sha256: file.sha256, title: row.title } };
  };
  const handleCloud = cloudRoute({ accounts: cloudAccounts, library: cloudLibrary, reviewPackages, requireUser, requireAdmin, bodyJson, throttle, json, resolveCloudPack: options.resolveCloudPack || resolveCloudPack, reserveTraffic, hubAi: options.hubAi ?? null });
  const handleLocalImport = createLocalImport({ db, uploadDir, enabled: localImportEnabled, throttle, reserveTraffic, json, openFile: options.localImportOpenFile });
  // AI service: the admin backend manages the switch and the upstream API keys, which are
  // stored encrypted with OFFICIAL_AI_MASTER_KEY; server file values are form defaults.
  const aiMaster = masterKey(options.officialAiMasterKey ?? process.env.OFFICIAL_AI_MASTER_KEY);
  const aiConfig = createOfficialAiConfig({ db, base: options.officialAi ?? officialAiSettings(), master: aiMaster, now: options.now, fetchImpl: options.officialAiFetch });
  const verifyPassword = async (userId, password) => {
    const row = db.prepare('SELECT password FROM users WHERE id=?').get(userId);
    if (typeof password !== 'string' || password.length > 128 || !row || !row.password.includes(':')) return false;
    const [salt, digest] = row.password.split(':'), candidate = await derive(password, salt, 64), expected = Buffer.from(digest, 'hex');
    return expected.length === candidate.length && timingSafeEqual(candidate, expected);
  };
  const aiPoints = createAiPoints({ db, master: aiMaster, now: options.now });
  const handleAdmin = createHubAdmin({ db, officialAi: aiConfig, aiPoints, verifyPassword, shanghaiDay, invitations, invitationPolicy, metrics, requireUser, requireAdmin, throttle, uploadDir, enabled: adminEnabled, token: req => sessionPattern.exec(req.headers.cookie || '')?.[1], cloud: options.adminCloud || createAdminClient({ port: Number(process.env.PRACTICE_ADMIN_PORT || 4324) }) });
  // Hub account connection and the official AI gateway (docs/HUB_CONNECT_AI.md).
  const connect = createConnect({ db, enabled: () => aiConfig.enabled(), identity, throttle, json, bodyJson, points: aiPoints, now: options.now });
  const officialAi = createOfficialAi({ db, config: aiConfig, connect, points: aiPoints, json, readBody, now: options.now, fetchImpl: options.officialAiFetch });
  // These device endpoints authenticate only with a Bearer device token and never
  // read cookies, so native clients may call them without a browser Origin.
  const deviceRoutes = new Set(['/api/connect/token', '/api/connect/logout', '/api/connect/redeem', '/api/ai/v1/chat/completions']);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (options.beforeRequest && await options.beforeRequest(req, res, url)) return;
      if (options.identityProvider) {
        const user = await options.identityProvider(req);
        if (user) {
          if (!/^[a-f0-9-]{36}$/.test(user.id) || typeof user.email !== 'string' || typeof user.name !== 'string' || ![0, 1].includes(user.admin)) fail(503, '登录信息无效');
          db.prepare("INSERT INTO users(id,email,name,password,admin,created) VALUES (?,?,?,'!external-auth',?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,admin=excluded.admin").run(user.id, user.email, user.name, user.admin, iso());
          req.externalHubIdentity = user;
        }
        if (pathname.startsWith('/api/auth/')) fail(403, '请通过 Hub 统一登录');
      }
      // AI configuration runs without the Hub's third-party registration script.
      // Only this document may directly connect to user-selected HTTPS models.
      if (cloudEnabled && pathname.startsWith('/cloud/')) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; frame-src 'none'; style-src 'self'; img-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      if (pathname.startsWith('/admin/')) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; frame-src 'none'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      if (!['GET', 'HEAD'].includes(req.method) && !deviceRoutes.has(pathname)) {
        const allowed = publicOrigin || `http://${req.headers.host}`;
        if (req.headers.origin !== allowed) fail(403, '请求来源不受信任');
      }
      if (pathname === '/internal/activity' && req.method === 'POST') {
        if (req.headers.host !== `127.0.0.1:${server.address().port}` || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) fail(403, '仅允许服务内部访问');
        const user = requireUser(req); const input = await bodyJson(req);
        if (!['visit', 'practice', 'heartbeat'].includes(input.kind)) fail(400, '活动类型无效');
        throttle(req, 'activity-service', 60, user.id); metrics.record(user.id, input.kind); json(res, 200, { ok: true }); return;
      }
      // Cloud practice grades with the signed-in account's free AI balance, no device token
      // (docs/HUB_CONNECT_AI.md 7.3). The practice service relays the user's Hub session.
      if (pathname.startsWith('/internal/ai/')) {
        if (req.headers.host !== `127.0.0.1:${server.address().port}` || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) fail(403, '仅允许服务内部访问');
        if (!aiConfig.enabled()) throw new ConnectError(404, 'OFFICIAL_AI_DISABLED', '免费 AI 暂未开放');
        const user = identity(req) || (() => { throw new ConnectError(401, 'HUB_LOGIN_REQUIRED', '登录已失效，请重新登录 Hub'); })();
        if (pathname === '/internal/ai/me' && req.method === 'GET') { json(res, 200, { user: { name: user.name, email: user.email }, ai: officialAi.usage(user.id) }); return; }
        if (pathname === '/internal/ai/redeem' && req.method === 'POST') { throttle(req, 'connect-redeem', 10, user.id); json(res, 200, aiPoints.redeem(user.id, (await bodyJson(req)).code)); return; }
        if (pathname === '/internal/ai/chat/completions' && req.method === 'POST') { await officialAi.complete(req, res, user.id); return; }
        fail(404, '页面不存在');
      }
      if (pathname === '/api/cloud/activity' && req.method === 'POST' && options.reportActivity) {
        const user = requireUser(req); throttle(req, 'activity-relay', 40, user.id); const input = await bodyJson(req);
        if (!['visit', 'practice', 'heartbeat'].includes(input.kind)) fail(400, '活动类型无效');
        await options.reportActivity(req, input.kind); json(res, 200, { ok: true }); return;
      }
      if (options.practiceHome && ['/', '/cloud/'].includes(pathname) && req.method === 'GET') {
        const user = identity(req);
        if (!user) { res.writeHead(303, { Location: '/auth/hub', 'Cache-Control': 'no-store' }).end(); return; }
        if (!cloudLibrary) fail(503, '云端运行时尚未配置');
        const item = await cloudLibrary.ensureDemo(user.id);
        res.writeHead(303, { Location: `/cloud/practice/${item.id}/`, 'Cache-Control': 'no-store' }).end(); return;
      }
      const practiceApi = /^\/api\/cloud\/practice\/([a-f0-9-]{36})(\/api\/.*)$/.exec(pathname);
      const practicePage = /^\/cloud\/practice\/([a-f0-9-]{36})\/(.*)$/.exec(pathname);
      if (practiceApi || practicePage) {
        if (options.practiceHome && practicePage && req.method === 'GET' && !identity(req)) {
          res.writeHead(303, { Location: '/auth/hub', 'Cache-Control': 'no-store' }).end(); return;
        }
        const user = requireUser(req);
        if (!cloudLibrary) fail(503, '云端练习运行时尚未配置');
        throttle(req, 'cloud-practice', 240, user.id);
        if (practiceApi?.[2] === '/api/library/import' && req.method === 'POST') throttle(req, 'cloud-import', 6, user.id);
        if (options.practiceHome && practicePage && practicePage[2] === '') {
          cloudLibrary.owned(user.id, practicePage[1]);
          const workspace = await cloudLibrary.ensureDemo(user.id);
          if (workspace.id !== practicePage[1]) { res.writeHead(303, { Location: `/cloud/practice/${workspace.id}/` + url.search, 'Cache-Control': 'no-store' }).end(); return; }
        }
        let result;
        if (practiceApi) result = await cloudLibrary.practice.api(user.id, practiceApi[1], practiceApi[2] + url.search, req);
        else {
          if (req.method !== 'GET') fail(405, '页面仅支持 GET');
          result = cloudLibrary.practice.asset(user.id, practicePage[1], practicePage[2], { ordinary: !!options.practiceHome });
          res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
        }
        // Reading, saving and grading are normal use, never file downloads.
        if (practiceApi && ['POST', 'PUT'].includes(req.method) && result.status < 400 && /\/(?:answer|answers|submit|exam|exams|actions)(?:\/|$)/.test(practiceApi[2])) options.reportActivity?.(req, 'practice')?.catch(() => {});
        res.writeHead(result.status, { 'Content-Type': result.type, 'Content-Length': result.bytes.length, 'Cache-Control': 'no-store' }); res.end(result.bytes); return;
      }
      if (pathname === '/api/me' && req.method === 'GET') { json(res, 200, { user: identity(req) }); return; }
      if (pathname === '/api/config' && req.method === 'GET') { json(res, 200, { maxArchiveMB: archiveLimit / MB, registrationReady: emailCodes.ready, invitationRequired: invitationPolicy.required(), turnstileSiteKey: emailCodes.siteKey, cloudEnabled, practiceOrigin, adminEnabled, localImport: { enabled: localImportEnabled, protocolVersion: 1, scheme: 'quizforge' }, officialAi: { enabled: aiConfig.enabled(), protocolVersion: 1 } }); return; }
      if (await connect.handle(req, res, url)) return;
      if (await officialAi.handle(req, res, url)) return;
      if (await handleAdmin(req, res, url)) return;
      if (await handleLocalImport(req, res, url)) return;
      if (await handleCloud(req, res, url)) return;
      if (pathname === '/api/auth/email-code' && req.method === 'POST') {
        throttle(req, 'email-code', 6);
        const input = await bodyJson(req);
        if (invitationPolicy.required()) invitations.check(input.invitationCode);
        const email = text(input.email, '邮箱', 180).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, '邮箱格式不正确');
        const ip = process.env.TRUST_PROXY === '1' ? String(req.headers['x-real-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress;
        const hostname = new URL(publicOrigin || `http://${req.headers.host}`).hostname;
        await emailCodes.send(email, ip || '', input.captchaToken, hostname);
        json(res, 200, { message: '如果该邮箱可以注册，验证码将发送到邮箱，请检查收件箱和垃圾邮件。', retryAfter: 60 }); return;
      }
      if (['/api/auth/register', '/api/auth/login'].includes(pathname) && req.method === 'POST') {
        throttle(req, 'auth', 12);
        const input = await bodyJson(req);
        const email = text(input.email, '邮箱', 180).toLowerCase();
        const password = input.password;
        if (typeof password !== 'string' || password.length > 128) fail(400, '密码格式不正确');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, '邮箱格式不正确');
        if (password.length < 10) fail(400, '密码至少需要 10 个字符');
        if (pathname.endsWith('register')) {
          if (!emailCodes.ready) fail(503, '注册邮件暂未开放，请稍后再来');
          if (invitationPolicy.required()) invitations.check(input.invitationCode);
          const name = text(input.name, '昵称', 30);
          const salt = randomBytes(16).toString('hex');
          const digest = (await derive(password, salt, 64)).toString('hex');
          const id = randomUUID();
          try { emailCodes.consume(email, input.code, () => {
            db.prepare('INSERT INTO users (id,email,name,password,created) VALUES (?,?,?,?,?)').run(id, email, name, `${salt}:${digest}`, iso());
            // Re-read inside the final account transaction: an administrator
            // can enable the gate while password hashing is still in flight.
            if (invitationPolicy.required()) invitations.consume(input.invitationCode, id);
          }); }
          catch (e) { if (e.message.includes('UNIQUE')) fail(409, '该邮箱已注册'); throw e; }
          session(res, id); json(res, 201, { user: { id, email, name, admin: 0 } }); return;
        }
        const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        const [salt, digest] = (user?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
        const candidate = await derive(password, salt, 64);
        if (!user || !timingSafeEqual(candidate, Buffer.from(digest, 'hex')) || db.prepare('SELECT 1 FROM user_blocks WHERE user_id=?').get(user.id)) fail(401, '邮箱或密码不正确，或账号已停用');
        session(res, user.id); json(res, 200, { user: { id: user.id, email: user.email, name: user.name, admin: user.admin } }); return;
      }
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const raw = sessionPattern.exec(req.headers.cookie || '')?.[1];
        if (raw) db.prepare('DELETE FROM sessions WHERE token=?').run(hash(raw));
        cookie(res, '', 0); json(res, 200, { ok: true }); return;
      }
      if (pathname === '/api/packs' && req.method === 'GET') {
        const conditions = []; const params = [];
        const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
        if (query) { conditions.push('(p.title LIKE ? ESCAPE \'!\' OR p.summary LIKE ? ESCAPE \'!\' OR p.tags LIKE ? ESCAPE \'!\')'); const pattern = `%${query.replace(/[!%_]/g, '!$&')}%`; params.push(pattern, pattern, pattern); }
        if (url.searchParams.get('mine') === '1') { conditions.push('p.user_id=?'); params.push(requireUser(req).id); }
        else conditions.push("p.status='approved'");
        const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
        const order = url.searchParams.get('sort') === 'popular' ? 'p.downloads DESC,p.updated DESC' : 'p.updated DESC';
        const page = Math.max(1, Math.min(100000, parseInt(url.searchParams.get('page') || '1') || 1));
        const count = db.prepare('SELECT COUNT(*) AS n FROM packs p' + where).get(...params).n;
        const rows = db.prepare('SELECT p.*,u.name AS author FROM packs p JOIN users u ON u.id=p.user_id' + where + ' ORDER BY ' + order + ' LIMIT 12 OFFSET ?').all(...params, (page - 1) * 12);
        json(res, 200, { packs: rows.map(packDto), count, page }); return;
      }
      if (pathname === '/api/packs' && req.method === 'POST') { await handleUpload(req, res); return; }
      const match = /^\/api\/packs\/([a-f0-9-]{36})(?:\/(comments|download|download-status|report|review))?$/.exec(pathname);
      if (match) {
        const [, id, action] = match; const row = packRow(id);
        if (action === 'review' && req.method === 'POST') {
          const admin = requireAdmin(req); const input = await bodyJson(req);
          if (adminEnabled) fail(409, '请前往管理后台执行包含拓展的整包审核');
          if (!['approved', 'rejected'].includes(input.decision)) fail(400, '请选择通过或驳回');
          if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail(400, '审核版本无效');
          const note = text(input.note ?? '', '审核说明', 1000, input.decision === 'rejected');
          db.exec('BEGIN IMMEDIATE');
          try {
            const changed = db.prepare("UPDATE packs SET status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND revision=? AND status='pending'").run(input.decision, note, admin.id, iso(), id, input.revision);
            if (!changed.changes) fail(409, '题库已修改或已审核，请刷新后重新查看');
            db.prepare('INSERT INTO pack_reviews VALUES (?,?,?,?,?,?,?)').run(randomUUID(), id, input.revision, input.decision, note, admin.id, iso());
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          json(res, 200, { pack: packDto(packRow(id)) }); return;
        }
        if (['GET', 'HEAD'].includes(req.method) || ['comments', 'report'].includes(action)) readable(req, row);
        if (['comments', 'report'].includes(action) && row.status !== 'approved') fail(409, '题库通过审核后才能评论或举报');
        if (!action && req.method === 'GET') {
          const comments = db.prepare('SELECT c.id,c.user_id,c.body,c.created,u.name AS author FROM comments c JOIN users u ON u.id=c.user_id WHERE c.pack_id=? ORDER BY c.created DESC LIMIT 100').all(id);
          json(res, 200, { pack: packDto(row), comments }); return;
        }
        if (!action && req.method === 'PUT') { await handleUpload(req, res, id); return; }
        if (!action && req.method === 'DELETE') {
          owned(req, row, true);
          const files = db.prepare('SELECT id FROM files WHERE pack_id=?').all(id);
          db.prepare('DELETE FROM packs WHERE id=?').run(id);
          for (const f of files) await unlink(path.join(uploadDir, f.id)).catch(() => {});
          json(res, 200, { ok: true }); return;
        }
        if (action === 'comments' && req.method === 'POST') {
          const user = requireUser(req); throttle(req, 'comment', 10, user.id);
          const body = text((await bodyJson(req)).body, '评论', 2000);
          const comment = { id: randomUUID(), user_id: user.id, body, created: iso(), author: user.name };
          db.prepare('INSERT INTO comments VALUES (?,?,?,?,?)').run(comment.id, id, user.id, body, comment.created);
          json(res, 201, { comment }); return;
        }
        if (action === 'report' && req.method === 'POST') {
          const user = requireUser(req); throttle(req, 'report', 5, user.id);
          const reason = text((await bodyJson(req)).reason, '举报原因', 1000);
          db.prepare('INSERT INTO reports VALUES (?,?,?,?,?)').run(randomUUID(), id, user.id, reason, iso());
          json(res, 201, { ok: true }); return;
        }
        if (action === 'download-status' && req.method === 'GET') {
          const file = db.prepare("SELECT * FROM files WHERE pack_id=? AND kind='archive'").get(id) || fail(404, '压缩包不存在');
          await stat(path.join(uploadDir, file.id)); reserveTraffic(req, file.size, false);
          json(res, 200, { ok: true }); return;
        }
        if (action === 'download' && req.method === 'GET') {
          throttle(req, 'download', 30);
          const file = db.prepare("SELECT * FROM files WHERE pack_id=? AND kind='archive'").get(id);
          if (!file) fail(404, '压缩包不存在');
          await stat(path.join(uploadDir, file.id));
          reserveTraffic(req, file.size);
          db.prepare('UPDATE packs SET downloads=downloads+1 WHERE id=?').run(id);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `attachment; filename="question-bank${path.extname(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'Cache-Control': 'private, no-store' });
          await pipeline(createReadStream(path.join(uploadDir, file.id)), res); return;
        }
      }
      const commentMatch = /^\/api\/comments\/([a-f0-9-]{36})$/.exec(pathname);
      if (commentMatch && req.method === 'DELETE') {
        const row = db.prepare('SELECT * FROM comments WHERE id=?').get(commentMatch[1]) || fail(404, '评论不存在');
        owned(req, row, true); db.prepare('DELETE FROM comments WHERE id=?').run(row.id); json(res, 200, { ok: true }); return;
      }
      if (pathname === '/api/reports' && req.method === 'GET') {
        if (!requireUser(req).admin) fail(403, '仅管理员可查看举报');
        json(res, 200, { reports: db.prepare('SELECT r.*,p.title,u.name AS author FROM reports r JOIN packs p ON p.id=r.pack_id JOIN users u ON u.id=r.user_id ORDER BY r.created DESC LIMIT 100').all(), traffic: { period: month(), reservedBytes: db.prepare('SELECT bytes FROM traffic WHERE period=?').get(month())?.bytes || 0, budgetBytes: monthlyBudget } }); return;
      }
      if (pathname === '/api/reviews' && req.method === 'GET') {
        requireAdmin(req);
        const status = url.searchParams.get('status') || 'pending';
        if (!['pending', 'approved', 'rejected'].includes(status)) fail(400, '审核状态无效');
        const page = Math.max(1, Math.min(100000, parseInt(url.searchParams.get('page') || '1') || 1));
        const count = db.prepare('SELECT COUNT(*) AS n FROM packs WHERE status=?').get(status).n;
        const rows = db.prepare('SELECT p.*,u.name AS author FROM packs p JOIN users u ON u.id=p.user_id WHERE status=? ORDER BY updated DESC LIMIT 12 OFFSET ?').all(status, (page - 1) * 12);
        json(res, 200, { packs: rows.map(packDto), count, page, status, reviewEmail, notification: reviewNotifier?.state() ?? { ready: false } }); return;
      }
      const imageMatch = /^\/media\/([a-f0-9-]{36})$/.exec(pathname);
      if (imageMatch && req.method === 'GET') {
        const file = db.prepare("SELECT * FROM files WHERE id=? AND kind='image'").get(imageMatch[1]) || fail(404, '图片不存在');
        readable(req, packRow(file.pack_id));
        await stat(path.join(uploadDir, file.id));
        throttle(req, 'image', 180); reserveTraffic(req, file.size);
        res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.size, 'Cache-Control': 'private, no-store' });
        await pipeline(createReadStream(path.join(uploadDir, file.id)), res); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && !pathname.startsWith('/api/')) {
        const assets = { '/app.js': ['app.js', 'text/javascript'], '/local-import.js': ['local-import.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['quizforge-icon.png', 'image/png'], '/quizforge-icon.png': ['quizforge-icon.png', 'image/png'] };
        assets['/activity.js'] = ['activity.js', 'text/javascript'];
        assets['/connect.js'] = ['connect.js', 'text/javascript'];
        if (adminEnabled) {
          if (pathname === '/admin/') { if (!identity(req)) { res.writeHead(303, { Location: '/manage/#admin', 'Cache-Control': 'no-store' }).end(); return; } requireAdmin(req); }
          assets['/admin/'] = ['admin/index.html', 'text/html']; assets['/admin/app.js'] = ['admin/app.js', 'text/javascript']; assets['/admin/ai.js'] = ['admin/ai.js', 'text/javascript']; assets['/admin/admin.css'] = ['admin/admin.css', 'text/css'];
        }
        if (cloudEnabled) {
          assets['/cloud/activity.js'] = ['activity.js', 'text/javascript'];
          assets['/cloud/library.js'] = ['cloud/library.js', 'text/javascript'];
          assets['/cloud/import'] = ['cloud/import.html', 'text/html'];
          assets['/cloud/import.js'] = ['cloud/import.js', 'text/javascript'];
          assets['/cloud/import.css'] = ['cloud/import.css', 'text/css'];
          for (const name of ['app.js', 'vault.js', 'ai-client.js', 'cloud.css', 'practice.css', 'experience.js', 'experience.css', 'embedded.css']) assets['/cloud/' + name] = ['cloud/' + name, name.endsWith('.css') ? 'text/css' : 'text/javascript'];
          for (const route of ['/cloud/', '/cloud/ai', '/cloud/admin']) assets[route] = ['cloud/index.html', 'text/html'];
        }
        const entry = assets[pathname] || (['/', '/manage/'].includes(pathname) ? ['index.html', 'text/html'] : null);
        if (entry) {
          let data = await readFile(path.join(root, 'public', entry[0]));
          if (options.practiceHome && pathname === '/cloud/ai' && url.searchParams.get('embedded') === '1') {
            // The custom-model frame inside Web's AI 评分 panel uses Web's own ai-settings.css.
            const base = url.searchParams.get('base'), web = /^\/cloud\/practice\/[a-f0-9-]{36}$/.test(base || '') ? `<link rel="stylesheet" href="${base}/ai/ai-settings.css">` : '';
            data = Buffer.from(data.toString('utf8').replace('<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/cloud/cloud.css">', web).replace('</head>', '<link rel="stylesheet" href="/cloud/embedded.css"></head>'));
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https:; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'self'");
          }
          res.writeHead(200, { 'Content-Type': entry[1] === 'image/png' ? entry[1] : `${entry[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : data); return;
        }
      }
      fail(404, '页面不存在');
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof ConnectError) { json(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } }); return; }
      const status = e instanceof ApiError || e instanceof EmailCodeError || e instanceof InvitationError || e instanceof CloudError ? e.status : e.code === 'ENOENT' ? 404 : 500;
      if (status === 500) console.error('Request failed:', e.name, e.code || 'internal');
      const message = status === 500 ? '服务器暂时无法处理，请稍后重试' : status === 404 && !(e instanceof ApiError) ? '文件不存在' : e.message;
      const scopedPractice = /^\/api\/cloud\/practice\/[a-f0-9-]{36}\/api\//.test(req.url.split('?')[0]);
      json(res, status, { error: scopedPractice ? { code: e.code || 'CLOUD_REQUEST_REJECTED', message } : message });
    }
  });
  server.requestTimeout = 45000; server.headersTimeout = 10000;
  server.on('close', () => { clearInterval(sweep); reviewNotifier.stop(); cloudLibrary?.close(); db.close(); });
  return { server, dataDir, db, cloudLibrary, cloudAccounts, metrics, reviewPackages, aiConfig, aiPoints };
}

if (import.meta.main) {
  // Keep private configuration outside source and OneDrive. An explicit path is required on servers.
  const privateFile = process.env.MAIL_ENV_FILE || (process.platform === 'win32' ? path.join(os.homedir(), '.codex', 'secrets', 'quizforge-hub', 'mail.env') : '');
  if (privateFile) {
    try { process.loadEnvFile(privateFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const { server } = await createApp();
  const port = Number(process.env.PORT || 4318); const host = process.env.HOST || '127.0.0.1';
  const browserHost = host === '127.0.0.1' ? 'localhost' : host;
  server.listen(port, host, () => console.log(`QuizForge Hub: http://${browserHost}:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
