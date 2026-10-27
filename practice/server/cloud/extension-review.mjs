import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CloudError } from './accounts.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(value).digest('hex');
function normalizeBindings(value) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && value.extension && typeof value.extension === 'object' && Object.keys(value.extension).length === 1 && typeof value.extension.path === 'string') value.extension = { path: '@package-extension' };
  for (const child of Object.values(value)) normalizeBindings(child);
}
// Unlike the local compatibility fingerprint, this inventory hashes every file:
// practice/editor/rules/schema, examples, media and any undeclared extra file.
// Only JSON formatting, the importer's display name and example binding paths
// are canonicalized. They cannot change executable bytes or file declarations.
export function extensionDigest(directory) {
  const root = path.resolve(directory), manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new CloudError(422, '拓展清单无效');
  if (typeof manifest.examples !== 'string' || !/^examples\/[A-Za-z0-9._/-]+\.json$/.test(manifest.examples) || manifest.examples.split('/').includes('..')) throw new CloudError(422, '云端拓展示例必须是 examples 目录内的 JSON');
  const files = []; let total = 0;
  function visit(item) {
    const stat = fs.lstatSync(item);
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new CloudError(422, '拓展不允许链接或特殊文件');
    if (stat.isDirectory()) { for (const name of fs.readdirSync(item).sort()) visit(path.join(item, name)); return; }
    if (stat.size > 8 * 1024 ** 2 || (total += stat.size) > 64 * 1024 ** 2 || files.length >= 2000) throw new CloudError(413, '拓展内容超过审核上限');
    const relative = path.relative(root, item).replaceAll('\\', '/');
    let bytes = fs.readFileSync(item);
    if (relative === 'manifest.json') {
      const value = { ...manifest, id: manifest.id ?? 'extension', version: manifest.version ?? '0.0.0', name: '@display-name' };
      bytes = Buffer.from(JSON.stringify(canonical(value)));
    } else if (relative === manifest.examples) {
      const value = JSON.parse(bytes.toString('utf8')); normalizeBindings(value); bytes = Buffer.from(JSON.stringify(canonical(value)));
    }
    files.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
  }
  visit(root);
  return { digest: hash(JSON.stringify(['qfh-extension-review-v1', files])), extensionId: manifest.id ?? 'extension', version: manifest.version ?? '0.0.0', files };
}

export class ExtensionReviews {
  constructor(db, builtins = []) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_extension_reviews (digest TEXT PRIMARY KEY, extension_id TEXT NOT NULL, version TEXT NOT NULL, inventory TEXT NOT NULL, status TEXT NOT NULL, reviewer TEXT NOT NULL, reviewed INTEGER NOT NULL, reason TEXT NOT NULL)`);
    // A revoked digest is never silently re-approved by a restart or update.
    for (const item of builtins) db.prepare('INSERT OR IGNORE INTO cloud_extension_reviews VALUES (?,?,?,?,?,?,?,?)').run(item.digest, item.extensionId, item.version, JSON.stringify(item.files), 'approved', 'builtin-release', Date.now(), '随固定运行时发布的基础拓展');
  }
  verify(directory) {
    const item = extensionDigest(directory), review = this.db.prepare('SELECT status FROM cloud_extension_reviews WHERE digest=?').get(item.digest);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (review?.status !== 'approved') throw new CloudError(422, review?.status === 'revoked' ? `拓展“${String(manifest.name || item.extensionId).slice(0, 100)}”的审核已撤销，云端暂不能使用` : `拓展“${String(manifest.name || item.extensionId).slice(0, 100)}”的完整文件摘要尚未获准在云端运行，请提交拓展审核`);
    return item;
  }
  list() { return this.db.prepare('SELECT digest,extension_id AS extensionId,version,status,reviewer,reviewed,reason FROM cloud_extension_reviews ORDER BY reviewed DESC').all(); }
  revoke(actorId, digest, reason) {
    if (!this.db.prepare('SELECT admin FROM users WHERE id=?').get(actorId)?.admin) throw new CloudError(403, '仅管理员可撤销拓展');
    if (!/^[a-f0-9]{64}$/.test(digest) || typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new CloudError(400, '请填写有效摘要和撤销原因');
    if (!this.db.prepare("UPDATE cloud_extension_reviews SET status='revoked',reviewer=?,reviewed=?,reason=? WHERE digest=?").run(actorId, Date.now(), reason.trim(), digest).changes) throw new CloudError(404, '审核记录不存在');
  }
}
