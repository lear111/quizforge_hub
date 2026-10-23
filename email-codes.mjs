import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

export class EmailCodeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new EmailCodeError(status, message); };

export function createEmailCodes(db, provider, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS email_codes (email_key TEXT PRIMARY KEY, nonce TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_sends (id TEXT PRIMARY KEY, email_key TEXT NOT NULL, ip_key TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS email_sends_email ON email_sends(email_key,created);
    CREATE INDEX IF NOT EXISTS email_sends_ip ON email_sends(ip_key,created);
    CREATE INDEX IF NOT EXISTS email_sends_time ON email_sends(created);`);
  if (!db.prepare('PRAGMA table_info(email_codes)').all().some(column => column.name === 'captcha_verified')) db.exec('ALTER TABLE email_codes ADD COLUMN captcha_verified INTEGER NOT NULL DEFAULT 1');
  const key = value => createHmac('sha256', provider.pepper).update(value).digest('hex');
  const fingerprint = (nonce, email, code) => key(`${nonce}:${email}:${code}`);
  const limits = (emailKey, ipKey, time) => {
    const count = (where, ...args) => db.prepare(`SELECT COUNT(*) AS n FROM email_sends WHERE ${where}`).get(...args).n;
    if (count('email_key=? AND created>?', emailKey, time - 60000)) fail(429, '请等待 60 秒后再获取验证码');
    if (count('email_key=? AND created>?', emailKey, time - 86400000) >= 5) fail(429, '该邮箱今天的验证码次数已用完');
    if (count('ip_key=? AND created>?', ipKey, time - 600000) >= 5 || count('ip_key=? AND created>?', ipKey, time - 86400000) >= 20) fail(429, '当前网络发送太频繁，请稍后重试');
    if (count('created>?', time - 86400000) >= 100) fail(429, '今天的邮件额度已用完，请稍后再来');
  };
  return {
    ready: provider.ready, siteKey: provider.siteKey || '',
    async send(email, ip, token, hostname, { captchaRequired = true, verifyCaptcha } = {}) {
      if (!(provider.deliveryReady ?? provider.ready)) fail(503, '注册邮件暂未开放，请稍后再来');
      const emailKey = key(email), ipKey = key(ip);
      limits(emailKey, ipKey, now());
      let verified = false;
      if (captchaRequired) {
        try { verified = await (verifyCaptcha || provider.verify.bind(provider))(token, ip, hostname, 'register_email'); } catch { /* fail closed */ }
        if (!verified) fail(400, '人机验证未通过，请重试');
      }
      const time = now(), nonce = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0');
      db.exec('BEGIN IMMEDIATE');
      try {
        limits(emailKey, ipKey, time);
        db.prepare('DELETE FROM email_sends WHERE created<=?').run(time - 86400000);
        db.prepare('DELETE FROM email_codes WHERE expires<=?').run(time);
        db.prepare('INSERT INTO email_sends VALUES (?,?,?,?)').run(nonce, emailKey, ipKey, time);
        db.prepare(`INSERT INTO email_codes (email_key,nonce,digest,expires,attempts,state,captcha_verified) VALUES (?,?,?,?,0,'pending',?) ON CONFLICT(email_key) DO UPDATE SET nonce=excluded.nonce,digest=excluded.digest,expires=excluded.expires,attempts=0,state='pending',captcha_verified=excluded.captcha_verified`).run(emailKey, nonce, fingerprint(nonce, email, code), time + 600000, +verified);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      // Existing accounts receive the same public response without another email.
      if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
        db.prepare("UPDATE email_codes SET state='failed' WHERE email_key=? AND nonce=?").run(emailKey, nonce); return;
      }
      try {
        await provider.send(email, code);
        db.prepare("UPDATE email_codes SET state='sent' WHERE email_key=? AND nonce=? AND state='pending'").run(emailKey, nonce);
      } catch {
        db.prepare("UPDATE email_codes SET state='failed' WHERE email_key=? AND nonce=?").run(emailKey, nonce);
        // Keep the reservation even on a timeout: the upstream may have accepted the mail.
        fail(503, '邮件暂时无法发送，请稍后重新获取验证码');
      }
    },
    consume(email, code, createUser, { captchaRequired = false } = {}) {
      if (!(provider.deliveryReady ?? provider.ready)) fail(503, '注册邮件暂未开放，请稍后再来');
      const emailKey = key(email);
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT * FROM email_codes WHERE email_key=?').get(emailKey);
        if (!row || row.state !== 'sent' || row.expires <= now() || row.attempts >= 5) {
          db.exec('COMMIT'); fail(400, '验证码无效或已失效，请重新获取');
        }
        const candidate = fingerprint(row.nonce, email, String(code ?? ''));
        if (!/^\d{6}$/.test(String(code ?? '')) || !timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(row.digest, 'hex'))) {
          db.prepare('UPDATE email_codes SET attempts=attempts+1 WHERE email_key=?').run(emailKey);
          db.exec('COMMIT'); fail(400, '验证码不正确，请重新输入');
        }
        if ((typeof captchaRequired === 'function' ? captchaRequired() : captchaRequired) && !row.captcha_verified) fail(409, '验证设置已更新，请完成人机验证后重新获取验证码');
        createUser({ captchaVerified: !!row.captcha_verified });
        db.prepare("UPDATE email_codes SET state='consumed' WHERE email_key=?").run(emailKey);
        db.exec('COMMIT');
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    },
  };
}
