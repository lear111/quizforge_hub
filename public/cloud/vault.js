const encoder = new TextEncoder(), decoder = new TextDecoder();
const iterations = 600000;
const sessions = new Map();
const encode = value => btoa(String.fromCharCode(...value));
function decode(value, max = 12000) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('本地凭据格式无效');
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
export function connection(value) {
  let url;
  try { url = new URL(value.baseUrl); } catch { throw new Error('请填写完整的 HTTPS 模型地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('云端页面仅支持无用户名、密码和查询参数的 HTTPS 模型地址');
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200) throw new Error('请填写模型名称');
  if (typeof value.apiKey !== 'string' || !value.apiKey || value.apiKey.length > 4096 || /[^\x21-\x7e]/.test(value.apiKey)) throw new Error('请填写有效的 API Key');
  if (value.outputMode !== undefined && !['json','schema','text'].includes(value.outputMode)) throw new Error('请选择有效的模型响应格式');
  const report = value.testReport;
  const testReport = report && typeof report.testedAt === 'string' && Array.isArray(report.checks) && report.checks.length <= 3 ? { testedAt: report.testedAt.slice(0,40), checks: report.checks.filter(check => ['文字连接','评分输出','图片识别'].includes(check.label)).map(check => ({label:check.label,ok:check.ok===true})) } : null;
  return { baseUrl: url.href.replace(/\/$/, ''), model: value.model.trim(), apiKey: value.apiKey,
    enabled: value.enabled !== false, autoGrade: value.autoGrade === true, vision: value.vision === true, outputMode: value.outputMode || 'json', testReport };
}
function context(value) {
  if (!value || typeof value.account !== 'string' || typeof value.origin !== 'string' || typeof value.endpoint !== 'string') throw new Error('本地凭据上下文无效');
  return encoder.encode(JSON.stringify(['qfh-ai-v1', value.origin, value.account, value.endpoint]));
}
async function derive(password, salt) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('本地解锁口令至少 8 个字符');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations, salt }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptKey(apiKey, password, bound) {
  if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096) throw new Error('API Key 无效');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(bound), tagLength: 128 }, key, encoder.encode(apiKey));
  return { version: 1, iterations, salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function decryptKey(stored, password, bound) {
  try {
    if (stored?.version !== 1 || stored.iterations !== iterations) throw new Error();
    const salt = decode(stored.salt, 32), iv = decode(stored.iv, 24), ciphertext = decode(stored.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17 || ciphertext.length > 4112) throw new Error();
    const key = await derive(password, salt);
    return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: context(bound), tagLength: 128 }, key, ciphertext));
  } catch { throw new Error('解锁失败：请检查口令，或清除本地配置后重新填写'); }
}
export const session = account => sessions.get(account) ?? null;
export function setSession(account, value) { sessions.set(account, connection(value)); }
export function clearSessions() { sessions.clear(); }

export async function gradeDirect(value, input, request = fetch) {
  const profile = connection(value);
  if (!profile.enabled) throw new Error('AI 评分尚未启用');
  if (!input || !Array.isArray(input.messages) || input.messages.length !== 2 || JSON.stringify(input).length > 12 * 1024 ** 2) throw new Error('评分输入无效或超出限制');
  if (!profile.vision && input.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url'))) throw Object.assign(new Error('本题含图片，请先测试并启用模型图片识别'), { code: 'AI_VISION_UNSUPPORTED' });
  let response;
  try {
    response = await request(profile.baseUrl + '/chat/completions', {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + profile.apiKey },
      body: JSON.stringify({ model: profile.model, stream: false, max_tokens: 8192, messages: input.messages, ...(profile.outputMode === 'text' ? {} : { response_format: profile.outputMode === 'schema' ? {type:'json_schema',json_schema:{name:'quizforge_grading',strict:true,schema:{type:'object',additionalProperties:false,properties:{score:{type:'number'},feedback:{type:'string'}},required:['score','feedback']}}} : { type: 'json_object' } }) }),
    });
  } catch { throw Object.assign(new Error('浏览器直连失败，请检查网络和模型的跨域设置'), { code: 'AI_BROWSER_FAILED' }); }
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('模型请求失败'), { code: [401,403].includes(response.status) ? 'AI_AUTH' : response.status === 402 ? 'AI_QUOTA' : response.status === 429 ? 'AI_RATE_LIMIT' : 'AI_BROWSER_FAILED' }); }
  let raw;
  try {
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { while (true) { const { value: chunk, done } = await reader.read(); if (done) break; size += chunk.length; if (size > 2 * 1024 ** 2) { await reader.cancel(); throw new Error(); } chunks.push(chunk); } }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    raw = JSON.parse(decoder.decode(bytes));
  } catch { throw Object.assign(new Error('模型响应不完整或过大，请手动重试'), { code: 'AI_OUTPUT_INVALID' }); }
  const choice = raw?.choices?.[0], content = choice?.message?.content;
  let output = typeof content === 'string' ? content : Array.isArray(content) && content.every(block => block.type === 'text' && typeof block.text === 'string') ? content.map(block => block.text).join('') : '';
  if (choice?.message?.refusal || choice?.finish_reason && choice.finish_reason !== 'stop' || !output.trim() || output.length > 24000) throw Object.assign(new Error('模型没有返回有效评分'), { code: 'AI_OUTPUT_INVALID' });
  const redact = text => text.replaceAll(profile.apiKey, '[redacted]');
  output = redact(output);
  const usage = Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(key => Number.isSafeInteger(raw.usage?.[key]) && raw.usage[key] >= 0).map(key => [key, raw.usage[key]]));
  return { output, provider: 'openai-compatible', model: redact(profile.model), responseId: typeof raw.id === 'string' && /^[A-Za-z0-9._:-]{0,160}$/.test(raw.id) ? redact(raw.id) : '', usage };
}

export async function testGradingModel(value, challenge, request = fetch) {
  const profile = connection({ ...value, enabled: true }), report = { testedAt: new Date().toISOString(), checks: [] };
  await testConnection(profile, request); report.checks.push({ label: '文字连接', ok: true });
  const parse = response => { try { const result = JSON.parse(response.output.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); return result && typeof result.score === 'number' && typeof result.feedback === 'string' ? result : null; } catch { return null; } };
  const probe = async content => parse(await gradeDirect({ ...profile, vision: true }, { messages: [{ role: 'system', content: '只返回包含 score 数字和 feedback 字符串的 JSON 对象，不添加其他内容。' }, { role: 'user', content }] }, request));
  const text = await probe('这是评分格式测试。请返回 score 为 2，feedback 为“评分格式通过”。');
  if (text?.score !== 2 || text.feedback !== '评分格式通过') throw new Error('文字连接成功，但评分输出格式未通过；请更换模型或检查兼容性');
  report.checks.push({ label: '评分输出', ok: true });
  let vision = false;
  try {
    const image = await probe([{type:'text',text:'请读取图片中唯一一行大写字母与数字，保持顺序和大小写。返回 JSON：score 为 0，feedback 只填图片里的字符。'}, {type:'image_url',image_url:{url:challenge.dataUrl,detail:'auto'}}]);
    vision = image?.score === 0 && image.feedback.trim() === challenge.expected;
  } catch { /* A failed network/image test does not establish model incapability. */ }
  report.checks.push({label:'图片识别',ok:vision}); return { vision, report };
}

export async function testConnection(value, request = fetch) {
  const profile = connection(value);
  let response;
  try {
    response = await request(profile.baseUrl + '/chat/completions', {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + profile.apiKey },
      body: JSON.stringify({ model: profile.model, stream: false, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
    });
  } catch { throw new Error('浏览器直连失败：请检查网络，以及模型服务是否允许跨域请求（CORS）'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? '模型认证失败，请检查 Key 和服务地址' : response.status === 429 || response.status === 402 ? '模型调用受限，请检查余额或调用额度' : '模型服务未接受请求，请检查地址和模型名称'); }
  // Provider output can echo input or secrets; it is never displayed or saved.
  await response.body?.cancel();
  return { ok: true };
}
