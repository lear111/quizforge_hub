import {escapeHtml as e,icon,bytes} from './catalog-view.mjs';

export function uploadForm(pack=null,{administrator=false}={}){
  const editing=Boolean(pack);
  return `<div class="up-wrap"><nav class="crumbs"><a href="#mine">${icon('back')}我的分享</a><span>/</span><span>${editing?'编辑题库':'分享题库'}</span></nav><header class="up-head"><h1>${editing?'编辑题库':'分享你的题库'}</h1><p>${administrator?'管理员上传后直接发布；新拓展需要确认代码已检查。':editing?'修改后重新审核，审核期间暂停公开。':'上传题库文件，填写名称和介绍，审核通过后公开。'}</p></header>
  <form class="up-card" data-publish-form><fieldset class="upload-fields"><div data-file-view></div><input type="file" data-archive-input accept=".qbank,.zip,.7z,.rar" hidden>
    <div class="field"><label class="f-label" for="publishTitle">题库名称 <small data-title-count></small></label><input id="publishTitle" name="title" class="input" maxlength="80" required value="${e(pack?.title||'')}" autocomplete="off"></div>
    <div class="field"><label class="f-label" for="publishIntro">题库介绍 <small data-intro-count></small></label><textarea id="publishIntro" name="description" class="textarea" maxlength="12000" required placeholder="介绍题库内容、适用范围和使用方式">${e(pack?.description||pack?.summary||'')}</textarea><p class="f-hint">第一段将作为列表中的简介展示。</p></div>
    <details class="more"${editing?' open':''}><summary>${icon('chev')}更多信息 <small>选填</small></summary><div class="more-grid"><div class="field"><label class="f-label" for="publishVersion">版本</label><input id="publishVersion" name="version" class="input" maxlength="30" value="${e(pack?.version||'1.0')}"></div><div class="field"><label class="f-label" for="publishTag">标签 <small>最多 5 个</small></label><div class="tag-input"><span data-tags></span><input id="publishTag" data-tag-input maxlength="100" placeholder="输入后按回车或逗号"></div></div></div>
    <div class="field"><div class="f-label">题库截图 <small>最多 6 张；PNG、JPEG、WebP，每张不超过 3 MB</small></div><div class="shot-grid" data-shots></div><input type="file" data-shots-input accept="image/png,image/jpeg,image/webp" multiple hidden><p class="f-hint">第一张截图用作封面。</p></div></details>
    <label class="upload-rights"><input type="checkbox" name="rights" required>我确认有权分享题库及其包含的图片、拓展等资源。</label>${administrator?'<label class="upload-rights"><input type="checkbox" name="codeReviewed">如包含新拓展，我已检查其完整代码与资源，允许本次发布。</label>':''}</fieldset>
    <p class="f-error" data-publish-status role="status" aria-live="polite"></p><progress class="upload-progress" data-upload-progress max="100" value="0" hidden aria-label="文件上传进度"></progress>
    <div class="up-actions"><p>${administrator?'管理员发布无需重复提交审核。':'提交后进入审核，请勿重复提交。'}</p><button class="btn-filled" type="submit">${administrator?editing?'保存并发布':'上传并发布':editing?'保存并重新提交审核':'提交审核'}</button></div></form></div>`;
}
export function uploadDone(pack,publication=null){
  const published=pack.status==='approved',needsReview=publication?.state==='code-review-required',pending=publication&&!published;
  const item=publication?.item;
  const files=(item?.extensions||[]).flatMap(extension=>(extension.files||[]).map(file=>({label:(extension.name||extension.extensionId)+' / '+file.path,url:'/api/admin/cloud/submissions/'+encodeURIComponent(item.id)+'/file?extension='+encodeURIComponent(extension.digest)+'&path='+encodeURIComponent(file.path)})));
  return `<div class="up-wrap"><div class="up-card up-done"><span class="done-icon">${icon('check')}</span><h2>${published?'已发布':pending?'已保存，尚未发布':'已提交，等待审核'}</h2><p>${e(pack.title)}${published?'已公开显示在题库广场。':needsReview?'包含尚未批准的拓展，请在下方检查并确认代码。':pending?'已保存，无需重复上传。'+e(publication.message||'请重试发布。'):'已保存。审核通过后会公开显示在题库广场。'}</p>
    ${pending?`<section data-publish-review>${files.length?`<details><summary>查看拓展文件</summary><select class="input" data-publish-review-file><option value="">选择文件查看</option>${files.map(file=>`<option value="${e(file.url)}">${e(file.label)}</option>`).join('')}</select><pre data-publish-review-code style="white-space:pre-wrap;max-height:24rem;overflow:auto;text-align:left"></pre></details>`:''}<label class="upload-rights"><input type="checkbox" data-publish-code-reviewed>我已检查本次拓展的完整代码与资源。</label><button class="btn-filled" type="button" data-publish-complete data-pack-id="${e(pack.id)}" data-revision="${e(pack.revision)}">${needsReview?'确认代码并发布':'重试发布'}</button><p class="f-error" data-publish-status role="status"></p></section>`:''}
    <div class="row"><a class="btn-filled runtime-link" href="#mine">查看我的分享</a><a class="btn-outline runtime-link" href="#pack/${e(pack.id)}">查看题库</a></div></div></div>`;
}

export function createPublishingUI({container,getUser,notice}){
  let pack=null,archive=null,shots=[],tags=[],dirty=false,busy=false,generation=0,request=null,loader=null;
  const find=selector=>container.querySelector(selector);
  function clean(){loader?.abort();loader=null;request?.abort();request=null;for(const shot of shots)if(shot.url)URL.revokeObjectURL(shot.url);shots=[];archive=null;tags=[];pack=null;dirty=false;busy=false;}
  function clear(){generation++;clean();}
  function status(message){const node=find('[data-publish-status]');if(node)node.textContent=message;}
  function counts(){find('[data-title-count]').textContent=`${find('[name=title]').value.length} / 80`;find('[data-intro-count]').textContent=`${find('[name=description]').value.length} / 12000`;}
  function fileView(){const file=archive||pack?.archive;find('[data-file-view]').innerHTML=file?`<div class="file-card"><span class="file-icon">${icon('qbank')}</span><div class="fc-info"><div class="fc-name">${e(file.name)}</div><div class="fc-sub">${bytes(file.size)} · ${archive?'已选择，提交时上传':'保留现有文件'}</div></div><button class="text-btn" type="button" data-pick-archive>更换</button></div>`:`<button class="dropzone" type="button" data-pick-archive><span class="dz-icon">${icon('upload')}</span><b>拖入文件，或<span>点击选择</span></b><small>.qbank、ZIP、7z、RAR，最多 20 MB</small></button>`;}
  function shotView(){find('[data-shots]').innerHTML=shots.map((shot,index)=>`<div class="shot-item"><img src="${e(shot.url||'/media/'+shot.id)}" alt="题库截图 ${index+1}"><button type="button" data-remove-shot="${index}" aria-label="移除第 ${index+1} 张截图">×</button>${index===0?'<span class="cover-tag">封面</span>':''}</div>`).join('')+(shots.length<6?`<button class="shot-add" type="button" data-pick-shots>${icon('plus')}添加截图</button>`:'');}
  function tagView(){find('[data-tags]').innerHTML=tags.map((tag,index)=>`<span class="chip">${e(tag)}<button type="button" data-remove-tag="${index}" aria-label="移除标签${e(tag)}">×</button></span>`).join('');}
  function addTags(){const input=find('[data-tag-input]'),value=input.value.trim();if(!value)return true;const next=[...new Set([...tags,...value.split(/[,，]/).map(x=>x.trim()).filter(Boolean)])];if(next.length>5||next.join(',').length>100){status('最多 5 个标签，总长度不能超过 100 个字符。');return false;}tags=next;input.value='';dirty=true;tagView();return true;}
  function chooseArchive(file){if(!file)return;if(!/\.(qbank|zip|7z|rar)$/i.test(file.name)||!file.size||file.size>20*1048576){status('请选择不超过 20 MB 的 .qbank、ZIP、7z 或 RAR 文件。');return;}archive=file;dirty=true;if(!find('[name=title]').value.trim())find('[name=title]').value=file.name.replace(/\.[^.]+$/,'').slice(0,80);fileView();counts();status('');}
  async function render(id=null){
    clear();const turn=generation;container.hidden=false;container.textContent=id?'正在读取编辑内容…':'';
    if(!getUser()){location.hash='login';return;}
    if(id){loader=new AbortController();const response=await fetch('/api/packs/'+id,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:loader.signal});const value=await response.json();if(!response.ok)throw new Error(value.error||'读取失败');if(turn!==generation)return;pack=value.pack;if(pack.user_id!==getUser()?.id)throw new Error('只能编辑自己分享的题库');}
    if(turn!==generation)return;shots=(pack?.screenshots||[]).map(shot=>({...shot}));tags=[...(pack?.tags||[])];container.innerHTML=uploadForm(pack,{administrator:!!getUser()?.admin});fileView();shotView();tagView();counts();document.title=(id?'编辑题库':'分享题库')+' · QuizForge';window.scrollTo({top:0});
  }
  container.addEventListener('input',event=>{if(!find('[data-publish-form]'))return;dirty=true;if(event.target.matches('[name=title],[name=description]'))counts();});
  container.addEventListener('keydown',event=>{if(event.target.matches('[data-tag-input]')&&['Enter',',','，'].includes(event.key)){event.preventDefault();addTags();}});
  container.addEventListener('click',event=>{
    if(busy)return;const button=event.target.closest('button');if(!button)return;
    if(button.hasAttribute('data-pick-archive'))find('[data-archive-input]').click();
    if(button.hasAttribute('data-pick-shots'))find('[data-shots-input]').click();
    if(button.hasAttribute('data-remove-shot')){const index=Number(button.dataset.removeShot),[shot]=shots.splice(index,1);if(shot?.url)URL.revokeObjectURL(shot.url);dirty=true;shotView();}
    if(button.hasAttribute('data-remove-tag')){tags.splice(Number(button.dataset.removeTag),1);dirty=true;tagView();}
  });
  container.addEventListener('change',event=>{
    if(busy)return;
    if(event.target.matches('[data-archive-input]')){chooseArchive(event.target.files[0]);event.target.value='';}
    if(event.target.matches('[data-shots-input]')){
      const files=[...event.target.files];event.target.value='';
      if(shots.length+files.length>6){status('最多添加 6 张截图。');return;}
      if(files.some(file=>!file.size||file.size>3*1048576||!(/\.(png|jpe?g|webp)$/i.test(file.name)))){status('请选择 PNG、JPEG 或 WebP 图片，每张不超过 3 MB。');return;}
      shots.push(...files.map(file=>({file,url:URL.createObjectURL(file)})));dirty=true;shotView();status('');
    }
  });
  container.addEventListener('dragover',event=>{if(find('[data-publish-form]')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
  container.addEventListener('drop',event=>{if(!find('[data-publish-form]'))return;event.preventDefault();if(!busy){const files=event.dataTransfer.files;if(files.length!==1){status('一次请选择一个题库文件。');return;}chooseArchive(files[0]);}});
  container.addEventListener('change',async event=>{
    if(busy||!event.target.matches('[data-publish-review-file]'))return;
    loader?.abort();const current=++generation,output=find('[data-publish-review-code]');output.textContent='正在读取…';
    if(!event.target.value){output.textContent='';return;}
    loader=new AbortController();
    try{const response=await fetch(event.target.value,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:loader.signal});const value=await response.json();if(!response.ok)throw new Error(value.error||'读取失败');if(current===generation)output.textContent=value.binary?'二进制资源，请在本次上传的原包中检查完整文件。':(value.text||'')+(value.truncated?'\n仅显示前512 KiB，请在本次上传的原包中检查完整文件后再确认。':'');}
    catch(error){if(current===generation&&error.name!=='AbortError')output.textContent=error.message;}
  });
  container.addEventListener('click',async event=>{
    const button=event.target.closest('[data-publish-complete]');if(!button||busy)return;
    loader?.abort();const current=++generation,selector=find('[data-publish-review-file]');busy=true;button.disabled=true;if(selector)selector.disabled=true;status('正在发布…');
    try{const response=await fetch('/api/packs/'+encodeURIComponent(button.dataset.packId)+'/publish',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:Number(button.dataset.revision),codeReviewed:find('[data-publish-code-reviewed]').checked}),signal:AbortSignal.timeout(190000)});const value=await response.json();if(!response.ok)throw new Error(value.error||'发布未完成');if(current!==generation)return;container.innerHTML=uploadDone(value.pack,value.publication);notice(value.pack.status==='approved'?'题库已发布':'请先完成拓展代码确认。');}
    catch(error){if(current===generation)status(error.message||'未收到发布确认，请先查看题库状态。');}
    finally{if(current===generation){busy=false;button.disabled=false;if(selector)selector.disabled=false;}}
  });
  container.addEventListener('submit',event=>{
    if(!event.target.matches('[data-publish-form]'))return;event.preventDefault();if(busy||!addTags())return;
    if(!archive&&!pack?.archive){status('请先选择题库文件。');find('[data-pick-archive]').focus();return;}
    const form=event.target,data=new FormData(),intro=find('[name=description]').value.trim();
    data.set('title',find('[name=title]').value.trim());data.set('summary',(intro.split(/\n/).find(line=>line.trim())||intro).trim().slice(0,240));data.set('description',intro);data.set('version',find('[name=version]').value.trim());data.set('tags',tags.join(','));data.set('rights',find('[name=rights]').checked?'yes':'');if(find('[name=codeReviewed]')?.checked)data.set('codeReviewed','yes');data.set('keepScreenshots',JSON.stringify(shots.filter(shot=>shot.id).map(shot=>shot.id)));if(pack)data.set('revision',String(pack.revision));if(archive)data.set('archive',archive);for(const shot of shots)if(shot.file)data.append('screenshots',shot.file);
    const turn=generation,xhr=new XMLHttpRequest();request=xhr;busy=true;find('fieldset').disabled=true;const button=form.querySelector('[type=submit]');button.disabled=true;const progress=find('[data-upload-progress]');progress.hidden=false;progress.value=0;status('正在上传，请等待服务器确认…');
    xhr.open(pack?'PUT':'POST',pack?'/api/packs/'+pack.id:'/api/packs');xhr.timeout=240000;xhr.responseType='json';
    xhr.upload.onprogress=event=>{if(turn===generation&&event.lengthComputable){progress.value=Math.round(event.loaded*100/event.total);if(event.loaded===event.total)status('文件已传输，正在保存，请等待确认…');}};
    xhr.onload=()=>{if(turn!==generation)return;if(xhr.status>=200&&xhr.status<300&&xhr.response?.pack){const saved=xhr.response.pack;clean();container.innerHTML=uploadDone(saved,xhr.response.publication);notice(saved.status==='approved'?'题库已发布':xhr.response.publication?'题库已保存，请完成发布':'题库已保存并提交审核');}else failure(xhr.response?.error||'提交未完成，请检查“我的分享”后再重试。');};
    function failure(message){if(turn!==generation)return;request=null;busy=false;find('fieldset').disabled=false;button.disabled=false;progress.hidden=true;status(message);}
    xhr.onerror=xhr.ontimeout=()=>failure('未收到保存确认，请先到“我的分享”检查结果，避免重复提交。');xhr.onabort=()=>failure('上传已中断，请先到“我的分享”检查是否已保存。');xhr.send(data);
  });
  return {render,clear,isDirty:()=>dirty||busy,isBusy:()=>busy};
}
