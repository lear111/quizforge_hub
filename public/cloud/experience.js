import { bindCloudAi } from './ai-client.js';
import { bindActivity } from './activity.js';
import { bindCloudLibrary } from './library.js';
const size = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
export async function downloadCloudSelection(route, selection) {
  const response = await fetch(route, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection), signal: AbortSignal.timeout(135000) });
  if (!response.ok) { const value = await response.json(); throw new Error(value.error || '题库导出失败，请稍后重试'); }
  return response.blob();
}
export function bindCloudExperience({ document, beforeLogout }) {
  bindActivity({ document, practice: true, endpoint: '/api/cloud/activity' });
  bindCloudLibrary(document);
  const get = id => document.getElementById(id), dialog = get('network-settings-dialog');
  const user = get('user-settings-panel'), ai = get('ai-settings-panel'), appearance = get('appearance-settings-panel');
  const tabs = [...document.querySelectorAll('.settings-tabs [role="tab"]')];
  bindCloudAi(ai.querySelector('iframe'));
  let epoch = 0;
  function select(tab, panel) {
    for (const node of [user, ai, appearance]) node.hidden = node !== panel;
    for (const node of tabs) node.setAttribute('aria-selected', String(node === tab));
  }
  async function load() {
    const current = ++epoch;
    get('cloud-user-status').textContent = '正在读取账户信息…'; get('cloud-user-details').hidden = true; get('cloud-user-login').hidden = true;
    try {
      const [identity, resources] = await Promise.all(['/api/me', '/api/cloud/me'].map(async path => {
        const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error(response.status === 401 ? '登录已失效，请重新登录。' : '暂时无法读取账户信息，请重新打开设置重试。');
        return response.json();
      }));
      if (current !== epoch) return;
      if (!identity.user) throw new Error('登录已失效，请重新登录。');
      get('cloud-user-name').textContent = identity.user.name; get('cloud-user-email').textContent = identity.user.email;
      for (const [id, field] of [['storage', 'storageBytes'], ['download', 'dailyTrafficBytes']]) {
        const used = resources.usage[field], limit = resources.limits[field], progress = get(`cloud-${id}-progress`);
        get(`cloud-${id}-value`).textContent = `${size(used)} / ${size(limit)}`;
        progress.max = Math.max(1, limit); progress.value = Math.min(used, limit); progress.setAttribute('aria-label', id === 'storage' ? '存储空间用量' : '今日下载用量');
      }
      get('cloud-user-status').textContent = ''; get('cloud-user-details').hidden = false;
    } catch (error) { if (current === epoch) { get('cloud-user-status').textContent = error.message; get('cloud-user-login').hidden = false; } }
  }
  function open() { select(get('settings-user-tab'), user); if (!dialog.open) dialog.showModal(); load(); }
  get('network-settings-open').addEventListener('click', open);
  get('network-settings-close').addEventListener('click', () => dialog.close());
  get('settings-user-tab').addEventListener('click', () => { select(get('settings-user-tab'), user); load(); });
  get('settings-ai-tab').addEventListener('click', () => {
    select(get('settings-ai-tab'), ai); const frame = ai.querySelector('iframe'); if (!frame.hasAttribute('src')) frame.src = frame.dataset.src;
  });
  get('settings-appearance-tab').addEventListener('click', () => { user.hidden = true; ai.hidden = true; });
  dialog.addEventListener('close', () => { epoch++; });
  document.addEventListener('qfh-login-required', open);
  document.addEventListener('qfh-ai-settings-required', () => { if (!dialog.open) dialog.showModal(); get('settings-ai-tab').click(); });
  get('cloud-user-logout').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      await beforeLogout();
      const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('暂时未能退出，请稍后重试。');
      if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel('qfh-account'); channel.postMessage('logout'); channel.close(); }
      ai.querySelector('iframe').src = 'about:blank'; location.assign('/');
    } catch (error) { get('cloud-user-status').textContent = error.message; button.disabled = false; }
  });
}
