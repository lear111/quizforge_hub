import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CloudError } from './accounts.mjs';
import { treeBytes } from './library.mjs';
import { ordinaryPracticeAsset } from './practice-ui.mjs';
import { attachCloudAi } from './ai.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const jsonBytes = value => Buffer.from(JSON.stringify(value));
const publicSharedModules = new Set(['shared/answer-area/1.3.0/model.js', 'shared/answer-area/1.4.0/model.js', 'shared/ink/1.0.0/renderer.js']);
export class CloudPractice {
  constructor(library) {
    this.library = library; this.db = library.db; this.accounts = library.accounts; this.sessions = new Map(); this.pending = 0; this.lanes = new Map(); this.closed = false;
    this.sessionOwners = new Map(); this.retiring = new Set(); this.sessionTail = Promise.resolve(); this.sessionLimit = 32; this.uploading = new Set();
    this.backups = path.join(library.root, 'backups'); fs.mkdirSync(this.backups, { recursive: true, mode: 0o700 });
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_practice_writes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,import_id TEXT NOT NULL)');
    for (const row of this.db.prepare('SELECT * FROM cloud_practice_writes').all()) {
      const original = library.location(row.user_id, row.import_id), backup = this.backup(row.id);
      if (!fs.existsSync(backup)) throw new Error('Practice recovery backup missing; preserve data for inspection');
      library.remove(original); fs.renameSync(backup, original);
      this.db.prepare('DELETE FROM cloud_practice_writes WHERE id=?').run(row.id);
    }
    for (const name of fs.readdirSync(this.backups)) library.remove(this.backup(name));
  }
  backup(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid practice backup ID');
    return path.join(this.backups, id);
  }
  async serial(userId, operation) {
    // A user's aliases/imports can resolve to the same physical workspace.
    // Serialize the account, including merge/export/delete, never all accounts.
    let lane = this.lanes.get(userId);
    if (this.closed || this.pending >= 128 || (lane?.pending ?? 0) >= 16 || !lane && this.lanes.size >= 32) throw new CloudError(503, '云端练习请求较多，请稍后重试，当前输入仍保留');
    if (!lane) { lane = { tail: Promise.resolve(), pending: 0, running: false }; this.lanes.set(userId, lane); }
    this.pending++; lane.pending++;
    const result = lane.tail.then(async () => { lane.running = true; lane.sessionId = null; try { return await operation(); } finally { lane.running = false; lane.sessionId = null; } });
    lane.tail = result.catch(() => {});
    try { return await result; } finally { this.pending--; if (!--lane.pending) this.lanes.delete(userId); }
  }
  approved(root) {
    const visit = directory => {
      for (const name of fs.readdirSync(directory)) {
        if (name === '.temp') continue;
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new CloudError(422, '练习目录包含无效文件');
        if (name === 'manifest.json' && stat.isFile()) this.library.reviews.verify(directory);
        else if (stat.isDirectory()) visit(file);
      }
    };
    visit(root);
  }
  async session(row) {
    const lane = this.lanes.get(row.user_id); if (lane) lane.sessionId = row.id;
    if (this.sessions.has(row.id) && !this.retiring.has(row.id)) {
      const value = this.sessions.get(row.id); this.sessions.delete(row.id); this.sessions.set(row.id, value); return value;
    }
    // Only cache construction/eviction uses a shared lifecycle barrier. Warm
    // sessions never wait here, and no API/model operation holds this barrier.
    const result = this.sessionTail.then(() => this.openSession(row));
    this.sessionTail = result.then(() => {}, () => {});
    return result;
  }
  async openSession(row) {
    while (this.sessions.size >= this.sessionLimit) {
      const idle = [...this.sessions].find(([id]) => {
        const owner = this.lanes.get(this.sessionOwners.get(id));
        return !this.retiring.has(id) && !(owner?.running && (owner.sessionId === null || owner.sessionId === id));
      });
      if (!idle) break;
      await this.releaseSession(idle[0]);
    }
    if (this.sessions.size >= this.sessionLimit) throw new CloudError(503, '正在使用练习空间的用户较多，请稍后重试');
    const r = this.library.runtime;
    const { QuizForgeServer } = await import(pathToFileURL(path.join(r.core, 'server/host/http/server.js')).href);
    const { ApiError } = await import(pathToFileURL(path.join(r.core, 'server/host/platform/errors.js')).href);
    const service = await QuizForgeServer.create({ root: this.library.location(row.user_id, row.id), codeRoot: r.core, host: '127.0.0.1', port: 0, tailscale: { read: async () => ({ state: 'unavailable' }) } });
    service.engine.close();
    const engine = { ...this.library.engine, close() {} };
    service.engine = engine; service.library.engine = engine; service.states.rules = engine; service.developmentStates.rules = engine;
    // No local/network administration or server-side model calls are exposed.
    // Existing practice, editor, history and exam handlers stay in the pinned
    // core; all their disk effects run inside the checkpoint below.
    service.canManage = () => false;
    const originalApi = service.api.bind(service);
    service.api = async (context, pathname) => {
      if (pathname === '/api/settings/development' && context.request.method === 'GET') return { enabled: false, canManage: false };
      if (pathname === '/api/settings/ai' && context.request.method === 'GET') return { enabled: false, canManage: false, apiKeyConfigured: false, baseUrl: '', model: '', provider: 'openai-compatible', autoGrade: false, vision: false, outputMode: 'json', maxOutputTokens: 8192, timeoutSeconds: 90, testReport: null };
      if (pathname === '/api/library/import' && context.request.method === 'POST') {
        if (context.request.headers['content-type']?.split(';')[0].trim() !== 'application/vnd.quizforge.qbank') throw new ApiError(415, 'QBANK_REQUIRED', '请上传 QuizForge .qbank 文件');
        let filename; try { filename = decodeURIComponent(context.request.headers['x-quizforge-filename'] || ''); } catch { throw new ApiError(400, 'INVALID_FILENAME', '文件名无效'); }
        return service.namespaceTransaction(async () => {
          const archive = new r.LibraryArchive(service.root, service.resources);
          const result = await archive.importPackage(context.request, async staging => {
            try { for (const directory of r.scanExtensions(path.join(staging, 'extensions'))) this.library.reviews.verify(directory); }
            catch (error) { throw new ApiError(error.status || 422, 'CLOUD_EXTENSION_REVIEW_REQUIRED', error.message); }
            const candidate = new r.Library(staging, r.core, this.library.engine);
            try { await r.validateImportLibrary(candidate); } finally { candidate.close(); }
          }, filename);
          service.library.invalidate(); return { ...result, catalog: { ...service.library.index(), canManage: true } };
        });
      }
      if (pathname === '/api/library/manage' && context.request.method === 'POST') {
        const input = await service.writeRequest(context);
        return service.namespaceTransaction(async () => {
          const result = await service.library.manage(input);
          service.states.clearMemory(); service.developmentStates.clearMemory(); return result;
        });
      }
      const result = await originalApi(context, pathname);
      if (context.request.method === 'GET' && ['/api/library/index', '/api/catalog'].includes(pathname)) return { ...result, canManage: true };
      return result;
    };
    // Deliberately do not call local start(): it would create background exam
    // writers and network listeners outside the cloud transaction boundary.
    // Exam deadlines are advanced by the core on the next scoped exam request.
    await attachCloudAi(service, r, this.library.hubAi);
    service.ready = true;
    this.sessionOwners.set(row.id, row.user_id); this.sessions.set(row.id, service); return service;
  }
  async releaseSession(id) {
    const service = this.sessions.get(id); if (!service) return;
    this.retiring.add(id);
    try { await service.close(); this.sessions.delete(id); this.sessionOwners.delete(id); }
    finally { this.retiring.delete(id); }
  }
  async checkpoint(row, operation) {
    const root = this.library.location(row.user_id, row.id), id = randomUUID(), backup = this.backup(id);
    this.approved(root);
    const disk = fs.statfsSync(this.backups), free = Number(disk.bavail) * Number(disk.bsize);
    if (free < treeBytes(root) + 256 * 1024 ** 2) throw new CloudError(507, '磁盘安全余量不足，暂时不能保存或加载更多内容');
    fs.cpSync(root, backup, { recursive: true, filter: file => !path.relative(root, file).split(path.sep).includes('.temp') && path.relative(root, file) !== path.join('.state', 'host.lock') });
    this.db.prepare('INSERT INTO cloud_practice_writes VALUES (?,?,?)').run(id, row.user_id, row.id);
    let committed = false, reservation;
    try {
      const result = await operation();
      this.approved(root);
      const mergedRows = result.mergedRows || [];
      const bytes = treeBytes(root, { ignoreTemp: true, ignorePlatform: true }), delta = bytes - row.bytes - mergedRows.reduce((sum, item) => sum + item.bytes, 0);
      const updatedCatalog = result.catalogUpdate;
      if (delta > 0) reservation = this.accounts.reserveStorage(row.user_id, delta);
      this.accounts.transaction(() => {
        if (delta > 0) this.accounts.commitStorage(row.user_id, reservation, delta, { transaction: false });
        if (delta < 0) this.accounts.removeStorage(row.user_id, -delta, { transaction: false });
        if (updatedCatalog) this.db.prepare('UPDATE cloud_imports SET bytes=?,catalog=?,title=? WHERE id=?').run(bytes, JSON.stringify(updatedCatalog), updatedCatalog.banks.length === 1 ? updatedCatalog.banks[0].title || row.title : row.title, row.id);
        else this.db.prepare('UPDATE cloud_imports SET bytes=? WHERE id=?').run(bytes, row.id);
        for (const previous of mergedRows) {
          this.db.prepare('INSERT INTO cloud_workspace_members VALUES (?,?,?,?,?)').run(previous.id, row.user_id, row.id, previous.source, previous.catalog);
          this.db.prepare("UPDATE cloud_imports SET status='merged',bytes=0 WHERE id=? AND user_id=?").run(previous.id, row.user_id);
        }
        if (result.workspaceMember) this.db.prepare('INSERT INTO cloud_workspace_members VALUES (?,?,?,?,?)').run(result.workspaceMember.id, row.user_id, row.id, JSON.stringify(result.workspaceMember.source), JSON.stringify(result.workspaceMember.result));
        if (result.deliveryAudit) this.accounts.audit(result.deliveryAudit.actorId, row.user_id, 'private-delivery', {}, { importId: row.id, title: result.deliveryAudit.filename, bytes }, '管理员向指定用户交付私人题库');
        this.db.prepare('DELETE FROM cloud_practice_writes WHERE id=?').run(id);
      });
      committed = true; return result;
    } finally {
      if (!committed) {
        await this.releaseSession(row.id);
        this.library.remove(root); fs.renameSync(backup, root);
        this.db.prepare('DELETE FROM cloud_practice_writes WHERE id=?').run(id);
        if (reservation) this.accounts.releaseStorage(row.user_id, reservation);
      } else this.library.remove(backup);
    }
  }
  async api(userId, importId, pathname, request) {
    const importing = pathname.split('?')[0] === '/api/library/import';
    if (importing && this.uploading.has(userId)) throw new CloudError(503, '另一份题库正在上传，请稍后重试');
    if (importing) this.uploading.add(userId);
    try { return await this.scopedApi(userId, importId, pathname, request); }
    finally { if (importing) this.uploading.delete(userId); }
  }
  async scopedApi(userId, importId, pathname, request) {
    const route = pathname.split('?')[0], importing = route === '/api/library/import', managing = route === '/api/library/manage' || importing;
    if (!pathname.startsWith('/api/') || /^\/api\/(?:auth|settings\/(?!ai$|development$)|development|library\/export)/.test(route) || route.startsWith('/api/library/import/') || managing && request.method !== 'POST') throw new CloudError(403, '此操作请从 Hub 的云端空间完成');
    if (pathname.startsWith('/api/settings/') && request.method !== 'GET') throw new CloudError(403, '云端设置请在 Hub 中管理');
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) throw new CloudError(405, '请求方法不受支持');
    let body;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { if ((bytes += chunk.length) > (importing ? 64 : 8) * 1024 ** 2) throw new CloudError(413, '请求内容超过大小上限'); chunks.push(chunk); }
      body = Buffer.concat(chunks);
    }
    return this.serial(userId, async () => {
      const row = this.library.owned(userId, importId);
      try { return await this.checkpoint(row, async () => {
        const service = await this.session(row), port = service.port(), headers = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` };
        for (const name of ['content-type', 'x-quizforge-filename', 'x-quizforge-practice-session', 'x-quizforge-question-stamp', 'x-quizforge-transient-resource', 'x-quizforge-cloud-ai']) if (request.headers[name]) headers[name] = request.headers[name];
        if (body) headers['Content-Length'] = body.length;
        const result = await new Promise((resolve, reject) => {
          // Checkpoint file work can outlive the core's idle connection timeout.
          // Open a fresh loopback connection; never retry a possibly saved write.
          const outgoing = http.request({ hostname: '127.0.0.1', port, path: pathname, method: request.method, headers, agent: false, timeout: 120000 }, incoming => {
            const chunks = []; let bytes = 0;
            incoming.on('data', chunk => { if ((bytes += chunk.length) > 32 * 1024 ** 2) outgoing.destroy(new Error('Practice response limit')); else chunks.push(chunk); });
            incoming.once('end', () => resolve({ status: incoming.statusCode, type: incoming.headers['content-type'], bytes: Buffer.concat(chunks) })); incoming.once('error', reject);
          });
          outgoing.once('timeout', () => outgoing.destroy(new Error('Practice request timeout'))); outgoing.once('error', reject); outgoing.end(body);
        });
        await Promise.allSettled([...service.handlers]);
        if (managing) {
          if (result.status >= 400) throw Object.assign(new Error('Practice request rejected'), { practiceResponse: result });
          result.catalogUpdate = JSON.parse(result.bytes).catalog;
        }
        return result;
      }); } catch (error) { if (error.practiceResponse) return error.practiceResponse; throw error; }
    });
  }
  asset(userId, importId, file, { ordinary = false } = {}) {
    this.library.owned(userId, importId);
    if (file === '') file = 'index.html';
    if (file === 'favicon.ico') file = 'assets/quizforge-icon.png';
    if (file.includes('\\') || file.includes('\0') || path.isAbsolute(file) || file.split('/').some(name => name === '..' || name.startsWith('.'))) throw new CloudError(404, '页面不存在');
    const root = publicSharedModules.has(file) ? this.library.runtime.core : path.join(this.library.runtime.core, 'web'), target = path.resolve(root, file), relative = path.relative(root, target), type = types[path.extname(file)];
    if (!type || relative.startsWith('..') || !fs.existsSync(target) || !fs.statSync(target).isFile() || fs.statSync(target).size > 4 * 1024 ** 2) throw new CloudError(404, '页面资源不存在');
    let bytes = fs.readFileSync(target);
    const prefix = `/api/cloud/practice/${importId}`, base = `/cloud/practice/${importId}`;
    if (file.endsWith('.js')) bytes = Buffer.from(bytes.toString('utf8').replace(/((?:from\s*|import\s*(?:\(\s*)?)['"])(\.[^'"\n]+)(['"])/g, (match, before, specifier, after) => {
      const shared = path.relative(this.library.runtime.core, path.resolve(path.dirname(target), specifier)).replaceAll('\\', '/');
      return publicSharedModules.has(shared) ? before + base + '/' + shared + after : match;
    }));
    if (ordinary && ['app.js', 'index.html', 'shell/appearance.js', 'shell/themes.css', 'library/library-transfer.js'].includes(file)) bytes = Buffer.from(ordinaryPracticeAsset(file, bytes.toString('utf8'), base));
    if (ordinary && file === 'manifest.webmanifest') {
      const manifest = JSON.parse(bytes);
      manifest.name = 'QuizForge Hub'; manifest.description = '你的云端刷题空间，题库与作答保存在账户中。';
      for (const icon of manifest.icons || []) if (icon.src.startsWith('/assets/')) icon.src = base + icon.src;
      bytes = Buffer.from(JSON.stringify(manifest));
    }
    if (file === 'shared/api.js') {
      let code = bytes.toString('utf8');
      if (!code.includes('await fetch(path,') || !code.includes('await fetch(`/api/')) throw new Error('Pinned Web API adapter changed; restage and update cloud adapter');
      code = code.replace('await fetch(path,', `await fetch(${JSON.stringify(prefix)} + path,`).replace('await fetch(`/api/', 'await fetch(`' + prefix + '/api/');
      code = "import {cloudAiHeaders,observeCloudAi,cloudAiPreferencesReady} from '/cloud/ai-client.js';\n" + code;
      code = code.replace("if (accessToken) headers", (ordinary ? 'await cloudAiPreferencesReady();' : '') + "Object.assign(headers,cloudAiHeaders());\n  if (accessToken) headers");
      code = code.replace('return result;', `observeCloudAi(result,${JSON.stringify(prefix)},headers,path);return result;`);
      bytes = Buffer.from(code);
    }
    if (file === 'index.html') {
      let html = bytes.toString('utf8').replace(/\b(href|src)="\/(?!\/|cloud\/|auth\/)/g, `$1="${base}/`);
      if (!ordinary) html = html.replace('</head>', `<link rel="stylesheet" href="/cloud/practice.css"></head>`).replace('<body>', `<body><nav class="hub-practice-nav"><a href="/cloud/">← 我的云端题库</a><span>QuizForge Hub</span><a href="/cloud/ai">本地 AI 设置</a></nav>`);
      bytes = Buffer.from(html);
    }
    return { status: 200, type, bytes };
  }
  async close() {
    this.closed = true; await Promise.all([...this.lanes.values()].map(lane => lane.tail)); await this.sessionTail;
    await Promise.all([...this.sessions.keys()].map(id => this.releaseSession(id))); this.sessions.clear(); this.sessionOwners.clear();
  }
}
