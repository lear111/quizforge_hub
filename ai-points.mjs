import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { ConnectError } from './connect.mjs';
import { encryptKey, decryptKey } from './official-ai-config.mjs';

// Free AI balance (docs/HUB_CONNECT_AI.md section 6.1), in yuan. Amounts are
// integers in units of 0.0001 yuan (UNIT). Only redeem codes add to a balance;
// grading spends it by the tokens used. Codes are looked up by SHA-256; the full code
// is also kept encrypted with the AI master key so administrators can see unused codes.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HOUR = 3600000, MAX_FAILURES = 10, CODE_AAD = Buffer.from('quizforge-redeem-code-v1');
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

export function createAiPoints({ db, master = null, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_points (user_id TEXT PRIMARY KEY REFERENCES users(id), balance INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_redeem_codes (id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, points INTEGER NOT NULL, note TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER, redeemed INTEGER, user_id TEXT REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS ai_points_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), delta INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, created INTEGER NOT NULL);`);
  // revoked doubles as "stopped" and can be cleared again; seq is the number shown in the admin list.
  const columns = db.prepare('PRAGMA table_info(ai_redeem_codes)').all().map(column => column.name);
  if (!columns.includes('code_cipher')) db.exec('ALTER TABLE ai_redeem_codes ADD COLUMN code_cipher TEXT');
  if (!columns.includes('seq')) {
    db.exec('ALTER TABLE ai_redeem_codes ADD COLUMN seq INTEGER');
    db.prepare('SELECT id FROM ai_redeem_codes ORDER BY created, id').all().forEach((row, index) => db.prepare('UPDATE ai_redeem_codes SET seq=? WHERE id=?').run(index + 1, row.id));
  }
  const readCode = cipher => { try { return cipher && master ? decryptKey(master, cipher, CODE_AAD) : null; } catch { return null; } };
  const failures = new Map();
  const balance = userId => db.prepare('SELECT balance FROM ai_points WHERE user_id=?').get(userId)?.balance || 0;
  const add = (userId, delta, time) => db.prepare('INSERT INTO ai_points VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance=MAX(balance+excluded.balance,0),updated=excluded.updated').run(userId, delta, time);
  const state = row => row.redeemed !== null ? 'redeemed' : row.revoked !== null ? 'disabled' : row.expires <= now() ? 'expired' : 'available';

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

  const fail400 = message => fail(400, 'AI_CODES_INVALID', message);
  const noteOf = value => { const note = typeof value === 'string' ? value.trim() : ''; if (Array.from(note).length > 60) fail400('备注最多 60 个字符'); return note; };
  // New codes start enabled. expires is a timestamp chosen in the admin form.
  function createCodes(actorId, input) {
    const allowed = ['count', 'amount', 'expires', 'note'];
    if (!input || typeof input !== 'object' || Object.keys(input).some(field => !allowed.includes(field))) fail400('字段无效');
    const { count, amount, expires } = input, note = noteOf(input.note), time = now();
    if (!Number.isSafeInteger(count) || count < 1 || count > 200) fail400('每次生成 1–200 个兑换码');
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 10000 * UNIT) fail400('每个兑换码的金额需为 0.01–10000 元');
    if (!Number.isSafeInteger(expires) || expires <= time || expires > time + 3650 * 86400000) fail400('到期时间需在今天之后、10 年以内');
    const issued = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      let seq = db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM ai_redeem_codes').get().n;
      for (let i = 0; i < count; i++) {
        const { body, code } = newCode(), id = randomUUID();
        db.prepare('INSERT INTO ai_redeem_codes (id,digest,prefix,points,note,created_by,created,expires,code_cipher,seq) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, digest(body), code.slice(0, 7), amount, note, actorId, time, expires, master ? encryptKey(master, code, CODE_AAD) : null, ++seq);
        issued.push({ id, seq, code, amount, expires });
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return issued;
  }

  // Unused codes show in full; redeemed ones only by prefix.
  function listCodes() {
    const rows = db.prepare('SELECT c.*,u.name AS redeemed_by FROM ai_redeem_codes c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.seq DESC LIMIT 1000').all();
    return rows.map(row => {
      const code = row.redeemed === null ? readCode(row.code_cipher) : null;
      return { id: row.id, seq: row.seq, code: code || row.prefix + '-…', full: !!code, note: row.note, created: row.created, expires: row.expires, amount: row.points, enabled: row.revoked === null, state: state(row), redeemedBy: row.redeemed_by, redeemed: row.redeemed };
    });
  }

  // Edits the note or switches a code on or off. A redeemed code cannot be switched.
  function updateCode(id, input) {
    const row = db.prepare('SELECT * FROM ai_redeem_codes WHERE id=?').get(id) || fail(404, 'AI_CODE_NOT_FOUND', '兑换码不存在');
    if (!input || typeof input !== 'object' || !Object.keys(input).length || Object.keys(input).some(field => !['note', 'enabled'].includes(field))) fail400('只能修改备注和启用状态');
    const changed = [];
    if (Object.hasOwn(input, 'note')) { const note = noteOf(input.note); if (note !== row.note) { db.prepare('UPDATE ai_redeem_codes SET note=? WHERE id=?').run(note, id); changed.push('note'); } }
    if (Object.hasOwn(input, 'enabled')) {
      if (typeof input.enabled !== 'boolean') fail400('请明确选择启用或停用');
      if (row.redeemed !== null) fail(409, 'AI_CODE_REDEEMED', '兑换码已被使用，不能再启用或停用');
      if (input.enabled !== (row.revoked === null)) { db.prepare('UPDATE ai_redeem_codes SET revoked=? WHERE id=?').run(input.enabled ? null : now(), id); changed.push(input.enabled ? 'enabled' : 'disabled'); }
    }
    return { row, changed };
  }

  function summary() {
    const codes = db.prepare('SELECT COALESCE(SUM(points),0) AS total, COALESCE(SUM(CASE WHEN redeemed IS NOT NULL THEN points ELSE 0 END),0) AS used FROM ai_redeem_codes').get();
    return { userBalance: db.prepare('SELECT COALESCE(SUM(balance),0) AS n FROM ai_points').get().n, codeTotal: codes.total, codeRedeemed: codes.used };
  }

  // Balance and total redeemed for the admin user list.
  function accounts(userIds) {
    const result = {};
    for (const id of userIds) result[id] = { balance: balance(id), redeemed: db.prepare("SELECT COALESCE(SUM(delta),0) AS n FROM ai_points_ledger WHERE user_id=? AND kind='redeem'").get(id).n };
    return result;
  }
  // An administrator sets a new balance (not an increment) with a reason; the change is a ledger entry.
  function setBalance(userId, input) {
    const allowed = ['balance', 'reason'];
    if (!input || typeof input !== 'object' || Object.keys(input).some(field => !allowed.includes(field))) fail400('只能修改余额');
    if (!Number.isSafeInteger(input.balance) || input.balance < 0 || input.balance > 1e6 * UNIT) fail400('余额需为 0–1000000 元');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || Array.from(reason).length > 200) fail400('请填写 1–200 个字的原因');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) fail(404, 'USER_NOT_FOUND', '用户不存在');
    db.exec('BEGIN IMMEDIATE');
    try {
      const before = balance(userId), time = now();
      db.prepare('INSERT INTO ai_points VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance=excluded.balance,updated=excluded.updated').run(userId, input.balance, time);
      if (input.balance !== before) db.prepare('INSERT INTO ai_points_ledger VALUES (?,?,?,?,?,?)').run(randomUUID(), userId, input.balance - before, 'admin', reason, time);
      db.exec('COMMIT');
      return { before, after: input.balance, reason };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Recent balance changes: redeems and admin changes one by one, grading spend per day.
  function history(userId, limit = 20) {
    const entries = db.prepare(`SELECT l.delta,l.kind,l.ref,l.created,c.prefix FROM ai_points_ledger l LEFT JOIN ai_redeem_codes c ON l.kind='redeem' AND c.id=l.ref WHERE l.user_id=? ORDER BY l.created DESC LIMIT ?`).all(userId, limit)
      .map(row => ({ kind: row.kind, delta: row.delta, at: row.created, note: row.kind === 'redeem' ? row.prefix || '' : row.ref || '' }));
    let spend = [];
    try { spend = db.prepare('SELECT day,calls,points FROM official_ai_usage WHERE user_id=? AND points>0 ORDER BY day DESC LIMIT ?').all(userId, limit).map(row => ({ kind: 'grading', delta: -row.points, day: row.day, calls: row.calls, at: Date.parse(row.day + 'T23:59:59+08:00') })); } catch { /* no grading yet */ }
    return [...entries, ...spend].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  return { balance, charge, redeem, createCodes, listCodes, updateCode, summary, accounts, setBalance, history };
}
