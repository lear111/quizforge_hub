const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function localImportLink(pack, config) {
  if (!config?.enabled || config.protocolVersion !== 1 || config.scheme !== 'quizforge'
    || pack?.status !== 'approved' || !uuid.test(pack.id) || !Number.isSafeInteger(pack.revision) || pack.revision < 1
    || !/\.qbank$/i.test(pack.archive?.name ?? '')) return null;
  return `quizforge://hub/import?v=1&pack=${pack.id}&revision=${pack.revision}`;
}

export function enhanceLocalImport({ document, pack, config }) {
  const download = document.querySelector('[data-action="download"]');
  const href = localImportLink(pack, config);
  if (!download || !href || document.querySelector('[data-local-import]')) return;
  const open = document.createElement('a');
  open.className = 'button'; open.href = href; open.dataset.localImport = '';
  open.textContent = '下载到本地';
  const status = document.createElement('p'); status.className = 'download-note'; status.setAttribute('role', 'status');
  open.addEventListener('click', () => {
    status.textContent = '已请求打开 QuizForge，请在浏览器提示中允许打开。导入结果请查看本地 QuizForge。';
  });
  // Keep this a real user-activated link: no asynchronous preflight, installation
  // detection, timer retries or claims that the native import has succeeded.
  download.before(open);
  download.textContent = '下载 .qbank 文件'; download.classList.add('secondary');
  const install = document.createElement('a'); install.href = '/'; install.className = 'text-button';
  install.textContent = '安装／升级 QuizForge';
  download.after(install, status);
}
