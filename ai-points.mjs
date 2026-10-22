import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { ConnectError } from './connect.mjs';

// Free AI balance (docs/HUB_CONNECT_AI.md section 6.1), in yuan. Amounts are
// integers in units of 0.0001 yuan (UNIT). Only redeem codes add to a balance;
// grading spends it by the tokens used. Codes are shown once and stored as SHA-256.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HOUR = 3600000, MAX_FAILURES = 10;
export const UNIT = 10000;
export const yuan = amount => (Math.floor(amount / 100) / 100).toFixed(2);
const fail = (status, code, message, extra) => { throw new ConnectError(status, code, message, extra); };
const digest = value => createHash('sha256').update(value).digest('hex');

// Crockford base32 without separators; O, I and L are read as 0, 1 and 1.
export function normalizeCode(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const body = value.toUpperCase().replace(/[\s-]/g, '').replace(/^AI/, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(body) ? body : null;
}
function newCode() {
  const bytes = randomBytes(16), body = Array.from(bytes, byte => ALPHABET[byte & 31]).join('');
  return { body, code: 'AI-' + body.match(/.{4}/g).join('-') };
}

export function createAiPoints({ db, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_points (user_id TEXT PRIMARY KEY REFERENCES users(id), balance INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_redeem_codes (id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, points INTEGER NOT NULL, note TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER, redeemed INTEGER, user_id TEXT REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS ai_points_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), delta INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, created INTEGER NOT NULL);`);
  const failures = new Map();
  const balance = userId => db.prepare('SELECT balance FROM ai_points WHERE user_id=?').get(userId)?.balance || 0;
  const add = (userId, delta, time) => db.prepare('INSERT INTO ai_points VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance=MAX(balance+excluded.balance,0),updated=excluded.updated').run(userId, delta, time);
  const state = row => row.redeemed !== null ? 'redeemed' : row.revoked !== null ? 'revoked' : row.expires <= now() ? 'expired' : 'available';

  // Spends up to `amount` after a successful grading. Concurrent gradings may
  // both start with a small balance; the balance then stops at 0, never below.
  function charge(userId, amount) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const spent = Math.min(amount, balance(userId)), time = now();
      if (spent > 0) add(userId, -spent, time);
      db.exec('COMMIT'); return spent;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function redeem(userId, input) {
    const time = now(), record = failures.get(userId);
    if (record && record.until > time && record.count >= MAX_FAILURES) fail(429, 'REDEEM_LOCKED', '兑换码输错次数太多，请 1 小时后再试');
    const body = normalizeCode(input);
    db.exec('BEGIN IMMEDIATE');
    let row;
    try {
      row = body && db.prepare('SELECT * FROM ai_redeem_codes WHERE digest=?').get(digest(body));
      if (!row || state(row) !== 'available') {
        db.exec('ROLLBACK');
        const next = record && record.until > time ? record : { count: 0, until: time + HOUR };
        next.count++; failures.set(userId, next);
        if (failures.size > 10000) for (const [key, value] of failures) if (value.until <= time) failures.delete(key);
        fail(400, 'REDEEM_CODE_INVALID', '兑换码无效、已使用或已过期');
      }
      db.prepare('UPDATE ai_redeem_codes SET redeemed=?,user_id=? WHERE id=? AND redeemed IS NULL').run(time, userId, row.id);
      add(userId, row.points, time);
      db.prepare('INSERT INTO ai_points_ledger VALUES (?,?,?,?,?,?)').run(randomUUID(), userId, row.points, 'redeem', row.id, time);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    failures.delete(userId);
    return { added: row.points, balance: balance(userId) };
  }

  function createCodes(actorId, input) {
    const count = input?.count, amount = input?.amount, days = input?.days, note = typeof input?.note === 'string' ? input.note.trim() : '';
    if (!Number.isSafeInteger(count) || count < 1 || count > 200) fail(400, 'AI_CODES_INVALID', '每次生成 1–200 个兑换码');
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 10000 * UNIT) fail(400, 'AI_CODES_INVALID', '每个兑换码的面值需为 0.01–10000 元');
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) fail(400, 'AI_CODES_INVALID', '有效期需为 1–3650 天');
    if (Array.from(note).length > 60) fail(400, 'AI_CODES_INVALID', '备注最多 60 个字符');
    const time = now(), expires = time + days * 86400000, issued = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let i = 0; i < count; i++) {
        const { body, code } = newCode(), id = randomUUID();
        db.prepare('INSERT INTO ai_redeem_codes (id,digest,prefix,points,note,created_by,created,expires) VALUES (?,?,?,?,?,?,?,?)').run(id, digest(body), code.slice(0, 7), amount, note, actorId, time, expires);
        issued.push({ id, code, amount, expires });
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return issued;
  }

  function listCodes() {
    const rows = db.prepare('SELECT c.id,c.prefix,c.points AS amount,c.note,c.created,c.expires,c.revoked,c.redeemed,u.name AS redeemed_by FROM ai_redeem_codes c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.created DESC,c.id LIMIT 500').all();
    return rows.map(row => ({ ...row, state: state(row) }));
  }

  function revokeCode(id) {
    const row = db.prepare('SELECT * FROM ai_redeem_codes WHERE id=?').get(id) || fail(404, 'AI_CODE_NOT_FOUND', '兑换码不存在');
    if (row.redeemed !== null) fail(409, 'AI_CODE_REDEEMED', '兑换码已被使用，不能作废');
    if (row.revoked === null) db.prepare('UPDATE ai_redeem_codes SET revoked=? WHERE id=?').run(now(), id);
    return row;
  }

  function summary() {
    const codes = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(points),0) AS points FROM ai_redeem_codes WHERE redeemed IS NULL AND revoked IS NULL AND expires>?').get(now());
    return { outstanding: db.prepare('SELECT COALESCE(SUM(balance),0) AS n FROM ai_points').get().n, availableCodes: codes.n, availableCodeAmount: codes.points };
  }

  return { balance, charge, redeem, createCodes, listCodes, revokeCode, summary };
}
