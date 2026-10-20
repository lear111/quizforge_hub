const status = document.querySelector('#status'), retry = document.querySelector('#retry'), confirm = document.querySelector('#confirm'), existing = document.querySelector('#existing');
const params = new URLSearchParams(location.search), packId = params.get('pack'), revision = Number(params.get('revision'));
const valid = [...params.keys()].length === 2 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(packId || '') && /^[1-9]\d{0,14}$/.test(params.get('revision') || '');
async function install() {
  confirm.hidden = true; retry.hidden = true; status.textContent = '正在下载、检查拓展并导入到你的云端空间，请稍候…';
  try {
    const response = await fetch('/api/cloud/library/from-hub', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId, revision }) });
    const result = await response.json();
    if (response.status === 401) { location.replace('/auth/hub?return=' + encodeURIComponent(location.pathname + location.search)); return; }
    if (!response.ok) throw new Error(result.error || '下载失败，请稍后重试');
    status.textContent = result.alreadyInstalled ? '此版本已在你的云端空间，正在打开…' : '已下载到云端，正在打开练习…';
    location.replace('/cloud/practice/' + result.item.id + '/');
  } catch (error) { status.textContent = error.message; retry.hidden = false; }
}
async function start() {
  if (!valid) { status.textContent = '题库链接无效，请返回广场重新选择。'; return; }
  try {
    const response = await fetch('/api/cloud/library', { credentials: 'same-origin' });
    if (response.status === 401) { location.replace('/auth/hub?return=' + encodeURIComponent(location.pathname + location.search)); return; }
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '暂时无法读取云端空间');
    const item = result.items.find(item => item.source.kind === 'hub' && item.source.packId === packId && item.source.revision === revision);
    if (item) { status.textContent = '此版本已经在你的云端空间，不会重复占用空间。'; existing.href = '/cloud/practice/' + item.id + '/'; existing.hidden = false; return; }
    status.textContent = '将把这份公共题库保存到你的云端空间，完成后直接开始练习。'; confirm.hidden = false;
  } catch (error) { status.textContent = error.message; retry.hidden = false; }
}
confirm.addEventListener('click', install); retry.addEventListener('click', install); await start();
