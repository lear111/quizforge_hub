import { connection, encryptKey, decryptKey, session, setSession, clearSessions, testGradingModel, gradeDirect } from './vault.js';
import { readCloudAiPrefs } from './ai-preferences.js';

const app = document.querySelector('#app');
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const MiB = 1024 ** 2;
const size = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / MiB).toFixed(2)} MiB`;
const labels = { storageBytes: '存储空间', dailyTrafficBytes: '每日下载流量', monthlyTrafficBytes: '每月下载流量' };
let user, epoch = 0, adminPage = 1, adminQuery = '', listing;
async function api(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || '请求未能完成'), { status: response.status });
  return value;
}
const heading = (title, description) => `<div class="cloud-heading"><h1>${esc(title)}</h1><p>${esc(description)}</p></div>`;
const keyName = () => `qfh.ai.v1:${user.id}`;
const bound = baseUrl => ({ account: user.id, origin: location.origin, endpoint: baseUrl });
function saved() {
  const raw = localStorage.getItem(keyName());
  if (!raw) return null;
  if (raw.length > 20000) throw new Error('本地配置无效，请清除后重新填写');
  const value = JSON.parse(raw);
  if (value.version !== 1 || !value.envelope) throw new Error('本地配置无效，请清除后重新填写');
  connection({ ...value, apiKey: 'validation-only' });
  return value;
}
function forgetSession() {
  epoch++; clearSessions();
  notifyAiStatus();
  document.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; });
}
const embedded = new URLSearchParams(location.search).get('embedded') === '1';
// The on/off switch and the two sources, as on the Web (non-secret, kept in this browser).
// Settings saved before the free quota existed keep using the custom model.
const prefsName = () => `qfh.ai.prefs.v1:${user.id}`;
function prefs() {
  return readCloudAiPrefs(localStorage, user?.id);
}
function notifyAiStatus() {
  if (!embedded || window.parent === window) return;
  // The switch and sources live in Web's AI 评分 panel; this frame only says whether the custom model is ready.
  window.parent.postMessage({ type: 'qfh-ai-status', account: user?.id ?? '', custom: !!(user && session(user.id)) }, location.origin);
}
const yuan = amount => '¥' + (Math.floor(Number(amount || 0) / 100) / 100).toFixed(2);
let generating = false;
window.addEventListener('message', async event => {
  if (!embedded || event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'qfh-ai-generate') return;
  const value = event.data, started = epoch;
  if (generating || !user || value.account !== user.id) return;
  generating = true;
  try {
    if (!await verifyIdentity()) throw new Error();
    const profile = session(user.id); if (!profile?.enabled) throw new Error();
    const result = await gradeDirect(profile, value.input);
    if (epoch !== started) throw new Error();
    window.parent.postMessage({ type: 'qfh-ai-response', id: value.id, ok: true, result }, location.origin);
  } catch (error) {
    window.parent.postMessage({ type: 'qfh-ai-response', id: value.id, ok: false, code: error.code || 'AI_INTERRUPTED' }, location.origin);
  } finally { generating = false; }
});
function signedOut() {
  forgetSession(); user = null;
  document.querySelector('#cloud-account').replaceChildren();
  app.innerHTML = heading('请先登录 Hub', '云端空间与题库广场共用同一套账户。') + '<a class="button" href="/manage/#library">前往题库广场登录</a>';
}
async function verifyIdentity() {
  const identity = await api('/api/me');
  if (!identity.user || identity.user.id !== user?.id) { signedOut(); return false; }
  return true;
}
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('qfh-account') : null;
if (channel) channel.onmessage = event => { if (event.data === 'logout') signedOut(); };
window.addEventListener('pagehide', forgetSession);
document.addEventListener('visibilitychange', () => { if (!document.hidden && user) verifyIdentity().catch(forgetSession); });

async function home() {
  const value = await api('/api/cloud/me');
  app.innerHTML = heading('我的云端空间', value.libraryReady ? '从公共广场添加题库，或上传仅自己可见的私人题库。' : '云端题库运行时尚未配置，当前可以管理资源额度与本地 AI 设置。') +
    '<div class="cloud-grid">' + Object.entries(labels).map(([field, label]) => `<section class="cloud-card"><h2>${label}</h2><div class="cloud-number">${size(value.usage[field])} / ${size(value.limits[field])}</div><progress max="${Math.max(1, value.limits[field])}" value="${Math.min(value.usage[field], value.limits[field])}" aria-label="${label}使用量"></progress><p>${field === 'storageBytes' ? `另有 ${size(value.usage.reservedStorageBytes)} 正在预留` : field === 'dailyTrafficBytes' ? `统计日：${value.period.day}` : `统计月：${value.period.month}`}</p></section>`).join('') + '</div>' +
    '<p class="cloud-muted">存储用量包含已安装的题库、拓展、图片与作答历史。流量覆盖登录后的 Hub 附件、云端练习请求和导出，按发送前预留计算，包含中断请求；不等同于服务器全部流量或云厂商账单。</p>' +
    (value.storageFull ? '<p class="cloud-notice">存储额度已满。后续导入和保存将检查额度；已保存内容不会因为调低额度而被自动删除。</p>' : '') +
    `<div class="cloud-actions"><a class="button" href="/manage/#library">浏览公共题库</a><a class="button secondary" href="/cloud/ai">配置本地 AI</a>${user.admin ? '<a class="button secondary" href="/cloud/admin">资源管理</a>' : ''}</div>`;
  if (value.libraryReady) {
    const library = await api('/api/cloud/library');
    app.insertAdjacentHTML('beforeend', `<section class="panel"><h2>导入私人题库</h2><p class="cloud-muted">仅自己可见。支持格式 3 的 .qbank 文件，包内拓展必须已通过云端审核。导入后仅保存展开的题库内容，不保留上传原始压缩包。</p><form id="cloud-import-form"><input type="file" name="package" accept=".qbank" required aria-label="私人题库文件"><div class="cloud-actions"><button class="button" type="submit">导入到我的云端</button><button class="button secondary" type="button" data-import-demo>添加基础题型示例</button></div><p class="form-error" role="alert"></p><p role="status" class="cloud-status"></p></form></section><section><h2>我的题库 <span class="count">${library.items.length} 份</span></h2>${library.items.length ? library.items.map(item => `<article class="cloud-card cloud-bank"><h3>${esc(item.title)}</h3><p>${esc(item.source.kind === 'hub' ? `来自公共广场 · 版本记录 ${item.source.revision}` : item.source.kind === 'admin-delivery' ? '管理员私人交付' : item.source.kind === 'builtin-demo' ? '官方基础题型示例' : '私人上传')} · ${size(item.bytes)} · ${item.banks.length} 本题库</p><p>${item.banks.map(bank => esc(bank.title || bank.name)).join('、')}</p><div class="cloud-actions">${item.practiceReady ? `<a class="button" href="/cloud/practice/${item.id}/">开始练习</a>` : '<span class="cloud-muted">练习运行正在接入</span>'}<a class="button secondary" href="/api/cloud/library/${item.id}/export">导出 .qbank</a></div></article>`).join('') : '<p class="cloud-muted">还没有题库。可以先添加基础题型示例，验证云端导入。</p>'}</section>`);
    app.querySelectorAll('.cloud-bank .cloud-actions').forEach((node, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.dataset.deleteImport = library.items[index].id; button.textContent = '删除此副本'; node.append(button);
    });
  }
}

function aiPage() {
  let stored = null, initialError = '';
  try { stored = saved(); } catch { initialError = '无法读取本地配置，可清除后重新填写；本次页面使用仍可配置。'; }
  const current = session(user.id), profile = current || stored || { baseUrl: '', model: '' };
  let testReport = profile.testReport ?? null;
  let choice = prefs();
  app.innerHTML = heading('AI 评分', '可使用账号的免费 AI 额度，也可以使用自己的模型。') + `<section class="cloud-ai">
    <form id="ai-prefs" autocomplete="off">
      <label class="cloud-switch">开启 AI 评分<input name="enabled" type="checkbox" role="switch" ${choice.enabled ? 'checked' : ''}></label>
      <div id="ai-options">
        <label class="cloud-check"><input name="autoGrade" type="checkbox" ${choice.autoGrade ? 'checked' : ''}>提交答案后自动 AI 评分</label>
        <fieldset class="cloud-source"><legend>评分来源（可同时开启，优先使用免费额度）</legend>
          <label class="cloud-check"><input name="useOfficial" type="checkbox" ${choice.useOfficial ? 'checked' : ''}><span>使用免费 AI 额度</span><span id="ai-points" class="cloud-points"></span></label>
          <p class="field-help">评分时，题目、答案和图片会经 QuizForge 服务器发送给模型服务商（通义千问），服务器不保存这些内容。额度用完或暂时不可用时，如果开启了自定义模型，会自动改用自定义模型。</p>
          <label class="cloud-check"><input name="useCustom" type="checkbox" ${choice.useCustom ? 'checked' : ''}><span>使用自定义模型</span></label>
        </fieldset>
      </div>
      <p id="ai-prefs-status" class="cloud-status" role="status"></p>
    </form>
    <div id="ai-custom" class="cloud-custom">
    <div class="cloud-notice"><strong>API Key 仅保存在你的设备上</strong><br>默认仅在当前页面使用；选择“记住此设备”后，用你设置的独立口令加密保存在当前浏览器，不上传至 Hub，也不会随账户同步。<br>浏览器直接连接你填写的模型服务；评分时，相关题目与作答会发送给该服务。模型接口需要允许浏览器跨域访问，不兼容时不会自动转发 Key 到 Hub。<br>本地保存不能防止设备失陷或恶意网页脚本，请使用专用、有限额的 Key。清除浏览器数据或更换设备后需要重新配置。</div>
    <p class="cloud-muted">支持题卡手动评分、提交后自动评分及考试交卷后的评分。评分期间请保持此页面打开；关闭或断线后请手动重试，不会自动重复调用。</p>
    <form id="ai-form" autocomplete="off">
      <label class="cloud-check"><input name="vision" type="checkbox" disabled ${profile.vision ? 'checked' : ''}>图片评分（模型图片识别测试通过后启用）</label>
      <div class="field"><label for="model-url">模型 API 基础地址</label><input id="model-url" name="baseUrl" type="url" required maxlength="2048" placeholder="https://你的模型服务地址/v1" value="${esc(profile.baseUrl)}"><p class="field-help">填写可信服务地址，程序会在其后添加 /chat/completions。更换服务地址时必须重新填写 Key。</p></div>
      <div class="field"><label for="model-name">模型名称</label><input id="model-name" name="model" required maxlength="200" value="${esc(profile.model)}"></div>
      <div class="field"><label for="model-output">响应格式</label><select id="model-output" name="outputMode"><option value="json" ${!profile.outputMode || profile.outputMode==='json'?'selected':''}>JSON 对象（推荐）</option><option value="schema" ${profile.outputMode==='schema'?'selected':''}>严格 JSON Schema</option><option value="text" ${profile.outputMode==='text'?'selected':''}>普通文本（兼容模式）</option></select></div>
      <div class="field"><label for="model-key">API Key</label><input id="model-key" name="apiKey" type="password" autocomplete="off" maxlength="4096" placeholder="${current ? '已在当前页面配置，留空保留' : stored ? '可填写新 Key，或用下面的口令解锁' : '仅发送给上方模型服务'}"></div>
      <label class="cloud-check"><input name="remember" type="checkbox" ${stored ? 'checked' : ''}>记住此设备（加密保存）</label>
      <div class="field"><label for="local-passphrase">本地解锁口令</label><input id="local-passphrase" name="passphrase" type="password" autocomplete="new-password" maxlength="1024"><p class="field-help">至少 8 个字符，不上传 Hub，请勿填写 Hub 登录密码。下次打开页面需重新解锁，Hub 无法恢复遗忘的口令。</p></div>
      <p class="form-error" role="alert">${esc(initialError)}</p><p id="ai-status" class="cloud-status" role="status">${current ? '已在当前页面配置' : stored ? '此设备已有加密配置，尚未解锁' : '尚未配置'}</p><p class="field-help">模型测试包含文字连接、评分输出和图片识别，最多调用 3 次。图片通过仅代表基础识别成功，复杂图表及手写仍需实际验证。</p>
      <div class="cloud-actions"><button class="button" type="submit">保存到本地</button><button class="button secondary" type="button" data-ai-action="unlock">解锁已保存配置</button><button class="button secondary" type="button" data-ai-action="test">测试直连（会产生模型调用）</button><button class="text-button" type="button" data-ai-action="clear">清除本地配置</button></div>
    </form></div></section>`;
  const form = app.querySelector('#ai-form'), choices = app.querySelector('#ai-prefs'), points = app.querySelector('#ai-points');
  function describe() {
    const custom = session(user.id);
    if (!choice.enabled) return 'AI 评分未开启，仍可人工评分。';
    const sources = [choice.useOfficial && '免费 AI 额度', choice.useCustom && '自定义模型'].filter(Boolean);
    if (!sources.length) return '请选择至少一个评分来源。';
    if (choice.useCustom && !custom && !choice.useOfficial) return '请在下方保存或解锁自定义模型后使用。';
    const how = sources.length === 2 ? '优先使用免费 AI 额度，不可用时改用自定义模型' : `使用${sources[0]}`;
    return `AI 评分已开启（${how}），` + (choice.autoGrade ? '提交答案后自动评分，结果自动保存。' : '可在题卡点击评分，结果自动保存。') + (choice.useCustom && !custom && choice.useOfficial ? '自定义模型尚未解锁。' : '');
  }
  function showChoices() {
    app.querySelector('#ai-options').hidden = !choice.enabled; app.querySelector('#ai-custom').hidden = !choice.enabled || !choice.useCustom;
    app.querySelector('#ai-prefs-status').textContent = describe();
  }
  async function loadPoints() {
    let text = '正在查询…', value = null;
    points.textContent = text; points.classList.remove('empty');
    try { const response = await fetch('/api/cloud/ai/hub', { cache: 'no-store', credentials: 'same-origin' }); value = response.ok ? await response.json() : null; } catch { }
    if (!value) text = '暂时查询不到余额';
    else if (!value.connected) text = '登录已失效';
    else if (value.unavailable) text = '暂时查询不到余额';
    else if (!value.ai?.enabled) text = '暂不可用';
    else { text = `剩余 ${yuan(value.ai.balance)}`; points.classList.toggle('empty', value.ai.balance < 1); }
    points.textContent = text;
  }
  choices.addEventListener('change', () => {
    choice = Object.fromEntries(['enabled', 'autoGrade', 'useOfficial', 'useCustom'].map(key => [key, choices.elements[key].checked]));
    try { localStorage.setItem(prefsName(), JSON.stringify(choice)); } catch { }
    showChoices(); notifyAiStatus();
  });
  window.addEventListener('message', event => { if (event.origin === location.origin && event.source === window.parent && event.data?.type === 'qfh-ai-refresh') loadPoints(); });
  showChoices(); loadPoints();
  const reportText = () => testReport ? testReport.checks.map(check => check.label + (check.ok ? '通过' : '未通过或未完成')).join('；') : '';
  if (testReport) form.querySelector('#ai-status').textContent += ' · 上次测试：' + reportText();
  form.addEventListener('input', event => { if (['baseUrl','model','apiKey','outputMode'].includes(event.target.name)) { testReport = null; form.elements.vision.checked = false; } });
  async function perform(action) {
    const data = Object.fromEntries(new FormData(form)), error = form.querySelector('.form-error'), status = form.querySelector('#ai-status');
    data.enabled = true; data.autoGrade = false; data.vision = form.elements.vision.checked;
    const started = epoch, account = user?.id;
    error.textContent = ''; status.textContent = '正在处理…';
    const buttons = [...form.querySelectorAll('button')]; buttons.forEach(button => { button.disabled = true; });
    try {
      if (action === 'clear') {
        forgetSession(); testReport = null; localStorage.removeItem(keyName()); form.reset(); form.elements.apiKey.value = ''; form.elements.passphrase.value = ''; form.elements.remember.checked = false; status.textContent = '本地配置已清除'; showChoices(); return;
      }
      if (!crypto.subtle) throw new Error('请通过 HTTPS 或本机地址打开设置页面');
      if (action === 'unlock') {
        const value = saved(); if (!value) throw new Error('此设备尚无加密配置');
        const apiKey = await decryptKey(value.envelope, data.passphrase, bound(value.baseUrl));
        if (epoch !== started || user?.id !== account) return;
        setSession(user.id, { ...value, apiKey, enabled: true }); testReport = value.testReport ?? null; notifyAiStatus(); showChoices(); form.elements.baseUrl.value = value.baseUrl; form.elements.model.value = value.model; form.elements.outputMode.value = value.outputMode || 'json'; form.elements.vision.checked = session(user.id).vision; form.elements.apiKey.value = ''; form.elements.passphrase.value = ''; status.textContent = '已解锁，仅在当前页面使用' + (testReport ? ' · 上次测试：' + reportText() : ''); return;
      }
      const previous = session(user.id);
      const normalizedUrl = new URL(data.baseUrl).href.replace(/\/$/, '');
      const profile = connection({ ...data, testReport, apiKey: data.apiKey || (previous?.baseUrl === normalizedUrl ? previous.apiKey : '') });
      if (action === 'test') {
        const canvas = document.createElement('canvas'); canvas.width = 290; canvas.height = 76;
        const expected = [...crypto.getRandomValues(new Uint8Array(6))].map(value => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[value % 32]).join('');
        const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0,0,290,76); context.fillStyle = '#111'; context.font = 'bold 42px monospace'; context.fillText(expected,20,54);
        const tested = await testGradingModel(profile, { expected, dataUrl: canvas.toDataURL('image/png') });
        if (epoch === started && user?.id === account) { testReport = tested.report; form.elements.vision.checked = tested.vision; status.textContent = reportText() + '。请保存配置使测试结果生效。'; }
        return;
      }
      let envelope;
      if (data.remember) envelope = await encryptKey(profile.apiKey, data.passphrase, bound(profile.baseUrl));
      if (epoch !== started || user?.id !== account) return;
      // Persist before reporting success. Neither plaintext nor the passphrase
      // appears in localStorage, URL parameters, Hub requests or global objects.
      if (envelope) { const { apiKey: _secret, ...settings } = profile; localStorage.setItem(keyName(), JSON.stringify({ version: 1, ...settings, envelope })); }
      else localStorage.removeItem(keyName());
      setSession(user.id, profile); notifyAiStatus(); showChoices(); form.elements.apiKey.value = ''; form.elements.passphrase.value = '';
      status.textContent = envelope ? '已加密保存到此设备，当前页面已解锁' : '仅在当前页面使用，关闭或离开页面后清除';
    } catch (failure) {
      // Never render native URL/parser/provider exceptions, which may contain
      // user-entered credentials. Domain errors above contain fixed messages.
      if (epoch === started && user?.id === account) { error.textContent = failure instanceof TypeError || failure instanceof SyntaxError ? '配置无效或浏览器存储不可用，请检查输入' : failure.message; status.textContent = ''; }
    } finally { buttons.forEach(button => { button.disabled = false; }); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); perform('save'); });
  form.addEventListener('click', event => { const action = event.target.closest('[data-ai-action]'); if (action) perform(action.dataset.aiAction); });
}

// Custom model fields inside Web's AI 评分 panel (practice-ui.mjs), in Web's markup and ai-settings.css.
// The API Key stays in this frame: in memory, or encrypted with a local passphrase in this browser.
function customPage() {
  let stored = null, initialError = '';
  try { stored = saved(); } catch { initialError = '无法读取本地配置，可清除后重新填写。'; }
  const current = session(user.id), profile = current || stored || { baseUrl: '', model: '' };
  let testReport = profile.testReport ?? null;
  app.innerHTML = `<form id="ai-form" class="ai-settings-form" autocomplete="off"><div class="cloud-custom-body">
    <label>服务地址<input name="baseUrl" type="url" maxlength="2048" required placeholder="https://服务地址/v1" value="${esc(profile.baseUrl)}"><small>填写 OpenAI 兼容接口的基础地址，系统会追加 /chat/completions。</small></label>
    <label>模型名称<input name="model" maxlength="200" required placeholder="填写服务提供的模型 ID" value="${esc(profile.model)}"></label>
    <label>API Key<input name="apiKey" type="password" maxlength="4096" autocomplete="new-password" placeholder="${current ? '已在当前页面配置，留空保留' : stored ? '可输入新值，或用口令解锁' : '输入 API Key'}"><small>API Key 只保存在这个浏览器中，不上传 Hub。</small></label>
    <label class="ai-check"><input name="remember" type="checkbox" ${stored ? 'checked' : ''}>记住此设备（用本地口令加密保存）</label>
    <label>本地解锁口令<input name="passphrase" type="password" maxlength="1024" autocomplete="new-password"><small>至少 8 个字符，不上传 Hub，请勿填写 Hub 登录密码；遗忘后无法恢复。</small></label>
    <input name="vision" type="checkbox" hidden ${profile.vision ? 'checked' : ''}>
    <p>评分内容会从浏览器直接发送到所配置的模型服务（服务需允许跨域访问），结果通过校验后自动保存。测试模型可检测图片识别能力并显示报告。</p>
    <div class="ai-custom-actions"><button type="button" data-ai-action="test">测试模型</button>${stored && !current ? '<button type="button" data-ai-action="unlock">解锁</button>' : ''}<button type="button" data-ai-action="clear">清除</button><button class="primary" type="submit">保存</button></div>
    <small id="ai-status" class="cloud-custom-status" role="status">${current ? '自定义模型已在当前页面可用。' : stored ? '此设备已有加密配置，输入口令后点“解锁”。' : '尚未配置自定义模型。'}</small>
    <p class="form-error" role="alert">${esc(initialError)}</p>
    <section class="ai-test-report" aria-live="polite" hidden></section>
  </div></form>`;
  const form = app.querySelector('#ai-form'), report = form.querySelector('.ai-test-report');
  const showReport = () => {
    report.hidden = !testReport; if (!testReport) return;
    report.innerHTML = '<h3>模型测试报告</h3><ul>' + testReport.checks.map(check => `<li><span class="ai-report-label">${esc(check.label)}</span><span class="ai-report-badge ${check.ok ? 'passed' : 'failed'}">${check.ok ? '通过' : '未通过'}</span></li>`).join('') + '</ul>';
  };
  const resize = () => window.parent.postMessage({ type: 'qfh-ai-height', height: Math.ceil(document.body.getBoundingClientRect().height) }, location.origin);
  new ResizeObserver(resize).observe(document.body); showReport(); resize();
  form.addEventListener('input', event => { if (['baseUrl', 'model', 'apiKey'].includes(event.target.name)) { testReport = null; form.elements.vision.checked = false; showReport(); } });
  async function perform(action) {
    const data = Object.fromEntries(new FormData(form)), error = form.querySelector('.form-error'), status = form.querySelector('#ai-status');
    data.enabled = true; data.autoGrade = false; data.vision = form.elements.vision.checked; data.remember = form.elements.remember.checked;
    const started = epoch, account = user?.id, buttons = [...form.querySelectorAll('button')];
    error.textContent = ''; status.textContent = '正在处理…'; buttons.forEach(button => { button.disabled = true; });
    try {
      if (action === 'clear') { forgetSession(); testReport = null; localStorage.removeItem(keyName()); customPage(); return; }
      if (!crypto.subtle) throw new Error('请通过 HTTPS 打开页面');
      if (action === 'unlock') {
        const value = saved(); if (!value) throw new Error('此设备尚无加密配置');
        const apiKey = await decryptKey(value.envelope, data.passphrase, bound(value.baseUrl));
        if (epoch !== started || user?.id !== account) return;
        setSession(user.id, { ...value, apiKey, enabled: true }); notifyAiStatus(); customPage(); return;
      }
      const previous = session(user.id), normalizedUrl = new URL(data.baseUrl).href.replace(/\/$/, '');
      const value = connection({ ...data, outputMode: previous?.outputMode || stored?.outputMode || 'json', testReport, apiKey: data.apiKey || (previous?.baseUrl === normalizedUrl ? previous.apiKey : '') });
      if (action === 'test') {
        const canvas = document.createElement('canvas'); canvas.width = 290; canvas.height = 76;
        const expected = [...crypto.getRandomValues(new Uint8Array(6))].map(item => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[item % 32]).join('');
        const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 290, 76); context.fillStyle = '#111'; context.font = 'bold 42px monospace'; context.fillText(expected, 20, 54);
        const tested = await testGradingModel(value, { expected, dataUrl: canvas.toDataURL('image/png') });
        if (epoch === started && user?.id === account) { testReport = tested.report; form.elements.vision.checked = tested.vision; showReport(); status.textContent = '模型测试已完成，点“保存”使结果生效。'; }
        return;
      }
      let envelope;
      if (data.remember) envelope = await encryptKey(value.apiKey, data.passphrase, bound(value.baseUrl));
      if (epoch !== started || user?.id !== account) return;
      // Neither plaintext nor the passphrase appears in localStorage, URLs, Hub requests or global objects.
      if (envelope) { const { apiKey: _secret, ...settings } = value; localStorage.setItem(keyName(), JSON.stringify({ version: 1, ...settings, envelope })); }
      else localStorage.removeItem(keyName());
      setSession(user.id, value); notifyAiStatus(); form.elements.apiKey.value = ''; form.elements.passphrase.value = '';
      status.textContent = envelope ? '已加密保存到此浏览器，当前页面可用。' : '仅在当前页面使用，关闭页面后需要重新填写。';
    } catch (failure) {
      // Never render native URL/parser/provider exceptions, which may contain user-entered credentials.
      if (epoch === started && user?.id === account) { error.textContent = failure instanceof TypeError || failure instanceof SyntaxError ? '配置无效或浏览器存储不可用，请检查输入' : failure.message; status.textContent = ''; }
    } finally { buttons.forEach(button => { button.disabled = false; }); resize(); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); perform('save'); });
  form.addEventListener('click', event => { const action = event.target.closest('[data-ai-action]'); if (action) perform(action.dataset.aiAction); });
}

function limitInputs(values, inherited = false) {
  return '<div class="cloud-limits">' + Object.entries(labels).map(([key, label]) => `<label>${label}（MiB）<input type="number" name="${key}" min="0" step="0.000001" ${inherited ? '' : 'required'} value="${values[key] === null ? '' : values[key] / MiB}"><small>${inherited ? '留空使用站点默认额度' : '0 表示没有可用额度'}</small></label>`).join('') + '</div>';
}
function parseLimits(form, inherited) {
  return Object.fromEntries(Object.keys(labels).map(key => {
    const raw = form.elements[key].value, bytes = Number(raw) * MiB;
    if (raw === '' && inherited) return [key, null];
    if (raw === '' || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('请填写可换算为整数字节的非负额度');
    return [key, bytes];
  }));
}
async function admin() {
  if (!user.admin) throw new Error('仅管理员可查看资源管理');
  listing = await api(`/api/cloud/admin/users?page=${adminPage}&q=${encodeURIComponent(adminQuery)}`);
  const audit = await api('/api/cloud/admin/audit');
  app.innerHTML = `<div class="cloud-admin">${heading('云端资源管理', '额度调整立即保存并记录操作者、修改前后数值与原因；调低额度不会删除用户内容或清空用量。')}
    <p class="cloud-muted">站点已记账存储 ${size(listing.site.storageBytes)}，预留 ${size(listing.site.reservedStorageBytes)}，预算 ${size(listing.site.storageLimitBytes)}。统计包含已导入题库和已保存的练习数据。</p>
    <section class="panel"><h2>默认额度</h2><form id="defaults-form">${limitInputs(listing.defaults)}<div class="cloud-actions"><input name="reason" required maxlength="500" placeholder="调整原因" aria-label="默认额度调整原因"><button class="button" type="submit">保存默认额度</button></div><p class="form-error" role="alert"></p></form></section>
    <section class="panel"><h2>交付私人题库</h2><p class="cloud-muted">导入到指定用户的私人空间，不发布到题库广场。记录实际导入管理员与所属用户。</p><form id="delivery-form"><label>所属用户 <select name="userId" required>${listing.users.map(row => `<option value="${row.id}">${esc(row.name)} · ${esc(row.email || row.phone)}</option>`).join('')}</select></label><div class="cloud-actions"><input name="package" type="file" accept=".qbank" required aria-label="交付题库文件"><button class="button" type="submit">导入指定用户</button></div><p class="form-error" role="alert"></p><p class="cloud-status" role="status"></p></form></section>
    <h2>用户额度与用量</h2><form id="user-search" class="cloud-search"><input name="q" type="search" value="${esc(adminQuery)}" maxlength="100" placeholder="搜索邮箱或昵称" aria-label="搜索用户"><button class="button secondary" type="submit">查询</button></form>
    <div class="cloud-table-wrap"><table class="cloud-table"><thead><tr><th>用户</th><th>存储：用量 / 额度</th><th>今日流量：用量 / 额度</th><th>本月流量：用量 / 额度</th><th>操作</th></tr></thead><tbody>${listing.users.map(row => `<tr><td>${esc(row.name)}<br>${esc(row.email || row.phone)}</td>${Object.keys(labels).map(key => `<td>${size(row.usage[key])}<br>/ ${size(row.limits[key])}</td>`).join('')}<td><button class="text-button" data-edit-user="${row.id}">调整额度</button></td></tr>`).join('')}</tbody></table></div>
    <div class="cloud-pagination"><button class="button secondary" data-page="${adminPage - 1}" ${adminPage === 1 ? 'disabled' : ''}>上一页</button><span>${adminPage} / ${Math.max(1, Math.ceil(listing.count / 50))} · ${listing.count} 位用户</span><button class="button secondary" data-page="${adminPage + 1}" ${adminPage * 50 >= listing.count ? 'disabled' : ''}>下一页</button></div>
    <section class="panel"><h2>最近额度调整</h2><div class="cloud-audit">${audit.entries.length ? audit.entries.map(entry => `<p>${esc(new Date(entry.created).toLocaleString())} · 操作者 ${esc(entry.actor_id)} · ${entry.user_id ? `用户 ${esc(entry.user_id)}` : '站点默认额度'}<br>${esc(entry.reason)}<br>修改前 ${esc(JSON.stringify(entry.previous))}<br>修改后 ${esc(JSON.stringify(entry.replacement))}</p>`).join('') : '暂无调整记录'}</div></section>
    <dialog id="quota-dialog" class="dialog"><h2>调整用户额度</h2><p id="quota-user" class="cloud-muted"></p><form id="quota-form"><div id="quota-fields"></div><div class="field"><input name="reason" required maxlength="500" placeholder="调整原因" aria-label="用户额度调整原因"></div><p class="form-error" role="alert"></p><div class="cloud-actions"><button class="button" type="submit">保存额度</button><button class="button secondary" type="button" data-close-quota>取消</button></div></form></dialog></div>`;
}

app.addEventListener('click', async event => {
  const element = event.target.closest('button'); if (!element || !user) return;
  try {
    if (element.dataset.deleteImport) {
      if (!window.confirm('删除这份云端副本及其作答、白板与历史记录？此操作无法撤销，请先导出需要保留的题库。')) return;
      element.disabled = true;
      await api('/api/cloud/library/' + element.dataset.deleteImport, { method: 'DELETE' }); await home(); return;
    }
    if (element.hasAttribute('data-import-demo')) {
      element.disabled = true;
      const status = document.querySelector('#cloud-import-form .cloud-status'); status.textContent = '正在校验与导入…';
      try { await api('/api/cloud/library/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await home(); }
      finally { element.disabled = false; }
      return;
    }
    if (element.dataset.page) { adminPage = Number(element.dataset.page); await admin(); }
    if (element.dataset.editUser) {
      const row = listing.users.find(item => item.id === element.dataset.editUser), dialog = document.querySelector('#quota-dialog');
      document.querySelector('#quota-user').textContent = `${row.name} · ${row.email || row.phone}`;
      document.querySelector('#quota-fields').innerHTML = limitInputs(row.overrides, true);
      document.querySelector('#quota-form').dataset.user = row.id; dialog.showModal();
    }
    if (element.hasAttribute('data-close-quota')) document.querySelector('#quota-dialog').close();
  } catch (error) { showError(error); }
});
app.addEventListener('submit', async event => {
  const form = event.target;
  if (!['user-search', 'defaults-form', 'quota-form', 'cloud-import-form', 'delivery-form'].includes(form.id)) return;
  event.preventDefault();
  const button = form.querySelector('button[type=submit]'); button.disabled = true;
  try {
    if (form.id === 'cloud-import-form' || form.id === 'delivery-form') {
      const file = form.elements.package.files[0];
      if (!file || !file.name.toLowerCase().endsWith('.qbank') || file.size > 64 * MiB) throw new Error('请选择不超过 64 MiB 的 .qbank 文件');
      const status = form.querySelector('.cloud-status'); if (status) status.textContent = '正在校验拓展、题库和空间额度…';
      const route = form.id === 'delivery-form' ? `/api/cloud/admin/users/${form.elements.userId.value}/import` : '/api/cloud/library/import';
      await api(route, { method: 'POST', headers: { 'Content-Type': 'application/vnd.quizforge.qbank', 'X-QuizForge-Filename': encodeURIComponent(file.name) }, body: file });
      if (form.id === 'delivery-form') { status.textContent = '已导入指定用户的私人题库'; form.reset(); } else await home();
      return;
    }
    if (form.id === 'user-search') { adminQuery = form.elements.q.value.trim(); adminPage = 1; await admin(); return; }
    const route = form.id === 'defaults-form' ? '/api/cloud/admin/defaults' : `/api/cloud/admin/users/${form.dataset.user}/limits`;
    await api(route, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limits: parseLimits(form, form.id === 'quota-form'), reason: form.elements.reason.value }) });
    await admin();
  } catch (error) { const node = form.querySelector('.form-error'); if (node) node.textContent = error.message; else showError(error); }
  finally { button.disabled = false; }
});
function showError(error) { const node = document.querySelector('#toast'); node.textContent = error.message; node.classList.add('show'); setTimeout(() => node.classList.remove('show'), 5000); }
try {
  const [identity, config] = await Promise.all([api('/api/me'), api('/api/config')]);
  user = identity.user;
  if (!config.cloudEnabled) throw new Error('云端测试功能尚未启用');
  if (!user) signedOut();
  else {
    document.querySelector('#cloud-account').textContent = user.name;
    if (location.pathname === '/cloud/ai') { if (embedded) customPage(); else aiPage(); notifyAiStatus(); }
    else if (location.pathname === '/cloud/admin') await admin();
    else await home();
  }
} catch (error) { app.innerHTML = heading('暂时无法打开', error.message) + '<a class="button secondary" href="/manage/#library">返回题库广场</a>'; }
