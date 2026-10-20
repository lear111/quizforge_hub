import { CloudError } from './accounts.mjs';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

export function cloudRoute({ accounts, library, requireUser, requireAdmin, bodyJson, throttle, json, resolveCloudPack, reserveTraffic }) {
  return async (req, res, url) => {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/cloud/')) return false;
    if (!accounts) throw new CloudError(404, '云端功能尚未启用');
    const user = requireUser(req);
    throttle(req, 'cloud-control', 120, user.id);
    if (pathname === '/api/cloud/me' && req.method === 'GET') {
      json(res, 200, { ...accounts.status(user.id), stage: library ? 'cloud-practice' : 'resource-foundation', ai: { keyStorage: 'browser-only', directConnection: true, serverRelay: false }, trafficScope: 'qbank-downloads-and-exports', personalMonthlyTrafficLimit: false, libraryReady: !!library, practiceReady: !!library?.practice }); return true;
    }
    const requireLibrary = () => { if (!library) throw new CloudError(503, '云端题库导入尚未配置'); return library; };
    if (pathname === '/api/cloud/library' && req.method === 'GET') { json(res, 200, { items: requireLibrary().list(user.id) }); return true; }
    if (pathname === '/api/cloud/library/demo' && req.method === 'POST') {
      throttle(req, 'cloud-import', 6, user.id); const input = await bodyJson(req);
      if (Object.keys(input).length) throw new CloudError(400, '示例导入不接受其他参数');
      json(res, 201, { item: await requireLibrary().demo(user.id) }); return true;
    }
    if (pathname === '/api/cloud/library/from-hub' && req.method === 'POST') {
      throttle(req, 'cloud-import', 6, user.id); const input = await bodyJson(req);
      if (Object.keys(input).some(key => !['packId', 'revision', 'newCopy'].includes(key)) || input.newCopy !== undefined && typeof input.newCopy !== 'boolean') throw new CloudError(400, '公共题库导入参数无效');
      const pack = resolveCloudPack(input.packId, input.revision);
      json(res, 201, { item: await requireLibrary().installFile(user.id, user.id, pack.file, pack.filename, { ...pack.source, newCopy: !!input.newCopy }) }); return true;
    }
    const delivery = /^\/api\/cloud\/admin\/users\/([a-f0-9-]{36})\/import$/.exec(pathname);
    if ((pathname === '/api/cloud/library/import' || delivery) && req.method === 'POST') {
      if (delivery) requireAdmin(req);
      throttle(req, 'cloud-import', 6, user.id);
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/vnd.quizforge.qbank') throw new CloudError(415, '请上传 .qbank 文件');
      let filename;
      try { filename = decodeURIComponent(req.headers['x-quizforge-filename'] || ''); } catch { throw new CloudError(400, '文件名无效'); }
      const item = await requireLibrary().install(delivery?.[1] ?? user.id, user.id, req, filename, { kind: delivery ? 'admin-delivery' : 'private' });
      json(res, 201, { item }); return true;
    }
    const exported = /^\/api\/cloud\/library\/([a-f0-9-]{36})\/(export|export-selection)$/.exec(pathname);
    const removed = /^\/api\/cloud\/library\/([a-f0-9-]{36})$/.exec(pathname);
    if (removed && req.method === 'DELETE') { json(res, 200, await requireLibrary().delete(user.id, removed[1])); return true; }
    if (exported && (exported[2] === 'export' && req.method === 'GET' || exported[2] === 'export-selection' && req.method === 'POST')) {
      throttle(req, 'cloud-export', 6, user.id);
      const download = await requireLibrary().export(user.id, exported[1], exported[2] === 'export-selection' ? await bodyJson(req) : null);
      try {
        reserveTraffic(req, download.bytes);
        res.writeHead(200, { 'Content-Type': 'application/vnd.quizforge.qbank', 'Content-Length': download.bytes, 'Content-Disposition': `attachment; filename="cloud-bank.qbank"; filename*=UTF-8''${encodeURIComponent(download.name + '.qbank')}`, 'Cache-Control': 'no-store' });
        await pipeline(fs.createReadStream(download.file), res);
      } finally { download.close(); }
      return true;
    }
    if (pathname === '/api/cloud/admin/extensions' && req.method === 'GET') { requireAdmin(req); json(res, 200, { entries: requireLibrary().reviews.list() }); return true; }
    if (pathname === '/api/cloud/admin/extensions/revoke' && req.method === 'POST') {
      requireAdmin(req); const input = await bodyJson(req);
      requireLibrary().reviews.revoke(user.id, input.digest, input.reason); json(res, 200, { ok: true }); return true;
    }
    if (!pathname.startsWith('/api/cloud/admin/')) throw new CloudError(404, '云端接口不存在');
    requireAdmin(req);
    if (pathname === '/api/cloud/admin/users' && req.method === 'GET') {
      json(res, 200, accounts.list(user.id, Number(url.searchParams.get('page') ?? 1), url.searchParams.get('q') ?? '')); return true;
    }
    if (pathname === '/api/cloud/admin/audit' && req.method === 'GET') {
      json(res, 200, { entries: accounts.audits(user.id, url.searchParams.get('user') || null) }); return true;
    }
    const match = /^\/api\/cloud\/admin\/users\/([a-f0-9-]{36})\/limits$/.exec(pathname);
    if ((pathname === '/api/cloud/admin/defaults' || match) && req.method === 'PUT') {
      throttle(req, 'cloud-adjust', 30, user.id);
      const input = await bodyJson(req);
      if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'limits') || !Object.hasOwn(input, 'reason')) throw new CloudError(400, '仅接受额度和调整原因');
      const value = match ? accounts.updateLimits(user.id, match[1], input.limits, input.reason) : accounts.updateDefaults(user.id, input.limits, input.reason);
      json(res, 200, value); return true;
    }
    throw new CloudError(404, '云端接口不存在');
  };
}
