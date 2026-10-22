import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConnectError } from './connect.mjs';

// AI service settings managed from the admin backend (docs/HUB_CONNECT_AI.md 8).
// The upstream API key is stored encrypted (AES-256-GCM) with a master key that
// only systemd passes in (OFFICIAL_AI_MASTER_KEY from a root-only file), so the
// database or a data backup alone never reveals it. The key is write-only: no
// API returns it. The upstream address is not editable here, so an admin
// session cannot redirect the key to another server.
const AAD = Buffer.from('quizforge-official-ai-key-v1');
const MODEL = /^[A-Za-z0-9._-]{1,64}$/;
const KEY = /^[\x21-\x7e]{10,200}$/;
const fail = (status, code, message) => { throw new ConnectError(status, code, message); };

export function masterKey(value) {
  if (typeof value !== 'string' || !value) return null;
  const key = Buffer.from(value.trim(), 'base64');
  return key.length === 32 ? key : null;
}
export function encryptKey(master, plain) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, iv); cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function decryptKey(master, stored) {
  const bytes = Buffer.from(stored, 'base64'), decipher = createDecipheriv('aes-256-gcm', master, bytes.subarray(0, 12)); decipher.setAAD(AAD);
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
const hint = key => key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : '已设置';

export function createOfficialAiConfig({ db, base, master, now = () => Date.now() }) {
  db.exec('CREATE TABLE IF NOT EXISTS official_ai_config (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, model TEXT NOT NULL, daily_limit INTEGER NOT NULL, monthly_tokens INTEGER NOT NULL, key_cipher TEXT, key_hint TEXT, updated INTEGER NOT NULL, updated_by TEXT)');
  // daily_limit and tokens_per_point are no longer used: grading spends a yuan balance (section 6.1).
  const columns = db.prepare('PRAGMA table_info(official_ai_config)').all().map(column => column.name);
  if (!columns.includes('tokens_per_point')) db.exec('ALTER TABLE official_ai_config ADD COLUMN tokens_per_point INTEGER NOT NULL DEFAULT 1000');
  if (!columns.includes('price_per_million')) db.exec('ALTER TABLE official_ai_config ADD COLUMN price_per_million INTEGER NOT NULL DEFAULT 30000');
  const row = () => db.prepare('SELECT * FROM official_ai_config WHERE id=1').get();
  let cache = null;
  // Effective settings. Without an admin row the server file applies as before;
  // a key in the server file always wins as an emergency override.
  function current() {
    const saved = row(), stamp = saved?.updated ?? 0;
    if (cache && cache.stamp === stamp) return cache.value;
    let key = base.key || '', keySource = base.key ? 'file' : null;
    if (!key && saved?.key_cipher) {
      keySource = 'admin';
      try { key = master ? decryptKey(master, saved.key_cipher) : ''; } catch { key = ''; }
      if (!key) keySource = 'locked';
    }
    const value = saved
      ? { enabled: !!saved.enabled, baseUrl: base.baseUrl, model: saved.model, pricePerMillion: saved.price_per_million, monthlyTokens: saved.monthly_tokens, key, keySource, keyHint: base.key ? hint(base.key) : saved.key_hint }
      : { ...base, key, keySource, keyHint: key ? hint(key) : null };
    cache = { stamp, value }; return value;
  }
  function adminStatus() {
    const value = current(), saved = row();
    return { enabled: value.enabled, model: value.model, pricePerMillion: value.pricePerMillion, monthlyTokens: value.monthlyTokens, upstreamHost: new URL(value.baseUrl).host,
      key: { configured: !!value.key, source: value.keySource, hint: value.keyHint || null }, encryptionReady: !!master, managedByAdmin: !!saved,
      updated: saved?.updated ?? null, updatedBy: saved?.updated_by ? db.prepare('SELECT name FROM users WHERE id=?').get(saved.updated_by)?.name ?? null : null };
  }
  // Applies an admin change. Returns the changed field names (never values of the key).
  function update(actorId, input) {
    const allowed = ['enabled', 'model', 'pricePerMillion', 'monthlyTokens', 'apiKey', 'clearKey', 'password'];
    if (!input || typeof input !== 'object' || Object.keys(input).some(field => !allowed.includes(field))) fail(400, 'AI_SETTINGS_INVALID', '设置字段无效');
    const value = current(), next = { enabled: value.enabled, model: value.model, pricePerMillion: value.pricePerMillion, monthlyTokens: value.monthlyTokens };
    if (Object.hasOwn(input, 'enabled')) { if (typeof input.enabled !== 'boolean') fail(400, 'AI_SETTINGS_INVALID', '请明确选择是否开启 AI 服务'); next.enabled = input.enabled; }
    if (Object.hasOwn(input, 'model')) { if (!MODEL.test(input.model)) fail(400, 'AI_SETTINGS_INVALID', '模型名只能包含字母、数字、点、下划线和连字符，最多 64 个字符'); next.model = input.model; }
    if (Object.hasOwn(input, 'pricePerMillion')) { if (!Number.isInteger(input.pricePerMillion) || input.pricePerMillion < 1 || input.pricePerMillion > 1000 * 10000) fail(400, 'AI_SETTINGS_INVALID', '每百万 token 价格需为 0.0001–1000 元'); next.pricePerMillion = input.pricePerMillion; }
    if (Object.hasOwn(input, 'monthlyTokens')) { if (!Number.isSafeInteger(input.monthlyTokens) || input.monthlyTokens < 0 || input.monthlyTokens > 1e10) fail(400, 'AI_SETTINGS_INVALID', '每月 token 预算需为 0–100 亿的整数'); next.monthlyTokens = input.monthlyTokens; }
    const saved = row(); let cipher = saved?.key_cipher ?? null, keyHint = saved?.key_hint ?? null, keyChange = null;
    if (Object.hasOwn(input, 'apiKey') || input.clearKey === true) {
      if (input.clearKey === true && Object.hasOwn(input, 'apiKey')) fail(400, 'AI_SETTINGS_INVALID', '不能同时设置和清除 API Key');
      if (input.clearKey === true) { cipher = null; keyHint = null; keyChange = 'cleared'; }
      else {
        if (typeof input.apiKey !== 'string' || !KEY.test(input.apiKey)) fail(400, 'AI_SETTINGS_INVALID', 'API Key 格式不正确：应为 10–200 个可见字符，不含空格');
        if (!master) fail(409, 'AI_ENCRYPTION_UNAVAILABLE', '服务器尚未配置加密主密钥，不能在后台保存 API Key');
        cipher = encryptKey(master, input.apiKey); keyHint = hint(input.apiKey); keyChange = 'replaced';
      }
    }
    const changed = ['enabled', 'model', 'pricePerMillion', 'monthlyTokens'].filter(field => next[field] !== value[field] || !saved);
    if (keyChange) changed.push(keyChange === 'cleared' ? 'apiKey:cleared' : 'apiKey:replaced');
    db.prepare(`INSERT INTO official_ai_config (id,enabled,model,daily_limit,monthly_tokens,key_cipher,key_hint,updated,updated_by,price_per_million) VALUES (1,?,?,0,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,model=excluded.model,price_per_million=excluded.price_per_million,monthly_tokens=excluded.monthly_tokens,key_cipher=excluded.key_cipher,key_hint=excluded.key_hint,updated=excluded.updated,updated_by=excluded.updated_by`)
      .run(next.enabled ? 1 : 0, next.model, next.monthlyTokens, cipher, keyHint, Math.max(now(), (saved?.updated ?? 0) + 1), actorId, next.pricePerMillion);
    cache = null;
    return changed;
  }
  function usage(day, month) {
    const today = db.prepare('SELECT COALESCE(SUM(calls),0) AS calls, COUNT(*) AS users, COALESCE(SUM(points),0) AS cost FROM official_ai_usage WHERE day=? AND calls>0').get(day);
    const tokens = db.prepare('SELECT tokens FROM official_ai_budget WHERE period=?').get(month)?.tokens || 0;
    return { todayCalls: today.calls, todayUsers: today.users, todayCost: today.cost, monthTokens: tokens };
  }
  return { current, adminStatus, update, usage };
}
