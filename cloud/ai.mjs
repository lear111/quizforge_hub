import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Adapt the pinned host's task/revision/confirmation protocol. Nothing here
// calls a model: the provider only renders a request for the owning browser.
export async function attachCloudAi(service, runtime) {
  const load = file => import(pathToFileURL(path.join(runtime.core, file)).href);
  const [{ OpenAiCompatibleProvider }, { ApiError }, { fingerprint }] = await Promise.all([
    load('server/host/ai/ai-provider.js'), load('server/host/platform/errors.js'), load('server/host/platform/json.js'),
  ]);
  const tasks = new Map(), installed = new WeakSet();
  let page = '', preferences = { enabled: false, autoGrade: false };
  const reject = (code, message, status = 409) => { throw new ApiError(status, code, message); };
  const snapshot = task => ({ ...task.value.snapshot, targetId: task.value.snapshot.targetId ?? null, targetGeneration: task.value.snapshot.targetGeneration ?? 0 });
  const profile = { enabled: true, autoGrade: false, vision: true, baseUrl: 'https://browser.invalid/v1', model: 'browser', apiKey: '', outputMode: 'json', maxOutputTokens: 8192, timeoutSeconds: 90 };
  function gateway(resources) {
    // The pinned Web provider binds an ordered list of sources; the cloud renders one request for the browser.
    const value = new OpenAiCompatibleProvider(null, resources, [profile]);
    value.call = async (_profile, content, system) => ({ messages: [{ role: 'system', content: system }, { role: 'user', content }], max_tokens: 8192, response_format: { type: 'json_object' } });
    return value;
  }
  function restore(ai, task) {
    const delivery = task.value.snapshot?.cloudDelivery;
    if (!delivery || !['queued', 'running'].includes(task.value.status)) return;
    if (delivery.deadline <= Date.now()) { ai.live.delete(task.value.taskId); ai.mark(task, 'failed', 'AI_INTERRUPTED', '浏览器评分已中断或超时，请手动重试。'); return; }
    if (delivery.page !== page) return;
    ai.live.set(task.value.taskId, task); tasks.set(task.value.taskId, { ai, task });
  }
  function install(ai, resources) {
    if (installed.has(ai)) return ai; installed.add(ai);
    ai.gateway = gateway(resources);
    ai.enqueue = batch => {
      for (const task of batch) {
        if ([...tasks.values()].filter(value => !value.ai.closed && ['queued','running'].includes(value.task.value.status)).length >= 32) { ai.mark(task, 'failed', 'AI_QUEUE_FULL', '当前页面评分任务较多，请处理完成后手动重试。'); continue; }
        task.value.snapshot.cloudDelivery = { page, deadline: Date.now() + 300000 };
        ai.mark(task, 'queued'); restore(ai, task);
      }
    };
    const get = ai.get.bind(ai);
    ai.get = async (collection, question, id) => { restore(ai, ai.scoped(collection, question, id)); return get(collection, question, id); };
    const temporary = ai.temporary.bind(ai);
    ai.temporary = (root, states, provider = ai.gateway) => install(temporary(root, states, provider), provider.resources ?? resources);
    return ai;
  }
  install(service.ai, service.resources);
  service.exams.resourceGateway = gateway;
  const createPracticeSession = service.createPracticeSession.bind(service);
  service.createPracticeSession = () => { const session = createPracticeSession(); install(session.ai, session.resources); return session; };

  async function locate(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) reject('AI_TASK_NOT_FOUND', '评分任务不存在。', 404);
    let value = tasks.get(id);
    if (!value) {
      const raw = service.ai.read(id), collection = await service.library.collection(raw.kind, raw.collectionId);
      value = { ai: service.ai, task: service.ai.scoped(collection, collection.question(raw.questionId), id) };
    }
    const { ai, task } = value, delivery = task.value.snapshot?.cloudDelivery;
    if (!delivery || delivery.page !== page) reject('AI_TASK_NOT_FOUND', '评分任务不属于当前刷题页面。', 404);
    const collection = await service.library.collection(task.value.kind, task.value.collectionId), question = collection.question(task.value.questionId);
    return { ai, task, delivery, collection, question };
  }
  function fields(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) reject('INVALID_AI_REQUEST', '评分请求格式无效。', 400);
  }
  const api = service.api.bind(service);
  service.api = async (context, pathname) => {
    page = context.request.headers['x-quizforge-practice-session'] ?? '';
    if (!/^[a-f0-9-]{36}$/.test(page)) page = '';
    const flags = context.request.headers['x-quizforge-cloud-ai'];
    preferences = { enabled: !!page && (flags === 'manual' || flags === 'auto'), autoGrade: !!page && flags === 'auto' };
    service.aiSettings.profile = { ...profile, ...preferences };
    // Expiration and every state write stay inside CloudPractice.checkpoint.
    for (const [id, { ai, task }] of tasks) {
      if (ai.closed) { tasks.delete(id); continue; }
      const delivery = task.value.snapshot?.cloudDelivery;
      if (task.value.status === 'queued' && delivery?.page === page && delivery.deadline > Date.now() && delivery.deadline < Date.now() + 240000) { delivery.deadline = Date.now() + 300000; ai.persist(task); }
      restore(ai, task);
    }
    while (tasks.size > 512) { const finished = [...tasks].find(([, value]) => !['queued','running'].includes(value.task.value.status)); if (!finished) break; tasks.delete(finished[0]); }
    if (pathname === '/api/settings/ai' && context.request.method === 'GET') return { ...preferences, canManage: false, apiKeyConfigured: false, browserOnly: true };
    let result;
    if (pathname.startsWith('/api/cloud-ai/')) {
      if (context.request.method !== 'POST') reject('METHOD_NOT_ALLOWED', '请求方法不受支持。', 405);
      const body = await service.writeRequest(context), action = pathname.slice('/api/cloud-ai/'.length);
      fields(body, action === 'claim' ? ['taskId'] : ['taskId', 'lease', action === 'result' ? 'result' : 'code']);
      const { ai, task, delivery, collection, question } = await locate(body.taskId);
      if (action === 'claim') {
        if (!preferences.enabled) reject('AI_NOT_CONFIGURED', '请先在设置中启用并解锁 AI 配置。');
        if (delivery.lease || task.value.status !== 'queued') reject('AI_ALREADY_CLAIMED', '评分已由当前页面发起，不会重复调用模型。');
        if (delivery.deadline <= Date.now() || !await ai.states.aiCurrent(collection, question, snapshot(task), task.value.taskId)) reject('AI_RESULT_STALE', '题目或答案已变化，请重新评分。');
        let input;
        try { input = await ai.gateway.generate({ gradingInput: snapshot(task).gradingInput }); }
        catch { ai.mark(task, 'failed', 'AI_INPUT_LIMIT', '评分内容或图片无法读取，或超出本次调用上限。'); ai.live.delete(task.value.taskId); reject('AI_INPUT_LIMIT', '评分内容或图片无法读取，或超出本次调用上限。', 422); }
        delivery.lease = randomUUID(); delivery.deadline = Date.now() + 180000; task.value.calls++;
        ai.mark(task, 'running'); restore(ai, task);
        return { taskId: task.value.taskId, lease: delivery.lease, input };
      }
      if (!['result', 'fail'].includes(action)) reject('NOT_FOUND', '评分接口不存在。', 404);
      if (typeof body.lease !== 'string' || body.lease !== delivery.lease) reject('AI_LEASE_INVALID', '评分请求已失效。');
      if (action === 'result') {
        fields(body.result, ['output', 'provider', 'model', 'responseId', 'usage']);
        if (typeof body.result.output !== 'string' || body.result.output.length > 24000 || typeof body.result.model !== 'string' || body.result.model.length > 200) reject('AI_OUTPUT_INVALID', '模型输出格式无效。', 422);
        const hash = fingerprint(body.result, 'quizforge-cloud-ai-result-v1');
        if (delivery.resultHash) {
          if (delivery.resultHash !== hash) reject('AI_RESULT_CONFLICT', '此评分结果已经保存，请使用人工评分调整。');
          return ai.get(collection, question, task.value.taskId);
        }
        if (delivery.deadline <= Date.now() || !await ai.states.aiCurrent(collection, question, snapshot(task), task.value.taskId)) reject('AI_RESULT_STALE', '题目、答案或人工评分已变化，这次结果不会覆盖现有内容。');
        if (!['queued', 'running'].includes(task.value.status)) reject('AI_RESULT_STALE', '这次评分已停止，请手动重试。');
        task.value.candidate = ai.candidate(task, { ...body.result, provider: body.result.provider === 'quizforge-official' ? 'quizforge-official' : 'openai-compatible' });
        delivery.resultHash = hash; ai.mark(task, 'succeeded'); await ai.autoApply(task); ai.live.delete(task.value.taskId);
        await service.exams.tick(); result = await ai.get(collection, question, task.value.taskId);
      } else {
        if (['queued', 'running'].includes(task.value.status)) {
          const errors = { AI_AUTH: '模型认证失败，请检查 Key 和地址。', AI_QUOTA: '模型余额或额度不足。', AI_RATE_LIMIT: '模型请求受限，请稍后手动重试。', AI_OUTPUT_INVALID: '模型没有返回有效评分，请重试或人工评分。', AI_VISION_UNSUPPORTED: '本题含图片，请先测试并启用模型图片识别。', AI_INTERRUPTED: '浏览器评分已中断，请手动重试。', AI_OFFICIAL_LOGIN: '登录已失效，请重新登录 Hub 后重试。', AI_OFFICIAL_BALANCE: '免费 AI 额度已用完，可在设置 → 用户中心兑换，或开启自定义模型。', AI_OFFICIAL_BUDGET: '免费 AI 今日额度已用完，请稍后再试或开启自定义模型。', AI_OFFICIAL_UNAVAILABLE: '免费 AI 暂时不可用，请稍后再试或开启自定义模型。', AI_UPSTREAM: '免费 AI 模型暂时没有响应，本次不扣额度，请稍后重试。', AI_TIMEOUT: '免费 AI 等待超时，本次不扣额度，请手动重试。', AI_NETWORK: '暂时无法连接 QuizForge 服务器，请稍后重试。', AI_INPUT_LIMIT: '评分内容或图片超出上限。', AI_CONFIG: '免费 AI 未接受这次评分请求，请人工评分或改用自定义模型。' };
          ai.mark(task, 'failed', Object.hasOwn(errors, body.code) ? body.code : 'AI_BROWSER_FAILED', errors[body.code] ?? '浏览器直连失败，请检查网络和模型跨域设置，再手动重试。'); ai.live.delete(task.value.taskId);
        }
        result = await ai.get(collection, question, task.value.taskId);
      }
    } else {
      if (/\/ai\/(?:grade|tasks\/[^/]+\/retry)$/.test(pathname) && !preferences.enabled) reject('AI_NOT_CONFIGURED', '请先在设置 → AI 评分中保存或解锁配置。');
      result = await api(context, pathname);
    }
    if (result && typeof result === 'object' && !Array.isArray(result)) result.cloudAiPending = [...tasks.values()].filter(({ ai, task }) => !ai.closed && task.value.status === 'queued' && task.value.snapshot.cloudDelivery?.page === page && !task.value.snapshot.cloudDelivery.lease).slice(0, 32).map(({ task }) => ({ taskId: task.value.taskId }));
    return result;
  };
}
