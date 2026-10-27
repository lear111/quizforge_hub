import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CloudError } from './accounts.mjs';
import { ExtensionReviews } from './extension-review.mjs';
import { loadRuntime } from './runtime.mjs';
import { CloudPractice } from './practice.mjs';
import { mergeWorkspace } from './workspace.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const MAX_INSTALLED = 192 * 1024 ** 2;
export function treeBytes(directory, { ignoreTemp = false, ignorePlatform = false } = {}) {
  let bytes = 0, count = 0;
  function visit(item) {
    const relative = path.relative(directory, item).replaceAll('\\', '/');
    if (ignorePlatform && (relative === '.state/host.lock' || relative === '.state/validation-cache' || relative.startsWith('.state/validation-cache/'))) return;
    const stat = fs.lstatSync(item);
    if (++count > 40000 || stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new CloudError(422, '题库目录包含无效内容');
    if (stat.isFile()) { bytes += stat.size; return; }
    for (const name of fs.readdirSync(item)) if (!ignoreTemp || name !== '.temp') visit(path.join(item, name));
  }
  visit(directory); return bytes;
}
export class CloudLibrary {
  static async create(db, accounts, dataDir, runtimeDirectory, { unifiedWorkspace = false, hubAi = null } = {}) {
    const runtime = await loadRuntime(runtimeDirectory), review = new ExtensionReviews(db, runtime.manifest.builtins);
    const result = new CloudLibrary(db, accounts, dataDir, runtime, review);
    let engine;
    try { engine = await runtime.RuleEngine.create(runtime.core); }
    catch (error) { result.releaseLock(); throw error; }
    if (!engine.permissions) { engine.close(); result.releaseLock(); throw new Error('Cloud runtime requires Node permission restrictions'); }
    result.rawEngine = engine;
    result.engine = {
      run: (extension, input) => { review.verify(extension.directory); return engine.run(extension, input); },
      validationEnvironment: () => engine.validationEnvironment(), background: fn => engine.background(fn),
    };
    result.practice = new CloudPractice(result);
    result.unifiedWorkspace = unifiedWorkspace; result.hubAi = hubAi;
    return result;
  }
  constructor(db, accounts, dataDir, runtime, reviews) {
    this.db = db; this.accounts = accounts; this.runtime = runtime; this.reviews = reviews; this.active = false;
    this.defaultImports = new Map(); this.defaultImportTail = Promise.resolve();
    this.root = path.join(path.resolve(dataDir), 'cloud-content');
    this.work = path.join(this.root, 'staging'); this.users = path.join(this.root, 'users');
    fs.mkdirSync(this.work, { recursive: true, mode: 0o700 }); fs.mkdirSync(this.users, { recursive: true, mode: 0o700 });
    this.lock = path.join(this.root, 'host.lock'); this.nonce = randomUUID();
    if (fs.existsSync(this.lock)) {
      const previous = JSON.parse(fs.readFileSync(this.lock, 'utf8'));
      if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('Cloud host lock invalid; preserve for inspection');
      let alive = true; try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Cloud data directory is already open by another host');
      fs.unlinkSync(this.lock);
    }
    fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, nonce: this.nonce }), { flag: 'wx', mode: 0o600 });
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_imports (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), actor_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, reservation_id TEXT, title TEXT NOT NULL, bytes INTEGER NOT NULL, catalog TEXT NOT NULL, source TEXT NOT NULL, created INTEGER NOT NULL)`);
    db.exec('CREATE TABLE IF NOT EXISTS cloud_workspace_members(import_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,workspace_id TEXT NOT NULL,source TEXT NOT NULL,catalog TEXT NOT NULL)');
    this.trash = path.join(this.root, 'trash'); fs.mkdirSync(this.trash, { recursive: true, mode: 0o700 });
    for (const row of db.prepare("SELECT * FROM cloud_imports WHERE status='deleting'").all()) {
      const target = this.location(row.user_id, row.id), trash = path.join(this.trash, row.id);
      if (!fs.existsSync(target) && fs.existsSync(trash)) fs.renameSync(trash, target);
      if (!fs.existsSync(target)) throw new Error('Cloud deletion recovery data missing; preserve for inspection');
      db.prepare("UPDATE cloud_imports SET status='ready' WHERE id=?").run(row.id);
    }
    for (const name of fs.readdirSync(this.trash)) { if (!uuid(name)) throw new Error('Unexpected cloud trash entry'); this.remove(path.join(this.trash, name)); }
    // A pre-commit crash can leave a renamed directory or a staging tree. They
    // were never acknowledged to the user and must not become usable or billed.
    for (const row of db.prepare("SELECT * FROM cloud_imports WHERE status='preparing'").all()) {
      this.remove(this.location(row.user_id, row.id));
      accounts.releaseStorage(row.user_id, row.reservation_id);
      db.prepare('DELETE FROM cloud_imports WHERE id=?').run(row.id);
    }
    for (const name of fs.readdirSync(this.work)) { if (!uuid(name)) throw new Error('Unexpected cloud staging entry; preserve for inspection'); this.remove(path.join(this.work, name)); }
  }
  location(userId, importId) {
    if (!uuid(userId) || !uuid(importId)) throw new CloudError(400, '无效的云端题库编号');
    const alias = this.db.prepare('SELECT workspace_id FROM cloud_workspace_members WHERE import_id=? AND user_id=?').get(importId, userId);
    if (alias) importId = alias.workspace_id;
    return path.join(this.users, userId, importId);
  }
  remove(directory) {
    const resolved = path.resolve(directory), relative = path.relative(this.root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe cloud cleanup path');
    if (fs.existsSync(resolved)) { treeBytes(resolved); fs.rmSync(resolved, { recursive: true }); }
  }
  list(userId) {
    return this.db.prepare("SELECT * FROM cloud_imports WHERE user_id=? AND status='ready' ORDER BY created DESC,id DESC").all(userId).map(row => ({ id: row.id, title: row.title, bytes: row.bytes, created: row.created, source: JSON.parse(row.source), banks: JSON.parse(row.catalog).banks, extensions: JSON.parse(row.catalog).extensions, practiceReady: !!this.practice }));
  }
  owned(userId, id) {
    if (!uuid(id)) throw new CloudError(404, '云端题库不存在');
    const alias = this.db.prepare('SELECT workspace_id FROM cloud_workspace_members WHERE import_id=? AND user_id=?').get(id, userId);
    if (alias) id = alias.workspace_id;
    return this.db.prepare("SELECT * FROM cloud_imports WHERE id=? AND user_id=? AND status='ready'").get(id, userId) || (() => { throw new CloudError(404, '云端题库不存在'); })();
  }
  async install(userId, actorId, input, filename, source = { kind: 'private' }) {
    this.accounts.ensure(userId); this.accounts.ensure(actorId);
    if (userId !== actorId && !this.db.prepare('SELECT admin FROM users WHERE id=?').get(actorId)?.admin) throw new CloudError(403, '仅管理员可向指定用户导入题库');
    if (this.unifiedWorkspace && source.kind !== 'builtin-demo') return this.appendToWorkspace(userId, actorId, input, filename, source);
    if (this.active) throw new CloudError(503, '另一份云端题库正在导入，请稍后再试');
    if (this.db.prepare("SELECT COUNT(*) AS n FROM cloud_imports WHERE user_id=? AND status='ready'").get(userId).n >= 100) throw new CloudError(413, '当前账户已达到 100 份导入上限');
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.qbank') || filename.length > 240) throw new CloudError(400, '请选择 .qbank 文件');
    if (source.kind === 'hub' && this.db.prepare("SELECT id FROM cloud_imports WHERE user_id=? AND status='ready' AND json_extract(source,'$.kind')='hub' AND json_extract(source,'$.packId')=? AND json_extract(source,'$.revision')=?").get(userId, source.packId, source.revision) && !source.newCopy) throw new CloudError(409, '此版本已在云端，请打开已有副本；需要独立练习时可选择再次导入');
    const space = fs.statfsSync(this.work), available = Number(space.bavail) * Number(space.bsize);
    if (available < 512 * 1024 ** 2) throw new CloudError(507, '服务器磁盘安全余量不足，暂时无法导入');
    this.active = true;
    const id = randomUUID(), job = path.join(this.work, id), destination = this.location(userId, id);
    let reservation, inserted = false, committed = false;
    try {
      fs.mkdirSync(job, { mode: 0o700 });
      const r = this.runtime, resources = new r.ResourceStore(job), archive = new r.LibraryArchive(job, resources);
      const result = await archive.importPackage(input, async staging => {
        // No validation engine or extension page is reached before all digests
        // have been accepted. The rule adapter rechecks each actual execution.
        for (const directory of r.scanExtensions(path.join(staging, 'extensions'))) this.reviews.verify(directory);
        const candidate = new r.Library(staging, r.core, this.engine);
        try { await r.validateImportLibrary(candidate); } finally { candidate.close(); }
      }, filename);
      const library = new r.Library(job, r.core, this.engine);
      let catalog; try { catalog = await library.catalog(); } finally { library.close(); }
      // Drop importer/validation caches. The uploaded archive has already been
      // removed in LibraryArchive.finally; only expanded installed data remains.
      for (const name of ['.temp']) this.remove(path.join(job, name));
      const bytes = treeBytes(job, { ignorePlatform: true });
      if (bytes > MAX_INSTALLED) throw new CloudError(413, '安装后的题库内容超过 192 MiB，请拆分题库');
      reservation = this.accounts.reserveStorage(userId, bytes, 600000);
      this.db.prepare('INSERT INTO cloud_imports VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, userId, actorId, 'preparing', reservation, result.name, bytes, JSON.stringify(catalog), JSON.stringify(source), Date.now()); inserted = true;
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); fs.renameSync(job, destination);
      this.accounts.transaction(() => {
        this.accounts.commitStorage(userId, reservation, bytes, { transaction: false });
        this.db.prepare("UPDATE cloud_imports SET status='ready',reservation_id=NULL WHERE id=?").run(id);
        if (source.kind === 'admin-delivery') this.accounts.audit(actorId, userId, 'private-delivery', {}, { importId: id, title: result.name, bytes }, '管理员向指定用户交付私人题库');
      });
      committed = true;
      return this.list(userId).find(item => item.id === id);
    } catch (error) {
      if (!committed) {
        this.remove(job); this.remove(destination);
        if (reservation) this.accounts.releaseStorage(userId, reservation);
        if (inserted) this.db.prepare('DELETE FROM cloud_imports WHERE id=?').run(id);
      }
      if (error instanceof CloudError) throw error;
      if (error?.status && error.status < 500) throw new CloudError(error.status, error.message);
      throw Object.assign(new CloudError(422, '云端题库导入失败，原有题库与作答未修改'), { cause: error });
    } finally { this.active = false; }
  }
  async installFile(userId, actorId, file, filename, source) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024 ** 2) throw new CloudError(413, '题库文件超过导入大小上限');
    const bytes = fs.readFileSync(file);
    if (source?.sha256 && createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new CloudError(422, '题库文件校验失败，请重新下载');
    return this.install(userId, actorId, bytes, filename, source);
  }
  async demo(userId) {
    return this.installFile(userId, userId, path.join(this.runtime.root, 'basic-demo.qbank'), '基础题型示例.qbank', { kind: 'builtin-demo' });
  }
  async ensureDemo(userId) {
    const existing = this.list(userId).findLast(item => item.source.kind === 'builtin-demo');
    if (existing) return this.unifiedWorkspace ? this.consolidate(userId, existing.id) : existing;
    if (!this.defaultImports.has(userId)) {
      if (this.defaultImports.size >= 16) throw new CloudError(503, '正在准备其他用户的基础题库，请稍后刷新');
      const next = this.defaultImportTail.then(() => this.list(userId).findLast(item => item.source.kind === 'builtin-demo') || this.demo(userId));
      this.defaultImportTail = next.catch(() => {});
      this.defaultImports.set(userId, next.finally(() => this.defaultImports.delete(userId)));
    }
    const item = await this.defaultImports.get(userId);
    return this.unifiedWorkspace ? this.consolidate(userId, item.id) : item;
  }
  async consolidate(userId, workspaceId) {
    return this.practice.serial(userId, async () => {
      const workspace = this.owned(userId, workspaceId), others = this.db.prepare("SELECT * FROM cloud_imports WHERE user_id=? AND status='ready' AND id<>? ORDER BY created,id").all(userId, workspace.id);
      if (others.length) {
        for (const row of [workspace, ...others]) await this.practice.releaseSession(row.id);
        await this.practice.checkpoint(workspace, async () => ({ mergedRows: others, catalogUpdate: await mergeWorkspace(this, workspace, others) }));
      }
      return this.list(userId).find(item => item.id === workspace.id);
    });
  }
  findHubImport(userId, packId, revision) {
    const items = this.list(userId);
    const members = this.db.prepare("SELECT workspace_id,catalog FROM cloud_workspace_members WHERE user_id=? AND json_extract(source,'$.kind')='hub' AND json_extract(source,'$.packId')=? AND json_extract(source,'$.revision')=?").all(userId, packId, revision);
    for (const member of members) {
      const workspace = items.find(item => item.id === member.workspace_id), bankIds = new Set((JSON.parse(member.catalog).banks || []).map(bank => bank.id));
      const bank = workspace?.banks.find(bank => bankIds.has(bank.id));
      if (bank) return { ...workspace, importedBankId: bank.id };
    }
    const existing = items.find(item => item.source.kind === 'hub' && item.source.packId === packId && item.source.revision === revision);
    return existing ? { ...existing, importedBankId: existing.banks[0]?.id } : undefined;
  }
  async appendToWorkspace(userId, actorId, input, filename, source) {
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.qbank') || filename.length > 240) throw new CloudError(400, '请选择 .qbank 文件');
    const workspace = await this.ensureDemo(userId);
    return this.practice.serial(userId, async () => {
      if (source.kind === 'hub' && !source.newCopy && this.findHubImport(userId, source.packId, source.revision)) throw new CloudError(409, '此版本已在云端，请打开已有题库');
      const row = this.owned(userId, workspace.id), root = this.location(userId, row.id), r = this.runtime;
      await this.practice.releaseSession(row.id);
      let importedBankId;
      await this.practice.checkpoint(row, async () => {
        const archive = new r.LibraryArchive(root, new r.ResourceStore(root));
        const result = await archive.importPackage(input, async staging => {
          for (const directory of r.scanExtensions(path.join(staging, 'extensions'))) this.reviews.verify(directory);
          const candidate = new r.Library(staging, r.core, this.engine); try { await r.validateImportLibrary(candidate); } finally { candidate.close(); }
        }, filename);
        const library = new r.Library(root, r.core, this.engine);
        let catalog; try { catalog = await library.catalog(); } finally { library.close(); }
        const previousIds = new Set(JSON.parse(row.catalog).banks.map(bank => bank.id)), banks = catalog.banks.filter(bank => !previousIds.has(bank.id));
        importedBankId = banks[0]?.id;
        return { catalogUpdate: catalog, workspaceMember: { id: randomUUID(), source, result: { ...result, banks } }, ...(source.kind === 'admin-delivery' ? { deliveryAudit: { actorId, filename } } : {}) };
      });
      return { ...this.list(userId).find(item => item.id === row.id), importedBankId };
    }).catch(error => {
      if (error instanceof CloudError) throw error;
      throw new CloudError(error.status && error.status < 500 ? error.status : 422, error.status && error.status < 500 ? error.message : '云端题库导入失败，原有题库与作答未修改');
    });
  }
  async export(userId, importId, selection = null) {
    return this.practice.serial(userId, () => this.exportSelection(userId, importId, selection));
  }
  async exportSelection(userId, importId, selection) {
    const row = this.owned(userId, importId), root = this.location(userId, importId), r = this.runtime;
    this.practice.approved(root);
    const reader = new r.Library(root, r.core, this.engine);
    let catalog; try { catalog = await reader.catalog(); } finally { reader.close(); }
    const archive = new r.LibraryArchive(root, new r.ResourceStore(root));
    let single, value;
    if (selection !== null) {
      if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).length !== 1 || !['bank', 'group'].includes(Object.keys(selection)[0])) throw new CloudError(400, '请选择一个题库或题库分组导出');
      single = Object.hasOwn(selection, 'bank'); value = selection[single ? 'bank' : 'group'];
      if (typeof value !== 'string' || !(single ? catalog.banks.some(bank => bank.path === value) : catalog.groups.banks.includes(value))) throw new CloudError(404, '题库或分组不存在');
    } else if (catalog.banks.length === 1) { single = true; value = catalog.banks[0].path; }
    else if (catalog.groups.banks.length === 1) { single = false; value = catalog.groups.banks[0]; }
    else throw new CloudError(422, '请选择具体题库或分组导出');
    const result = single ? await archive.exportBank(value) : await archive.exportGroup(value);
    return { ...result, bytes: fs.statSync(result.file).size };
  }
  async delete(userId, importId) {
    return this.practice.serial(userId, async () => {
      const row = this.owned(userId, importId), target = this.location(userId, row.id), trash = path.join(this.trash, row.id);
      if (row.id !== importId) throw new CloudError(409, '此题库已合并到工作区，请在题库列表中删除指定题库');
      await this.practice.releaseSession(row.id);
      this.db.prepare("UPDATE cloud_imports SET status='deleting' WHERE id=?").run(row.id);
      let moved = false, committed = false;
      try {
        fs.renameSync(target, trash); moved = true;
        this.accounts.transaction(() => {
          this.accounts.removeStorage(userId, row.bytes, { transaction: false });
          this.db.prepare('DELETE FROM cloud_workspace_members WHERE workspace_id=? AND user_id=?').run(row.id, userId);
          this.db.prepare('DELETE FROM cloud_imports WHERE id=?').run(row.id);
        });
        committed = true; this.remove(trash); return { deleted: true };
      } finally {
        if (!committed) {
          if (moved) fs.renameSync(trash, target);
          this.db.prepare("UPDATE cloud_imports SET status='ready' WHERE id=?").run(row.id);
        }
      }
    });
  }
  releaseLock() {
    if (this.lock && fs.existsSync(this.lock) && JSON.parse(fs.readFileSync(this.lock, 'utf8')).nonce === this.nonce) fs.unlinkSync(this.lock);
  }
  async close() { await this.practice?.close(); this.rawEngine?.close(); this.releaseLock(); }
}
