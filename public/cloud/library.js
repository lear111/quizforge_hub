export function bindCloudLibrary(document) {
  const actions = document.querySelector('.sidebar-actions'); if (!actions || document.getElementById('cloud-library-dialog')) return;
  const dialog = document.createElement('dialog'); dialog.id = 'cloud-library-dialog'; dialog.className = 'library-manage-dialog'; dialog.setAttribute('aria-labelledby', 'cloud-library-title');
  dialog.innerHTML = '<div class="dialog-heading"><h2 id="cloud-library-title">我的云端题库</h2><button type="button" id="cloud-library-close" aria-label="关闭">×</button></div><div class="cloud-library-tabs"><button type="button" data-cloud-tab="list">切换题库</button><button type="button" data-cloud-tab="upload">从电脑导入</button></div><div id="cloud-library-content"></div>';
  document.body.append(dialog);
  const picker = document.createElement('button'); picker.type = 'button'; picker.className = 'icon-button'; picker.id = 'cloud-library-open'; picker.textContent = '切换'; picker.title = '切换我的云端题库';
  const upload = document.createElement('button'); upload.type = 'button'; upload.className = 'icon-button'; upload.id = 'cloud-library-import'; upload.textContent = '导入'; upload.title = '从电脑上传私人题库';
  actions.prepend(picker, upload);
  let busy = false, file = null, view = 0;
  const content = () => dialog.querySelector('#cloud-library-content');
  const message = value => { const node = dialog.querySelector('[role=status]'); if (node) node.textContent = value; };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  async function request(route, file) {
    const response = await fetch(route, { credentials: 'same-origin', ...(file ? { method: 'POST', headers: { 'Content-Type': 'application/vnd.quizforge.qbank', 'X-QuizForge-Filename': encodeURIComponent(file.name) }, body: file, signal: AbortSignal.timeout(180000) } : { cache: 'no-store' }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || '请求失败，请稍后重试'); return value;
  }
  async function show(tab) {
    if (busy) return; if (!dialog.open) dialog.showModal();
    const current = ++view;
    if (tab === 'upload') {
      content().innerHTML = '<form id="cloud-library-upload"><p>选择格式 3 的 .qbank，导入后仅你自己可见。系统将校验拓展哈希并检查空间额度。</p><label>私人题库文件<input type="file" name="package" accept=".qbank" required></label><div class="dialog-actions"><button type="submit">验证并导入</button><button type="button" id="cloud-extension-submit" hidden>提交包内拓展审核</button></div><p role="status" aria-live="polite"></p><p class="library-manage-hint">格式 1、2 请联系制作者升级。未知拓展先审核；题库内容不会因此公开。</p></form>'; return;
    }
    content().innerHTML = '<p role="status">正在读取题库列表…</p>';
    try {
      const { items } = await request('/api/cloud/library');
      if (current !== view) return;
      content().innerHTML = '<div class="cloud-bank-list">' + (items.length ? items.map(item => `<a href="/cloud/practice/${item.id}/"><strong>${esc(item.title)}</strong><span>${item.banks.length} 本 · ${(item.bytes / 1024 ** 2).toFixed(2)} MiB · ${item.source.kind === 'admin-delivery' ? '管理员私人交付' : item.source.kind === 'hub' ? '来自公共广场' : item.source.kind === 'builtin-demo' ? '基础示例' : '私人上传'}</span></a>`).join('') : '<p>还没有题库，请从电脑导入或前往题库广场添加。</p>') + '</div>';
    } catch (error) { if (current === view) message(error.message); }
  }
  picker.addEventListener('click', () => show('list')); upload.addEventListener('click', () => show('upload'));
  dialog.querySelector('#cloud-library-close').addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.cloudTab) await show(button.dataset.cloudTab);
    if (button.id === 'cloud-extension-submit' && file && !busy) {
      busy = true; button.disabled = true; message('正在提取拓展并提交审核，不运行待审代码…');
      try { const { item } = await request('/api/cloud/extensions/submissions', file); message(item.status === 'verified' ? '拓展哈希已匹配白名单，可以重新导入。' : '拓展审核已提交。请等待管理员处理后重新导入，私人题库未公开。'); }
      catch (error) { message(error.message); } finally { busy = false; button.disabled = false; }
    }
  });
  dialog.addEventListener('submit', async event => {
    if (event.target.id !== 'cloud-library-upload') return; event.preventDefault(); if (busy) return;
    file = event.target.elements.package.files[0]; if (!file || !/\.qbank$/i.test(file.name) || file.size > 64 * 1024 ** 2) { message('请选择不超过 64 MiB 的 .qbank 文件'); return; }
    busy = true; const submit = event.target.querySelector('[type=submit]'), review = dialog.querySelector('#cloud-extension-submit'); submit.disabled = true; review.hidden = true; message('正在上传并验证拓展、格式和空间额度…');
    try { const { item } = await request('/api/cloud/library/import', file); message('导入成功，正在打开…'); location.assign('/cloud/practice/' + item.id + '/'); }
    catch (error) { message(error.message); review.hidden = !error.message.includes('拓展'); }
    finally { busy = false; submit.disabled = false; }
  });
}
