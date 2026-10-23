import { randomUUID } from 'node:crypto';
import { initializeContacts } from '../accounts.mjs';

export class CloudError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new CloudError(status, message); };
const MiB = 1024 ** 2;
const fields = ['storageBytes', 'dailyTrafficBytes', 'monthlyTrafficBytes'];
const maximum = 1024 ** 5;
const numeric = value => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function limits(value, nullable = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) fail(400, '请完整填写三项资源额度');
  if (fields.some(key => !(nullable && value[key] === null) && !numeric(value[key]))) fail(400, '额度必须是有效的非负整数字节数');
  return value;
}

// Accounting primitives own transactions. A caller may join an existing Hub
// download transaction so site, IP and account traffic are reserved together.
export class CloudAccounts {
  constructor(db, { now = Date.now, timeZone = 'Asia/Shanghai', defaults, siteStorageBytes = 5 * 1024 ** 3 } = {}) {
    initializeContacts(db);
    this.db = db; this.now = now;
    this.calendar = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (!numeric(siteStorageBytes)) throw new Error('Invalid cloud site storage budget');
    this.siteStorageBytes = siteStorageBytes;
    const initial = limits(defaults ?? { storageBytes: 256 * MiB, dailyTrafficBytes: 256 * MiB, monthlyTrafficBytes: 1024 * MiB });
    db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_defaults (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_accounts (user_id TEXT PRIMARY KEY REFERENCES users(id), limits_json TEXT NOT NULL, storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK(storage_bytes>=0));
      CREATE TABLE IF NOT EXISTS cloud_storage_reservations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), bytes INTEGER NOT NULL CHECK(bytes>=0), expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cloud_storage_owner ON cloud_storage_reservations(user_id);
      CREATE TABLE IF NOT EXISTS cloud_traffic (user_id TEXT NOT NULL REFERENCES users(id), period TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0), PRIMARY KEY(user_id,period));
      CREATE TABLE IF NOT EXISTS cloud_audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), user_id TEXT REFERENCES users(id), action TEXT NOT NULL, previous TEXT NOT NULL, replacement TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL);
    `);
    db.prepare('INSERT OR IGNORE INTO cloud_defaults VALUES (1,?)').run(JSON.stringify(initial));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  periods() {
    const parts = Object.fromEntries(this.calendar.formatToParts(new Date(this.now())).map(part => [part.type, part.value]));
    return { month: `${parts.year}-${parts.month}`, day: `${parts.year}-${parts.month}-${parts.day}` };
  }
  defaults() { return JSON.parse(this.db.prepare('SELECT value FROM cloud_defaults WHERE id=1').get().value); }
  ensure(userId) {
    if (!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) fail(404, '用户不存在');
    this.db.prepare('INSERT OR IGNORE INTO cloud_accounts(user_id,limits_json) VALUES (?,?)').run(userId, JSON.stringify(Object.fromEntries(fields.map(key => [key, null]))));
    return this.db.prepare('SELECT * FROM cloud_accounts WHERE user_id=?').get(userId);
  }
  status(userId) {
    const row = this.ensure(userId), overrides = JSON.parse(row.limits_json), defaults = this.defaults(), effective = Object.fromEntries(fields.map(key => [key, overrides[key] ?? defaults[key]]));
    const period = this.periods(), traffic = key => this.db.prepare('SELECT bytes FROM cloud_traffic WHERE user_id=? AND period=?').get(userId, key)?.bytes ?? 0;
    const reservedBytes = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM cloud_storage_reservations WHERE user_id=? AND expires>?').get(userId, this.now()).n;
    return { limits: effective, overrides, usage: { storageBytes: row.storage_bytes, reservedStorageBytes: reservedBytes, dailyTrafficBytes: traffic(period.day), monthlyTrafficBytes: traffic(period.month) }, period, storageFull: row.storage_bytes + reservedBytes >= effective.storageBytes };
  }
  admin(actorId) { if (!this.db.prepare('SELECT admin FROM users WHERE id=?').get(actorId)?.admin) fail(403, '仅管理员可调整资源额度'); }
  audit(actorId, userId, action, previous, replacement, reason) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) fail(400, '请填写 1–500 字的调整原因');
    this.db.prepare('INSERT INTO cloud_audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), actorId, userId, action, JSON.stringify(previous), JSON.stringify(replacement), reason.trim(), this.now());
  }
  updateLimits(actorId, userId, replacement, reason) {
    this.admin(actorId); limits(replacement, true);
    return this.transaction(() => {
      const previous = JSON.parse(this.ensure(userId).limits_json);
      this.audit(actorId, userId, 'user-limits', previous, replacement, reason);
      this.db.prepare('UPDATE cloud_accounts SET limits_json=? WHERE user_id=?').run(JSON.stringify(replacement), userId);
      return this.status(userId);
    });
  }
  updateDefaults(actorId, replacement, reason) {
    this.admin(actorId); limits(replacement);
    return this.transaction(() => {
      this.audit(actorId, null, 'default-limits', this.defaults(), replacement, reason);
      this.db.prepare('UPDATE cloud_defaults SET value=? WHERE id=1').run(JSON.stringify(replacement));
      return this.defaults();
    });
  }
  list(actorId, page = 1, query = '') {
    this.admin(actorId);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || typeof query !== 'string' || query.length > 100) fail(400, '无效的查询');
    const pattern = '%' + query.replace(/[!%_]/g, '!$&') + '%';
    const where = "WHERE email LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!' OR id IN (SELECT user_id FROM user_phones WHERE phone LIKE ? ESCAPE '!')";
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM users ' + where).get(pattern, pattern, pattern).n;
    const users = this.db.prepare('SELECT id,name,email,(SELECT phone FROM user_phones WHERE user_id=users.id) AS phone,admin FROM users ' + where + ' ORDER BY created DESC,id LIMIT 50 OFFSET ?').all(pattern, pattern, pattern, (page - 1) * 50);
    return { users: users.map(user => ({ ...user, ...this.status(user.id) })), count, page, defaults: this.defaults(), site: this.siteStatus() };
  }
  audits(actorId, userId = null) {
    this.admin(actorId);
    const rows = userId ? this.db.prepare('SELECT * FROM cloud_audit WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 50').all(userId) : this.db.prepare('SELECT * FROM cloud_audit ORDER BY created DESC,rowid DESC LIMIT 50').all();
    return rows.map(row => ({ ...row, previous: JSON.parse(row.previous), replacement: JSON.parse(row.replacement) }));
  }
  siteStatus() {
    return { storageBytes: this.db.prepare('SELECT COALESCE(SUM(storage_bytes),0) AS n FROM cloud_accounts').get().n, reservedStorageBytes: this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM cloud_storage_reservations WHERE expires>?').get(this.now()).n, storageLimitBytes: this.siteStorageBytes };
  }
  reserveStorage(userId, bytes, ttlMs = 120000) {
    if (!numeric(bytes) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600000) fail(400, '无效的存储预留');
    return this.transaction(() => {
      this.db.prepare('DELETE FROM cloud_storage_reservations WHERE expires<=?').run(this.now());
      const account = this.status(userId), site = this.siteStatus();
      if (account.usage.storageBytes + account.usage.reservedStorageBytes + bytes > account.limits.storageBytes) fail(413, '个人存储额度不足');
      if (site.storageBytes + site.reservedStorageBytes + bytes > site.storageLimitBytes) fail(507, '站点存储预算不足');
      const id = randomUUID();
      this.db.prepare('INSERT INTO cloud_storage_reservations VALUES (?,?,?,?)').run(id, userId, bytes, this.now() + ttlMs);
      return id;
    });
  }
  commitStorage(userId, reservationId, actualBytes, { transaction = true } = {}) {
    if (!numeric(actualBytes)) fail(400, '无效的实际存储大小');
    const operation = () => {
      const row = this.db.prepare('SELECT * FROM cloud_storage_reservations WHERE id=? AND user_id=? AND expires>?').get(reservationId, userId, this.now());
      if (!row) fail(409, '存储预留已过期或不存在');
      if (actualBytes > row.bytes) fail(413, '实际存储超过预留额度');
      const account = this.status(userId), site = this.siteStatus();
      if (account.usage.storageBytes + account.usage.reservedStorageBytes - row.bytes + actualBytes > account.limits.storageBytes) fail(413, '个人存储额度已调整，请重新尝试');
      if (site.storageBytes + site.reservedStorageBytes - row.bytes + actualBytes > site.storageLimitBytes) fail(507, '站点存储预算不足');
      this.db.prepare('UPDATE cloud_accounts SET storage_bytes=storage_bytes+? WHERE user_id=?').run(actualBytes, userId);
      this.db.prepare('DELETE FROM cloud_storage_reservations WHERE id=?').run(reservationId);
      return this.status(userId);
    };
    return transaction ? this.transaction(operation) : operation();
  }
  releaseStorage(userId, reservationId) { this.db.prepare('DELETE FROM cloud_storage_reservations WHERE id=? AND user_id=?').run(reservationId, userId); }
  removeStorage(userId, bytes, { transaction = true } = {}) {
    if (!numeric(bytes)) fail(400, '无效的删除大小');
    const operation = () => {
      const row = this.ensure(userId);
      if (bytes > row.storage_bytes) fail(409, '存储统计需要重新核对');
      this.db.prepare('UPDATE cloud_accounts SET storage_bytes=storage_bytes-? WHERE user_id=?').run(bytes, userId);
      return this.status(userId);
    };
    return transaction ? this.transaction(operation) : operation();
  }
  reserveTraffic(userId, bytes, { transaction = true } = {}) {
    if (!numeric(bytes)) fail(400, '无效的流量大小');
    const operation = () => {
      const account = this.status(userId);
      if (account.usage.dailyTrafficBytes + bytes > account.limits.dailyTrafficBytes) fail(429, '今日下载流量额度已用完，请明天再试或联系管理员');
      for (const period of Object.values(account.period)) this.db.prepare('INSERT INTO cloud_traffic VALUES (?,?,?) ON CONFLICT(user_id,period) DO UPDATE SET bytes=bytes+excluded.bytes').run(userId, period, bytes);
    };
    return transaction ? this.transaction(operation) : operation();
  }
}
