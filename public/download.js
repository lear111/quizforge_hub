// Download page: one card per platform, filled from /api/downloads (downloads.mjs).
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const size = bytes => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const platforms = [
  { id: 'android', name: 'Android', requirement: 'Android 10 及以上', button: '下载 APK', install: '安装：允许浏览器“安装未知应用”，再打开下载的文件。', pending: '正式签名版本准备中，敬请期待。' },
  { id: 'windows', name: 'Windows', requirement: 'Windows 10/11 64 位', button: '下载安装程序', install: '安装：若出现“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”。', pending: '安装程序准备中，敬请期待。' },
];
const list = document.getElementById('downloads');
function card(platform, item) {
  if (!item) return `<section class="panel download-card"><h2>${platform.name}</h2><p class="subtle">${platform.requirement}</p><p class="download-pending">${platform.pending}</p></section>`;
  return `<section class="panel download-card"><h2>${platform.name}</h2>
    <p class="download-version">${esc(item.version)}${item.label ? ' ' + esc(item.label) : ''} · ${size(item.bytes)}</p><p class="subtle">${platform.requirement}</p>
    <a class="button" href="/download/files/${encodeURIComponent(item.file)}" download>${platform.button}</a>
    <p class="download-note">${platform.install}</p>
    <p class="download-hash"><span>SHA-256</span> <code title="${esc(item.sha256)}">${esc(item.sha256.slice(0, 4))}…${esc(item.sha256.slice(-4))}</code> <button class="text-button" type="button" data-copy="${esc(item.sha256)}">复制</button></p>
    <p class="subtle">更新于 ${esc(item.updated.slice(0, 10))}</p></section>`;
}
try {
  const response = await fetch('/api/downloads', { cache: 'no-store' });
  if (!response.ok) throw new Error();
  const { items } = await response.json();
  list.innerHTML = platforms.map(platform => card(platform, items.find(item => item.platform === platform.id))).join('');
} catch { list.innerHTML = '<p class="subtle">暂时无法读取安装包，请稍后刷新重试。</p>'; }
list.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]'); if (!button) return;
  try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = '已复制'; } catch { button.textContent = '复制失败'; }
  setTimeout(() => { button.textContent = '复制'; }, 1500);
});
