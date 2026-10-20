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
export class CloudPractice {
  constructor(library) {
    this.library = library; this.db = library.db; this.accounts = library.accounts; this.sessions = new Map(); this.pending = 0; this.tail = Promise.resolve(); this.closed = false;
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
  async serial(operation) {
    if (this.closed || this.pending >= 16) throw new CloudError(503, '云端练习请求较多，请稍后重试，当前输入仍保留');
    this.pending++;
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    try { return await result; } finally { this.pending--; }
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
    if (this.sessions.has(row.id)) {
      const value = this.sessions.get(row.id); this.sessions.delete(row.id); this.sessions.set(row.id, value); return value;
    }
    while (this.sessions.size >= 2) {
      const [id, value] = this.sessions.entries().next().value;
      await value.close(); this.sessions.delete(id);
    }
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
      if (pathname === '/api/library/manage' && context.request.method === 'POST') {
        const input = await service.writeRequest(context);
        if (input?.kind !== 'bank') throw new ApiError(403, 'CLOUD_BANK_MANAGEMENT_ONLY', '云端只能管理自己的题库与题库分组');
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
    await attachCloudAi(service, r);
    service.ready = true;
    this.sessions.set(row.id, service); return service;
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
      const bytes = treeBytes(root, { ignoreTemp: true, ignorePlatform: true }), delta = bytes - row.bytes;
      const updatedCatalog = result.catalogUpdate;
      if (delta > 0) reservation = this.accounts.reserveStorage(row.user_id, delta);
      this.accounts.transaction(() => {
        if (delta > 0) this.accounts.commitStorage(row.user_id, reservation, delta, { transaction: false });
        if (delta < 0) this.accounts.removeStorage(row.user_id, -delta, { transaction: false });
        if (updatedCatalog) this.db.prepare('UPDATE cloud_imports SET bytes=?,catalog=?,title=? WHERE id=?').run(bytes, JSON.stringify(updatedCatalog), updatedCatalog.banks.length === 1 ? updatedCatalog.banks[0].title || row.title : row.title, row.id);
        else this.db.prepare('UPDATE cloud_imports SET bytes=? WHERE id=?').run(bytes, row.id);
        this.db.prepare('DELETE FROM cloud_practice_writes WHERE id=?').run(id);
      });
      committed = true; return result;
    } finally {
      if (!committed) {
        const service = this.sessions.get(row.id);
        if (service) { await service.close(); this.sessions.delete(row.id); }
        this.library.remove(root); fs.renameSync(backup, root);
        this.db.prepare('DELETE FROM cloud_practice_writes WHERE id=?').run(id);
        if (reservation) this.accounts.releaseStorage(row.user_id, reservation);
      } else this.library.remove(backup);
    }
  }
  async api(userId, importId, pathname, request) {
    const route = pathname.split('?')[0], managing = route === '/api/library/manage';
    if (!pathname.startsWith('/api/') || /^\/api\/(?:auth|settings\/(?!ai$|development$)|development|library\/(?:import|export))/.test(route) || managing && request.method !== 'POST') throw new CloudError(403, '此操作请从 Hub 的云端空间完成');
    if (pathname.startsWith('/api/settings/') && request.method !== 'GET') throw new CloudError(403, '云端设置请在 Hub 中管理');
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) throw new CloudError(405, '请求方法不受支持');
    let body;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { if ((bytes += chunk.length) > 8 * 1024 ** 2) throw new CloudError(413, '保存内容超过 8 MiB 上限'); chunks.push(chunk); }
      body = Buffer.concat(chunks);
    }
    return this.serial(async () => {
      const row = this.library.owned(userId, importId);
      try { return await this.checkpoint(row, async () => {
        const service = await this.session(row), port = service.port(), headers = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` };
        for (const name of ['content-type', 'x-quizforge-practice-session', 'x-quizforge-question-stamp', 'x-quizforge-transient-resource', 'x-quizforge-cloud-ai']) if (request.headers[name]) headers[name] = request.headers[name];
        if (body) headers['Content-Length'] = body.length;
        const result = await new Promise((resolve, reject) => {
          const outgoing = http.request({ hostname: '127.0.0.1', port, path: pathname, method: request.method, headers, timeout: 120000 }, incoming => {
            const chunks = []; let bytes = 0;
            incoming.on('data', chunk => { if ((bytes += chunk.length) > 32 * 1024 ** 2) outgoing.destroy(new Error('Practice response limit')); else chunks.push(chunk); });
            incoming.once('end', () => resolve({ status: incoming.statusCode, type: incoming.headers['content-type'], bytes: Buffer.concat(chunks) })); incoming.once('error', reject);
          });
          outgoing.once('timeout', () => outgoing.destroy(new Error('Practice request timeout'))); outgoing.once('error', reject); outgoing.end(body);
        });
        await Promise.allSettled([...service.handlers]);
        if (managing) {
          if (result.status >= 400) throw Object.assign(new Error('Bank management rejected'), { practiceResponse: result });
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
    const root = path.join(this.library.runtime.core, 'web'), target = path.resolve(root, file), relative = path.relative(root, target), type = types[path.extname(file)];
    if (!type || relative.startsWith('..') || !fs.existsSync(target) || !fs.statSync(target).isFile() || fs.statSync(target).size > 4 * 1024 ** 2) throw new CloudError(404, '页面资源不存在');
    let bytes = fs.readFileSync(target);
    const prefix = `/api/cloud/practice/${importId}`, base = `/cloud/practice/${importId}`;
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
      code = "import {cloudAiHeaders,observeCloudAi} from '/cloud/ai-client.js';\n" + code;
      code = code.replace("if (accessToken) headers", "Object.assign(headers,cloudAiHeaders());\n  if (accessToken) headers");
      code = code.replace('return result;', `observeCloudAi(result,${JSON.stringify(prefix)},headers);return result;`);
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
    this.closed = true; await this.tail;
    await Promise.all([...this.sessions.values()].map(service => service.close())); this.sessions.clear();
  }
}
