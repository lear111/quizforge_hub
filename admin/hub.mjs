import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { CloudError } from '../cloud/accounts.mjs';
import { bytes, filename, jsonBody, reason, send, uuid } from './common.mjs';

export function createHubAdmin({ db, invitations, invitationPolicy, metrics, requireUser, requireAdmin, throttle, cloud, token, uploadDir, enabled }) {
  db.exec(`CREATE TABLE IF NOT EXISTS pack_admin_reviews(pack_id TEXT NOT NULL,revision INTEGER NOT NULL,sha256 TEXT NOT NULL,submission TEXT NOT NULL,PRIMARY KEY(pack_id,revision,sha256));
    CREATE TABLE IF NOT EXISTS pack_cloud_approvals(pack_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,sha256 TEXT NOT NULL,digests TEXT NOT NULL,status TEXT NOT NULL,actor_id TEXT NOT NULL,created INTEGER NOT NULL);`);
  const audit = (actor, action, target, detail) => db.prepare('INSERT INTO admin_audit VALUES (?,?,?,?,?,?)').run(randomUUID(), actor, target, action, JSON.stringify(detail), Date.now());
  const pack = id => {
    if (!uuid(id)) throw new CloudError(400, '题库编号无效');
    const row = db.prepare("SELECT p.*,u.name AS author,f.id AS file_id,f.name AS filename,f.size,f.sha256 FROM packs p JOIN users u ON u.id=p.user_id LEFT JOIN files f ON f.pack_id=p.id AND f.kind='archive' WHERE p.id=?").get(id);
    if (!row) throw new CloudError(404, '题库不存在'); return row;
  };
  const call = (req, route, options = {}) => cloud(route, { ...options, token: token(req) });
  const listUsers = async (req, url) => {
    const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('page')) || 1)), query = (url.searchParams.get('q') || '').slice(0, 100), pattern = '%' + query.replace(/[!%_]/g, '!$&') + '%';
    const where = "WHERE name LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!'";
    const rows = db.prepare(`SELECT id,name,email,admin,created FROM users ${where} ORDER BY created DESC,id LIMIT 50 OFFSET ?`).all(pattern, pattern, (page - 1) * 50);
    const quotas = rows.length ? await call(req, '/accounts?ids=' + rows.map(u => u.id).join(',')) : { accounts: {}, defaults: {} };
    return { page, count: db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(pattern, pattern).n, defaults: quotas.defaults,
      users: rows.map(u => ({ ...u, disabled: !!db.prepare('SELECT 1 FROM user_blocks WHERE user_id=?').get(u.id), lastSeen: db.prepare('SELECT last_seen FROM activity_online WHERE user_id=?').get(u.id)?.last_seen || null, invitation: db.prepare('SELECT prefix FROM invitations WHERE user_id=?').get(u.id)?.prefix || null, resources: quotas.accounts[u.id] || { limits: quotas.defaults, overrides: { storageBytes: null, dailyTrafficBytes: null }, usage: { storageBytes: 0, dailyTrafficBytes: 0 } } })) };
  };
  return async (req, res, url) => {
    if (url.pathname === '/api/activity' && req.method === 'POST') {
      const user = requireUser(req); throttle(req, 'activity', 40, user.id); const input = await jsonBody(req);
      if (!['visit', 'practice', 'heartbeat'].includes(input.kind)) throw new CloudError(400, '活动类型无效');
      metrics.record(user.id, input.kind); send(res, 200, { ok: true }); return true;
    }
    if (!url.pathname.startsWith('/api/admin/')) return false;
    if (!enabled) throw new CloudError(404, '管理后台尚未开放');
    const actor = requireAdmin(req); throttle(req, 'admin', 120, actor.id);
    const route = url.pathname.slice('/api/admin'.length); let value, status = 200;
    const profile = /^\/users\/([a-f0-9-]{36})\/profile$/.exec(route);
    if (profile && req.method === 'GET') {
      const user = db.prepare('SELECT id,name,email,admin,created FROM users WHERE id=?').get(profile[1]);
      if (!user || db.prepare('SELECT 1 FROM user_blocks WHERE user_id=?').get(profile[1])) throw new CloudError(404, '用户不存在或已被封禁'); value = { user };
    } else if (route === '/overview' && req.method === 'GET') {
      const local = metrics.overview(Number(url.searchParams.get('days'))), remote = await call(req, '/summary');
      value = { ...local, transfers: { requests: local.transfers.requests + remote.transfers.requests, bytes: local.transfers.bytes + remote.transfers.bytes }, cloud: remote };
    }
    else if (route === '/invitations' && req.method === 'GET') value = { items: invitations.list(actor.id), invitationRequired: invitationPolicy.required() };
    else if (route === '/invitations/settings' && req.method === 'PUT') {
      const input = await jsonBody(req);
      if (Object.keys(input).length !== 1 || typeof input.invitationRequired !== 'boolean') throw new CloudError(400, '请明确选择是否启用邀请码验证');
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = invitationPolicy.required(); invitationPolicy.setRequired(input.invitationRequired);
        if (previous !== input.invitationRequired) audit(actor.id, 'invitation-policy-updated', 'registration', { previous, replacement: input.invitationRequired });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      value = { invitationRequired: invitationPolicy.required() };
    }
    else if (route === '/invitations' && req.method === 'POST') { const input = await jsonBody(req); value = { items: invitations.create(actor.id, input.count ?? 1, input.days ?? 30) }; status = 201; }
    else if (/^\/invitations\/[a-f0-9-]{36}\/revoke$/.test(route) && req.method === 'POST') { invitations.revoke(actor.id, route.split('/')[2]); value = { ok: true }; }
    else if (route === '/users' && req.method === 'GET') value = await listUsers(req, url);
    else if (/^\/users\/[a-f0-9-]{36}\/block$/.test(route) && req.method === 'PUT') {
      const id = route.split('/')[2], input = await jsonBody(req), note = reason(input.reason);
      if (id === actor.id || typeof input.blocked !== 'boolean') throw new CloudError(400, '不能封禁当前管理员，且必须明确账户状态');
      if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) throw new CloudError(404, '用户不存在');
      db.exec('BEGIN IMMEDIATE'); try {
        if (input.blocked) { db.prepare('INSERT INTO user_blocks VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET actor_id=excluded.actor_id,reason=excluded.reason,created=excluded.created').run(id, actor.id, note, Date.now()); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }
        else db.prepare('DELETE FROM user_blocks WHERE user_id=?').run(id);
        audit(actor.id, input.blocked ? 'user-blocked' : 'user-unblocked', id, { reason: note }); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; } value = { ok: true };
    } else if (route === '/packs' && req.method === 'GET') {
      const state = url.searchParams.get('status') || 'pending'; if (!['pending', 'approved', 'rejected', 'all'].includes(state)) throw new CloudError(400, '审核状态无效');
      const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('page')) || 1)), where = state === 'all' ? '' : ' WHERE p.status=?', args = state === 'all' ? [] : [state];
      const items = db.prepare('SELECT p.id FROM packs p' + where + ' ORDER BY p.updated DESC LIMIT 30 OFFSET ?').all(...args, (page - 1) * 30).map(row => { const p = pack(row.id); return { ...p, tags: JSON.parse(p.tags), cloudApproval: db.prepare('SELECT * FROM pack_cloud_approvals WHERE pack_id=? AND revision=? AND sha256=?').get(p.id, p.revision, p.sha256) || null }; });
      value = { items, page, count: db.prepare('SELECT COUNT(*) AS n FROM packs p' + where).get(...args).n };
    } else if (/^\/packs\/[a-f0-9-]{36}\/(inspect|decision|unpublish)$/.test(route) && req.method === 'POST') {
      const [, , id, action] = route.split('/'), row = pack(id);
      if (action === 'unpublish') { const input = await jsonBody(req), note = reason(input.reason); db.prepare("UPDATE packs SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?").run(note, actor.id, new Date().toISOString(), id); audit(actor.id, 'pack-unpublished', id, { revision: row.revision, reason: note }); value = { ok: true }; }
      else if (action === 'inspect') {
        if (!/\.qbank$/i.test(row.filename || '')) { value = { pack: row, item: null, notice: '此附件不是 .qbank，可审核上架供文件下载，不能导入云端。' }; }
        else {
          const old = db.prepare('SELECT submission FROM pack_admin_reviews WHERE pack_id=? AND revision=? AND sha256=?').get(id, row.revision, row.sha256);
          let item;
          if (old) { try { item = (await call(req, '/submissions/' + old.submission)).item; } catch (e) { if (e.status !== 404) throw e; } }
          if (!item || item.status === 'rejected') {
            const buffer = await fs.readFile(path.join(uploadDir, row.file_id)); if (createHash('sha256').update(buffer).digest('hex') !== row.sha256) throw new CloudError(409, '题库文件已变化');
            item = (await call(req, '/submissions', { method: 'POST', body: buffer, filename: row.filename, source: { kind: 'public', packId: id, revision: row.revision, sha256: row.sha256, title: row.title } })).item;
            const fresh = pack(id); if (fresh.revision !== row.revision || fresh.sha256 !== row.sha256 || fresh.file_id !== row.file_id) throw new CloudError(409, '题库已更新，请重新审核');
            db.prepare('INSERT INTO pack_admin_reviews VALUES (?,?,?,?) ON CONFLICT(pack_id,revision,sha256) DO UPDATE SET submission=excluded.submission').run(id, row.revision, row.sha256, item.id);
          }
          value = { pack: row, item };
        }
      } else {
        const input = await jsonBody(req), note = reason(input.reason);
        if (!['approved', 'rejected'].includes(input.decision) || input.revision !== row.revision) throw new CloudError(409, '审核决定或题库版本无效，请刷新后重试');
        let item;
        if (input.decision === 'rejected') {
          const prepared = db.prepare('SELECT submission FROM pack_admin_reviews WHERE pack_id=? AND revision=? AND sha256=?').get(id, row.revision, row.sha256);
          if (prepared) { const job = (await call(req, '/submissions/' + prepared.submission)).item; if (job.status === 'pending') await call(req, '/submissions/' + job.id + '/decision', { method: 'POST', body: { decision: 'rejected', reason: note } }); }
        }
        if (input.decision === 'approved' && /\.qbank$/i.test(row.filename || '')) {
          const prepared = db.prepare('SELECT submission FROM pack_admin_reviews WHERE pack_id=? AND revision=? AND sha256=?').get(id, row.revision, row.sha256);
          if (!prepared) throw new CloudError(409, '请先查看整包内容与拓展，再执行审核');
          item = (await call(req, '/submissions/' + prepared.submission)).item;
          if (item.status === 'pending') item = (await call(req, '/submissions/' + item.id + '/decision', { method: 'POST', body: { decision: 'approved', reason: note, codeReviewed: input.codeReviewed } })).item;
          else if (input.codeReviewed !== true || item.status !== 'approved' || item.extensions.some(e => e.status !== 'approved')) throw new CloudError(409, '拓展审核已失效，请重新预审或提交');
        }
        db.exec('BEGIN IMMEDIATE'); try {
          const fresh = pack(id); if (fresh.revision !== row.revision || fresh.sha256 !== row.sha256 || fresh.file_id !== row.file_id) throw new CloudError(409, '题库已更新，请重新审核');
          db.prepare('UPDATE packs SET status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(input.decision, note, actor.id, new Date().toISOString(), id);
          db.prepare('INSERT INTO pack_reviews VALUES (?,?,?,?,?,?,?)').run(randomUUID(), id, row.revision, input.decision, note, actor.id, new Date().toISOString());
          if (item) db.prepare("INSERT INTO pack_cloud_approvals VALUES (?,?,?,?,?,?,?) ON CONFLICT(pack_id) DO UPDATE SET revision=excluded.revision,sha256=excluded.sha256,digests=excluded.digests,status=excluded.status,actor_id=excluded.actor_id,created=excluded.created").run(id, row.revision, row.sha256, JSON.stringify(item.extensions.map(e => e.digest)), 'approved', actor.id, Date.now());
          audit(actor.id, 'pack-' + input.decision, id, { revision: row.revision, sha256: row.sha256, digests: item?.extensions.map(e => e.digest), reason: note }); db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        value = { ok: true };
      }
    } else if (route === '/reports' && req.method === 'GET') value = { items: db.prepare('SELECT r.id,r.pack_id,r.reason,r.created,p.title,u.name AS reporter FROM reports r JOIN packs p ON p.id=r.pack_id JOIN users u ON u.id=r.user_id ORDER BY r.created DESC LIMIT 100').all() };
    else if (route === '/audit' && req.method === 'GET') {
      const local = db.prepare('SELECT * FROM admin_audit ORDER BY created DESC LIMIT 100').all();
      const invites = db.prepare("SELECT a.id,a.actor_id,a.invitation_id AS target,'invitation-'||a.action AS action,a.created,i.prefix FROM invitation_audit a JOIN invitations i ON i.id=a.invitation_id ORDER BY a.created DESC LIMIT 100").all().map(e => ({ ...e, detail: JSON.stringify({ prefix: e.prefix }) }));
      const remote = (await call(req, '/audit')).entries.map(e => ({ ...e, target: e.user_id || '', detail: JSON.stringify({ previous: e.previous, replacement: e.replacement, reason: e.reason }) }));
      value = { items: [...local, ...invites, ...remote].sort((a, b) => b.created - a.created).slice(0, 150).map(e => ({ ...e, actor: db.prepare('SELECT name FROM users WHERE id=?').get(e.actor_id)?.name || '系统', detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail })) };
    } else if (route.startsWith('/cloud/')) {
      const remote = route.slice('/cloud'.length) + url.search;
      const allowed = req.method === 'GET' && (/^\/submissions(?:\/[a-f0-9-]{36}(?:\/file)?)?(?:\?|$)/.test(remote) || remote === '/extensions' || /^\/extensions\/affected\?/.test(remote)) || req.method === 'POST' && (remote === '/submissions' || /^\/submissions\/[a-f0-9-]{36}\/decision$/.test(remote) || /^\/users\/[a-f0-9-]{36}\/import$/.test(remote) || remote === '/extensions/revoke') || req.method === 'PUT' && (/^\/users\/[a-f0-9-]{36}\/limits$/.test(remote) || remote === '/defaults');
      if (!allowed) throw new CloudError(404, '管理接口不存在');
      const binary = req.method === 'POST' && (remote === '/submissions' || remote.endsWith('/import'));
      value = await call(req, remote, { method: req.method, ...(req.method === 'GET' ? {} : { body: binary ? await bytes(req) : await jsonBody(req) }), ...(binary ? { filename: filename(req), source: { kind: 'preaudit' } } : {}) });
      if (remote.startsWith('/extensions/affected?')) value.publicPacks = db.prepare("SELECT a.pack_id AS id,p.title,a.status FROM pack_cloud_approvals a JOIN packs p ON p.id=a.pack_id WHERE EXISTS (SELECT 1 FROM json_each(a.digests) d WHERE d.value=?)").all(url.searchParams.get('digest'));
      if (remote === '/extensions/revoke') {
        const states = await call(req, '/extensions');
        for (const entry of db.prepare("SELECT pack_id,digests FROM pack_cloud_approvals WHERE status='approved'").all()) {
          if (JSON.parse(entry.digests).some(hash => states.entries.find(e => e.digest === hash)?.status !== 'approved')) db.prepare("UPDATE pack_cloud_approvals SET status='revoked' WHERE pack_id=?").run(entry.pack_id);
        }
      }
    } else throw new CloudError(404, '管理接口不存在');
    send(res, status, value); return true;
  };
}
