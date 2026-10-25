import {card,downloads,escapeHtml} from './catalog-view.mjs';
import {bindAdminContact} from './admin-contact.js';
import {createAccountUI} from './account-ui.mjs';
import {createDetailUI} from './detail-ui.mjs';
import {createPublishingUI} from './publishing-ui.mjs';
import {bindActivity} from './activity.js';
const $=id=>document.getElementById(id);
let config={},user=null,page=1,query='',generation=0,controller,mineStatus='',renderedHash=location.hash;
function identityView(){
  $('identity').replaceChildren();const link=document.createElement('a');link.className='user-link';link.href=user?'#profile':'#login';
  if(user){const avatar=document.createElement('span');avatar.className='mini-avatar';avatar.textContent=Array.from(user.name||'Q')[0].toUpperCase();avatar.setAttribute('aria-hidden','true');const name=document.createElement('span');name.textContent=user.name;link.append(avatar,name);link.setAttribute('aria-label','个人中心');}else link.textContent='登录';$('identity').append(link);
  bindActivity({document,account:user?.id||null});
  for(const id of ['adminLink','mobileAdminLink']){$(id).hidden=!(user?.admin&&config.adminEnabled);if(user?.admin&&config.adminEnabled)$(id).href='/admin/';}
}
const accountUI=createAccountUI({container:$('profileView'),getUser:()=>user,setUser:value=>{user=value;},getConfig:()=>config,onIdentity:identityView});
const detailUI=createDetailUI({container:$('detailView'),getConfig:()=>config,getUser:()=>user,notice});
const publishingUI=createPublishingUI({container:$('uploadView'),getUser:()=>user,notice});
function notice(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(notice.timer);notice.timer=setTimeout(()=>$('toast').classList.remove('show'),4000);}
async function api(path,signal){const response=await fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});const value=await response.json();if(!response.ok)throw new Error(value.error||'读取失败，请重试');return value;}
async function render(){
  const turn=++generation;controller?.abort();controller=new AbortController();const signal=controller.signal;
  detailUI.clear();
  publishingUI.clear();
  for(const id of ['heroSection','library','detailView','uploadView','profileView','downloadView'])$(id).hidden=true;
  document.querySelectorAll('.nav-link[data-view]').forEach(link=>link.classList.toggle('active',location.hash==='#'+link.dataset.view));
  const route=(location.hash||'#discover').slice(1);
  if(!['profile','login','register','admin'].includes(route)&&!route.startsWith('connect-login/')&&!route.startsWith('practice-login/'))accountUI.clear();
  try{
    if(['profile','login','register','admin'].includes(route)||route.startsWith('connect-login/')||route.startsWith('practice-login/')){await accountUI.render(route);return;}
    if(route==='upload'||route.startsWith('edit/')){const id=route.startsWith('edit/')?route.slice(5):null;if(id&&!/^[a-f0-9-]{36}$/.test(id))throw new Error('题库地址无效');await publishingUI.render(id);return;}
    if(route==='download'){$('downloadView').hidden=false;$('downloadView').textContent='正在读取安装包…';const value=await api('/api/downloads',signal);if(turn===generation)$('downloadView').innerHTML=downloads(value.items);return;}
    if(route.startsWith('pack/')){
      const id=route.slice(5);if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('题库地址无效');
      $('detailView').hidden=false;$('detailView').textContent='正在读取题库…';const value=await api('/api/packs/'+id,signal);if(turn!==generation)return;
      document.title=value.pack.title+' · QuizForge';window.scrollTo({top:0});await detailUI.render(value);return;
    }
    const mine=route==='mine';$('heroSection').hidden=false;$('library').hidden=false;$('pageTitle').textContent=mine?'我的分享':'发现题库';$('libraryTitle').textContent=mine?'我的分享':'公开题库';
    if(mine&&!user){location.hash='login';return;}
    $('resultCount').textContent='正在读取题库…';$('libraryGrid').replaceChildren();$('emptyState').hidden=true;
    document.querySelector('.mine-status')?.remove();
    if(mine){const filters=document.createElement('nav');filters.className='mine-status';filters.setAttribute('aria-label','审核状态');filters.innerHTML=[['','全部'],['approved','已公开'],['pending','审核中'],['rejected','未通过']].map(([value,label])=>`<button class="btn-outline" type="button" data-mine-status="${value}" aria-pressed="${mineStatus===value}">${label}</button>`).join('');$('libraryGrid').before(filters);}
    const result=await api('/api/packs?'+new URLSearchParams({q:query,page:String(page),...(mine?{mine:'1',status:mineStatus}:{})}),signal);if(turn!==generation)return;
    $('resultCount').textContent=`共 ${result.count} 份题库`;$('libraryGrid').innerHTML=result.packs.map(card).join('');$('emptyState').hidden=result.packs.length!==0;
    document.querySelector('.runtime-pager')?.remove();const pager=document.createElement('div');pager.className='runtime-pager';pager.innerHTML=`<button class="btn-outline" data-page="${page-1}"${page<=1?' disabled':''}>上一页</button><span>第 ${page} 页</span><button class="btn-outline" data-page="${page+1}"${page*12>=result.count?' disabled':''}>下一页</button>`;$('library').append(pager);document.title='发现题库 · QuizForge';
  }catch(error){if(error.name==='AbortError'||turn!==generation)return;const target=[...document.querySelectorAll('main>section')].find(section=>!section.hidden)||$('library');target.hidden=false;target.innerHTML=`<div class="page-error" role="alert">${escapeHtml(error.message)}<div class="runtime-actions"><button class="btn-outline" data-retry>重新读取</button><a href="#discover">返回题库广场</a></div></div>`;}
}
$('searchForm').addEventListener('submit',event=>{event.preventDefault();query=$('searchInput').value;page=1;render();});
$('searchInput').addEventListener('search',()=>{if(!$('searchInput').value){query='';page=1;render();}});
$('resetBtn').addEventListener('click',()=>{query='';page=1;$('searchInput').value='';render();});
$('menuBtn').addEventListener('click',()=>{$('menuBtn').setAttribute('aria-expanded',String($('mainNav').classList.toggle('open')));});
document.addEventListener('click',async event=>{
  const element=event.target.closest('a,button');if(!element)return;
  if(element.matches('[data-admin-contact]'))return;
  if(element.hasAttribute('data-mine-status')){mineStatus=element.dataset.mineStatus;page=1;render();return;}
  if(element.dataset.download){
    if(element.disabled)return;const label=element.textContent;element.disabled=true;
    try{await api('/api/packs/'+element.dataset.download+'/download-status');const link=document.createElement('a');link.href='/api/packs/'+element.dataset.download+'/download';link.download='';document.body.append(link);link.click();link.remove();notice('已请求下载，请查看浏览器下载记录');}catch(error){notice(error.message);}finally{element.disabled=false;element.textContent=label;}return;
  }
  if(element.dataset.image){$('lightboxImg').src='/media/'+element.dataset.image;$('lightbox').classList.add('open');$('lightbox').setAttribute('aria-hidden','false');return;}
  if(element.hasAttribute('data-retry')){location.reload();return;}
  if(element.dataset.page){page=Number(element.dataset.page);render();$('library').scrollIntoView();return;}
  if(element.dataset.goto){location.hash=element.dataset.goto;return;}
  if(element.dataset.view){$('mainNav').classList.remove('open');$('menuBtn').setAttribute('aria-expanded','false');page=1;return;}
  if(element.dataset.demo==='练习空间'){if(config.practiceOrigin)location.href=config.practiceOrigin;else notice('尚未配置练习空间地址');}
});
function closeImage(){$('lightbox').classList.remove('open');$('lightbox').setAttribute('aria-hidden','true');$('lightboxImg').removeAttribute('src');}
$('lightbox').addEventListener('click',closeImage);document.addEventListener('keydown',event=>{if(event.key==='Escape')closeImage();});
window.addEventListener('hashchange',()=>{if(publishingUI.isDirty()&&!confirm(publishingUI.isBusy()?'正在上传，离开会中断等待；内容可能已保存，请到“我的分享”检查。确定离开？':'分享内容尚未提交，确定放弃并离开？')){history.replaceState(null,'',renderedHash||'#discover');return;}renderedHash=location.hash;render();});
window.addEventListener('beforeunload',event=>{if(publishingUI.isDirty()){event.preventDefault();event.returnValue='';}});
window.addEventListener('scroll',()=>$('siteHeader').classList.toggle('scrolled',window.scrollY>10),{passive:true});
bindAdminContact({document});
try{
  const [capabilities,auth,identity]=await Promise.all([api('/api/java/capabilities'),api('/api/config'),api('/api/me')]);config={...capabilities,...auth};user=identity.user;identityView();
}catch(error){notice(error.message);}
render();
