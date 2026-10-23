import { bindCloudAi, setCloudAiPrefs } from './ai-client.js';
import { bindActivity } from './activity.js';
import { bindCloudLibrary } from './library.js';
import { bindAdminContact } from '/admin-contact.js';
// Free AI amounts are integers of 0.0001 yuan; shown in yuan rounded down to the cent, as on the Web.
const yuan = amount => '¥' + (Math.floor(Number(amount || 0) / 100) / 100).toFixed(2);
const size = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
export async function downloadCloudSelection(route, selection) {
  const response = await fetch(route, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection), signal: AbortSignal.timeout(135000) });
  if (!response.ok) { const value = await response.json(); throw new Error(value.error || '题库导出失败，请稍后重试'); }
  return response.blob();
}
async function read(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Object.assign(new Error(response.status === 401 ? '登录已失效，请重新登录 Hub。' : '暂时无法读取账户信息，请重新打开设置重试。'), { status: response.status });
  return response.json();
}
const hubAccount = () => read('/api/cloud/ai/hub').catch(() => ({ connected: true, unavailable: true }));

// Settings drive Web's own 用户中心 and AI 评分 markup (docs/HUB_CONNECT_AI.md 7.3). The visitor is
// always signed in to Hub: no device login or device logout, and 退出登录 signs out of Hub.
export function bindCloudExperience({ document, beforeLogout }) {
  bindAdminContact({ document, endpoint: '/api/cloud/admin-contact' });
  bindActivity({ document, practice: true, endpoint: '/api/cloud/activity' });
  bindCloudLibrary(document);
  const get = id => document.getElementById(id), dialog = get('network-settings-dialog');
  const user = get('user-center-panel'), ai = get('ai-settings-panel'), appearance = get('appearance-settings-panel');
  const tabs = [...document.querySelectorAll('.settings-tabs [role="tab"]')], frame = ai.querySelector('iframe');
  bindCloudAi(frame);
  let epoch = 0, account = null, hub = null;
  function select(tab, panel) {
    for (const node of [user, ai, appearance]) node.hidden = node !== panel;
    for (const node of tabs) node.setAttribute('aria-selected', String(node === tab));
  }

  // 用户中心
  const uc = id => get(`user-center-${id}`), points = uc('points'), result = uc('redeem-result');
  uc('manage').hidden = true; uc('login').textContent = '重新登录 Hub'; uc('logout').textContent = '退出登录';
  function showPoints() {
    const value = hub;
    points.textContent = !value ? '正在查询…' : value.unavailable ? '暂时查询不到' : !value.connected ? '登录已失效' : value.ai?.enabled ? yuan(value.ai.balance) : `${yuan(value.ai?.balance)} · 暂不可用`;
    points.classList.toggle('empty', Boolean(value?.ai && value.ai.balance < 1));
    renderHub();
  }
  async function loadHub(current) {
    hub = null; showPoints();
    const value = await hubAccount();
    if (current === epoch) { hub = value; showPoints(); }
  }
  async function loadUser() {
    const current = ++epoch;
    uc('status').textContent = '正在读取账号…'; uc('status').hidden = false; uc('account').hidden = true; uc('guest').hidden = true; uc('error').hidden = true;
    loadHub(current);
    try {
      const [identity, resources] = await Promise.all([read('/api/me'), read('/api/cloud/me')]);
      if (current !== epoch) return;
      if (!identity.user) throw Object.assign(new Error('登录已失效，请重新登录 Hub。'), { status: 401 });
      account = identity.user;
      uc('name').textContent = account.name; uc('device').textContent = account.email || account.phone || ''; uc('avatar').textContent = Array.from(account.name)[0] || 'Q';
      for (const [id, field] of [['storage', 'storageBytes'], ['download', 'dailyTrafficBytes']]) {
        const used = resources.usage[field], limit = resources.limits[field], progress = get(`cloud-${id}-progress`);
        get(`cloud-${id}-value`).textContent = `${size(used)} / ${size(limit)}`;
        progress.max = Math.max(1, limit); progress.value = Math.min(used, limit);
      }
      uc('status').hidden = true; uc('account').hidden = false;
    } catch (error) {
      if (current !== epoch) return;
      if (error.status === 401) { uc('status').textContent = error.message; uc('guest').hidden = false; }
      else { uc('status').textContent = '读取账号失败。'; uc('error').textContent = error.message; uc('error').hidden = false; }
    }
  }
  uc('refresh').addEventListener('click', () => loadHub(epoch));
  uc('login').addEventListener('click', () => location.assign('/auth/hub'));
  uc('close').addEventListener('click', () => dialog.close());
  uc('code').addEventListener('input', () => { result.textContent = ''; result.classList.remove('error'); });
  uc('redeem').addEventListener('submit', async event => {
    event.preventDefault();
    const input = uc('code'), button = uc('redeem-submit'), code = input.value.trim();
    result.classList.remove('error');
    if (!code) { result.textContent = '请输入兑换码。'; result.classList.add('error'); return; }
    button.disabled = true; button.textContent = '正在处理…'; result.textContent = '';
    try {
      const response = await fetch('/api/cloud/ai/hub/redeem', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new Error(value?.error?.message || (typeof value?.error === 'string' ? value.error : '兑换没有完成，请重试。'));
      input.value = ''; result.textContent = `已兑换 ${yuan(value.added)}，当前剩余 ${yuan(value.balance)}。`;
      hub = { ...(hub || { connected: true }), ai: { ...(hub?.ai || { enabled: true }), balance: value.balance } }; delete hub.unavailable; showPoints();
    } catch (error) { result.textContent = error.message || '兑换没有完成，请重试。'; result.classList.add('error'); }
    finally { button.disabled = false; button.textContent = '兑换'; }
  });
  uc('logout').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      await beforeLogout();
      const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('暂时未能退出，请稍后重试。');
      if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel('qfh-account'); channel.postMessage('logout'); channel.close(); }
      frame.src = 'about:blank'; location.assign('/');
    } catch (error) { uc('error').textContent = error.message; uc('error').hidden = false; button.disabled = false; }
  });

  // AI 评分: the switch and sources are kept in this browser; the custom model lives in the frame.
  const as = id => get(`ai-settings-${id}`), names = ['enabled', 'autoGrade', 'useOfficial', 'useCustom'];
  const key = () => account && `qfh.ai.prefs.v1:${account.id}`;
  let prefs = { enabled: false, autoGrade: false, useOfficial: false, useCustom: false };
  function loadPrefs() {
    try {
      const raw = key() && localStorage.getItem(key());
      if (raw) { const value = JSON.parse(raw); prefs = Object.fromEntries(names.map(name => [name, value?.[name] === true])); }
      // Settings saved before the free quota existed keep using the custom model.
      else if (key() && localStorage.getItem(`qfh.ai.v1:${account.id}`)) prefs = { enabled: true, autoGrade: false, useOfficial: false, useCustom: true };
    } catch { }
    setCloudAiPrefs(prefs);
  }
  function renderHub() {
    const node = as('points');
    let text = '', empty = false, balance = false;
    if (!hub) text = '正在查询…';
    else if (!hub.connected) text = '登录已失效';
    else if (hub.unavailable) text = '暂时查询不到余额';
    else if (!hub.ai?.enabled) text = '暂不可用';
    else { text = `剩余 ${yuan(hub.ai.balance)}`; empty = hub.ai.balance < 1; balance = true; }
    node.textContent = text; node.hidden = !text; node.classList.toggle('empty', empty); node.classList.toggle('muted', !balance);
  }
  function describe() {
    if (!prefs.enabled) return 'AI 评分未开启，仍可人工评分。';
    const sources = [prefs.useOfficial && '免费 AI 额度', prefs.useCustom && '自定义模型'].filter(Boolean);
    if (!sources.length) return '请选择至少一个评分来源。';
    const how = sources.length === 2 ? '优先使用免费 AI 额度，不可用时改用自定义模型' : `使用${sources[0]}`;
    return prefs.autoGrade ? `AI 评分已开启（${how}），提交答案后自动评分，结果自动保存。` : `AI 评分已开启（${how}），可在题卡点击评分，结果自动保存。`;
  }
  function renderAi() {
    for (const name of names) as(name).checked = prefs[name];
    as('options').hidden = !prefs.enabled; as('custom').hidden = !prefs.useCustom; as('status').textContent = describe(); as('error').hidden = true;
  }
  for (const name of names) as(name).addEventListener('change', () => {
    prefs = { ...prefs, [name]: as(name).checked };
    try { if (key()) localStorage.setItem(key(), JSON.stringify(prefs)); } catch { }
    setCloudAiPrefs(prefs); renderAi();
  });
  as('form').addEventListener('submit', event => event.preventDefault());
  as('close').addEventListener('click', () => dialog.close());
  async function openAi() {
    select(get('settings-ai-tab'), ai); renderAi();
    const current = ++epoch;
    if (!account) { try { account = (await read('/api/me')).user; } catch { } loadPrefs(); renderAi(); }
    loadHub(current);
  }

  function open() { select(get('settings-user-tab'), user); if (!dialog.open) dialog.showModal(); loadUser(); }
  get('network-settings-open').addEventListener('click', open);
  get('network-settings-close').addEventListener('click', () => dialog.close());
  get('settings-user-tab').addEventListener('click', () => { select(get('settings-user-tab'), user); loadUser(); });
  get('settings-ai-tab').addEventListener('click', openAi);
  get('settings-appearance-tab').addEventListener('click', () => { user.hidden = true; ai.hidden = true; });
  dialog.addEventListener('close', () => { epoch++; });
  document.addEventListener('qfh-login-required', open);
  document.addEventListener('qfh-ai-settings-required', () => { if (!dialog.open) dialog.showModal(); openAi(); });
  // Grading preferences are needed before the settings dialog is ever opened.
  read('/api/me').then(value => { account = value.user; loadPrefs(); }).catch(() => {});
}
