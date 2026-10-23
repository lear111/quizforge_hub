import { createHash, randomBytes, randomUUID } from 'node:crypto';

export class InvitationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fingerprint = code => {
  if (typeof code !== 'string' || !/^QF-(?:[A-F0-9]{8}-){3}[A-F0-9]{8}$/.test(code.trim().toUpperCase())) throw new InvitationError(400, '邀请码无效、已使用或已停用');
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
};

export function createInvitationPolicy(db, initiallyRequired = false) {
  if (typeof initiallyRequired !== 'boolean') throw new Error('Invitation policy default must be boolean');
  db.exec('CREATE TABLE IF NOT EXISTS registration_policy(id INTEGER PRIMARY KEY CHECK(id=1),required INTEGER NOT NULL CHECK(required IN (0,1)))');
  // Environment configuration seeds existing installations once; subsequent
  // administrator choices survive restarts and release changes.
  db.prepare('INSERT OR IGNORE INTO registration_policy VALUES (1,?)').run(initiallyRequired ? 1 : 0);
  return {
    required: () => db.prepare('SELECT required FROM registration_policy WHERE id=1').get().required === 1,
    setRequired(value) {
      if (typeof value !== 'boolean') throw new InvitationError(400, '请明确选择是否启用邀请码验证');
      if (!db.isTransaction) throw new Error('Invitation policy updates require the audit transaction');
      db.prepare('UPDATE registration_policy SET required=? WHERE id=1').run(value ? 1 : 0);
    },
  };
}

export function createInvitations(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id), created INTEGER NOT NULL,
    expires INTEGER NOT NULL, revoked INTEGER, used INTEGER,
    user_id TEXT UNIQUE REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS invitation_audit (
    id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL REFERENCES invitations(id),
    actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, created INTEGER NOT NULL);`);
  const admin = actor => {
    if (!db.prepare('SELECT admin FROM users WHERE id=?').get(actor)?.admin) throw new InvitationError(403, '仅管理员可管理邀请码');
  };
  const valid = code => {
    const row = db.prepare('SELECT * FROM invitations WHERE digest=?').get(fingerprint(code));
    if (!row || row.used !== null || row.revoked !== null || row.expires <= now()) throw new InvitationError(400, '邀请码无效、已使用或已停用');
    return row;
  };
  return {
    check: code => { valid(code); },
    // The registration/email-code transaction owns the boundary. Never reserve
    // a code before account creation, and never commit it independently.
    consume(code, userId) {
      if (!db.isTransaction) throw new Error('Invitation consumption requires the account transaction');
      const row = valid(code), time = now();
      const result = db.prepare('UPDATE invitations SET used=?,user_id=? WHERE id=? AND used IS NULL AND revoked IS NULL AND expires>?').run(time, userId, row.id, time);
      if (result.changes !== 1) throw new InvitationError(400, '邀请码无效、已使用或已停用');
      db.prepare('INSERT INTO invitation_audit VALUES (?,?,?,?,?)').run(randomUUID(), row.id, userId, 'redeem', time);
    },
    create(actor, count = 1, days = 30) {
      admin(actor);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100 || !Number.isSafeInteger(days) || days < 1 || days > 365) throw new InvitationError(400, '每次生成 1–100 个邀请码，有效期 1–365 天');
      const issued = [], time = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (let i = 0; i < count; i++) {
          const code = 'QF-' + randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g).join('-'), id = randomUUID();
          db.prepare('INSERT INTO invitations(id,digest,prefix,created_by,created,expires) VALUES (?,?,?,?,?,?)').run(id, fingerprint(code), code.slice(0, 11), actor, time, time + days * 86400000);
          db.prepare('INSERT INTO invitation_audit VALUES (?,?,?,?,?)').run(randomUUID(), id, actor, 'create', time);
          issued.push({ id, code, expires: time + days * 86400000 });
        }
        db.exec('COMMIT'); return issued;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    list(actor) {
      admin(actor);
      return db.prepare('SELECT i.id,i.prefix,i.created,i.expires,i.revoked,i.used,i.user_id,COALESCE(u.email,u.name) AS used_by FROM invitations i LEFT JOIN users u ON u.id=i.user_id ORDER BY i.created DESC,i.id LIMIT 1000').all().map(row => ({ ...row, state: row.used !== null ? 'used' : row.revoked !== null ? 'revoked' : row.expires <= now() ? 'expired' : 'available' }));
    },
    revoke(actor, id) {
      admin(actor); db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT * FROM invitations WHERE id=?').get(id);
        if (!row) throw new InvitationError(404, '邀请码不存在');
        if (row.used !== null) throw new InvitationError(409, '邀请码已使用，不能撤回账号');
        if (row.revoked === null) {
          db.prepare('UPDATE invitations SET revoked=? WHERE id=?').run(now(), id);
          db.prepare('INSERT INTO invitation_audit VALUES (?,?,?,?,?)').run(randomUUID(), id, actor, 'revoke', now());
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
