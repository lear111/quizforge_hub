const replaceRequired = (source, find, value) => {
  if (!source.includes(find)) throw new Error('Pinned Web cloud UI adapter changed; update adapter before deployment');
  return source.replace(find, value);
};

export function ordinaryPracticeAsset(file, source, base) {
  if (file === 'shell/appearance.js') {
    source = replaceRequired(source, 'DEFAULT_DIM=30', 'DEFAULT_DIM=15');
    if (!/green:0,image:\d+/.test(source)) throw new Error('Pinned Web appearance defaults changed');
    source = source.replace(/green:0,image:\d+/, 'green:0,image:70');
    if (source.includes("?saved.theme:'default'")) source = source.replace("?saved.theme:'default'", "?saved.theme:'image'");
    else if (!source.includes("?saved.theme:'image'")) throw new Error('Pinned Web appearance theme changed');
  }
  if (file === 'shell/themes.css') source = source.replaceAll('url("/assets/', `url("${base}/assets/`);
  if (file === 'library/library-transfer.js') {
    source = "import {downloadCloudSelection} from '/cloud/experience.js';\n" + source;
    source = replaceRequired(source, "const blob=await request('/api/library/export',{method:'POST',body:JSON.stringify(single?{bank:row.path}:{group:row.path}),responseType:'blob',timeoutMs:135000});", `const blob=await downloadCloudSelection(${JSON.stringify(base.replace('/cloud/practice/', '/api/cloud/library/') + '/export-selection')},single?{bank:row.path}:{group:row.path});`);
  }
  if (file === 'app.js') {
    const dispatch = "!pane.recovering&&pane.plugin===candidatePlugin&&pane.questionId===qid?pageRequest(pane,method,args):['resource-get','sdk-editor'].includes(method)?pageRequest({...pane,view:'development-loading',pageAssets:assets},method,args):Promise.resolve({ok:false,error:{code:'READ_ONLY',message:'当前题卡未处于活动状态'}})";
    source = replaceRequired(source, 'onRequest:(method,args)=>' + dispatch, "onRequest:(method,args)=>{const dispatch=()=>" + dispatch + ";return method==='ai-task'?candidatePlugin.ready.then(()=>new Promise(resolve=>setTimeout(resolve,0))).then(dispatch):dispatch();}");
    for (const [name, from] of [['bindNetworkSettings', './shell/network-settings.js'], ['bindDevelopmentSettings', './development/development-settings.js'], ['bindAiSettings', './ai/ai-settings.js'], ['bindUserCenter', './ai/user-center.js'], ['createHubLogin', './ai/hub-login.js']]) {
      source = replaceRequired(source, `import {${name}} from '${from}';`, '');
    }
    source = "import {bindCloudExperience} from '/cloud/experience.js';\n" + source;
    // The cloud keeps its own AI frame and 用户中心 (cloud/hub-ai.mjs); the visitor is always signed in.
    source = replaceRequired(source, 'const hubLogin=createHubLogin({request});\nbindAiSettings({request,login:hubLogin});\nbindUserCenter({request,login:hubLogin});', '');
    const network = 'bindNetworkSettings({request,beforeSave:()=>transitionTo(async()=>{for(const pane of collections.values())await flushPane(pane);})});';
    source = replaceRequired(source, network, 'bindCloudExperience({document,beforeLogout:()=>transitionTo(async()=>{for(const pane of collections.values())await flushPane(pane);})});');
    const development = 'bindDevelopmentSettings({request,beforeSave:settings=>transitionTo(()=>prepareDevelopmentSettings(settings)),onSaved:settings=>transitionTo(async()=>{for(const pane of collections.values())if(pane.development&&settings.enabled)pane.developmentWatcher?.invalidate();await refreshCatalog();})});';
    source = replaceRequired(source, development, '');
    const start = source.indexOf("document.addEventListener('quizforge-auth-required',"), end = source.indexOf("window.addEventListener('beforeunload',", start);
    if (start < 0 || end < start) throw new Error('Pinned Web authentication adapter changed');
    source = source.slice(0, start) + "document.addEventListener('quizforge-auth-required',()=>document.dispatchEvent(new Event('qfh-login-required')));\n" + source.slice(end);
  }
  if (file === 'index.html') {
    source = replaceRequired(source, '<html lang="zh-CN">', '<html lang="zh-CN" data-qf-theme="image" style="--qf-dim:.15;--qf-clear:.7">');
    source = source.replace(/<nav class="settings-tabs"[\s\S]*?<\/nav>/, '<nav class="settings-tabs" role="tablist" aria-label="设置分类"><button id="settings-user-tab" role="tab" aria-selected="true" type="button">用户中心</button><button id="settings-ai-tab" role="tab" aria-selected="false" type="button">AI 评分</button><button id="settings-appearance-tab" role="tab" aria-selected="false" type="button">外观</button></nav>');
    source = source.replace(/<form id="network-settings-form">[\s\S]*?<\/form>/, userPanel);
    const start = source.indexOf('<section id="ai-settings-panel"'), end = source.indexOf('<section id="appearance-settings-panel"', start);
    if (start < 0 || end < start) throw new Error('Pinned Web settings adapter changed');
    source = source.slice(0, start) + '<section id="ai-settings-panel" hidden><iframe class="cloud-ai-frame" title="AI 评分设置" data-src="/cloud/ai?embedded=1"></iframe></section>\n    ' + source.slice(end);
    source = source.replace('href="https://quizforge.treenewbee.cloud/#library"', 'href="https://quizforge.treenewbee.cloud/manage/#library"');
    source = source.replace(/<dialog id="access-dialog">[\s\S]*?<\/dialog>/, '');
    source = source.replace(/<dialog id="hub-login-dialog"[\s\S]*?<\/dialog>/, '');
    source = source.replace('</head>', '<link rel="stylesheet" href="/cloud/experience.css"></head>');
  }
  return source;
}

const userPanel = `<section id="user-settings-panel"><p id="cloud-user-status" role="status">正在读取账户信息…</p><div id="cloud-user-details" hidden><div class="user-center-who"><span id="cloud-user-avatar" class="user-center-avatar" aria-hidden="true"></span><span><h3 id="cloud-user-name"></h3><p id="cloud-user-email"></p></span></div><div class="cloud-resource"><label for="cloud-redeem-code">免费 AI 额度</label><strong id="cloud-ai-points">—</strong><form id="cloud-redeem" class="cloud-redeem"><div><input id="cloud-redeem-code" maxlength="64" autocomplete="off" spellcheck="false" placeholder="兑换码 AI-XXXX-XXXX-XXXX-XXXX"><button id="cloud-redeem-submit" type="submit">兑换</button><button id="cloud-ai-refresh" type="button">刷新</button></div><small id="cloud-redeem-result" role="status"></small></form></div><div class="cloud-resource"><label for="cloud-storage-progress">存储空间</label><strong id="cloud-storage-value"></strong><progress id="cloud-storage-progress" max="1" value="0"></progress><small>包含题库、图片、已保存的作答和历史。</small></div><div class="cloud-resource"><label for="cloud-download-progress">今日下载流量</label><strong id="cloud-download-value"></strong><progress id="cloud-download-progress" max="1" value="0"></progress><small>仅题库文件下载和导出计入，每天北京时间 00:00 重置。正常刷题、读取图片和保存不消耗此额度。</small></div><div class="dialog-actions"><button id="cloud-user-logout" type="button">退出登录</button></div></div><a id="cloud-user-login" href="/auth/hub" hidden>重新登录 Hub</a></section>`;
