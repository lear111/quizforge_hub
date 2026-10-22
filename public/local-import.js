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
  open.textContent = '下载并导入到本地'; open.setAttribute('aria-describedby', 'local-import-description');
  const option = document.createElement('div'); option.className = 'download-option';
  const description = document.createElement('p'); description.id = 'local-import-description'; description.className = 'download-note';
  description.textContent = '导入当前设备上的 QuizForge，支持电脑和安卓手机、平板。';
  const status = document.createElement('p'); status.className = 'download-note'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  open.addEventListener('click', () => {
    status.textContent = '已请求打开 QuizForge，请在系统提示中允许打开';
  });
  // Keep this a real user-activated link: no asynchronous preflight, installation
  // detection, timer retries or claims that the native import has succeeded.
  option.append(open, description, status); download.after(option);
  download.textContent = '下载题库文件'; download.classList.add('secondary');
  const installers = document.createElement('div'); installers.className = 'download-installers';
  const install = document.createElement('a'); install.href = 'https://github.com/lear111/quizforge_web/releases'; install.className = 'text-button'; install.target = '_blank'; install.rel = 'noopener noreferrer';
  install.textContent = 'Windows 版下载';
  // Android release URL and signing identity are not configured yet. Do not
  // guess an APK address or send Android users to the Windows download.
  const android = document.createElement('span'); android.className = 'download-note'; android.textContent = 'Android 安装包待发布';
  const fallback = document.createElement('p'); fallback.className = 'download-note'; fallback.textContent = '未安装客户端或浏览器未唤起时，可下载题库文件后手动导入。';
  installers.append(install, android, fallback);
  (document.querySelector('[data-action="download-cloud"]')?.closest('.download-option') || option).after(installers);
}
