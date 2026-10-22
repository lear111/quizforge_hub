import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { ConnectError } from './connect.mjs';

// AI service settings managed from the admin backend (docs/HUB_CONNECT_AI.md 8).
// The service has one switch and an ordered list of upstream API keys. Each key
// has its own address, model, input and output price, remaining amount and expiry.
// Grading tries usable keys from the top of the list and charges the user at the
// prices of the key that answered. A key's status follows its add-time test and
// then its latest call: ok, fault, or insufficient (remaining amount used up, or
// the provider said the account is in arrears). A faulty key is skipped for a
// minute and then tried again; amounts and expiry only change by hand.
// Keys are stored encrypted (AES-256-GCM) with a master key that only systemd
// passes in (OFFICIAL_AI_MASTER_KEY from a root-only file) and are write-only; an
// address cannot be changed, so an admin session cannot send a saved key to
// another server. Amounts are integers in units of 0.0001 yuan; prices are per
// million tokens.
const AAD = Buffer.from('quizforge-official-ai-key-v1');
const MODEL = /^[A-Za-z0-9._:/-]{1,64}$/;
const KEY = /^[\x21-\x7e]{10,200}$/;
const MAX_KEYS = 20, FAULT_COOLDOWN = 60000, ARREARS_COOLDOWN = 600000, TEST_TIMEOUT = 20000;
const PRICE_MAX = 1000 * 10000, AMOUNT_MAX = 1e6 * 10000;
// Provider error codes that mean the account has no money left (others count as a fault).
const ARREARS = new Set(['Arrearage', 'insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'account_deactivated', 'AllocationQuota.FreeTierOnly', 'BudgetLimitExceeded', 'PrepaidBillOverdue', 'PostpaidBillOverdue', 'CommodityNotPurchased']);
const fail = (status, code, message) => { throw new ConnectError(status, code, message); };

export function masterKey(value) {
  if (typeof value !== 'string' || !value) return null;
  const key = Buffer.from(value.trim(), 'base64');
  return key.length === 32 ? key : null;
}
export function encryptKey(master, plain, aad = AAD) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, iv); cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function decryptKey(master, stored, aad = AAD) {
  const bytes = Buffer.from(stored, 'base64'), decipher = createDecipheriv('aes-256-gcm', master, bytes.subarray(0, 12)); decipher.setAAD(aad);
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
const hint = key => key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : '已设置';
// Upstream addresses are HTTPS without credentials, query or fragment; /chat/completions is appended.
export function upstreamUrl(value) {
  let url; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || value.length > 300) return null;
  return url.href.replace(/\/+$/, '');
}
// Cost of one call at a key's prices, rounded up to 0.0001 yuan and at least that.
export function costFor(usage, prices) {
  const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const input = count(usage?.prompt_tokens), output = count(usage?.completion_tokens), total = count(usage?.total_tokens) || input + output;
  // Without a split, every token is charged at the higher price.
  const amount = input || output ? input * prices.inputPrice + output * prices.outputPrice : total * Math.max(prices.inputPrice, prices.outputPrice);
  return Math.max(1, Math.ceil(amount / 1e6));
}
// Sorts a failed upstream response into the key status it causes. Rate limits are
// faults; only an explicit arrears code or HTTP 402 means the account is out of money.
export function upstreamFailure(status, text) {
  let code = ''; try { const body = JSON.parse(text); code = String(body?.error?.code ?? body?.code ?? ''); } catch { /* status only */ }
  if (status !== 429 && (status === 402 || ARREARS.has(code))) return { status: 'insufficient', reason: `欠费或额度不足（${code || 'HTTP ' + status}）` };
  if (status === 400 && !code.startsWith('InvalidApiKey')) return { status: 'rejected', reason: `请求被拒绝（HTTP 400${code ? ' ' + code : ''}）` };
  const what = { 401: 'Key 无效', 403: '没有权限', 404: '地址或模型不存在', 429: '被限流' }[status] || (status >= 500 ? '服务出错' : '请求失败');
  return { status: 'fault', reason: `${what}（HTTP ${status}${code ? ' ' + code : ''}）` };
}

export function createOfficialAiConfig({ db, base, master, now = () => Date.now(), fetchImpl = globalThis.fetch }) {
  db.exec(`CREATE TABLE IF NOT EXISTS official_ai_config (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, model TEXT NOT NULL, daily_limit INTEGER NOT NULL, monthly_tokens INTEGER NOT NULL, key_cipher TEXT, key_hint TEXT, updated INTEGER NOT NULL, updated_by TEXT);
    CREATE TABLE IF NOT EXISTS ai_upstreams (id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, position INTEGER NOT NULL, note TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, key_cipher TEXT NOT NULL, key_hint TEXT NOT NULL,
      input_price INTEGER NOT NULL, output_price INTEGER NOT NULL, remaining INTEGER, expires INTEGER, enabled INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, status_at INTEGER, cooldown_until INTEGER NOT NULL DEFAULT 0,
      spent INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);`);
  // official_ai_config keeps only the switch; its other columns are from earlier versions and unused.
  const row = () => db.prepare('SELECT * FROM official_ai_config WHERE id=1').get();
  const max = column => db.prepare(`SELECT MAX(${column}) AS n FROM ai_upstreams`).get().n || 0;
  // The single key saved by an earlier version becomes key No. 1 at the old price, with no limit or expiry.
  const legacy = row();
  if (legacy?.key_cipher && !db.prepare('SELECT 1 FROM ai_upstreams LIMIT 1').get()) {
    const time = now(), oldPrice = Number.isSafeInteger(legacy.price_per_million) ? legacy.price_per_million : base.inputPrice;
    db.prepare('INSERT INTO ai_upstreams (id,seq,position,note,base_url,model,key_cipher,key_hint,input_price,output_price,remaining,expires,enabled,status,created,updated) VALUES (?,1,1,?,?,?,?,?,?,?,NULL,NULL,1,?,?,?)')
      .run(randomUUID(), '原有 Key', base.baseUrl, legacy.model, legacy.key_cipher, legacy.key_hint || '已设置', oldPrice, oldPrice, 'ok', time, time);
    db.prepare('UPDATE official_ai_config SET key_cipher=NULL,key_hint=NULL WHERE id=1').run();
  }
  const reveal = cipher => { try { return master ? decryptKey(master, cipher) : ''; } catch { return ''; } };
  const rows = () => db.prepare('SELECT * FROM ai_upstreams ORDER BY position, seq').all();
  const emptied = entry => entry.remaining !== null && entry.remaining <= 0;
  const expired = entry => entry.expires !== null && entry.expires <= now();
  const stateOf = entry => !entry.enabled ? 'disabled' : expired(entry) ? 'expired' : emptied(entry) || entry.status === 'insufficient' ? 'insufficient' : entry.status === 'fault' ? 'fault' : 'ok';
  const dto = entry => ({ id: entry.id, seq: entry.seq, note: entry.note, host: new URL(entry.base_url).host, model: entry.model, keyHint: entry.key_hint,
    inputPrice: entry.input_price, outputPrice: entry.output_price, remaining: entry.remaining, expires: entry.expires, enabled: !!entry.enabled, state: stateOf(entry),
    reason: emptied(entry) && entry.status !== 'insufficient' ? '剩余金额已用完' : entry.reason || null, statusAt: entry.status_at, calls: entry.calls, spent: entry.spent, created: entry.created, readable: !!reveal(entry.key_cipher) });
  const entry = id => db.prepare('SELECT * FROM ai_upstreams WHERE id=?').get(id) || fail(404, 'AI_KEY_NOT_FOUND', 'API Key 不存在');

  const enabled = () => !!row()?.enabled;
  // Usable keys in list order, with their keys decrypted.
  function candidates() {
    const time = now(), list = [];
    for (const item of rows()) {
      if (!item.enabled || expired(item) || emptied(item) || item.cooldown_until > time) continue;
      const key = reveal(item.key_cipher); if (key) list.push({ id: item.id, seq: item.seq, baseUrl: item.base_url, model: item.model, key, prices: { inputPrice: item.input_price, outputPrice: item.output_price } });
    }
    return list;
  }
  // Whether a key can serve now or after a short cooldown; used for the client status.
  const available = () => rows().some(item => item.enabled && !expired(item) && !emptied(item) && reveal(item.key_cipher));
  const label = () => rows().find(item => item.enabled && !expired(item) && !emptied(item))?.model ?? base.model;
  // Records a successful call: the key is ok again and its remaining amount goes down.
  function record(id, usage, cost) {
    const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
    db.prepare(`UPDATE ai_upstreams SET status='ok',reason=NULL,status_at=?,cooldown_until=0,spent=spent+?,remaining=CASE WHEN remaining IS NULL THEN NULL ELSE MAX(remaining-?,0) END,
      input_tokens=input_tokens+?,output_tokens=output_tokens+?,calls=calls+1 WHERE id=?`).run(now(), cost, cost, count(usage?.prompt_tokens), count(usage?.completion_tokens), id);
  }
  // Records a failed call or test. A rejected request does not change the key's status.
  function failed(id, failure) {
    if (failure.status === 'rejected') return;
    const time = now(), until = time + (failure.status === 'insufficient' ? ARREARS_COOLDOWN : FAULT_COOLDOWN);
    db.prepare('UPDATE ai_upstreams SET status=?,reason=?,status_at=?,cooldown_until=? WHERE id=?').run(failure.status, failure.reason, time, until, id);
  }

  // Sends a tiny request to check the address, model and key. Never returns provider text.
  async function probe({ baseUrl, model, key }) {
    const started = now();
    try {
      const response = await fetchImpl(baseUrl + '/chat/completions', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TEST_TIMEOUT), headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model, messages: [{ role: 'user', content: '请只回复 OK' }], max_tokens: 5 }) });
      const text = await response.text(), ms = now() - started;
      if (response.ok) { let body = null; try { body = JSON.parse(text); } catch { /* checked below */ } return Array.isArray(body?.choices) ? { ok: true, ms, status: 'ok', reason: '测试通过' } : { ok: false, ms, status: 'fault', reason: '返回的不是 OpenAI 兼容格式' }; }
      const failure = upstreamFailure(response.status, text);
      return { ok: false, ms, status: failure.status === 'rejected' ? 'fault' : failure.status, reason: failure.reason };
    } catch { return { ok: false, ms: now() - started, status: 'fault', reason: '连不上或超时' }; }
  }
  const amount = (value, label, maxValue, nullable) => {
    if (nullable && value === null) return null;
    if (!Number.isSafeInteger(value) || value < 0 || value > maxValue) fail(400, 'AI_SETTINGS_INVALID', `${label}无效`);
    return value;
  };
  // Adds a key and tests it at once; the test result is its first status.
  async function addKey(input) {
    const allowed = ['note', 'baseUrl', 'model', 'apiKey', 'inputPrice', 'outputPrice', 'remaining', 'expires'];
    if (!input || typeof input !== 'object' || Object.keys(input).some(field => !allowed.includes(field))) fail(400, 'AI_SETTINGS_INVALID', '设置字段无效');
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (Array.from(note).length > 60) fail(400, 'AI_SETTINGS_INVALID', '备注最多 60 个字符');
    const baseUrl = upstreamUrl(typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '') || fail(400, 'AI_SETTINGS_INVALID', '服务地址需为 HTTPS 地址，不含账号、查询参数或 #');
    const model = typeof input.model === 'string' && MODEL.test(input.model.trim()) ? input.model.trim() : fail(400, 'AI_SETTINGS_INVALID', '模型名只能包含字母、数字和 . _ : / -，最多 64 个字符');
    if (typeof input.apiKey !== 'string' || !KEY.test(input.apiKey)) fail(400, 'AI_SETTINGS_INVALID', 'API Key 格式不正确：应为 10–200 个可见字符，不含空格');
    const inputPrice = amount(input.inputPrice, '输入单价', PRICE_MAX), outputPrice = amount(input.outputPrice, '输出单价', PRICE_MAX);
    const remaining = amount(input.remaining ?? null, '剩余金额', AMOUNT_MAX, true), expires = input.expires ?? null;
    if (expires !== null && (!Number.isSafeInteger(expires) || expires <= now())) fail(400, 'AI_SETTINGS_INVALID', '到期时间需晚于现在，或留空表示无期限');
    if (!master) fail(409, 'AI_ENCRYPTION_UNAVAILABLE', '服务器尚未配置加密主密钥，不能在后台保存 API Key');
    if (db.prepare('SELECT COUNT(*) AS n FROM ai_upstreams').get().n >= MAX_KEYS) fail(409, 'AI_KEYS_FULL', `最多保存 ${MAX_KEYS} 个 API Key`);
    const test = await probe({ baseUrl, model, key: input.apiKey });
    const id = randomUUID(), time = now();
    db.prepare(`INSERT INTO ai_upstreams (id,seq,position,note,base_url,model,key_cipher,key_hint,input_price,output_price,remaining,expires,enabled,status,reason,status_at,cooldown_until,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`).run(id, max('seq') + 1, max('position') + 1, note, baseUrl, model, encryptKey(master, input.apiKey), hint(input.apiKey),
      inputPrice, outputPrice, remaining, expires, test.status, test.reason, time, test.ok ? 0 : time + FAULT_COOLDOWN, time, time);
    return { test, item: dto(entry(id)) };
  }
  // Only prices and the remaining amount can be edited. A new amount lets the key be tried again at once.
  function updateKey(id, input) {
    const saved = entry(id), allowed = ['inputPrice', 'outputPrice', 'remaining'];
    if (!input || typeof input !== 'object' || Object.keys(input).some(field => !allowed.includes(field))) fail(400, 'AI_SETTINGS_INVALID', '只能修改输入单价、输出单价和剩余金额');
    const next = {
      input_price: Object.hasOwn(input, 'inputPrice') ? amount(input.inputPrice, '输入单价', PRICE_MAX) : saved.input_price,
      output_price: Object.hasOwn(input, 'outputPrice') ? amount(input.outputPrice, '输出单价', PRICE_MAX) : saved.output_price,
      remaining: Object.hasOwn(input, 'remaining') ? amount(input.remaining, '剩余金额', AMOUNT_MAX, true) : saved.remaining };
    const topped = Object.hasOwn(input, 'remaining') && next.remaining !== saved.remaining;
    db.prepare(`UPDATE ai_upstreams SET input_price=?,output_price=?,remaining=?,updated=?${topped ? ",cooldown_until=0,status=CASE WHEN status='insufficient' THEN 'ok' ELSE status END,reason=CASE WHEN status='insufficient' THEN NULL ELSE reason END" : ''} WHERE id=?`)
      .run(next.input_price, next.output_price, next.remaining, now(), id);
    const changed = allowed.filter(field => Object.hasOwn(input, field) && next[{ inputPrice: 'input_price', outputPrice: 'output_price', remaining: 'remaining' }[field]] !== saved[{ inputPrice: 'input_price', outputPrice: 'output_price', remaining: 'remaining' }[field]]);
    return { item: dto(entry(id)), changed };
  }
  function setKeyEnabled(id, value) {
    if (typeof value !== 'boolean') fail(400, 'AI_SETTINGS_INVALID', '请明确选择启用或停用');
    entry(id); db.prepare(`UPDATE ai_upstreams SET enabled=?,updated=?${value ? ',cooldown_until=0' : ''} WHERE id=?`).run(value ? 1 : 0, now(), id);
    return dto(entry(id));
  }
  async function testKey(id) {
    const saved = entry(id), key = reveal(saved.key_cipher);
    if (!key) fail(409, 'AI_ENCRYPTION_UNAVAILABLE', '服务器缺少加密主密钥，无法读取这个 Key');
    const test = await probe({ baseUrl: saved.base_url, model: saved.model, key });
    db.prepare('UPDATE ai_upstreams SET status=?,reason=?,status_at=?,cooldown_until=? WHERE id=?').run(test.status, test.reason, now(), test.ok ? 0 : now() + FAULT_COOLDOWN, id);
    return { test, item: dto(entry(id)) };
  }
  function removeKey(id) { const saved = entry(id); db.prepare('DELETE FROM ai_upstreams WHERE id=?').run(id); return dto(saved); }
  // Saves a new top-to-bottom order; the list must contain every key exactly once.
  function reorder(ids) {
    const current = rows().map(item => item.id);
    if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !current.includes(id))) fail(400, 'AI_SETTINGS_INVALID', '顺序无效，请刷新后重试');
    ids.forEach((id, index) => db.prepare('UPDATE ai_upstreams SET position=? WHERE id=?').run(index + 1, id));
  }
  function setEnabled(actorId, value) {
    if (typeof value !== 'boolean') fail(400, 'AI_SETTINGS_INVALID', '请明确选择是否开启 AI 服务');
    const saved = row();
    db.prepare('INSERT INTO official_ai_config (id,enabled,model,daily_limit,monthly_tokens,updated,updated_by) VALUES (1,?,?,0,0,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated,updated_by=excluded.updated_by')
      .run(value ? 1 : 0, base.model, Math.max(now(), (saved?.updated ?? 0) + 1), actorId);
  }
  function adminStatus() {
    return { enabled: enabled(), keys: rows().map(dto), encryptionReady: !!master, maxKeys: MAX_KEYS, defaults: { baseUrl: base.baseUrl, model: base.model, inputPrice: base.inputPrice, outputPrice: base.outputPrice } };
  }
  function usage(day) {
    const today = db.prepare('SELECT COALESCE(SUM(points),0) AS cost FROM official_ai_usage WHERE day=?').get(day);
    const total = db.prepare('SELECT COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(points),0) AS cost FROM official_ai_usage').get();
    return { totalCalls: total.calls, todayCost: today.cost, totalCost: total.cost };
  }
  return { enabled, candidates, available, label, record, failed, addKey, updateKey, setKeyEnabled, testKey, removeKey, reorder, setEnabled, adminStatus, usage };
}
