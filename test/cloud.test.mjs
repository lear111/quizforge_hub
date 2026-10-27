import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CloudAccounts } from '../practice/server/cloud/accounts.mjs';

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
