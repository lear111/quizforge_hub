import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CloudAccounts } from '../cloud/accounts.mjs';
import { createApp } from '../server.mjs';

function accounting(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,admin INTEGER,created TEXT)');
  for (const [id, admin] of [['alice', 0], ['bob', 0], ['admin', 1]]) db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id, id, id + '@example.test', admin, '2026-01-01');
  t.after(() => db.close());
  return new CloudAccounts(db, { defaults: { storageBytes: 100, dailyTrafficBytes: 50, monthlyTrafficBytes: 80 }, siteStorageBytes: 150, ...options });
}
test('存储预留在用户和站点预算内串行提交，过期与跨用户提交被拒绝', t => {
  let now = Date.UTC(2026, 9, 19);
  const store = accounting(t, { now: () => now });
  const first = store.reserveStorage('alice', 70);
  assert.throws(() => store.reserveStorage('alice', 40), /个人存储/);
  const second = store.reserveStorage('bob', 70);
  assert.throws(() => store.reserveStorage('admin', 20), /站点存储/);
  assert.throws(() => store.commitStorage('bob', first, 70), /不存在/);
  assert.throws(() => store.commitStorage('alice', first, 71), /超过预留/);
  store.commitStorage('alice', first, 60);
  store.releaseStorage('bob', second);
  const expired = store.reserveStorage('alice', 30, 1000); now += 1001;
  assert.throws(() => store.commitStorage('alice', expired, 30), /过期/);
  assert.equal(store.status('alice').usage.storageBytes, 60);
  assert.equal(store.status('alice').usage.reservedStorageBytes, 0);
  store.removeStorage('alice', 10); assert.equal(store.status('alice').usage.storageBytes, 50);
  assert.throws(() => store.removeStorage('alice', 60), /核对/);
});
test('调低额度保留已用量，待提交操作重新检查，审计记录实际管理员', t => {
  const store = accounting(t);
  const reservation = store.reserveStorage('alice', 80);
  store.updateLimits('admin', 'alice', { storageBytes: 20, dailyTrafficBytes: null, monthlyTrafficBytes: null }, '调整测试额度');
  assert.throws(() => store.commitStorage('alice', reservation, 80), /额度已调整/);
  store.releaseStorage('alice', reservation);
  const next = store.reserveStorage('alice', 20); store.commitStorage('alice', next, 20);
  store.updateLimits('admin', 'alice', { storageBytes: 10, dailyTrafficBytes: null, monthlyTrafficBytes: null }, '缩减额度');
  assert.equal(store.status('alice').usage.storageBytes, 20);
  assert.equal(store.status('alice').storageFull, true);
  assert.equal(store.status('alice').limits.dailyTrafficBytes, 50);
  assert.throws(() => store.updateDefaults('bob', { storageBytes: 1, dailyTrafficBytes: 1, monthlyTrafficBytes: 1 }, '无权限'), /管理员/);
  assert.throws(() => store.updateDefaults('admin', { storageBytes: 1, dailyTrafficBytes: 1, monthlyTrafficBytes: 1 }, ''), /原因/);
  const audit = store.audits('admin'); assert.equal(audit.length, 2); assert.equal(audit[0].actor_id, 'admin');
  assert.equal(audit[0].previous.storageBytes, 20); assert.equal(audit[0].replacement.storageBytes, 10);
});
test('下载按北京时间逐日限额，月度旧统计保留但不再限制下载', t => {
  let now = Date.UTC(2026, 9, 19, 15, 59);
  const store = accounting(t, { now: () => now });
  store.reserveTraffic('alice', 40);
  assert.throws(() => store.reserveTraffic('alice', 11), /流量额度/);
  assert.equal(store.status('alice').usage.monthlyTrafficBytes, 40);
  now += 2 * 60000;
  assert.equal(store.status('alice').period.day, '2026-10-20');
  assert.equal(store.status('alice').usage.dailyTrafficBytes, 0);
  store.reserveTraffic('alice', 40); store.reserveTraffic('alice', 1);
  assert.throws(() => store.reserveTraffic('alice', 10), /流量额度/);
  const reopened = new CloudAccounts(store.db, { now: () => now });
  assert.equal(reopened.status('alice').usage.monthlyTrafficBytes, 81);
  assert.equal(reopened.defaults().storageBytes, 100);
});

test('云端沿用 Hub 登录、拒绝越权、持久保存额度与审计，附件流量共同回滚', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qfh-cloud-test-'));
  const codes = new Map(), mailProvider = { ready: true, pepper: 'synthetic-cloud-test-pepper'.repeat(3), verify: async () => true, send: async (email, code) => codes.set(email, code) };
  let current;
  async function start(enabled = true) {
    current = await createApp({ dataDir: directory, cloudEnabled: enabled, mailProvider, cloud: { defaults: { storageBytes: 1024, dailyTrafficBytes: 100, monthlyTrafficBytes: 1000 } } });
    await new Promise(resolve => current.server.listen(0, '127.0.0.1', resolve));
    current.origin = `http://127.0.0.1:${current.server.address().port}`;
  }
  const close = () => new Promise(resolve => { current.server.close(resolve); current.server.closeIdleConnections(); });
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  const request = (route, cookie, body, method = body ? 'POST' : 'GET', origin = current.origin) => fetch(current.origin + route, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  async function register(email) {
    await request('/api/auth/email-code', null, { email, captchaToken: 'synthetic' });
    const response = await request('/api/auth/register', null, { email, name: email.split('@')[0], password: 'synthetic-test-only-password', code: codes.get(email) });
    assert.equal(response.status, 201);
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user };
  }
  await start();
  const alice = await register('alice@example.test'), admin = await register('admin@example.test');
  const db = new DatabaseSync(path.join(directory, 'hub.sqlite'));
  db.prepare('UPDATE users SET admin=1 WHERE id=?').run(admin.user.id);
  assert.equal((await request('/api/cloud/me')).status, 401);
  assert.equal((await request('/api/cloud/admin/users', alice.cookie)).status, 403);
  const mine = await (await request('/api/cloud/me', alice.cookie)).json();
  assert.equal(mine.ai.serverRelay, false); assert.equal(mine.practiceReady, false);
  const input = { limits: { storageBytes: 10, dailyTrafficBytes: 0, monthlyTrafficBytes: null }, reason: '验证个人额度' };
  const route = `/api/cloud/admin/users/${alice.user.id}/limits`;
  assert.equal((await request(route, alice.cookie, input, 'PUT')).status, 403);
  assert.equal((await request(route, admin.cookie, input, 'PUT', 'https://evil.example')).status, 403);
  assert.equal((await request(route, admin.cookie, { ...input, apiKey: 'never-store-this' }, 'PUT')).status, 400);
  assert.equal((await request(route, admin.cookie, input, 'PUT')).status, 200);
  assert.equal((await (await request('/api/cloud/me', alice.cookie)).json()).limits.storageBytes, 10);
  const list = await (await request('/api/cloud/admin/users', admin.cookie)).json(); assert.equal(list.count, 2);
  assert.equal((await (await request('/api/cloud/admin/audit', admin.cookie)).json()).entries.length, 1);
  assert.equal((await request('/api/cloud/ai/credential', alice.cookie)).status, 404);
  for (const route of ['/cloud/', '/cloud/ai', '/cloud/admin', '/cloud/app.js', '/cloud/vault.js', '/cloud/cloud.css']) assert.equal((await request(route)).status, 200, route);
  const policy = (await request('/cloud/ai')).headers.get('content-security-policy'); assert.match(policy, /connect-src 'self' https:/); assert.doesNotMatch(policy, /cloudflare/);
  assert.doesNotMatch((await request('/')).headers.get('content-security-policy'), /connect-src 'self' https:;/);
  // A real existing Hub download exercises joint site/IP/account rollback.
  const pack = '11111111-1111-4111-8111-111111111111', file = '22222222-2222-4222-8222-222222222222';
  db.prepare("INSERT INTO packs(id,user_id,title,summary,description,category,tags,version,created,updated,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(pack, admin.user.id, 'synthetic', '', '', '', '[]', '1', '', '', 'approved');
  db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run(file, pack, 'archive', 'test.qbank', 'application/octet-stream', 4, '0'.repeat(64));
  const { writeFile } = await import('node:fs/promises'); await writeFile(path.join(directory, 'files', file), 'test');
  assert.equal((await request(`/api/packs/${pack}/download`, alice.cookie)).status, 429);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM traffic').get().n, 0);
  assert.equal((await request(`/api/packs/${pack}/download`, admin.cookie)).status, 200);
  assert.equal((await (await request('/api/cloud/me', admin.cookie)).json()).usage.dailyTrafficBytes, 4);
  db.close(); await close(); await start();
  assert.equal((await (await request('/api/cloud/me', alice.cookie)).json()).limits.storageBytes, 10);
  await close(); await start(false);
  assert.equal((await request('/cloud/ai')).status, 404);
  assert.equal((await request('/api/cloud/me', alice.cookie)).status, 404);
});
