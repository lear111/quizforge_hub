import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

export class ContactCodeError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new ContactCodeError(status, message); };
// Registration SMS and supplementary contact binding. Legacy email registration
// retains its existing challenge table and API for backwards compatibility.
export function createContactCodes(db, providers, now = Date.now, dailySmsLimit = 100) {
  if (!Number.isSafeInteger(dailySmsLimit) || dailySmsLimit < 1 || dailySmsLimit > 10000) throw new Error('Invalid SMS daily limit');
  db.exec(`CREATE TABLE IF NOT EXISTS contact_codes(channel TEXT NOT NULL,subject TEXT NOT NULL,nonce TEXT NOT NULL,digest TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,PRIMARY KEY(channel,subject));
    CREATE TABLE IF NOT EXISTS contact_sends(id TEXT PRIMARY KEY,channel TEXT NOT NULL,address_key TEXT NOT NULL,ip_key TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS contact_sends_address ON contact_sends(channel,address_key,created);
    CREATE INDEX IF NOT EXISTS contact_sends_ip ON contact_sends(channel,ip_key,created);`);
  if (!db.prepare('PRAGMA table_info(contact_codes)').all().some(column => column.name === 'captcha_verified')) db.exec('ALTER TABLE contact_codes ADD COLUMN captcha_verified INTEGER NOT NULL DEFAULT 1');
  const providerFor = channel => {
    const provider = providers[channel];
    if (!(provider?.deliveryReady ?? provider?.ready)) fail(503, channel === 'phone' ? '手机验证暂未开放，请使用邮箱' : '邮箱验证暂未开放，请稍后再试');
    return provider;
  };
  const keys = (channel, address, purpose) => {
    const provider = providerFor(channel), key = value => createHmac('sha256', provider.pepper).update(value).digest('hex');
    return { provider, key, addressKey: key(address), subject: key(purpose + ':' + address) };
  };
  const limits = (channel, addressKey, ipKey, time) => {
    const count = (filter, ...args) => db.prepare('SELECT COUNT(*) AS n FROM contact_sends WHERE channel=? AND ' + filter).get(channel, ...args).n;
    if (count('address_key=? AND created>?', addressKey, time - 60000)) fail(429, '请等待 60 秒后再获取验证码');
    if (count('address_key=? AND created>?', addressKey, time - 86400000) >= 5) fail(429, '该联系方式今天的验证码次数已用完');
    if (count('ip_key=? AND created>?', ipKey, time - 600000) >= 5 || count('ip_key=? AND created>?', ipKey, time - 86400000) >= 20) fail(429, '当前网络发送太频繁，请稍后重试');
    if (count('created>?', time - 86400000) >= (channel === 'phone' ? dailySmsLimit : 100)) fail(429, '今天的验证发送额度已用完，请稍后再来');
  };
  return {
    async send(contact, purpose, ip, token, hostname, eligible = true, { captchaRequired = true, captchaAction, verifyCaptcha } = {}) {
      const { channel, value } = contact, { provider, key, addressKey, subject } = keys(channel, value, purpose), ipKey = key(ip);
      limits(channel, addressKey, ipKey, now());
      let verified = false;
      if (captchaRequired) {
        try { verified = await (verifyCaptcha || provider.verify.bind(provider))(token, ip, hostname, captchaAction || (purpose === 'register' ? 'register_phone' : 'bind_contact')); } catch { /* fail closed */ }
        if (!verified) fail(400, '人机验证未通过，请重试');
      }
      const time = now(), nonce = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0');
      db.exec('BEGIN IMMEDIATE');
      try {
        limits(channel, addressKey, ipKey, time);
        db.prepare('DELETE FROM contact_sends WHERE created<=?').run(time - 86400000);
        db.prepare('DELETE FROM contact_codes WHERE expires<=?').run(time);
        db.prepare('INSERT INTO contact_sends VALUES (?,?,?,?,?)').run(nonce, channel, addressKey, ipKey, time);
        db.prepare("INSERT INTO contact_codes(channel,subject,nonce,digest,expires,attempts,state,captcha_verified) VALUES (?,?,?,?,?,0,'pending',?) ON CONFLICT(channel,subject) DO UPDATE SET nonce=excluded.nonce,digest=excluded.digest,expires=excluded.expires,attempts=0,state='pending',captcha_verified=excluded.captcha_verified").run(channel, subject, nonce, key(`${nonce}:${subject}:${code}`), time + 600000, +verified);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      try {
        if (eligible) await provider.send(value, code, nonce, { purpose });
        db.prepare('UPDATE contact_codes SET state=? WHERE channel=? AND subject=? AND nonce=? AND state=\'pending\'').run(eligible ? 'sent' : 'failed', channel, subject, nonce);
      } catch {
        db.prepare("UPDATE contact_codes SET state='failed' WHERE channel=? AND subject=? AND nonce=?").run(channel, subject, nonce);
        // A timeout may still have delivered a paid SMS; do not refund or retry.
        fail(503, '验证码暂时无法发送，请稍后重新获取');
      }
    },
    consume(contact, purpose, code, updateAccount, { captchaRequired = false } = {}) {
      const { channel, value } = contact, { key, subject } = keys(channel, value, purpose);
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT * FROM contact_codes WHERE channel=? AND subject=?').get(channel, subject);
        if (!row || row.state !== 'sent' || row.expires <= now() || row.attempts >= 5) { db.exec('COMMIT'); fail(400, '验证码无效或已失效，请重新获取'); }
        const candidate = key(`${row.nonce}:${subject}:${String(code ?? '')}`);
        if (!/^\d{6}$/.test(String(code ?? '')) || !timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(row.digest, 'hex'))) {
          db.prepare('UPDATE contact_codes SET attempts=attempts+1 WHERE channel=? AND subject=?').run(channel, subject); db.exec('COMMIT'); fail(400, '验证码不正确，请重新输入');
        }
        if ((typeof captchaRequired === 'function' ? captchaRequired() : captchaRequired) && !row.captcha_verified) fail(409, '验证设置已更新，请完成人机验证后重新获取验证码');
        updateAccount({ captchaVerified: !!row.captcha_verified });
        db.prepare("UPDATE contact_codes SET state='consumed' WHERE channel=? AND subject=?").run(channel, subject);
        db.exec('COMMIT');
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    },
  };
}
