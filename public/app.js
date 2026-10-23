import { enhanceLocalImport } from './local-import.js';
import { bindActivity } from './activity.js';
let localImport = null;
const $ = selector => document.querySelector(selector);
let cloudEnabled = false, practiceOrigin = '', invitationRequired = false, adminEnabled = false, officialAiEnabled = false;
const app = $('#app');
const icons = { plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>', grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1v15"/>', award: '<circle cx="12" cy="9" r="6"/><path d="m8 14-2 7 6-3 6 3-2-7"/>', code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>', globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>', folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>', download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>', chat: '<path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4z"/>', upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>', image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m21 16-5-5-8 10"/>', check: '<path d="m5 12 4 4L19 6"/>', arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3zM14 5l5 5"/>' };
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.book}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const size = value => value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
const date = value => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
const avatar = name => `<span class="avatar">${esc(Array.from(name || '?')[0])}</span>`;
const tagList = tags => `<div class="tags">${tags.map(v => `<span class="tag">${esc(v)}</span>`).join('')}</div>`;
let user = null, maxArchiveMB = 20, turn = 0, toastTimer, authTarget = null;
function practiceAuthorization(target) {
  const request = /^#practice-login\/([a-f0-9]{64})$/.exec(target || '')?.[1];
  if (request) return '/practice-auth/authorize?request=' + request;
  // Connecting a local QuizForge app returns to its consent page after login.
  const connect = /^#connect-login\/([a-f0-9]{64})$/.exec(target || '')?.[1];
  return connect ? '/connect/authorize?request=' + connect : null;
}
const connectLogin = target => /^#connect-login\//.test(target || '');
let filters = { q: '', sort: 'latest', page: 1 };
let reviewFilter = 'pending';
let currentPack = null, upload = null, previewUrls = [];
let registrationReady = false, registrationMethods = { email: false, phone: false }, captchaSiteKey = '', captchaWidget = null, captchaToken = '', captchaLoader, codeTimer, captchaEpoch = 0, captchaAction = '';
const codeCooldowns = new Map();
const contactChannel = value => !value.trim() && isBinding() ? (user?.email ? 'phone' : 'email')
  : /^[+\d]/.test(value.trim()) && !value.includes('@') ? 'phone' : 'email';
const contactReady = () => !!registrationMethods[contactChannel($('#auth-email')?.value || '')];
const isBinding = () => $('#auth-form')?.dataset.mode === 'bind';
function clearCaptcha() {
  captchaEpoch++;
  if (captchaWidget !== null && window.turnstile) window.turnstile.remove(captchaWidget);
  captchaWidget = null; captchaToken = ''; captchaAction = ''; clearInterval(codeTimer);
}
function loadCaptcha() {
  if (window.turnstile) return Promise.resolve();
  if (!captchaLoader) captchaLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload = resolve; script.onerror = () => { script.remove(); captchaLoader = null; reject(new Error('人机验证加载失败，请稍后重试')); };
    document.head.append(script);
  });
  return captchaLoader;
}
function updateCodeButton() {
  const button = $('#send-email-code'); if (!button) return;
  const email = $('#auth-email').value.trim().toLowerCase();
  const remaining = Math.max(0, Math.ceil(((codeCooldowns.get(email) || 0) - Date.now()) / 1000));
  button.textContent = remaining ? `${remaining} 秒后重发` : '获取验证码';
  button.disabled = !contactReady() || !captchaToken || (!isBinding() && invitationRequired && !$('#auth-invitation')?.value.trim()) || remaining > 0 || button.dataset.sending === '1';
}
async function mountCaptcha() {
  const container = $('#register-captcha'); if (!container || !registrationReady) return;
  const epoch = ++captchaEpoch;
  try {
    await loadCaptcha();
    if (epoch !== captchaEpoch || !container.isConnected || !$('#auth-dialog').open) return;
    captchaAction = isBinding() ? 'bind_contact' : 'register_' + contactChannel($('#auth-email').value);
    captchaWidget = window.turnstile.render(container, { sitekey: captchaSiteKey, action: captchaAction, size: container.clientWidth < 300 ? 'compact' : 'flexible',
      callback: token => { captchaToken = token; updateCodeButton(); },
      'expired-callback': () => { captchaToken = ''; updateCodeButton(); },
      'error-callback': () => { captchaToken = ''; updateCodeButton(); $('#auth-form .form-error').textContent = '人机验证未完成，请重试'; },
    });
    codeTimer = setInterval(updateCodeButton, 1000); updateCodeButton();
  } catch (error) { if (container.isConnected) $('#auth-form .form-error').textContent = error.message; }
}
async function sendEmailCode() {
  const input = $('#auth-email'), button = $('#send-email-code'), form = $('#auth-form');
  if (!input.reportValidity() || (isBinding() && !$('#auth-password').reportValidity()) || !captchaToken || button.disabled) return;
  const email = input.value.trim().toLowerCase();
  const widget = captchaWidget;
  button.dataset.sending = '1'; updateCodeButton(); form.querySelector('.form-error').textContent = '';
  try {
    const phone = contactChannel(email) === 'phone';
    const result = await api(isBinding() ? '/api/account/contact-code' : '/api/auth/' + (phone ? 'phone-code' : 'email-code'), jsonOptions(isBinding()
      ? { identifier: email, password: $('#auth-password').value, captchaToken }
      : { [phone ? 'phone' : 'email']: email, captchaToken, invitationCode: $('#auth-invitation')?.value.trim() }));
    codeCooldowns.set(email, Date.now() + result.retryAfter * 1000); toast(result.message);
  } catch (error) { if (form.isConnected) form.querySelector('.form-error').textContent = error.message; await refreshInvitationPolicy(form).catch(() => {}); }
  finally {
    button.dataset.sending = '0';
    if (widget === captchaWidget) { captchaToken = ''; if (widget !== null) window.turnstile.reset(widget); }
    updateCodeButton();
  }
}
function updateContactFields() {
  const form = $('#auth-form'); if (!form || form.dataset.mode === 'login') return;
  const phone = contactChannel($('#auth-email').value) === 'phone';
  document.querySelector('label[for="auth-code"]').textContent = phone ? '短信验证码' : '邮箱验证码';
  const status = $('#auth-method-status');
  status.textContent = contactReady() ? (isBinding() ? '验证后绑定到当前账号，原有题库和 AI 余额不变。' : '邮箱和手机号验证其中一个即可。') : (phone ? '手机验证暂未开放，请使用邮箱。' : '邮箱验证暂未开放，请稍后再试。');
  form.querySelector('button[type="submit"]').disabled = !contactReady();
  const action = isBinding() ? 'bind_contact' : 'register_' + (phone ? 'phone' : 'email');
  if (captchaAction && captchaAction !== action) { clearCaptcha(); mountCaptcha(); }
  updateCodeButton();
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || result.error || '请求失败，请稍后重试');
  return result;
}
const jsonOptions = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 4500); }
function account() {
  bindActivity({ document, account: user?.id || null });
  $('#account').innerHTML = `${user ? `<div class="user-chip"><a href="#mine" class="avatar" title="我的分享">${esc(Array.from(user.name)[0])}</a><a href="#mine" class="name">${esc(user.name)}</a><button class="text-button" data-action="logout">退出</button></div>${user.admin ? `<a class="text-button" href="${adminEnabled ? '/admin/' : '#reviews'}">管理后台</a>` : ''}` : '<button class="text-button" data-action="login">登录 / 注册</button>'}<a href="#upload" class="button">${icon('plus')}<span>分享题库</span></a>`;
  if (cloudEnabled && !practiceOrigin) {
    document.title = 'QuizForge Hub · 题库广场'; const subtitle = document.querySelector('.brand small'); if (subtitle) subtitle.textContent = 'Hub';
    const link = document.createElement('a'); link.className = 'text-button'; link.href = '/cloud/'; link.textContent = '云端空间'; $('#account').prepend(link);
  }
  if (practiceOrigin) {
    const link = document.createElement('a'); link.className = 'button secondary practice-entry'; link.href = practiceOrigin + '/'; link.textContent = '进入练习'; $('#account').prepend(link);
  }
}
function cloudDownloadButton() {
  if (!cloudEnabled && !practiceOrigin) return;
  const download = document.querySelector('[data-action="download"]');
  if (!download || currentPack?.status !== 'approved' || !/\.qbank$/i.test(currentPack.archive?.name ?? '') || document.querySelector('[data-action="download-cloud"]')) return;
  const option = document.createElement('div'); option.className = 'download-option';
  const description = document.createElement('p'); description.id = 'cloud-import-description'; description.className = 'download-note'; description.textContent = '导入账号的云端题库，需登录。';
  const link = document.createElement(practiceOrigin ? 'a' : 'button'); link.className = 'button secondary'; link.dataset.action = 'download-cloud'; link.textContent = '下载并导入到云端'; link.setAttribute('aria-describedby', description.id);
  if (practiceOrigin) {
    link.href = `${practiceOrigin}/cloud/import?pack=${encodeURIComponent(currentPack.id)}&revision=${currentPack.revision}`;
  } else link.type = 'button';
  option.append(link, description);
  if (!practiceOrigin) { const status = document.createElement('p'); status.className = 'download-note cloud-download-status'; status.setAttribute('role', 'status'); option.append(status); }
  (document.querySelector('[data-local-import]')?.closest('.download-option') || download).after(option);
}
function empty(title, description, action = '<a class="button small" href="#upload">分享第一个题库 ' + icon('arrow') + '</a>') { return `<div class="empty"><div class="empty-symbol">${icon('book')}</div><h3>${title}</h3><p>${description}</p>${action}</div>`; }
const statusNames = { pending: '待审核', approved: '已通过', rejected: '已驳回' };
const statusBadge = pack => `<span class="review-status ${esc(pack.status)}">${statusNames[pack.status] || '待审核'}</span>`;
function card(pack) {
  return `<a class="pack-card" href="#pack/${pack.id}">${pack.screenshots[0] ? `<div class="card-cover"><img src="/media/${pack.screenshots[0].id}" alt="${esc(pack.title)}截图" loading="lazy"></div>` : ''}<div class="card-content">${statusBadge(pack)}<h3>${esc(pack.title)}</h3><p class="card-description">${esc(pack.summary)}</p>${tagList(pack.tags)}<div class="card-author">${avatar(pack.author)}<span class="author-name">${esc(pack.author)}</span><time datetime="${pack.updated}">${date(pack.updated)} 更新</time></div><div class="card-meta"><span>${icon('download')}${pack.downloads} 次下载请求</span><span>${icon('chat')}${pack.commentCount} 条评论</span><span class="size">${size(pack.archive.size)}</span></div></div></a>`;
}
async function library(mine, stamp) {
  const params = new URLSearchParams({ q: filters.q, sort: filters.sort, page: filters.page, ...(mine ? { mine: '1' } : {}) });
  const result = await api('/api/packs?' + params);
  if (stamp !== turn) return;
  app.innerHTML = `<div class="listing-header"><h1>${mine ? '我的分享' : '题库分享'}</h1><p>${mine ? '查看审核状态、修改题库并重新提交。' : '浏览题库介绍与截图，下载压缩包，和作者交流。'}</p></div>
  <section class="library-single"><div class="library-top"><form class="search" id="search-form">${icon('search')}<input name="q" value="${esc(filters.q)}" placeholder="搜索题库名称、简介或标签" aria-label="搜索题库"><button class="search-submit" type="submit">搜索</button></form><span class="listing-count">${filters.q ? '找到' : '共'} ${result.count} 份题库</span><select class="sort" id="sort" aria-label="题库排序"><option value="latest" ${filters.sort === 'latest' ? 'selected' : ''}>最近更新</option><option value="popular" ${filters.sort === 'popular' ? 'selected' : ''}>最多下载</option></select></div>${filters.q ? `<div class="search-result-note">搜索“${esc(filters.q)}”<button class="text-button" data-action="reset-search">清除搜索 ×</button></div>` : ''}<div class="cards">${result.packs.length ? result.packs.map(card).join('') : filters.q ? empty('没有找到匹配的题库', '换个关键词试试。', '<button class="button small secondary" data-action="reset-search">清除搜索</button>') : empty(mine ? '你还没有上传题库' : '还没有题库', '上传压缩包，填写简介，也可以添加截图。', '<a class="button small" href="#upload">' + icon('plus') + '上传题库</a>')}</div>${result.count > 12 ? `<div class="pagination"><button class="button small secondary" data-page="${result.page - 1}" ${result.page === 1 ? 'disabled' : ''}>上一页</button><span>${result.page} / ${Math.ceil(result.count / 12)}</span><button class="button small secondary" data-page="${result.page + 1}" ${result.page * 12 >= result.count ? 'disabled' : ''}>下一页</button></div>` : ''}</section>`;
}
// Local QuizForge apps connected for official AI grading (docs/HUB_CONNECT_AI.md 5).
async function devices(stamp) {
  const result = await api('/api/connect/devices');
  if (stamp !== turn) return;
  const client = value => value === 'web' ? '电脑' : 'Android';
  const rows = result.devices.map(d => `<li class="device-row"><div><strong>${esc(d.name)}</strong><span>${client(d.client)} · 连接于 ${date(d.created)}${d.lastUsed ? ' · 最近使用 ' + date(d.lastUsed) : ''}</span></div><button class="text-button" data-revoke-device="${esc(d.id)}">撤销</button></li>`).join('');
  app.insertAdjacentHTML('beforeend', `<section class="panel devices-panel" aria-labelledby="devices-title"><h2 id="devices-title">已连接设备</h2><p>这些 QuizForge 设备已用你的账号登录。撤销后，该设备需要重新登录。</p>${rows ? `<ul class="device-list">${rows}</ul>` : '<p class="devices-empty">还没有连接的设备。</p>'}</section>`);
}
async function detail(id, stamp) {
  const result = await api('/api/packs/' + id);
  if (stamp !== turn) return;
  const p = result.pack; currentPack = p;
  document.title = `${p.title} · QuizForge 题库广场`;
  app.innerHTML = `<div class="breadcrumb"><a href="#library">题库广场</a><span>/</span><span>题库详情</span></div><div class="detail-layout"><article class="detail-main">${tagList(p.tags)}${statusBadge(p)}<h1>${esc(p.title)}</h1><div class="detail-meta">${avatar(p.author)}<span>${esc(p.author)}</span><span>·</span><span>${new Date(p.updated).toLocaleDateString('zh-CN')} 更新</span><span>·</span><span>版本 ${esc(p.version)}</span></div><p class="detail-summary">${esc(p.summary)}</p>${p.status !== 'approved' ? `<section class="review-notice"><strong>${p.status === 'rejected' ? '审核未通过' : '等待管理员审核'}</strong><p>${p.status === 'rejected' ? esc(p.review_note) : '仅作者和管理员可查看此页与附件，通过审核后才会公开。'}</p>${user?.id === p.user_id ? '<p>修改后保存即可重新提交审核。</p>' : ''}</section>` : ''}${user?.admin && p.status === 'pending' ? `<section class="panel review-panel"><h2>审核这份题库</h2><p class="subtle">检查介绍、截图和压缩包后，决定是否允许公开下载。人工审核不等同于病毒扫描。</p><div class="review-actions"><button class="button" data-action="approve-pack">通过审核</button><button class="button secondary" data-action="reject-pack">驳回并说明原因</button></div></section>` : ''}<section class="panel"><h2>题库介绍</h2><div class="prose">${esc(p.description)}</div></section><section class="panel"><h2>题库截图 <span class="count">${p.screenshots.length} 张</span></h2>${p.screenshots.length ? `<div class="gallery">${p.screenshots.map((f, i) => `<button data-image="/media/${f.id}" aria-label="查看第 ${i + 1} 张截图"><img src="/media/${f.id}" alt="${esc(p.title)}，截图 ${i + 1}" loading="lazy"></button>`).join('')}</div><p class="subtle">点击图片查看大图</p>` : '<p class="subtle">作者尚未添加截图。</p>'}</section><section class="panel"><h2>交流与反馈 <span class="count">${p.commentCount} 条</span></h2>${p.status !== 'approved' ? '<p class="subtle">通过审核后开放评论。</p>' : user ? `<form id="comment-form" class="comment-form"><label for="comment-body" class="subtle">分享使用体验，或向作者提问</label><textarea id="comment-body" name="body" maxlength="2000" required placeholder="你觉得这份题库怎么样？"></textarea><div class="form-bottom"><span>友善交流，请勿发布广告或个人敏感信息</span><button class="button small" type="submit">发表评论</button></div><p class="form-error" role="alert"></p></form>` : '<p class="subtle">登录后可以发表评论，与作者交流。 <button class="text-button" data-action="login">去登录 →</button></p>'}<div>${result.comments.length ? result.comments.map(c => `<div class="comment"><div class="comment-head">${avatar(c.author)}<strong>${esc(c.author)}</strong><time>${new Date(c.created).toLocaleString('zh-CN')}</time>${user && (user.id === c.user_id || user.admin) ? `<button class="text-button danger" data-delete-comment="${c.id}">删除</button>` : ''}</div><p class="comment-body">${esc(c.body)}</p></div>`).join('') : '<p class="subtle">还没有评论，欢迎留下第一条反馈。</p>'}</div>${p.commentCount > 100 ? '<p class="subtle">显示最近 100 条评论。</p>' : ''}</section></article><aside class="detail-side"><section class="panel download-panel"><div class="file-icon">${icon('folder')}</div><h2>下载这份题库</h2><p class="file-name">${esc(p.archive.name)}</p><div class="file-facts"><div><span>文件大小</span><strong>${size(p.archive.size)}</strong></div><div><span>版本</span><strong>${esc(p.version)}</strong></div><div><span>下载请求</span><strong>${p.downloads}</strong></div></div><button class="button" data-action="download">${icon('download')}${p.status === 'approved' ? '下载题库文件' : '下载文件供审核 / 自查'}</button><p class="download-note">文件由作者上传，未经病毒扫描。请自行检查内容后，再在 QuizForge 中导入或使用。</p><details class="checksum"><summary>文件校验值 · SHA-256</summary><code>${p.archive.sha256}</code></details><div class="author-actions">${user?.id === p.user_id ? `<a href="#edit/${p.id}" class="button small secondary">${icon('edit')}编辑题库</a>` : ''}${user && (user.id === p.user_id || user.admin) ? '<button class="text-button danger" data-action="delete-pack">下架题库</button>' : ''}<button class="text-button" data-action="report">举报内容</button></div></section></aside></div>`;
}
function uploadForm(pack) {
  upload = { pack, keep: pack?.screenshots.map(f => f.id) || [], pictures: [] };
  app.innerHTML = `<div class="breadcrumb"><a href="#library">题库广场</a><span>/</span><span>${pack ? '编辑题库' : '分享题库'}</span></div><h1 class="page-title">${pack ? '编辑题库' : '上传题库'}</h1><p class="page-subtitle">${pack ? '保存任何修改后会重新进入审核，通过前不会公开。' : '选择压缩包，填写简介，可添加截图。提交后等待管理员审核。'}</p><div class="form-layout"><form id="upload-form" class="upload-form"><section class="form-section"><div class="section-title"><span class="section-number">01</span>基本信息</div><div class="field"><label for="title">题库名称</label><input id="title" name="title" maxlength="80" required value="${esc(pack?.title || '')}" placeholder="例如：考研英语长难句练习 · 基础篇"></div><div class="field-row"><div class="field"><label for="version">版本号</label><input id="version" name="version" maxlength="30" value="${esc(pack?.version || '1.0')}" required></div></div><div class="field"><label for="summary">一句话简介 <small>最多 240 字</small></label><input id="summary" name="summary" required maxlength="240" value="${esc(pack?.summary || '')}" placeholder="简要说明内容范围、适用人群和特色"></div><div class="field"><label for="tags">标签 <small>用逗号分隔，最多 5 个</small></label><input id="tags" name="tags" maxlength="100" value="${esc(pack?.tags.join(', ') || '')}" placeholder="英语, 长难句, 基础练习"></div><div class="field"><label for="description">详细介绍</label><textarea id="description" name="description" required maxlength="12000" placeholder="介绍题库内容、资料来源、适合的学习阶段，以及导入和使用方式。">${esc(pack?.description || '')}</textarea><p class="field-help">支持分段纯文本。说明来源和适用版本，能帮助大家判断是否适合自己。</p></div></section><section class="form-section"><div class="section-title"><span class="section-number">02</span>题库文件</div><label class="upload-zone">${icon('upload')}<strong>${pack ? '选择新版压缩包（可选）' : '点击选择题库压缩包'}</strong><span>ZIP / 7Z / RAR / QBank · 最大 ${maxArchiveMB} MB</span><input id="archive-input" type="file" name="archive" accept=".zip,.7z,.rar,.qbank" ${pack ? '' : 'required'} aria-label="选择题库压缩包"></label><p id="archive-selection" class="file-selection">${pack ? `当前文件：${esc(pack.archive.name)}（不选择则保留）` : ''}</p></section><section class="form-section"><div class="section-title"><span class="section-number">03</span>截图展示 <span class="count">选填</span></div><label class="upload-zone">${icon('image')}<strong>添加题库截图</strong><span>PNG / JPEG / WebP · 每张最大 3 MB · 最多 6 张</span><input id="screenshots-input" type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="添加题库截图"></label><div class="preview-grid" id="preview-grid"></div><p class="field-help">展示真实题目和使用界面，上传前请遮盖姓名、手机号等个人信息。</p></section><label class="rights"><input type="checkbox" name="rights" value="yes" required><span>我确认有权分享题库和截图，内容不包含未经授权的付费资料或个人敏感信息，并同意<a href="#" data-action="guidelines">分享须知</a>。</span></label><p class="form-error" role="alert"></p><div class="form-bottom"><span>通过审核后才会出现在题库广场</span><a class="button secondary" href="${pack ? '#pack/' + pack.id : '#library'}">取消</a><button type="submit" class="button">${icon('upload')}${pack ? '保存并重新送审' : '提交审核'}</button></div></form></div>`;
  previews();
}
function previews() {
  previewUrls.forEach(URL.revokeObjectURL); previewUrls = [];
  const existing = (upload.pack?.screenshots || []).filter(f => upload.keep.includes(f.id));
  $('#preview-grid').innerHTML = existing.map(f => `<div class="preview-item"><img src="/media/${f.id}" alt="已有截图"><button type="button" data-remove-existing="${f.id}" aria-label="移除已有截图">×</button></div>`).join('') + upload.pictures.map((f, i) => { const url = URL.createObjectURL(f); previewUrls.push(url); return `<div class="preview-item"><img src="${url}" alt="${esc(f.name)}"><button type="button" data-remove-picture="${i}" aria-label="移除截图">×</button></div>`; }).join('');
}
async function reviews(stamp) {
  const result = await api('/api/reviews?' + new URLSearchParams({ status: reviewFilter, page: filters.page })); if (stamp !== turn) return;
  app.innerHTML = `<div class="breadcrumb"><a href="#library">题库广场</a><span>/</span><span>审核管理</span></div><h1 class="page-title">题库审核</h1><p class="page-subtitle">打开题库检查内容和附件，再通过或驳回。修改后的题库需要重新审核。</p><section class="review-settings"><span>提醒邮箱：${esc(result.reviewEmail || '尚未设置')}</span><span>${result.notification.ready ? '邮件提醒已启用 · 合并发送，最多每 15 分钟一次 / 每天 24 次' : '邮件提醒等待腾讯云模板配置'}</span>${result.notification.error ? '<span class="danger">'+esc(result.notification.error)+'</span>' : ''}<a class="text-button" href="#reports">查看举报与下载预算 →</a></section><div class="review-tabs">${Object.entries(statusNames).map(([value,label]) => `<button class="button small ${reviewFilter === value ? '' : 'secondary'}" data-review-filter="${value}">${label}</button>`).join('')}<button class="text-button" data-action="retry">刷新列表</button><span>共 ${result.count} 份</span></div><div class="cards">${result.packs.length ? result.packs.map(card).join('') : empty('暂无'+statusNames[reviewFilter]+'题库','提交的题库会出现在对应列表中。','')}</div>${result.count > 12 ? `<div class="pagination"><button class="button small secondary" data-page="${result.page-1}" ${result.page === 1 ? 'disabled' : ''}>上一页</button><span>${result.page} / ${Math.ceil(result.count/12)}</span><button class="button small secondary" data-page="${result.page+1}" ${result.page*12 >= result.count ? 'disabled' : ''}>下一页</button></div>` : ''}`;
}
async function reports(stamp) {
  const result = await api('/api/reports'); if (stamp !== turn) return;
  app.innerHTML = `<div class="breadcrumb"><a href="#library">题库广场</a><span>/</span><span>管理</span></div><h1 class="page-title">举报与下载预算</h1><p class="page-subtitle">本期 ${esc(result.traffic.period)}，附件预留用量 ${size(result.traffic.reservedBytes)} / ${size(result.traffic.budgetBytes)}。计数包含中断请求，不等同于阿里云实际流量。</p>${result.reports.length ? result.reports.map(r => `<article class="report-card"><h3><a href="#pack/${r.pack_id}">${esc(r.title)} ↗</a></h3><p>${esc(r.reason)}</p><div class="subtle">${esc(r.author)} · ${new Date(r.created).toLocaleString('zh-CN')}</div></article>`).join('') : empty('目前没有举报', '用户提交的题库举报会出现在这里。', '')}`;
}
async function refreshInvitationPolicy(form) {
  const config = await api('/api/config', { signal: AbortSignal.timeout(5000) });
  if (form !== $('#auth-form') || form.dataset.mode === 'login' || !$('#auth-dialog').open) return;
  registrationReady = config.registrationReady;
  registrationMethods = config.registrationMethods || { email: registrationReady, phone: false };
  captchaSiteKey = config.turnstileSiteKey;
  invitationRequired = config.invitationRequired === true;
  let input = $('#auth-invitation');
  if (form.dataset.mode === 'register' && invitationRequired && !input) {
    $('#auth-code').closest('.field').insertAdjacentHTML('beforebegin', '<div class="field"><label for="auth-invitation">邀请码</label><input id="auth-invitation" name="invitationCode" required maxlength="38" autocomplete="off" spellcheck="false" placeholder="请输入管理员提供的邀请码"><p class="field-help">当前采用邀请注册，每个邀请码仅供一个账号使用。</p></div>');
    input = $('#auth-invitation'); input.addEventListener('input', updateCodeButton);
  }
  if (input) { input.required = invitationRequired; input.disabled = !invitationRequired; input.closest('.field').hidden = !invitationRequired; }
  if (registrationReady && captchaWidget === null) mountCaptcha();
  updateContactFields();
}
function showAuth(mode = 'login', target = null) {
  clearCaptcha();
  authTarget = target;
  const binding = mode === 'bind', registering = mode === 'register', needsCode = registering || binding;
  const label = binding ? (user.email ? '待绑定手机号' : '待绑定邮箱') : (mode === 'login' || registrationMethods.phone ? '邮箱或手机号' : '邮箱');
  const title = binding ? '补充账号联系方式' : registering ? '欢迎加入题库广场' : '欢迎回来';
  $('#auth-content').innerHTML = '<h2 id="auth-title">'+title+'</h2><p class="dialog-intro">'+(binding ? '为当前账号增加另一种登录方式。' : '登录后，分享你的题库，与同路人交流。')+'</p>'
    +(binding ? '' : '<div class="auth-tabs"><button class="'+(mode==='login'?'active':'')+'" data-auth-mode="login">登录</button><button class="'+(registering?'active':'')+'" data-auth-mode="register">注册账号</button></div>')
    +'<form id="auth-form" data-mode="'+mode+'">'+(registering ? '<div class="field"><label for="auth-name">昵称</label><input id="auth-name" name="name" required maxlength="30" autocomplete="nickname" placeholder="大家会看到这个名字"></div>' : '')
    +'<div class="field"><label for="auth-email">'+label+'</label><input id="auth-email" name="identifier" type="text" required maxlength="180" autocomplete="'+(registering?'email':'username')+'" autocapitalize="none" spellcheck="false" placeholder="'+(binding?(user.email?'中国大陆手机号':'you@example.com'):'邮箱或中国大陆手机号')+'"></div>'
    +'<div class="field"><label for="auth-password">'+(binding?'当前账号密码':'密码')+'</label><input id="auth-password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="'+(registering?'new-password':'current-password')+'" placeholder="至少 10 个字符"></div>'
    +'<p class="form-error" role="alert"></p><button type="submit" class="button">'+(binding?'验证并绑定':registering?'注册并登录':'登录')+'</button><p class="auth-note">联系方式仅用于账号登录和验证，不会展示在题库和评论中。暂不支持自助密码找回。</p></form>';
  if (!$('#auth-dialog').open) $('#auth-dialog').showModal();
  if (practiceAuthorization(target)) $('#auth-content .dialog-intro').textContent = connectLogin(target) ? '登录或注册后，返回确认授权这台设备登录。' : '与题库广场共用同一个账号，登录或注册后自动返回云端练习。';
  if (needsCode) {
    const passwordField = $('#auth-password').closest('.field');
    if (registering && invitationRequired) {
      passwordField.insertAdjacentHTML('beforebegin', '<div class="field"><label for="auth-invitation">邀请码</label><input id="auth-invitation" name="invitationCode" required maxlength="38" autocomplete="off" spellcheck="false" placeholder="请输入管理员提供的邀请码"><p class="field-help">当前采用邀请注册，每个邀请码仅供一个账号使用。</p></div>');
      $('#auth-invitation').addEventListener('input', updateCodeButton);
    }
    passwordField.insertAdjacentHTML('afterend', '<div class="field"><label for="auth-code">验证码</label><div class="email-code-row"><input id="auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="6 位验证码"><button type="button" id="send-email-code" data-action="send-email-code" class="button secondary small" disabled>获取验证码</button></div></div><p id="auth-method-status" class="auth-note" role="status"></p><div id="register-captcha" class="register-captcha" aria-label="人机验证"></div>');
    $('#auth-email').addEventListener('input', updateContactFields);
    mountCaptcha(); updateContactFields();
    refreshInvitationPolicy($('#auth-form')).catch(() => {});
  }
}
function contactPanel() {
  if (!user) return;
  const section = document.createElement('section'); section.className = 'panel account-contacts';
  section.innerHTML = '<h2>账号联系方式</h2><p>邮箱：'+esc(user.email || '未绑定')+'</p><p>手机：'+esc(user.phone || '未绑定')+'</p>'+(!user.email || !user.phone ? '<button type="button" class="button secondary small" data-action="bind-contact">'+(user.email?'绑定手机号':'绑定邮箱')+'</button>' : '<p class="subtle">邮箱和手机号均可登录同一个账号。</p>');
  app.prepend(section);
}
function message(title, html) { $('#message-content').innerHTML = `<h2 id="message-title">${title}</h2>${html}`; $('#message-dialog').showModal(); }
function guidelines() { message('分享须知', '<div class="guidelines"><p><strong>分享有权公开的内容。</strong><br>请注明资料来源，不上传未经授权的付费题库、教材扫描件或个人敏感信息。</p><p><strong>提交后等待审核。</strong><br>题库通过人工审核后才能公开下载；修改介绍、截图或文件后需重新审核。人工审核不等同于病毒扫描。</p><p><strong>让文件可用，让介绍清楚。</strong><br>请检查压缩包与截图，说明适用版本和导入方式。管理员会对格式 3 的 .qbank 静态解包核对内容与拓展，待审拓展不会自动运行。</p><p><strong>保持友善交流。</strong><br>评论用于提问和反馈，请勿发布广告、攻击性内容或个人信息。</p><p><strong>发现问题及时举报。</strong><br>题库详情页可提交举报。管理员可以下架题库、删除不当评论。</p><p>此页面是试用版分享说明，正式公开运营前需补充完整的服务协议、隐私政策和联系渠道。</p></div>'); }
async function render() {
  const stamp = ++turn; const [view = 'library', id] = location.hash.slice(1).split('/');
  const authorization = practiceAuthorization(location.hash);
  if (authorization) {
    document.title = '登录 · QuizForge Hub';
    if (user) { location.replace(authorization); return; }
    app.innerHTML = connectLogin(location.hash) ? empty('登录后连接设备', '登录或注册后，返回确认授权这台设备登录。', '<button class="button" data-action="login">登录 / 注册</button>') : empty('登录后开始练习', '练习页与题库广场共用同一个账号，完成登录或注册后将自动返回练习页。', '<button class="button" data-action="login">登录 / 注册</button>');
    showAuth('login', location.hash); return;
  }
  if (view === 'admin') { if (user?.admin) { location.assign('/admin/'); return; } app.innerHTML = empty('管理员登录', '请使用管理员账号进入管理后台。', '<button class="button" data-action="login">登录</button>'); if (!user) showAuth('login', '#admin'); return; }
  document.title = 'QuizForge · 题库广场'; currentPack = null;
  previewUrls.forEach(URL.revokeObjectURL); previewUrls = [];
  document.querySelectorAll('[data-nav]').forEach(el => el.classList.toggle('active', el.dataset.nav === view));
  if (['upload', 'edit', 'mine', 'reports', 'reviews'].includes(view) && !user) {
    app.innerHTML = empty('登录后继续', '使用独立账号，管理自己的分享和评论。', '<button class="button" data-action="login">登录 / 注册</button>'); showAuth('login', location.hash); return;
  }
  app.innerHTML = '<div class="loading" role="status">正在加载…</div>';
  try {
    if (view === 'pack' && /^[a-f0-9-]{36}$/.test(id)) { await detail(id, stamp); enhanceLocalImport({ document, pack: currentPack, config: localImport }); }
    else if (view === 'edit' && /^[a-f0-9-]{36}$/.test(id)) { const result = await api('/api/packs/' + id); if (stamp !== turn) return; if (result.pack.user_id !== user.id) throw new Error('只能编辑自己发布的题库'); uploadForm(result.pack); }
    else if (view === 'upload') uploadForm(null);
    else if (view === 'reviews') await reviews(stamp);
    else if (view === 'reports') await reports(stamp);
    else { await library(view === 'mine', stamp); if (view === 'mine' && stamp === turn) { contactPanel(); if (officialAiEnabled) await devices(stamp); } }
  } catch (error) { if (stamp === turn) app.innerHTML = empty('暂时无法打开', esc(error.message), '<button class="button small" data-action="retry">重试</button><a href="#library" class="text-button">返回广场</a>'); }
}

document.addEventListener('click', async event => {
  const element = event.target.closest('button,a'); if (!element) return;
  try {
    if (element.dataset.reviewFilter) { reviewFilter = element.dataset.reviewFilter; filters.page = 1; await render(); return; }
    if (element.dataset.authMode) { showAuth(element.dataset.authMode, authTarget); return; }
    if (element.dataset.page) { filters.page = Number(element.dataset.page); await render(); app.scrollIntoView({ block: 'start' }); return; }
    if (element.dataset.image) { $('#large-image').src = element.dataset.image; $('#image-dialog').showModal(); return; }
    if (element.dataset.removeExisting) { upload.keep = upload.keep.filter(id => id !== element.dataset.removeExisting); previews(); return; }
    if (element.hasAttribute('data-remove-picture')) { upload.pictures.splice(Number(element.dataset.removePicture), 1); previews(); return; }
    if (element.dataset.deleteComment) { message('删除这条评论？', `<p class="dialog-intro">删除后无法恢复。</p><button class="button" data-confirm-comment="${element.dataset.deleteComment}">确认删除</button>`); return; }
    if (element.dataset.revokeDevice) { await api('/api/connect/devices/' + element.dataset.revokeDevice, { method: 'DELETE' }); toast('已撤销该设备'); await render(); return; }
    if (element.dataset.confirmComment) { await api('/api/comments/' + element.dataset.confirmComment, { method: 'DELETE' }); $('#message-dialog').close(); toast('评论已删除'); await render(); return; }
    const action = element.dataset.action;
    // Cross-origin cloud import is a real navigation link, including modified
    // clicks. Leave it to the browser before canceling in-page button actions.
    if (action === 'download-cloud' && practiceOrigin && element.matches('a[href]')) return;
    if (!action) return; event.preventDefault();
    if (action === 'close-dialog') { element.closest('dialog').close(); return; }
    if (action === 'login') { showAuth('login', location.hash); return; }
    if (action === 'bind-contact') { showAuth('bind', location.hash); return; }
    if (action === 'send-email-code') { await sendEmailCode(); return; }
    if (action === 'logout') { await api('/api/auth/logout', { method: 'POST' }); if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel('qfh-account'); channel.postMessage('logout'); channel.close(); } user = null; account(); toast('已退出登录'); if (location.hash === '#library') await render(); else location.hash = '#library'; return; }
    if (action === 'guidelines') { guidelines(); return; }
    if (action === 'reset-search') { filters = { q: '', sort: 'latest', page: 1 }; await render(); return; }
    if (action === 'retry') { await render(); return; }
    if (action === 'download-cloud' || action === 'download-cloud-copy') {
      if (practiceOrigin) return;
      if (!user) { showAuth('login', location.hash); return; }
      const status = document.querySelector('.cloud-download-status'); element.disabled = true;
      if (status) status.textContent = '正在校验与导入到云端…';
      try {
        await api('/api/cloud/library/from-hub', jsonOptions({ packId: currentPack.id, revision: currentPack.revision, newCopy: action === 'download-cloud-copy' }));
        if (status) { status.textContent = ''; const link = document.createElement('a'); link.href = '/cloud/'; link.textContent = '已添加，打开我的云端题库 →'; status.append(link); }
      } catch (error) {
        if (status) status.textContent = error.message;
        if (error.message.includes('此版本已在云端') && status) { const button = document.createElement('button'); button.className = 'text-button'; button.dataset.action = 'download-cloud-copy'; button.textContent = '再创建一个独立副本'; status.append(button); const link = document.createElement('a'); link.href = '/cloud/'; link.textContent = '打开已有题库'; status.append(link); }
      } finally { element.disabled = false; }
      return;
    }
    if (action === 'download') {
      const pack = currentPack; const previousLabel = element.innerHTML; element.disabled = true; element.textContent = '下载中…';
      try {
        await api('/api/packs/' + pack.id + '/download-status');
        const link = document.createElement('a'); link.href = '/api/packs/' + pack.id + '/download'; link.download = pack.archive.name; document.body.append(link); link.click(); link.remove(); toast('已请求下载，请查看浏览器下载记录');
      } finally { element.disabled = false; element.innerHTML = previousLabel; }
      return;
    }
    if (action === 'approve-pack' || action === 'reject-pack') {
      const reject = action === 'reject-pack';
      message(reject ? '驳回题库' : '通过题库审核？', `<p class="dialog-intro">${reject ? '填写原因，作者可以修改后重新提交。' : '确认已检查当前版本。通过后题库与附件将公开。'}</p><form id="review-form" data-pack-id="${currentPack.id}" data-revision="${currentPack.revision}" data-decision="${reject ? 'rejected' : 'approved'}">${reject ? '<div class="field"><label for="review-note">驳回原因</label><textarea id="review-note" name="note" required maxlength="1000" rows="4"></textarea></div>' : ''}<p class="form-error" role="alert"></p><button class="button" type="submit">${reject ? '确认驳回' : '确认通过'}</button></form>`); return;
    }
    if (action === 'report') { if (!user) { showAuth('login', location.hash); return; } message('举报题库内容', '<p class="dialog-intro">请说明侵权、文件风险或其他问题，管理员会查看举报。</p><form class="report-form" id="report-form"><label for="report-reason" class="subtle">举报原因</label><textarea id="report-reason" name="reason" maxlength="1000" required rows="5"></textarea><p class="form-error" role="alert"></p><button type="submit" class="button">提交举报</button></form>'); return; }
    if (action === 'delete-pack') { message('下架这份题库？', '<p class="dialog-intro">题库、压缩包、截图和评论会一起删除，此操作无法恢复。</p><button class="button" data-action="confirm-delete-pack">确认下架</button>'); return; }
    if (action === 'confirm-delete-pack') { await api('/api/packs/' + currentPack.id, { method: 'DELETE' }); $('#message-dialog').close(); toast('题库已下架'); location.hash = '#library'; }
  } catch (error) { toast(error.message); }
});
document.addEventListener('change', event => {
  const el = event.target;
  if (el.id === 'sort') { filters.sort = el.value; filters.page = 1; render(); }
  if (el.id === 'archive-input') { const file = el.files[0]; if (file?.size > maxArchiveMB * 1024 * 1024) { el.value = ''; $('#archive-selection').textContent = ''; toast(`压缩包不能超过 ${maxArchiveMB} MB`); return; } $('#archive-selection').textContent = file ? `${file.name} · ${size(file.size)}` : upload.pack ? `当前文件：${upload.pack.archive.name}（不选择则保留）` : ''; }
  if (el.id === 'screenshots-input') {
    const files = [...el.files];
    if (files.length + upload.pictures.length + upload.keep.length > 6) toast('最多添加 6 张截图');
    else if (files.some(f => f.size > 3 * 1024 * 1024)) toast('每张截图不能超过 3 MB');
    else { upload.pictures.push(...files); previews(); }
    el.value = '';
  }
});
document.addEventListener('submit', async event => {
  const form = event.target; event.preventDefault();
  if (form.id === 'search-form') { filters.q = new FormData(form).get('q').trim(); filters.page = 1; await render(); return; }
  const button = form.querySelector('button[type="submit"]'); const errorNode = form.querySelector('.form-error');
  if (!button) return; button.disabled = true; if (errorNode) errorNode.textContent = '';
  try {
    if (form.id === 'auth-form') {
      const data = Object.fromEntries(new FormData(form)); const binding = form.dataset.mode === 'bind'; const result = await api(binding ? '/api/account/contact' : '/api/auth/' + form.dataset.mode, jsonOptions(data));
      user = result.user; account(); $('#auth-dialog').close(); toast(form.dataset.mode === 'bind' ? '绑定成功，原账号数据和额度已保留' : '登录成功');
      const authorization = practiceAuthorization(authTarget);
      if (authorization) { location.replace(authorization); return; }
      if (authTarget && location.hash !== authTarget) location.hash = authTarget; else await render();
    } else if (form.id === 'upload-form') {
      const data = new FormData(form); data.set('keepScreenshots', JSON.stringify(upload.keep));
      for (const file of upload.pictures) data.append('screenshots', file);
      const result = await api('/api/packs' + (upload.pack ? '/' + upload.pack.id : ''), { method: upload.pack ? 'PUT' : 'POST', body: data });
      toast('已提交，等待管理员审核'); location.hash = '#pack/' + result.pack.id;
    } else if (form.id === 'review-form') {
      await api('/api/packs/' + form.dataset.packId + '/review', jsonOptions({ decision: form.dataset.decision, revision: Number(form.dataset.revision), note: new FormData(form).get('note') || '' }));
      $('#message-dialog').close(); toast(form.dataset.decision === 'approved' ? '审核已通过，题库已公开' : '已驳回，作者可查看原因'); await render();
    } else if (form.id === 'comment-form') { await api('/api/packs/' + currentPack.id + '/comments', jsonOptions({ body: new FormData(form).get('body') })); toast('评论已发布'); await render(); }
    else if (form.id === 'report-form') { await api('/api/packs/' + currentPack.id + '/report', jsonOptions({ reason: new FormData(form).get('reason') })); $('#message-dialog').close(); toast('举报已提交'); }
  } catch (error) { if (errorNode) errorNode.textContent = error.message; else toast(error.message); if (form.id === 'auth-form' && form.dataset.mode !== 'login') await refreshInvitationPolicy(form).catch(() => {}); }
  finally { button.disabled = form.id === 'auth-form' && form.dataset.mode !== 'login' && !contactReady(); }
});
window.addEventListener('hashchange', () => { document.querySelectorAll('dialog[open]').forEach(d => d.close()); window.scrollTo(0, 0); render(); });
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
$('#auth-dialog').addEventListener('close', clearCaptcha);
try { const [identity, config] = await Promise.all([api('/api/me'), api('/api/config')]); user = identity.user; maxArchiveMB = config.maxArchiveMB; registrationReady = config.registrationReady; registrationMethods = config.registrationMethods || { email: registrationReady, phone: false }; captchaSiteKey = config.turnstileSiteKey; localImport = config.localImport; cloudEnabled = config.cloudEnabled; practiceOrigin = config.practiceOrigin || ''; invitationRequired = !!config.invitationRequired; adminEnabled = !!config.adminEnabled; officialAiEnabled = !!config.officialAi?.enabled; } catch (error) { toast(error.message); }
account(); await render(); cloudDownloadButton();
new MutationObserver(cloudDownloadButton).observe(app, { childList: true, subtree: true });
