import { practiceInstallHead } from './pwa.mjs';

const replaceRequired = (source, find, value) => {
  if (!source.includes(find)) throw new Error('Pinned Web cloud UI adapter changed; update adapter before deployment');
  return source.replace(find, value);
};

export function ordinaryPracticeAsset(file, source, base) {
  if (file === 'shell/appearance.js') {
    source = replaceRequired(source, 'DEFAULT_DIM=30', 'DEFAULT_DIM=15');
    source = replaceRequired(source, 'green:0,coast:65,image:65', 'green:0,coast:65,image:70');
    // Keep the established image default while a coast preference without a saved mask uses Web's 30%.
    source = replaceRequired(source, '?saved.dim:DEFAULT_DIM', "?saved.dim:theme==='coast'?30:DEFAULT_DIM");
    source = replaceRequired(source, 'let value=readAppearance(storage),imageUrl=null,busy=false,destroyed=false;', `let value=readAppearance(storage),imageUrl=null,busy=false,destroyed=false;
  let untouchedMask=true;
  try { const saved=JSON.parse(storage?.getItem('quizforge-appearance')||'{}'); untouchedMask=!validStep(saved?.dim,MAX_DIM); } catch {}`);
    source = replaceRequired(source, 'value={...value,theme:id};save();apply();render();', "value={...value,theme:id,...(untouchedMask?{dim:id==='coast'?30:DEFAULT_DIM}:{})};save();apply();render();");
    source = replaceRequired(source, "listen(dim,'input',()=>{const next=Number(dim.value);", "listen(dim,'input',()=>{untouchedMask=false;const next=Number(dim.value);");
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
    const taskScope = JSON.stringify(base.replace('/cloud/practice/', '/api/cloud/practice/'));
    source = replaceRequired(source, 'onRequest:(method,args)=>' + dispatch, "onRequest:(method,args)=>{if(method==='ai-task'&&!args?.taskId&&pane.view==='practice'&&!pane.closed&&pane.questionId===qid){const task=takeCloudAiTask(" + taskScope + "+questionPath(pane.kind,pane.id,qid),args?.targetId);if(task)return Promise.resolve({ok:true,data:{task}});}const dispatch=()=>" + dispatch + ";return method==='ai-task'?candidatePlugin.ready.then(()=>new Promise(resolve=>setTimeout(resolve,0))).then(dispatch):dispatch();}");
    source = replaceRequired(source, 'onRequest:(method,args)=>pageRequest(pane.plugin===candidatePlugin?pane:next,method,args)', "onRequest:(method,args)=>{const target=pane.plugin===candidatePlugin?pane:next;if(method==='ai-task'&&!args?.taskId&&target.view==='practice'&&!target.closed&&target.questionId===qid){const task=takeCloudAiTask(" + taskScope + "+questionPath(target.kind,target.id,qid),args?.targetId);if(task)return Promise.resolve({ok:true,data:{task}});}return pageRequest(target,method,args);}");
    for (const [name, from] of [['bindNetworkSettings', './shell/network-settings.js'], ['bindDevelopmentSettings', './development/development-settings.js'], ['bindAiSettings', './ai/ai-settings.js'], ['bindUserCenter', './ai/user-center.js'], ['createHubLogin', './ai/hub-login.js']]) {
      source = replaceRequired(source, `import {${name}} from '${from}';`, '');
    }
    source = "import {bindCloudExperience} from '/cloud/experience.js';\nimport {takeCloudAiTask} from '/cloud/ai-client.js';\n" + source;
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
    source = practiceInstallHead(source);
    source = replaceRequired(source, '<html lang="zh-CN">', '<html lang="zh-CN" data-qf-theme="image" style="--qf-dim:.15;--qf-clear:.7">');
    source = source.replace(/<nav class="settings-tabs"[\s\S]*?<\/nav>/, '<nav class="settings-tabs" role="tablist" aria-label="设置分类"><button id="settings-user-tab" role="tab" aria-selected="true" type="button">用户中心</button><button id="settings-ai-tab" role="tab" aria-selected="false" type="button">AI 评分</button><button id="settings-appearance-tab" role="tab" aria-selected="false" type="button">外观</button></nav>');
    // Web's own AI 评分 and 用户中心 panels stay as they are (docs/HUB_CONNECT_AI.md 7.3). The cloud has no
    // local network settings, adds its storage/download cards in Web's card style, and keeps the custom
    // model fields in a same-origin frame so the browser-local API Key never enters this page.
    source = source.replace(/<form id="network-settings-form">[\s\S]*?<\/form>/, '');
    source = replaceRequired(source, '<div class="user-center-actions">', quotaCards + '<div class="user-center-actions"><button type="button" data-admin-contact aria-haspopup="dialog">联系管理员</button>');
    const custom = /<div id="ai-settings-custom" class="ai-custom" hidden>[\s\S]*?<section id="ai-settings-report"[^>]*><\/section>\s*<\/div>/;
    if (!custom.test(source)) throw new Error('Pinned Web AI settings adapter changed');
    source = source.replace(custom, `<div id="ai-settings-custom" class="ai-custom" hidden><iframe class="cloud-ai-frame" title="自定义模型设置" data-src="/cloud/ai?embedded=1&amp;base=${encodeURIComponent(base)}"></iframe></div>`);
    source = source.replace('href="https://quizforge.treenewbee.cloud/#library"', 'href="https://quizforge.treenewbee.cloud/manage/#library"');
    source = source.replace(/<dialog id="access-dialog">[\s\S]*?<\/dialog>/, '');
    source = source.replace(/<dialog id="hub-login-dialog"[\s\S]*?<\/dialog>/, '');
    source = source.replace('</head>', '<link rel="stylesheet" href="/cloud/experience.css"><link rel="stylesheet" href="/cloud/admin-contact.css"></head>');
  }
  return source;
}

const quotaCards = `<div class="user-center-points cloud-quota"><small>存储空间</small><strong id="cloud-storage-value">—</strong><progress id="cloud-storage-progress" max="1" value="0" aria-label="存储空间用量"></progress><small>包含题库、图片、已保存的作答和历史。</small></div><div class="user-center-points cloud-quota"><small>今日下载流量</small><strong id="cloud-download-value">—</strong><progress id="cloud-download-progress" max="1" value="0" aria-label="今日下载用量"></progress><small>仅题库文件下载和导出计入，每天北京时间 00:00 重置。正常刷题、读取图片和保存不消耗此额度。</small></div>`;
