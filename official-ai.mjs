import { randomUUID } from 'node:crypto';
import { ConnectError } from './connect.mjs';
import { costFor, upstreamFailure } from './official-ai-config.mjs';

// Official AI gateway (docs/HUB_CONNECT_AI.md section 6). Upstream keys stay here.
// Each grading tries the usable keys from the top of the admin list and spends the
// account's balance at the prices of the key that answered. Only counts, token
// totals and amounts are stored; request and response content is never written to
// the database or logs.
const MiB = 1024 * 1024;
const FIELDS = new Set(['model', 'messages', 'max_tokens', 'response_format', 'temperature']);
const IMAGE = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const fail = (status, code, message, extra) => { throw new ConnectError(status, code, message, extra); };
const reject = message => fail(400, 'AI_REQUEST_UNSUPPORTED', message);

// Defaults for the admin form when adding a key; prices are yuan per million tokens, stored as 0.0001 yuan.
export function officialAiSettings(env = process.env) {
  return {
    baseUrl: (env.OFFICIAL_AI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    model: env.OFFICIAL_AI_MODEL || 'qwen-vl-plus',
    inputPrice: Math.round(Number(env.OFFICIAL_AI_INPUT_PRICE || 3) * 10000),
    outputPrice: Math.round(Number(env.OFFICIAL_AI_OUTPUT_PRICE || 9) * 10000),
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

const UPSTREAM_TRIES = 3;

export function createOfficialAi({ db, config, connect, points, json, readBody, now = () => Date.now(), fetchImpl = globalThis.fetch, timeoutMs = 90000, siteConcurrency = 8 }) {
  db.exec('CREATE TABLE IF NOT EXISTS official_ai_usage (user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));');
  // points holds the amount spent (0.0001 yuan); the name is from an earlier version.
  if (!db.prepare('PRAGMA table_info(official_ai_usage)').all().some(column => column.name === 'points')) db.exec('ALTER TABLE official_ai_usage ADD COLUMN points INTEGER NOT NULL DEFAULT 0');
  const active = new Map();
  const usage = userId => ({ enabled: config.enabled() && config.available(), model: '通义千问 ' + config.label(), vision: true, balance: points.balance(userId) });
  connect.setUsage(usage);
  // Calls one upstream key and returns its body, or how it failed.
  async function call(upstream, request) {
    try {
      const response = await fetchImpl(upstream.baseUrl + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + upstream.key },
        body: JSON.stringify({ model: upstream.model, ...request }),
      });
      const text = await response.text();
      if (!response.ok) return { failure: upstreamFailure(response.status, text) };
      const body = JSON.parse(text);
      return Array.isArray(body?.choices) ? { body } : { failure: { status: 'fault', reason: '返回的不是 OpenAI 兼容格式' } };
    } catch { return { failure: { status: 'fault', reason: '无法连接或等待超时' } }; }
  }

  async function handle(req, res, url) {
    if (url.pathname !== '/api/ai/v1/chat/completions') return false;
    if (req.method !== 'POST') fail(405, 'AI_REQUEST_UNSUPPORTED', '只支持 POST');
    if (!config.enabled()) fail(404, 'OFFICIAL_AI_DISABLED', '免费 AI 暂未开放');
    const device = connect.device(req);
    // Requests are buffered in memory (up to 12 MiB), so the whole site is capped too.
    if ([...active.values()].reduce((sum, value) => sum + value, 0) >= siteConcurrency) fail(429, 'AI_BUSY', '免费 AI 评分人数较多，请稍后再试');
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'AI_REQUEST_UNSUPPORTED', '请使用 JSON 请求');
    let raw;
    try { raw = await readBody(req, 13 * MiB); } catch (error) { if (error.status === 413) fail(413, 'AI_REQUEST_TOO_LARGE', '请求超过 12 MiB 上限'); throw error; }
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch { reject('请求内容不是有效的 JSON'); }
    const request = validateCompletion(body);
    const userId = device.user_id;
    if ((active.get(userId) || 0) >= 2) fail(429, 'AI_BUSY', '同时进行的评分太多，请等前面的评分完成后再试');
    // The balance is only spent after a model answers, so failures cost nothing.
    if (points.balance(userId) < 1) fail(402, 'AI_BALANCE_EXHAUSTED', '免费 AI 额度已用完，可以在设置 → 用户中心输入兑换码获取额度，也可以改用自己的模型。', { balance: 0 });
    const upstreams = config.candidates();
    if (!upstreams.length) fail(503, 'AI_DISABLED', '免费 AI 暂时不可用，请稍后再试，或在 AI 设置中改用自己的模型');
    active.set(userId, (active.get(userId) || 0) + 1);
    let answer = null, used = null;
    try {
      // A key that fails is marked and skipped for a while, and the next key is tried.
      for (const upstream of upstreams.slice(0, UPSTREAM_TRIES)) {
        const result = await call(upstream, request);
        if (result.body) { answer = result.body; used = upstream; break; }
        config.failed(upstream.id, result.failure);
      }
    } finally {
      const left = (active.get(userId) || 1) - 1; if (left) active.set(userId, left); else active.delete(userId);
    }
    if (!answer) fail(502, 'AI_UPSTREAM_FAILED', '免费 AI 模型暂时没有响应，本次不扣额度，请稍后重试');
    const cost = costFor(answer.usage, used.prices), spent = points.charge(userId, cost);
    const tokens = Number.isSafeInteger(answer.usage?.total_tokens) && answer.usage.total_tokens > 0 ? answer.usage.total_tokens : 0;
    // The key's remaining amount goes down by the full cost even if the user's balance ran short.
    config.record(used.id, answer.usage, cost);
    db.prepare('INSERT INTO official_ai_usage (user_id,day,calls,tokens,points) VALUES (?,?,1,?,?) ON CONFLICT(user_id,day) DO UPDATE SET calls=calls+1,tokens=tokens+excluded.tokens,points=points+excluded.points').run(userId, shanghaiDay(now()), tokens, spent);
    json(res, 200, { id: 'qf-' + randomUUID(), object: 'chat.completion', model: 'quizforge-official', choices: answer.choices, ...(answer.usage ? { usage: answer.usage } : {}), quizforge: { cost: spent, balance: points.balance(userId) } });
    return true;
  }
  return { handle, usage };
}
