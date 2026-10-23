import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

// App downloads (/download). Installers and manifest.json live in DATA_DIR/downloads, outside
// releases, so deploys keep them. Publish with `node scripts/admin.mjs download-publish ...`.
export const PLATFORMS = { android: { extension: '.apk', type: 'application/vnd.android.package-archive' }, windows: { extension: '.exe', type: 'application/vnd.microsoft.portable-executable' } };
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function readDownloads(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, 'downloads', 'manifest.json'), 'utf8'));
    return (Array.isArray(value.items) ? value.items : []).filter(item => PLATFORMS[item.platform] && NAME.test(item.file) && Number.isSafeInteger(item.bytes));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Copies an installer in and replaces that platform's entry; the previous file is removed
// only after the new manifest is in place.
export function publishDownload(dataDir, { platform, source, version, label = '' }) {
  const kind = PLATFORMS[platform];
  if (!kind) throw new Error('平台应为 android 或 windows');
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(version)) throw new Error('版本号格式无效');
  if (typeof label !== 'string' || label.length > 20) throw new Error('版本说明最多 20 个字');
  const bytes = fs.readFileSync(source);
  const file = `QuizForge-${version}-${platform}${kind.extension}`;
  if (!NAME.test(file)) throw new Error('文件名无效');
  const directory = path.join(dataDir, 'downloads'); fs.mkdirSync(directory, { recursive: true });
  const items = readDownloads(dataDir), previous = items.find(item => item.platform === platform);
  fs.writeFileSync(path.join(directory, file + '.part'), bytes); fs.renameSync(path.join(directory, file + '.part'), path.join(directory, file));
  const item = { platform, version, label, file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), updated: new Date().toISOString() };
  const manifest = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifest + '.part', JSON.stringify({ schemaVersion: 1, items: [...items.filter(entry => entry.platform !== platform), item] }, null, 2) + '\n');
  fs.renameSync(manifest + '.part', manifest);
  if (previous && previous.file !== file) fs.rmSync(path.join(directory, previous.file), { force: true });
  return item;
}

export function unpublishDownload(dataDir, platform) {
  const items = readDownloads(dataDir), previous = items.find(item => item.platform === platform);
  if (!previous) return false;
  const manifest = path.join(dataDir, 'downloads', 'manifest.json');
  fs.writeFileSync(manifest + '.part', JSON.stringify({ schemaVersion: 1, items: items.filter(item => item.platform !== platform) }, null, 2) + '\n');
  fs.renameSync(manifest + '.part', manifest); fs.rmSync(path.join(dataDir, 'downloads', previous.file), { force: true });
  return true;
}

// Serves the manifest and the listed files; each download counts against the site file budget.
export function createDownloads({ dataDir, json, reserveTraffic }) {
  return async function handle(req, res, url) {
    if (url.pathname === '/api/downloads' && req.method === 'GET') { json(res, 200, { items: readDownloads(dataDir) }); return true; }
    const match = /^\/download\/files\/([^/]+)$/.exec(url.pathname);
    if (!match || !['GET', 'HEAD'].includes(req.method)) return false;
    const item = readDownloads(dataDir).find(entry => entry.file === match[1]);
    const file = item && path.join(dataDir, 'downloads', item.file);
    if (!item || !fs.existsSync(file)) { json(res, 404, { error: '安装包不存在或已更新，请刷新下载页' }); return true; }
    if (req.method === 'GET') reserveTraffic(req, item.bytes, true, true);
    res.writeHead(200, { 'Content-Type': PLATFORMS[item.platform].type, 'Content-Length': item.bytes, 'Content-Disposition': `attachment; filename="${item.file}"`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') { res.end(); return true; }
    await pipeline(fs.createReadStream(file), res);
    return true;
  };
}
