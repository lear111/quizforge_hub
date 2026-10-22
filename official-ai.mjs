import { randomUUID } from 'node:crypto';
import { ConnectError } from './connect.mjs';

// Official AI gateway (docs/HUB_CONNECT_AI.md section 6). The upstream key stays
// here. Only counts and token totals are stored; request and response content
// is never written to the database or logs.
const MiB = 1024 * 1024;
const FIELDS = new Set(['model', 'messages', 'max_tokens', 'response_format', 'temperature']);
const IMAGE = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const fail = (status, code, message, extra) => { throw new ConnectError(status, code, message, extra); };
const reject = message => fail(400, 'AI_REQUEST_UNSUPPORTED', message);

export function officialAiSettings(env = process.env) {
  return {
    enabled: env.OFFICIAL_AI_ENABLED === '1',
    baseUrl: (env.OFFICIAL_AI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    model: env.OFFICIAL_AI_MODEL || 'qwen-vl-plus',
    key: env.OFFICIAL_AI_KEY || '',
    dailyLimit: Number(env.OFFICIAL_AI_DAILY_LIMIT || 20),
    monthlyTokens: Number(env.OFFICIAL_AI_MONTHLY_TOKENS || 10000000),
  };
}

// Shanghai has no daylight saving time, so a fixed +08:00 offset is exact.
export function shanghaiDay(time) { return new Date(time + 8 * 3600000).toISOString().slice(0, 10); }
export function nextShanghaiMidnight(time) { const day = new Date(Date.parse(shanghaiDay(time) + 'T00:00:00+08:00') + 86400000); return shanghaiDay(day.getTime()) + 'T00:00:00+08:00'; }

export function validateCompletion(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject('请求内容应为对象');
  for (const key of Object.keys(body)) if (!FIELDS.has(key)) reject(`不支持的字段：${key}`);
  if (body.model !== 'quizforge-official') reject('model 必须为 quizforge-official');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 50) reject('messages 必须是 1–50 条消息');
  let images = 0;
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !['system', 'user', 'assistant'].includes(message.role) || Object.keys(message).some(key => !['role', 'content'].includes(key))) reject('消息格式不正确');
    if (typeof message.content === 'string') continue;
    if (!Array.isArray(message.content) || !message.content.length) reject('消息内容格式不正确');
    for (const part of message.content) {
      if (part?.type === 'text' && typeof part.text === 'string' && Object.keys(part).length === 2) continue;
      const url = part?.type === 'image_url' && Object.keys(part).length === 2 && part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url : null;
      const data = url && IMAGE.exec(url)?.[1];
      if (!data || Object.keys(part.image_url).some(key => !['url', 'detail'].includes(key))) reject('图片只接受 PNG、JPEG、WebP 的 data URL');
      const bytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      if (bytes > 4 * MiB) fail(413, 'AI_REQUEST_TOO_LARGE', '单张图片不能超过 4 MiB');
      images += bytes;
    }
  }
  if (images > 12 * MiB) fail(413, 'AI_REQUEST_TOO_LARGE', '一次请求的图片总大小不能超过 12 MiB');
  if (Object.hasOwn(body, 'max_tokens') && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 8192)) reject('max_tokens 必须是 1–8192 的整数');
  if (Object.hasOwn(body, 'temperature') && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2)) reject('temperature 必须在 0–2 之间');
  if (Object.hasOwn(body, 'response_format') && !['json_object', 'json_schema', 'text'].includes(body.response_format?.type)) reject('response_format 不受支持');
  return { messages: body.messages, max_tokens: body.max_tokens ?? 8192, ...(Object.hasOwn(body, 'temperature') ? { temperature: body.temperature } : {}), ...(body.response_format ? { response_format: body.response_format } : {}) };
}

export function createOfficialAi({ db, settings: source, connect, json, readBody, now = () => Date.now(), fetchImpl = globalThis.fetch, timeoutMs = 90000, siteConcurrency = 8 }) {
  db.exec(`CREATE TABLE IF NOT EXISTS official_ai_usage (user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));
    CREATE TABLE IF NOT EXISTS official_ai_budget (period TEXT PRIMARY KEY, tokens INTEGER NOT NULL);`);
  // Settings may change from the admin backend; read them on every request.
  const read = typeof source === 'function' ? source : () => source;
  const active = new Map();
  const month = time => shanghaiDay(time).slice(0, 7);
  const usedTokens = time => db.prepare('SELECT tokens FROM official_ai_budget WHERE period=?').get(month(time))?.tokens || 0;
  const usage = userId => {
    const settings = read();
    const time = now(), day = shanghaiDay(time), used = db.prepare('SELECT calls FROM official_ai_usage WHERE user_id=? AND day=?').get(userId, day)?.calls || 0;
    return { enabled: settings.enabled && !!settings.key && usedTokens(time) < settings.monthlyTokens, model: '通义千问 ' + settings.model, vision: true, dailyLimit: settings.dailyLimit, usedToday: used, resetAt: nextShanghaiMidnight(time) };
  };
  connect.setUsage(usage);
  const refund = (userId, day) => db.prepare('UPDATE official_ai_usage SET calls=MAX(calls-1,0) WHERE user_id=? AND day=?').run(userId, day);

  async function handle(req, res, url) {
    if (url.pathname !== '/api/ai/v1/chat/completions') return false;
    const settings = read();
    if (req.method !== 'POST') fail(405, 'AI_REQUEST_UNSUPPORTED', '只支持 POST');
    if (!settings.enabled) fail(404, 'OFFICIAL_AI_DISABLED', '官方 AI 暂未开放');
    const device = connect.device(req);
    // Requests are buffered in memory (up to 12 MiB), so the whole site is capped too.
    if ([...active.values()].reduce((sum, value) => sum + value, 0) >= siteConcurrency) fail(429, 'AI_BUSY', '官方 AI 评分人数较多，请稍后再试');
    if (!settings.key) fail(503, 'AI_DISABLED', '官方 AI 暂时不可用，请稍后再试，或在 AI 设置中改用自己的模型');
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'AI_REQUEST_UNSUPPORTED', '请使用 JSON 请求');
    let raw;
    try { raw = await readBody(req, 13 * MiB); } catch (error) { if (error.status === 413) fail(413, 'AI_REQUEST_TOO_LARGE', '请求超过 12 MiB 上限'); throw error; }
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch { reject('请求内容不是有效的 JSON'); }
    const request = validateCompletion(body);
    const userId = device.user_id;
    if ((active.get(userId) || 0) >= 2) fail(429, 'AI_BUSY', '同时进行的评分太多，请等前面的评分完成后再试');
    const time = now(), day = shanghaiDay(time), resetAt = nextShanghaiMidnight(time);
    if (usedTokens(time) >= settings.monthlyTokens) fail(503, 'AI_BUDGET_EXHAUSTED', '本月官方 AI 额度已用完，下月恢复，也可以在 AI 设置中改用自己的模型');
    db.exec('BEGIN IMMEDIATE');
    try {
      const calls = db.prepare('SELECT calls FROM official_ai_usage WHERE user_id=? AND day=?').get(userId, day)?.calls || 0;
      if (calls >= settings.dailyLimit) fail(429, 'AI_DAILY_LIMIT', '今天的官方 AI 评分次数已用完，明天 0 点恢复，也可以在 AI 设置中改用自己的模型。', { resetAt });
      db.prepare('INSERT INTO official_ai_usage (user_id,day,calls) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET calls=calls+1').run(userId, day);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    active.set(userId, (active.get(userId) || 0) + 1);
    let upstream;
    try {
      const response = await fetchImpl(settings.baseUrl + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + settings.key },
        body: JSON.stringify({ model: settings.model, ...request }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error('upstream status ' + response.status);
      upstream = JSON.parse(text);
      if (!Array.isArray(upstream?.choices)) throw new Error('upstream body');
    } catch {
      // Network failures, timeouts and upstream errors do not use the user's quota.
      refund(userId, day);
      fail(502, 'AI_UPSTREAM_FAILED', '官方模型暂时没有响应，本次不计次数，请稍后重试');
    } finally {
      const left = (active.get(userId) || 1) - 1; if (left) active.set(userId, left); else active.delete(userId);
    }
    const tokens = Number.isSafeInteger(upstream.usage?.total_tokens) && upstream.usage.total_tokens > 0 ? upstream.usage.total_tokens : 0;
    if (tokens) {
      db.prepare('UPDATE official_ai_usage SET tokens=tokens+? WHERE user_id=? AND day=?').run(tokens, userId, day);
      db.prepare('INSERT INTO official_ai_budget VALUES (?,?) ON CONFLICT(period) DO UPDATE SET tokens=tokens+excluded.tokens').run(month(time), tokens);
    }
    json(res, 200, { id: 'qf-' + randomUUID(), object: 'chat.completion', model: 'quizforge-official', choices: upstream.choices, ...(upstream.usage ? { usage: upstream.usage } : {}) });
    return true;
  }
  return { handle, usage };
}
