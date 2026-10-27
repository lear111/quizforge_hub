import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { CloudError } from './accounts.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function hubImportTarget(search) {
  const params = new URLSearchParams(search);
  if ([...params.keys()].length !== 2 || !uuid.test(params.get('pack') || '') || !/^[1-9]\d{0,14}$/.test(params.get('revision') || '')) throw new CloudError(400, '题库链接无效，请从题库广场重新选择');
  return { packId: params.get('pack'), revision: Number(params.get('revision')) };
}
export function importReturnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/cloud/import?')) throw new CloudError(400, '登录返回地址无效');
  const target = hubImportTarget(value.slice('/cloud/import?'.length));
  return `/cloud/import?pack=${target.packId}&revision=${target.revision}`;
}

// Only server-configured HTTPS Hub origins are accepted. No caller URLs,
// cookies, auth headers, redirects, or third-party model credentials are used.
export function createHubSource({ origin, dataDir, fetchImpl = fetch }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Invalid Hub source origin');
  let active = false;
  return async (packId, revision) => {
    if (!uuid.test(packId ?? '') || !Number.isSafeInteger(revision) || revision < 1) throw new CloudError(400, '题库版本无效');
    if (active) throw new CloudError(503, '另一份公共题库正在下载，请稍后重试');
    active = true;
    let directory;
    const close = async () => { try { if (directory) await rm(directory, { recursive: true, force: true }); } finally { active = false; } };
    try {
      const options = { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(180000) };
      const prefix = `${origin}/api/packs/${packId}`;
      const request = async url => {
        const response = await fetchImpl(url, options);
        if (!response.ok) {
          await response.body?.cancel();
          throw new CloudError(response.status === 409 ? 409 : response.status === 404 ? 404 : response.status === 429 ? 429 : 503,
            response.status === 409 ? '题库已更新，请返回广场刷新后重试' : response.status === 404 ? '题库不存在或已下架' : response.status === 429 ? 'Hub 下载额度或请求次数已达上限，请稍后重试' : '暂时无法下载 Hub 题库，请稍后重试');
        }
        return response;
      };
      const response = await request(`${prefix}/local-import?revision=${revision}`);
      let size = 0; const chunks = [];
      for await (const chunk of Readable.fromWeb(response.body)) {
        size += chunk.length;
        if (size > 32768) throw new CloudError(502, 'Hub 题库清单过大');
        chunks.push(chunk);
      }
      const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')), archive = manifest.archive;
      if (manifest.schemaVersion !== 1 || manifest.pack?.id !== packId || manifest.pack?.revision !== revision
        || typeof manifest.pack.title !== 'string' || manifest.pack.title.length > 240
        || !archive || typeof archive.name !== 'string' || archive.name.length > 240 || !/\.qbank$/i.test(archive.name)
        || !Number.isSafeInteger(archive.size) || archive.size < 1 || archive.size > 64 * 1024 ** 2 || !/^[a-f0-9]{64}$/.test(archive.sha256)) throw new CloudError(502, 'Hub 题库清单无效');
      const parent = path.join(dataDir, 'hub-downloads'); await mkdir(parent, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(path.join(parent, 'import-'));
      const file = path.join(directory, 'source.qbank'), download = await request(`${prefix}/download?revision=${revision}&sha256=${archive.sha256}`);
      if (download.headers.get('content-length') !== String(archive.size)) { await download.body?.cancel(); throw new CloudError(502, 'Hub 题库文件大小不符'); }
      let bytes = 0; const digest = createHash('sha256');
      const verify = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > archive.size) { callback(new CloudError(502, 'Hub 题库文件大小不符')); return; }
        digest.update(chunk); callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(download.body), verify, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
      if (bytes !== archive.size || digest.digest('hex') !== archive.sha256) throw new CloudError(502, 'Hub 题库文件校验失败');
      return { file, filename: archive.name, source: { kind: 'hub', packId, revision, sha256: archive.sha256, title: manifest.pack.title }, close };
    } catch (error) {
      await close();
      if (error instanceof CloudError) throw error;
      throw new CloudError(503, 'Hub 题库下载失败，请稍后重试');
    }
  };
}
