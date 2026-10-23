import { CloudError } from './accounts.mjs';

// Cloud practice's free AI (docs/HUB_CONNECT_AI.md 7.3). The visitor is already signed in
// to Hub, so the practice service relays the account, redeem and grading calls to the
// Hub with that session; the Hub charges the session user. `hubAi.call` comes from
// scripts/cloud-practice-site.mjs and returns { status, body } (status 0: no answer).
const MiB = 1024 ** 2;
const coded = (status, code, message) => Object.assign(new CloudError(status, message), { code });

// Same codes as the Web host's classifyOfficial, so the browser falls back to the
// custom model on exactly the cases the Web does.
export function officialFailure({ status, timeout, body }) {
  const code = body?.error?.code ?? '';
  if (status === 0) return timeout ? coded(504, 'AI_TIMEOUT', '免费 AI 等待超时，本次不扣额度') : coded(502, 'AI_NETWORK', '暂时无法连接 QuizForge 服务器');
  if (status === 401 || code === 'HUB_LOGIN_REQUIRED') return coded(401, 'AI_OFFICIAL_LOGIN', '登录已失效，请重新登录 Hub');
  if (status === 402 || code === 'AI_BALANCE_EXHAUSTED') return coded(402, 'AI_OFFICIAL_BALANCE', '免费 AI 额度已用完，可以在设置 → 用户中心输入兑换码');
  if (code === 'AI_BUDGET_EXHAUSTED') return coded(503, 'AI_OFFICIAL_BUDGET', '免费 AI 今日额度已用完，请稍后再试');
  if (code === 'AI_BUSY' || status === 429) return coded(429, 'AI_RATE_LIMIT', '免费 AI 当前请求较多，请稍后再试');
  if (code === 'AI_UPSTREAM_FAILED' || status === 502) return coded(502, 'AI_UPSTREAM', '免费 AI 模型暂时没有响应，本次不扣额度');
  if (status === 413 || code === 'AI_REQUEST_TOO_LARGE') return coded(413, 'AI_INPUT_LIMIT', '评分内容或图片超出免费 AI 的上限');
  if ([404, 503].includes(status)) return coded(503, 'AI_OFFICIAL_UNAVAILABLE', '免费 AI 暂时不可用');
  return coded(502, 'AI_CONFIG', '免费 AI 未接受这次评分请求');
}

export async function hubAccount(hubAi, req) {
  const result = await hubAi.call(req, 'me');
  if (result.status === 401) return { connected: false, expired: true };
  if (result.status !== 200 || !result.body?.ai) return { connected: true, unavailable: true, manageUrl: hubAi.manageUrl };
  return { connected: true, user: { name: result.body.user.name, email: result.body.user.email, ...(result.body.user.phone ? { phone: result.body.user.phone } : {}) }, ai: result.body.ai, manageUrl: hubAi.manageUrl };
}

export async function hubRedeem(hubAi, req, code) {
  if (typeof code !== 'string' || !code.trim() || code.length > 64) throw coded(400, 'REDEEM_CODE_INVALID', '请输入兑换码');
  const result = await hubAi.call(req, 'redeem', { code });
  if (result.status === 200 && Number.isSafeInteger(result.body?.balance)) return { added: result.body.added, balance: result.body.balance };
  if (result.status === 0) throw coded(502, 'HUB_UNAVAILABLE', '暂时无法连接 QuizForge 服务器，请稍后重试');
  if (result.status === 401) throw coded(401, 'HUB_LOGIN_REQUIRED', '登录已失效，请重新登录 Hub');
  throw coded(result.status >= 400 && result.status < 600 ? result.status : 502, result.body?.error?.code || 'REDEEM_FAILED', result.body?.error?.message || '兑换没有完成，请重试');
}

// Grades one claimed input. The browser then saves the result through the same
// /api/cloud-ai/result path a custom model uses.
export async function hubComplete(hubAi, req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { if ((bytes += chunk.length) > 13 * MiB) throw coded(413, 'AI_INPUT_LIMIT', '评分内容超过 12 MiB 上限'); chunks.push(chunk); }
  let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw coded(400, 'INVALID_AI_REQUEST', '评分请求格式无效'); }
  if (!input || !Array.isArray(input.messages) || Object.keys(input).some(key => !['messages', 'max_tokens', 'response_format'].includes(key))) throw coded(400, 'INVALID_AI_REQUEST', '评分请求格式无效');
  const result = await hubAi.call(req, 'chat/completions', { model: 'quizforge-official', stream: false, ...input }, 125000);
  if (result.status !== 200) throw officialFailure(result);
  const raw = result.body, choice = raw?.choices?.[0], content = choice?.message?.content;
  const output = typeof content === 'string' ? content : Array.isArray(content) && content.every(block => block?.type === 'text' && typeof block.text === 'string') ? content.map(block => block.text).join('') : '';
  if (choice?.message?.refusal || choice?.finish_reason && choice.finish_reason !== 'stop' || !output.trim() || output.length > 24000) throw coded(502, 'AI_OUTPUT_INVALID', '模型没有返回有效评分');
  const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].filter(key => Number.isSafeInteger(raw.usage?.[key]) && raw.usage[key] >= 0).map(key => [key, raw.usage[key]]));
  return { result: { output, provider: 'quizforge-official', model: 'quizforge-official', responseId: typeof raw.id === 'string' && /^[A-Za-z0-9._:-]{0,160}$/.test(raw.id) ? raw.id : '', usage }, balance: raw.quizforge?.balance ?? null };
}
