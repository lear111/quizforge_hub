import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { crc32 } from 'node:zlib';
import { extensionDigest } from '../cloud/extension-review.mjs';
import { treeBytes } from '../cloud/library.mjs';
import { CloudError } from '../cloud/accounts.mjs';
import { bytes, reason, uuid } from './common.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export class ReviewPackages {
  constructor(library) {
    this.library = library; this.db = library.db; this.runtime = library.runtime; this.active = false;
    this.root = path.join(path.dirname(library.root), 'extension-submissions');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.db.exec(`CREATE TABLE IF NOT EXISTS extension_submissions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,filename TEXT NOT NULL,sha256 TEXT NOT NULL,source TEXT NOT NULL,extensions TEXT NOT NULL,bytes INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,reviewer TEXT,created INTEGER NOT NULL,reviewed INTEGER);
      CREATE TABLE IF NOT EXISTS extension_review_names(digest TEXT PRIMARY KEY,name TEXT NOT NULL);`);
    // Uncommitted upload directories are never used as review records.
    for (const name of fs.readdirSync(this.root)) if (uuid(name) && !this.db.prepare('SELECT 1 FROM extension_submissions WHERE id=?').get(name)) fs.rmSync(path.join(this.root, name), { recursive: true, force: true });
  }
  row(id) { if (!uuid(id)) throw new CloudError(404, '审核申请不存在'); const row = this.db.prepare('SELECT * FROM extension_submissions WHERE id=?').get(id); if (!row) throw new CloudError(404, '审核申请不存在'); return row; }
  info(row) { return { ...row, source: JSON.parse(row.source), extensions: JSON.parse(row.extensions).map(e => ({ ...e, status: this.db.prepare('SELECT status FROM cloud_extension_reviews WHERE digest=?').get(e.digest)?.status || 'unknown' })) }; }
  list(userId = null) { return (userId ? this.db.prepare('SELECT * FROM extension_submissions WHERE user_id=? ORDER BY created DESC LIMIT 100').all(userId) : this.db.prepare('SELECT * FROM extension_submissions ORDER BY created DESC LIMIT 200').all()).map(row => this.info(row)); }
  async receive(user, req, filename, source) {
    if (this.receiving || this.active) throw new CloudError(503, '另一个拓展包正在上传或解包，请稍后重试');
    this.receiving = true;
    try { return await this.submit(user, await bytes(req), filename, source); }
    finally { this.receiving = false; }
  }
  async unpackZip(file, destination) {
    const require = createRequire(path.join(this.runtime.core, 'package.json')), yauzl = require('yauzl');
    const archive = await yauzl.openPromise(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    let count = 0, total = 0; const seen = new Set();
    try {
      for await (const entry of archive.eachEntry()) {
        const isDir = entry.fileName.endsWith('/'), name = isDir ? entry.fileName.slice(0, -1) : entry.fileName, parts = name.split('/'), mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (++count > 10000 || parts.length > 32 || parts.some(p => !p.trim() || p === '.' || p === '..' || /[\\:*?"<>|\x00-\x1f\x7f-\x9f]/.test(p) || /[ .]$/.test(p) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(p)) || seen.has(name.toLowerCase()) || entry.generalPurposeBitFlag & 1 || ![0, 0x8000, 0x4000].includes(mode) || mode === 0x4000 && !isDir || mode === 0x8000 && isDir) throw new CloudError(422, '拓展压缩包包含无效、重复或越界路径');
        seen.add(name.toLowerCase());
        const target = path.join(destination, ...parts);
        if (isDir) { fs.mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
        if (entry.uncompressedSize > 8 * 1024 ** 2) throw new CloudError(413, '拓展单个文件超过 8 MiB');
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        let size = 0, crc = 0;
        await pipeline(await archive.openReadStreamPromise(entry), new Transform({ transform(chunk, _, cb) { size += chunk.length; total += chunk.length; crc = crc32(chunk, crc); cb(size > 8 * 1024 ** 2 || total > 128 * 1024 ** 2 ? new CloudError(413, '拓展解压内容超过限制') : null, chunk); } }), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        if (crc !== entry.crc32 >>> 0) throw new CloudError(422, '拓展压缩包文件校验失败');
      }
    } finally { archive.close(); }
  }
  async submit(user, buffer, filename, source = { kind: 'private' }) {
    if (this.active) throw new CloudError(503, '另一个拓展包正在处理，请稍后重试');
    if (!/\.(qbank|zip)$/i.test(filename)) throw new CloudError(415, '请上传格式 3 的 .qbank 或拓展 .zip 包');
    if (buffer.length > 64 * 1024 ** 2) throw new CloudError(413, '审核包超过 64 MiB');
    if (this.db.prepare('SELECT COUNT(*) AS n FROM extension_submissions').get().n >= 200 || this.db.prepare("SELECT COUNT(*) AS n FROM extension_submissions WHERE user_id=? AND status='pending'").get(user.id).n >= 10) throw new CloudError(429, '审核申请数量已达上限，请先处理已有申请');
    const available = fs.statfsSync(this.root); if (Number(available.bavail) * Number(available.bsize) < 512 * 1024 ** 2) throw new CloudError(507, '服务器磁盘安全余量不足');
    const id = randomUUID(), root = path.join(this.root, id), work = path.join(root, 'work');
    this.active = true;
    try {
      fs.mkdirSync(work, { recursive: true, mode: 0o700 });
      let directories = [], bankCount = 0;
      if (/\.qbank$/i.test(filename)) {
        const archive = new this.runtime.LibraryArchive(work, new this.runtime.ResourceStore(work));
        // Use the pinned bounded ZIP decoder, but never the normal importer:
        // import validation may execute rules or initialize resource caches.
        const zip = path.join(root, 'source.qbank'); fs.writeFileSync(zip, buffer, { mode: 0o600 }); await archive.unzip(zip, work); fs.unlinkSync(zip);
        const marker = JSON.parse(fs.readFileSync(path.join(work, 'quizforge-package.json'), 'utf8'));
        if (marker.format !== 'quizforge-bank-group' || marker.formatVersion !== 3) throw new CloudError(422, '仅支持格式 3 的 .qbank，格式 1、2 需要制作者升级');
        if (typeof marker.group !== 'string' || !marker.group || marker.group.length > 120 || /[\\/\x00-\x1f]/.test(marker.group) || ['.', '..'].includes(marker.group) || marker.scope !== undefined && !['bank', 'group'].includes(marker.scope)) throw new CloudError(422, '题库包分组或范围无效');
        for (const name of ['question-banks', 'extensions']) { const groups = fs.readdirSync(path.join(work, name)); if (groups.length !== 1 || groups[0] !== marker.group) throw new CloudError(422, '题库和拓展必须使用配套的单个物理分组'); }
        const banks = this.runtime.scanBanks(path.join(work, 'question-banks')).banks;
        directories = this.runtime.scanExtensions(path.join(work, 'extensions')); bankCount = banks.length;
        if (!bankCount || marker.scope === 'bank' && bankCount !== 1) throw new CloudError(422, '题库包数量与范围不匹配');
        if (banks.some(file => path.basename(file) !== 'bank.json' || path.dirname(path.dirname(file)) !== path.join(work, 'question-banks', marker.group)) || directories.some(directory => path.dirname(directory) !== path.join(work, 'extensions', marker.group))) throw new CloudError(422, '题库和拓展必须位于配套分组中的独立文件夹');
        archive.validatePrivatePaths(work, banks, directories);
      } else {
        const zip = path.join(root, 'source.zip'); fs.writeFileSync(zip, buffer, { mode: 0o600 }); await this.unpackZip(zip, work); fs.unlinkSync(zip);
        const find = directory => {
          const manifest = path.join(directory, 'manifest.json');
          if (fs.existsSync(manifest)) { const value = JSON.parse(fs.readFileSync(manifest, 'utf8')); if (typeof value.rules === 'string' && typeof value.script === 'string') { directories.push(directory); return; } }
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) find(path.join(directory, entry.name));
        }; find(work);
      }
      if (!directories.length || directories.length > 64) throw new CloudError(422, '审核包须包含 1–64 个完整拓展');
      const extensions = directories.map((directory, index) => {
        const item = extensionDigest(directory), manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
        const target = path.join(root, 'extensions', String(index)); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.cpSync(directory, target, { recursive: true });
        return { ...item, name: typeof manifest.name === 'string' ? manifest.name.slice(0, 100) : item.extensionId, index };
      });
      fs.rmSync(work, { recursive: true, force: true });
      const size = treeBytes(root), used = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM extension_submissions').get().n;
      if (used + size > 512 * 1024 ** 2) throw new CloudError(507, '待审拓展存储预算不足');
      const value = { ...source, bankCount };
      const known = source.kind !== 'public' && extensions.every(e => this.db.prepare('SELECT status FROM cloud_extension_reviews WHERE digest=?').get(e.digest)?.status === 'approved');
      this.db.prepare('INSERT INTO extension_submissions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, user.id, source.kind || 'private', filename, digest(buffer), JSON.stringify(value), JSON.stringify(extensions), size, known ? 'verified' : 'pending', '', null, Date.now(), null);
      return this.info(this.row(id));
    } catch (error) { fs.rmSync(root, { recursive: true, force: true }); if (error instanceof CloudError) throw error; throw new CloudError(error.status || 422, '审核包解析失败，请检查格式与文件内容'); }
    finally { this.active = false; }
  }
  file(id, extension, filename, download = false) {
    const row = this.row(id), item = JSON.parse(row.extensions).find(e => e.digest === extension), inventory = item?.files.find(f => f.path === filename);
    if (!inventory || filename.includes('\\') || filename.split('/').includes('..')) throw new CloudError(404, '审核文件不存在');
    const file = path.join(this.root, id, 'extensions', String(item.index), filename), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 ** 2) throw new CloudError(422, '审核文件无效');
    const buffer = fs.readFileSync(file), text = /\.(js|mjs|cjs|html|css|json|md|txt|svg)$/i.test(filename);
    return { path: filename, size: buffer.length, sha256: digest(buffer), binary: !text, truncated: text && buffer.length > 512 * 1024, text: text ? buffer.subarray(0, 512 * 1024).toString('utf8') : null, ...(download ? { base64: buffer.toString('base64') } : {}) };
  }
  decide(actor, id, input) {
    const note = reason(input.reason), row = this.row(id);
    if (!['approved', 'rejected'].includes(input.decision)) throw new CloudError(400, '请选择批准或驳回');
    if (row.status !== 'pending') throw new CloudError(409, '此申请已处理，请刷新');
    if (input.decision === 'approved' && input.codeReviewed !== true) throw new CloudError(400, '请确认已经检查完整拓展代码与资源');
    const items = JSON.parse(row.extensions);
    if (input.decision === 'approved') for (const item of items) if (extensionDigest(path.join(this.root, id, 'extensions', String(item.index))).digest !== item.digest) throw new CloudError(409, '待审文件已变化，必须重新提交');
    this.library.accounts.transaction(() => {
      if (input.decision === 'approved') for (const item of items) {
        this.db.prepare("INSERT INTO cloud_extension_reviews VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(digest) DO UPDATE SET status='approved',reviewer=excluded.reviewer,reviewed=excluded.reviewed,reason=excluded.reason").run(item.digest, item.extensionId, item.version, JSON.stringify(item.files), 'approved', actor.id, Date.now(), note);
        this.db.prepare('INSERT INTO extension_review_names VALUES (?,?) ON CONFLICT(digest) DO UPDATE SET name=excluded.name').run(item.digest, item.name);
      }
      this.db.prepare('UPDATE extension_submissions SET status=?,reason=?,reviewer=?,reviewed=? WHERE id=?').run(input.decision, note, actor.id, Date.now(), id);
      this.library.accounts.audit(actor.id, row.user_id, 'extension-' + input.decision, { submission: id }, { digests: items.map(e => e.digest), source: JSON.parse(row.source) }, note);
    });
    return this.info(this.row(id));
  }
}
