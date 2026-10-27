const bindings = new WeakMap();

export function bindAdminContact({ document, endpoint = '/api/admin-contact', fetcher = fetch }) {
  const previous = bindings.get(document);
  if (previous) { previous.bindTriggers(); return previous; }
  const dialog = document.getElementById('qfh-contact-dialog') || document.createElement('dialog');
  dialog.id = 'qfh-contact-dialog'; dialog.className = 'qfh-contact-dialog'; dialog.setAttribute('aria-labelledby', 'qfh-contact-title');
  dialog.innerHTML = '<div class="qfh-contact-header"><h2 id="qfh-contact-title">联系管理员</h2><button type="button" class="qfh-contact-close" aria-label="关闭联系管理员">×</button></div><p class="qfh-contact-content" role="status" aria-live="polite"></p><div class="qfh-contact-actions"><button type="button" class="qfh-contact-retry" hidden>重新读取</button><button type="button" class="qfh-contact-done">关闭</button></div>';
  if (!dialog.isConnected) document.body.append(dialog);
  const content = dialog.querySelector('.qfh-contact-content'), retry = dialog.querySelector('.qfh-contact-retry');
  let request = 0, controller;
  async function load() {
    controller?.abort(); controller = new AbortController();
    const current = ++request, active = controller, timer = setTimeout(() => active.abort(), 10000);
    content.textContent = '正在读取联系方式…'; content.classList.remove('error'); retry.hidden = true;
    try {
      const response = await fetcher(endpoint, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: active.signal });
      if (!response.ok) throw new Error();
      const value = await response.json();
      if (typeof value.content !== 'string' || value.content.length > 4000) throw new Error();
      if (current !== request || !dialog.open) return;
      // Administrator text is displayed literally, never interpreted as HTML.
      content.textContent = value.content || '管理员尚未填写联系方式。';
    } catch {
      if (current !== request || !dialog.open) return;
      content.textContent = '暂时无法读取联系方式，请重试。'; content.classList.add('error'); retry.hidden = false;
    } finally { clearTimeout(timer); }
  }
  dialog.querySelector('.qfh-contact-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('.qfh-contact-done').addEventListener('click', () => dialog.close());
  retry.addEventListener('click', load);
  dialog.addEventListener('close', () => { request++; controller?.abort(); content.textContent = ''; retry.hidden = true; });
  function open() {
    if (!dialog.open) dialog.showModal();
    load();
  }
  const triggers = new WeakSet();
  function bindTriggers() {
    for (const trigger of document.querySelectorAll('[data-admin-contact]')) {
      if (triggers.has(trigger)) continue;
      triggers.add(trigger);
      trigger.addEventListener('click', event => { event.preventDefault(); open(); });
    }
  }
  const binding = { open, bindTriggers }; bindings.set(document, binding); bindTriggers(); return binding;
}
