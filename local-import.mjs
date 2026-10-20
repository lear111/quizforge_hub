import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const maximum = 64 * 1024 * 1024;
class LocalImportError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = `LOCAL_IMPORT_${code}`; }
}
const fail = (status, code, message) => { throw new LocalImportError(status, code, message); };
const unavailable = () => fail(404, 'UNAVAILABLE', '题库不存在、尚未公开或附件暂不可用');

// Public, anonymous delivery only. It deliberately bypasses the author's and
// administrator's permission to preview unpublished attachments.
export function createLocalImport({ db, uploadDir, enabled, throttle, reserveTraffic, json, openFile = open }) {
  const lookup = db.prepare(`SELECT p.id,p.title,p.status,p.revision,
    f.id AS fileId,f.name,f.size,f.sha256 FROM packs p
    LEFT JOIN files f ON f.pack_id=p.id AND f.kind='archive' WHERE p.id=?`);
  function current(id, revision, sha256) {
    const row = lookup.get(id);
    if (!row || row.status !== 'approved' || !row.fileId) unavailable();
    if (row.revision !== revision || sha256 !== undefined && row.sha256 !== sha256) {
      fail(409, 'REVISION_CHANGED', '题库版本已变化，请刷新 Hub 后重新点击');
    }
    if (!row.name.toLowerCase().endsWith('.qbank')) fail(422, 'FORMAT_UNSUPPORTED', '此附件不支持直接导入，请使用文件下载');
    if (row.size > maximum) fail(413, 'TOO_LARGE', '题库文件超过 64 MiB');
    if (!uuid.test(row.fileId) || !Number.isSafeInteger(row.size) || row.size < 1 || !digest.test(row.sha256)) {
      throw new Error('Invalid local import metadata');
    }
    return row;
  }
  function limit(req, group, maximum) {
    try { throttle(req, group, maximum); }
    catch (error) {
      if (error.status === 429) fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
      throw error;
    }
  }
  return async (req, res, url) => {
    const match = /^\/api\/packs\/([^/]+)\/(local-import|download)$/.exec(url.pathname);
    if (!match) return false;
    const [, id, action] = match;
    const pinned = url.searchParams.has('revision') || url.searchParams.has('sha256');
    if (action === 'download' && !pinned) return false;
    let file;
    try {
      if (!enabled) fail(404, 'DISABLED', 'Hub 暂未开启直接导入，请下载 .qbank 文件');
      if (req.method !== 'GET') fail(405, 'REQUEST_INVALID', '此接口只支持 GET');
      limit(req, action === 'local-import' ? 'local-import-manifest' : 'download', action === 'local-import' ? 60 : 30);
      const entries = [...url.searchParams];
      const keys = action === 'local-import' ? ['revision'] : ['revision', 'sha256'];
      const revision = url.searchParams.get('revision');
      const sha256 = action === 'download' ? url.searchParams.get('sha256') : undefined;
      if (!uuid.test(id) || /[^?a-z0-9=&-]/.test(url.search) || entries.length !== keys.length
        || keys.some(key => url.searchParams.getAll(key).length !== 1)
        || !/^[1-9][0-9]{0,15}$/.test(revision ?? '') || !Number.isSafeInteger(Number(revision))
        || action === 'download' && !digest.test(sha256 ?? '')) {
        fail(400, 'REQUEST_INVALID', 'Hub 导入参数无效');
      }
      const first = current(id, Number(revision), sha256);
      file = await openFile(path.join(uploadDir, first.fileId), 'r');
      const info = await file.stat();
      // Recheck after the asynchronous open/stat, before reserving any traffic.
      const row = current(id, Number(revision), sha256);
      if (row.fileId !== first.fileId || row.sha256 !== first.sha256 || row.size !== first.size) {
        fail(409, 'REVISION_CHANGED', '题库文件已变化，请刷新 Hub 后重新点击');
      }
      if (!info.isFile() || info.size !== row.size) unavailable();
      if (action === 'local-import') {
        json(res, 200, { schemaVersion: 1, pack: { id: row.id, revision: row.revision, title: row.title },
          archive: { name: row.name, size: row.size, sha256: row.sha256 } });
      } else {
        // No await between the recheck and reservation. Public delivery never
        // uses an incidental browser cookie to debit an account's quota.
        try { reserveTraffic(req, row.size, true, true); }
        catch (error) {
          if (error.status === 429) fail(429, 'TRAFFIC_LIMIT', error.message);
          throw error;
        }
        db.prepare('UPDATE packs SET downloads=downloads+1 WHERE id=?').run(id);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': row.size,
          'Content-Disposition': `attachment; filename="question-bank.qbank"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
          'Cache-Control': 'private, no-store' });
        await pipeline(file.createReadStream({ autoClose: false }), res);
      }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else if (error instanceof LocalImportError) json(res, error.status, { error: error.message, code: error.code });
      else if (error.code === 'ENOENT') json(res, 404, { error: '题库附件暂不可用', code: 'LOCAL_IMPORT_UNAVAILABLE' });
      else {
        console.error('Local import failed:', error.name);
        json(res, 500, { error: '服务器暂时无法处理，请稍后重试', code: 'LOCAL_IMPORT_SERVER_ERROR' });
      }
    } finally { await file?.close(); }
    return true;
  };
}
