let frame, flags = 'off', account = '', sources = { official: false, custom: false }, prefs = {}, customReady = false, sequence = 0;
// Free-quota errors that move on to the custom model, as on the Web host (ai-provider.js FALLBACK).
const FALLBACK = new Set(['AI_OFFICIAL_LOGIN', 'AI_OFFICIAL_BALANCE', 'AI_OFFICIAL_BUDGET', 'AI_OFFICIAL_UNAVAILABLE', 'AI_UPSTREAM', 'AI_TIMEOUT', 'AI_NETWORK', 'AI_RATE_LIMIT']);
const calls = new Map(), scheduled = new Set();
const initialTasks = new Map();
let queue = Promise.resolve();
let preferencesReady;
const initialized = new Promise(resolve => { preferencesReady = resolve; });
export const cloudAiPreferencesReady = () => initialized;
export const cloudAiHeaders = () => ({ 'X-QuizForge-Cloud-Ai': flags });
// The switch and sources come from Web's AI 评分 panel (experience.js); whether the custom model is
// saved or unlocked comes from the custom-model frame, which keeps the Key.
function recompute() {
  const custom = !!prefs.useCustom && customReady, enabled = !!prefs.enabled && (!!prefs.useOfficial || custom);
  flags = enabled ? prefs.autoGrade ? 'auto' : 'manual' : 'off'; sources = { official: !!prefs.useOfficial, custom };
  document.dispatchEvent(new CustomEvent('qfh-ai-status', { detail: { enabled, customReady } }));
}
export function setCloudAiPrefs(value) { prefs = { ...value }; recompute(); preferencesReady(); }
export function bindCloudAi(element) {
  frame = element;
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const value = event.data;
    if (value?.type === 'qfh-ai-status') {
      account = value.account; customReady = value.custom === true; recompute();
    }
    if (value?.type === 'qfh-ai-height' && Number.isFinite(value.height)) frame.style.height = Math.min(Math.max(value.height, 40), 2000) + 'px';
    if (value?.type === 'qfh-ai-response') {
      const call = calls.get(value.id); if (!call) return; calls.delete(value.id); clearTimeout(call.timer);
      if (value.ok) call.resolve(value.result); else call.reject(Object.assign(new Error('浏览器评分未完成'), { code: value.code }));
    }
  });
  // The vault and Key stay inside this settings frame, including during grading.
  frame.src = frame.dataset.src;
  window.addEventListener('beforeunload', event => { if (calls.size) { event.preventDefault(); event.returnValue = ''; } });
}
// The free quota is graded by the Hub for the signed-in account; the result is saved like any other.
async function official(input) {
  let response;
  try { response = await fetch('/api/cloud/ai/complete', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(130000) }); }
  catch (error) { throw Object.assign(new Error('免费 AI 评分未完成'), { code: error?.name === 'TimeoutError' ? 'AI_TIMEOUT' : 'AI_NETWORK' }); }
  let value = null; try { value = await response.json(); } catch { }
  if (!response.ok) throw Object.assign(new Error('免费 AI 评分未完成'), { code: value?.error?.code || (response.status === 429 ? 'AI_RATE_LIMIT' : response.status === 401 ? 'AI_OFFICIAL_LOGIN' : 'AI_UPSTREAM') });
  document.dispatchEvent(new CustomEvent('qfh-ai-balance', { detail: { balance: value.balance } }));
  return value.result;
}
async function grade(input) {
  if (flags !== 'off' && sources.official) {
    try { return await official(input); }
    catch (error) { if (!sources.custom || !FALLBACK.has(error.code)) throw error; }
  }
  return generate(input);
}
function generate(input) {
  if (flags === 'off' || !sources.custom || !frame?.contentWindow || !account) {
    document.dispatchEvent(new Event('qfh-ai-settings-required'));
    throw Object.assign(new Error('请先保存或解锁 AI 配置'), { code: 'AI_INTERRUPTED' });
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { calls.delete(id); reject(Object.assign(new Error('浏览器评分超时'), { code: 'AI_INTERRUPTED' })); }, 130000);
    calls.set(id, { resolve, reject, timer });
    frame.contentWindow.postMessage({ type: 'qfh-ai-generate', id, account, input }, location.origin);
  });
}
export function takeCloudAiTask(route, targetId = null) {
  if (targetId !== null && (typeof targetId !== 'string' || targetId.length > 128)) return null;
  const key = JSON.stringify([route, targetId]), entry = initialTasks.get(key);
  initialTasks.delete(key);
  return entry && entry.expires > Date.now() ? structuredClone(entry.task) : null;
}
export function observeCloudAi(result, prefix, headers, requestPath = '') {
  if (requestPath.endsWith('/actions')) for (const [key, entry] of initialTasks) if (entry.route === prefix + requestPath.slice(0, -8)) initialTasks.delete(key);
  // A submission already knows which tasks were scheduled. The first read from
  // its frame can show queued immediately, without a second checkpoint request.
  for (const row of result?.cloudAiStates ?? []) {
    const task = row?.task;
    if (!/^\/api\/collections\/(?:bank|extension|exam)\/[^/?]+\/questions\/[^/?]+$/.test(row?.route || '') || !/^[a-f0-9]{64}$/.test(task?.taskId || '') || !['queued', 'running', 'failed'].includes(task.status) || task.targetId != null && (typeof task.targetId !== 'string' || task.targetId.length > 128)) continue;
    const route = prefix + row.route, key = JSON.stringify([route, task.targetId ?? null]);
    initialTasks.set(key, { route, task: structuredClone(task), expires: Date.now() + 30000 });
  }
  if (result?.taskId) for (const [key, entry] of initialTasks) if (entry.task.taskId === result.taskId) initialTasks.delete(key);
  while (initialTasks.size > 256) initialTasks.delete(initialTasks.keys().next().value);
  for (const task of result?.cloudAiPending ?? []) {
    if (!task || !/^[a-f0-9]{64}$/.test(task.taskId)) continue;
    const key = prefix + ':' + task.taskId;
    if (scheduled.has(key)) continue; scheduled.add(key);
    queue = queue.then(async () => {
      const post = async (action, body) => {
        const response = await fetch(prefix + '/api/cloud-ai/' + action, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-QuizForge-Practice-Session': headers['X-QuizForge-Practice-Session'], ...cloudAiHeaders() }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error?.message || value.message || '评分未能保存'), { code: value.error?.code || value.code });
        observeCloudAi(value, prefix, headers); return value;
      };
      let claim;
      try {
        claim = await post('claim', { taskId: task.taskId });
        const response = await grade(claim.input);
        const body = { taskId: task.taskId, lease: claim.lease, result: response };
        try { await post('result', body); } catch (error) { if (error.code) throw error; await post('result', body); }
      } catch (error) {
        if (claim) try { await post('fail', { taskId: task.taskId, lease: claim.lease, code: error.code || 'AI_BROWSER_FAILED' }); } catch { /* Preserve task for explicit retry. */ }
        document.dispatchEvent(new CustomEvent('qfh-ai-failure', { detail: { code: error.code || 'AI_BROWSER_FAILED' } }));
      } finally { document.dispatchEvent(new Event('qfh-ai-updated')); }
    }).catch(() => {});
    while (scheduled.size > 512) scheduled.delete(scheduled.values().next().value);
  }
}
