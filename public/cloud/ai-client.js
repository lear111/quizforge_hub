let frame, flags = 'off', account = '', sequence = 0;
const calls = new Map(), scheduled = new Set();
let queue = Promise.resolve();
export const cloudAiHeaders = () => ({ 'X-QuizForge-Cloud-Ai': flags });
export function bindCloudAi(element) {
  frame = element;
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const value = event.data;
    if (value?.type === 'qfh-ai-status') {
      account = value.account; flags = value.enabled ? value.autoGrade ? 'auto' : 'manual' : 'off';
      document.dispatchEvent(new CustomEvent('qfh-ai-status', { detail: { enabled: flags !== 'off' } }));
    }
    if (value?.type === 'qfh-ai-response') {
      const call = calls.get(value.id); if (!call) return; calls.delete(value.id); clearTimeout(call.timer);
      if (value.ok) call.resolve(value.result); else call.reject(Object.assign(new Error('浏览器评分未完成'), { code: value.code }));
    }
  });
  // The vault and Key stay inside this settings frame, including during grading.
  frame.src = frame.dataset.src;
  window.addEventListener('beforeunload', event => { if (calls.size) { event.preventDefault(); event.returnValue = ''; } });
}
function generate(input) {
  if (flags === 'off' || !frame?.contentWindow || !account) {
    document.dispatchEvent(new Event('qfh-ai-settings-required'));
    throw Object.assign(new Error('请先保存或解锁 AI 配置'), { code: 'AI_INTERRUPTED' });
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { calls.delete(id); reject(Object.assign(new Error('浏览器评分超时'), { code: 'AI_INTERRUPTED' })); }, 130000);
    calls.set(id, { resolve, reject, timer });
    frame.contentWindow.postMessage({ type: 'qfh-ai-generate', id, account, input }, location.origin);
  });
}
export function observeCloudAi(result, prefix, headers) {
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
        const response = await generate(claim.input);
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
