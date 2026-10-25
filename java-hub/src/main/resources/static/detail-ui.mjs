import {detail,bankCatalogView,commentsView,bytes,escapeHtml} from './catalog-view.mjs';

export function createDetailUI({container,getConfig,getUser,notice}){
  let turn=0,controller,pack=null,catalog=null,selected=new Set(),expanded=false,busy=false;
  const clear=()=>{turn++;controller?.abort();controller=new AbortController();pack=null;catalog=null;selected=new Set();expanded=false;busy=false;container.querySelector('[data-report-dialog]')?.close();};
  async function request(path,body,method=body===undefined?'GET':'POST'){
    const response=await fetch(path,{method,signal:controller.signal,credentials:'same-origin',cache:'no-store',redirect:'error',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    const value=await response.json();if(!response.ok)throw new Error(typeof value.error==='string'?value.error:'操作未完成，请重试');return value;
  }
  function feedback(message,target='[data-detail-action-status]'){const element=container.querySelector(target);if(element)element.textContent=message;}
  function updateSelection(rebuild=true){
    if(!pack||!catalog)return;
    const chosen=catalog.banks.filter(bank=>selected.has(bank.id)),all=chosen.length===catalog.banks.length;
    if(rebuild)container.querySelector('[data-bank-catalog]').innerHTML=bankCatalogView(catalog.banks,selected,expanded);
    else{container.querySelectorAll('[data-bank-key]').forEach(checkbox=>{checkbox.checked=selected.has(checkbox.dataset.bankKey);});container.querySelector('.sel-sum b').textContent=String(chosen.length);}
    const checkbox=container.querySelector('[data-bank-all]');checkbox.checked=all;checkbox.indeterminate=chosen.length>0&&!all;
    container.querySelector('[data-selected-title]').textContent=all?pack.archive.name:chosen.length===1?chosen[0].title+'.qbank':pack.title+`（已选${chosen.length}本）.qbank`;
    container.querySelector('[data-selected-info]').textContent=all?`${catalog.banks.length} 本题库 · ${bytes(pack.archive.size)}（整包）`:`已选 ${chosen.length} / ${catalog.banks.length} 本 · 打包后下载`;
    container.querySelector('[data-selected-hint]').textContent=chosen.length===0?'请先选择题库':all?'整组下载，包含配套拓展':`将所选 ${chosen.length} 本与配套拓展打包下载`;
    container.querySelector('[data-detail-download]').disabled=busy||chosen.length===0;
  }
  async function render(value){
    clear();const generation=turn;pack=value.pack;container.innerHTML=detail(pack,value.comments,getConfig(),getUser());
    const target=container.querySelector('[data-bank-catalog]'),summary=container.querySelector('[data-bank-catalog-summary]');
    if(!pack.archive||!getConfig().native?.includes('package-catalog')){target.textContent='此附件暂不支持目录预览，可下载完整文件后查看。';summary.textContent='';return;}
    try{
      const result=await request('/api/packs/'+pack.id+'/catalog');if(generation!==turn)return;
      if(result.revision!==pack.revision||result.sha256!==pack.archive.sha256)throw new Error('题库已更新，请刷新详情后重新选择。');
      catalog=result;selected=new Set(result.banks.map(bank=>bank.id));summary.textContent=`${result.banks.length} 本，勾选后在右侧下载`;container.querySelector('[data-detail-bank-total]').textContent=` · ${result.banks.length} 本题库`;
      updateSelection();
    }catch(error){if(generation===turn&&error.name!=='AbortError'){summary.textContent='';target.innerHTML=`<p class="detail-catalog-note">${escapeHtml(error.message)}</p><button class="text-btn" type="button" data-catalog-retry>重新读取目录</button>`;}}
  }
  function saveBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  async function download(button){
    const generation=turn,current=pack,keys=[...selected];busy=true;button.disabled=true;feedback('正在准备下载…');
    try{
      if(!catalog||keys.length===catalog.banks.length){await request('/api/packs/'+current.id+'/download-status');if(generation!==turn)return;const link=document.createElement('a');link.href='/api/packs/'+current.id+'/download';link.download='';document.body.append(link);link.click();link.remove();}
      else{
        const response=await fetch('/api/packs/'+current.id+'/download-selection',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:catalog.revision,sha256:catalog.sha256,banks:keys})});
        if(!response.ok){const error=await response.json();throw new Error(typeof error.error==='string'?error.error:'打包失败，请稍后重试');}
        const blob=await response.blob();if(generation!==turn)return;
        const match=/filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('Content-Disposition')||'');let name='所选题库.qbank';if(match)try{name=decodeURIComponent(match[1]);}catch{}
        saveBlob(blob,name);
      }
      if(generation===turn)feedback('已请求下载，请查看浏览器下载记录。');
    }catch(error){if(generation===turn&&error.name!=='AbortError')feedback(error.message);}finally{if(generation===turn){busy=false;button.disabled=catalog?selected.size===0:!pack?.archive;}}
  }
  async function refreshComments(generation){if(generation!==turn||!pack)return;const value=await request('/api/packs/'+pack.id);if(generation!==turn)return;pack=value.pack;container.querySelector('[data-detail-comments]').innerHTML=commentsView(value.comments,getUser());container.querySelector('[data-comment-count]').textContent=`${value.pack.commentCount} 条`;}
  container.addEventListener('change',event=>{
    if(!catalog)return;const checkbox=event.target;if(checkbox.matches('[data-bank-all]'))selected=checkbox.checked?new Set(catalog.banks.map(bank=>bank.id)):new Set();else if(checkbox.matches('[data-bank-key]')){if(checkbox.checked)selected.add(checkbox.dataset.bankKey);else selected.delete(checkbox.dataset.bankKey);}else return;updateSelection(false);
  });
  container.addEventListener('click',async event=>{
    if(event.target.closest('[data-detail-delete]')){if(busy||!pack)return;if(!confirm('确定删除这份分享及其评论？已导入的练习副本会保留。'))return;busy=true;try{await request('/api/packs/'+pack.id,{revision:pack.revision},'DELETE');notice('分享已删除');location.hash='mine';}catch(error){feedback(error.message);}finally{busy=false;}return;}
    const button=event.target.closest('button');if(!button||button.disabled||!pack)return;const generation=turn;
    if(button.hasAttribute('data-detail-download')){await download(button);return;}
    if(button.hasAttribute('data-banks-expand')){expanded=!expanded;updateSelection();return;}
    if(button.hasAttribute('data-catalog-retry')){const value=await request('/api/packs/'+pack.id).catch(error=>{feedback(error.message);return null;});if(value&&generation===turn)await render(value);return;}
    if(button.hasAttribute('data-detail-report')){if(!getUser()){notice('请先登录后举报。');return;}container.querySelector('[data-report-dialog]').showModal();return;}
    if(button.hasAttribute('data-report-close')){container.querySelector('[data-report-dialog]').close();return;}
    if(button.dataset.commentDelete){if(!confirm('确定删除这条评论吗？'))return;button.disabled=true;try{await request('/api/comments/'+button.dataset.commentDelete,undefined,'DELETE');await refreshComments(generation);}catch(error){if(generation===turn&&error.name!=='AbortError'){feedback(error.message,'[data-comment-status]');button.disabled=false;}}}
  });
  container.addEventListener('submit',async event=>{
    const form=event.target.closest('[data-detail-comment],[data-detail-report-form]');if(!form||!pack)return;event.preventDefault();const generation=turn,button=form.querySelector('[type="submit"]'),report=form.hasAttribute('data-detail-report-form');button.disabled=true;
    const target=report?'[data-report-dialog] [role="status"]':'[data-comment-status]';feedback('',target);
    try{const value=Object.fromEntries(new FormData(form));await request('/api/packs/'+pack.id+(report?'/report':'/comments'),value);if(generation!==turn)return;form.reset();if(report){container.querySelector('[data-report-dialog]').close();notice('举报已提交，感谢反馈。');}else{await refreshComments(generation);feedback('评论已发布。',target);}}
    catch(error){if(generation===turn&&error.name!=='AbortError')feedback(error.message,target);}finally{if(generation===turn)button.disabled=false;}
  });
  return {render,clear};
}
