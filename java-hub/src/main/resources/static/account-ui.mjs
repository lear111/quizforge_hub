import {escapeHtml as esc} from './catalog-view.mjs';
const field=(name,label,type='text',autocomplete='off')=>`<label>${label}<input name="${name}" type="${type}" autocomplete="${autocomplete}" required${name==='password'?' minlength="10" maxlength="128"':''}${name==='name'?' maxlength="30"':''}></label>`;
export function authPage(mode,config={}){
  const register=mode==='register',policy=config.authPolicy||{},code=register?policy.registrationCodeRequired:policy.loginCodeRequired,captcha=register?policy.registrationCaptchaRequired:policy.loginCaptchaRequired;
  const unavailable=register&&!config.registrationReady;
  return `<div class="account-panel"><h1>${register?'注册账号':'登录'}</h1>${unavailable?'<p class="account-note" role="status">注册验证服务暂未开放，请稍后再来。已有账号可以正常尝试登录。</p>':''}<form class="account-form" data-account-auth="${mode}">${register?field('name','用户名','text','nickname'):''}${field('identifier','邮箱或中国大陆手机号','text','username')}${field('password','密码','password',register?'new-password':'current-password')}${register&&policy.invitationRequired?field('invitationCode','邀请码'):''}${code?'<div class="account-code-row">'+field('code','六位验证码','text','one-time-code')+'<button class="btn-outline" type="button" data-send-code>获取验证码</button></div>':''}${captcha?'<div class="account-captcha" data-captcha></div>':''}<p class="account-error" role="alert"></p><button class="btn-filled" type="submit"${unavailable?' disabled':''}>${register?'注册并登录':'登录'}</button></form><div class="account-actions"><a class="account-inline-link" href="#${register?'login':'register'}">${register?'已有账号，去登录':'注册新账号'}</a><a href="#discover">返回题库广场</a></div></div>`;
}
export function profilePage(user,config={}){
  const initial=esc(Array.from(user.name||'Q')[0].toUpperCase());
  const binding=!user.email?'email':!user.phone?'phone':null;
  const contact=(channel,label,symbol)=>{
    const value=user[channel],unverified=user.unverifiedContacts?.includes(channel);
    return `<div class="info-row"><span class="info-label">${icon(symbol)}${label}</span><span class="info-value account-contact-value">${value?`${esc(value)}<span class="bound${unverified?' account-unverified':''}">${unverified?'待验证':'已绑定'}</span>`:'<span class="account-note">未绑定</span>'}</span>${binding===channel?'<button class="text-btn" type="button" data-open-bind>绑定</button>':'<span></span>'}</div>`;
  };
  const bind=binding?`<details class="account-bind-panel" data-account-bind-panel><summary>补绑${binding==='email'?'邮箱':'手机号'}</summary><p class="account-note">补绑保留当前账号、已有题库、设备和余额。暂不支持覆盖已绑定的联系方式。</p><form class="account-form" data-account-bind>${field(binding,binding==='email'?'邮箱':'中国大陆手机号','text',binding==='email'?'email':'tel')}${field('password','当前密码','password','current-password')}<div class="account-code-row">${field('code','六位验证码','text','one-time-code')}<button class="btn-outline" type="button" data-send-bind>获取验证码</button></div><div class="account-captcha" data-captcha></div><p class="account-error" role="alert"></p><button class="btn-filled" type="submit">确认绑定</button></form></details>`:'';
  return `<div class="pf-head"><span class="pf-avatar" aria-hidden="true">${initial}</span><div><h1 id="pfName">${esc(user.name)}</h1><p>个人中心${user.id?` · 用户 ID ${esc(user.id)}`:''}</p></div></div>
    <div class="pf-layout">
      <div class="pf-main">
        <section class="panel" aria-labelledby="accTitle"><div class="panel-title"><h2 id="accTitle">账户信息</h2></div>
          <div class="info-row"><span class="info-label">${icon('image')}头像</span><span class="info-value"><span class="mini-avatar" aria-hidden="true">${initial}</span></span><span></span></div>
          <div class="info-row"><span class="info-label">${icon('user')}用户名</span><span class="info-value">${esc(user.name)}</span><span></span></div>
          ${contact('email','绑定邮箱','mail')}${contact('phone','绑定手机','phone')}
          <div class="info-row"><span class="info-label">${icon('lock')}登录密码</span><span class="info-value">已设置</span><span></span></div>
          ${bind}
        </section>
        <section class="panel" aria-labelledby="devTitle"><div class="panel-title"><div><h2 id="devTitle">已连接设备</h2><small data-account-device-count></small></div></div><p class="account-note">管理电脑和 Android 的设备连接。撤销后需重新连接；当前网页登录单独退出。</p><div data-account-devices role="status">正在读取设备…</div></section>
        <button class="logout-btn pf-logout-m" type="button" data-account-logout>${icon('logout')}退出当前网页登录</button>
      </div>
      <aside class="pf-side">
        <section class="panel" aria-label="账户余额"><div class="balance-label">${icon('wallet')}账户余额</div>${(config.native||[]).includes('ai-balance')?`<div class="balance-num" data-ai-balance>正在读取…</div><p class="account-note">用于 QuizForge 官方 AI 评分</p><form data-account-ai-redeem><label class="account-form">兑换码<input name="code" maxlength="64" required autocomplete="off"></label><button class="btn-outline" type="submit">兑换额度</button><p class="account-error" role="alert"></p></form><details class="account-ai-history"><summary>收支明细</summary><div data-ai-history></div></details><p class="account-note" data-ai-read-error></p><button class="text-btn" type="button" data-ai-refresh>重新读取</button><button class="btn-filled" type="button" disabled title="暂未开放">充值</button>`:`<div class="balance-num account-balance-pending" aria-label="余额暂不可查询">—</div><p class="account-note">暂不可查询</p><div class="balance-actions"><button class="btn-filled" type="button" disabled title="暂未开放">充值</button><button class="btn-outline" type="button" disabled title="暂未开放">明细</button></div>`}</section>
        <button class="btn-outline account-contact-button" type="button" data-admin-contact>${icon('comment')}联系管理员</button>
        <button class="logout-btn pf-logout-d" type="button" data-account-logout>${icon('logout')}退出当前网页登录</button>
        <p class="account-error" role="alert" data-account-status></p>
      </aside>
    </div>`;
}
const icon=name=>`<svg aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
export function deviceCards(devices){
  const time=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'暂无记录';};
  return devices.map(item=>`<div class="device account-device" data-device="${esc(item.id)}"><span class="dev-icon">${icon(item.client==='web'?'monitor':'phone')}</span><div class="dev-info"><label class="account-device-label">设备名称<input aria-label="设备名称" maxlength="80" value="${esc(item.name)}"></label><small>${esc(item.client==='web'?'电脑':item.client==='android'?'Android':'其他客户端')} · 最近使用 ${esc(time(item.lastUsed||item.created))}</small><p class="account-error" role="alert"></p></div><div class="account-device-actions"><button class="btn-outline" type="button" data-device-save>保存名称</button><button class="btn-outline" type="button" data-device-revoke>撤销连接</button></div></div>`).join('');
}
let captchaScript;
function loadCaptcha(){
  if(globalThis.turnstile)return Promise.resolve(globalThis.turnstile);
  if(!captchaScript)captchaScript=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.onload=()=>resolve(globalThis.turnstile);script.onerror=()=>{captchaScript=null;script.remove();reject(new Error('暂时无法加载人机验证，请重试。'));};document.head.append(script);});
  return captchaScript;
}
export function createAccountUI({container,getUser,setUser,getConfig,onIdentity}){
  let turn=0,controller,widget=null,token='',resume='';
  const resetCaptcha=()=>{token='';if(widget!==null&&globalThis.turnstile)globalThis.turnstile.reset(widget);};
  const clear=()=>{turn++;controller?.abort();controller=new AbortController();token='';if(widget!==null&&globalThis.turnstile)globalThis.turnstile.remove(widget);widget=null;};
  async function request(path,body,method=body===undefined?'GET':'POST'){
    const response=await fetch(path,{method,signal:controller.signal,credentials:'same-origin',cache:'no-store',redirect:'error',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    const value=await response.json();if(!response.ok)throw new Error(typeof value.error==='string'?value.error:value.error?.message||'操作未完成，请重试');return value;
  }
  async function captcha(form){
    const target=form?.querySelector('[data-captcha]');if(!target)return;
    if(!getConfig().captchaReady){form.querySelector('[role="alert"]').textContent='人机验证暂未配置，暂时无法完成此操作。';return;}
    const generation=turn;
    try{const api=await loadCaptcha();if(generation!==turn)return;const bind=form.hasAttribute('data-account-bind'),register=form.dataset.accountAuth==='register';const channel=()=>bind?'bind_contact':`${register?'register':'login'}_${form.elements.identifier.value.includes('@')?'email':'phone'}`;
      let renderedAction='';const mount=()=>{if(generation!==turn)return;const action=channel();if(action===renderedAction)return;if(widget!==null)api.remove(widget);token='';renderedAction=action;widget=api.render(target,{sitekey:getConfig().turnstileSiteKey,action,callback:value=>{if(generation===turn)token=value;},'expired-callback':()=>{if(generation===turn)token='';},'error-callback':()=>{if(generation!==turn)return;token='';form.querySelector('[role="alert"]').textContent='人机验证未完成，请重试。';}});};
      mount();if(!bind)form.elements.identifier.addEventListener('input',mount);
    }catch(error){if(generation===turn)form.querySelector('[role="alert"]').textContent=error.message;}
  }
  const money=value=>'¥'+(Number(value)/10000).toFixed(Number(value)%100?4:2);
  async function refreshBalance(){const generation=turn;try{const value=await request('/api/account/ai');if(generation!==turn)return;container.querySelector('[data-ai-balance]').textContent=money(value.balance);const names={signup:'新用户赠送',redeem:'兑换',admin:'管理员调整',grading:'AI 评分'};container.querySelector('[data-ai-history]').innerHTML=value.history.map(item=>`<p>${esc(item.day||new Date(item.at).toLocaleDateString('zh-CN'))} · ${esc(names[item.kind]||item.kind)} ${money(item.delta)}${item.note?`<small> ${esc(item.note)}</small>`:''}</p>`).join('')||'<p class="account-note">暂无收支记录。</p>';container.querySelector('[data-ai-read-error]').textContent='';}catch(error){if(generation===turn&&container.querySelector('[data-ai-read-error]'))container.querySelector('[data-ai-read-error]').textContent=error.message;}}
  function inputs(form){return Object.fromEntries(new FormData(form).entries());}
  function feedback(form,message,success=false){const target=form.querySelector('[role="alert"]');target.textContent=message;target.classList.toggle('account-success',success);}
  function cooldown(button){let seconds=60;button.disabled=true;button.textContent=`${seconds} 秒后重发`;const generation=turn;const timer=setInterval(()=>{if(generation!==turn){clearInterval(timer);return;}seconds--;button.textContent=seconds?`${seconds} 秒后重发`:'获取验证码';if(!seconds){clearInterval(timer);button.disabled=false;}},1000);}
  async function render(route){
    clear();container.hidden=false;const generation=turn;
    resume='';const returning=/^connect-login\/([a-f0-9]{64})$/.exec(route),practice=/^practice-login\/([a-f0-9]{64})$/.exec(route);if(returning)resume='/connect/authorize?request='+returning[1];if(practice)resume='/practice-auth/authorize?request='+practice[1];if(route==='admin')resume='/admin/';
    if(resume&&getUser()){location.href=resume;return;}
    const user=getUser(),profile=route==='profile'&&user;container.innerHTML=profile?profilePage(user,getConfig()):authPage(route==='register'?'register':'login',getConfig());
    document.title=(profile?'个人中心':route==='register'?'注册账号':'登录')+' · QuizForge';
    if(!profile)captcha(container.querySelector('form'));
    const bindPanel=container.querySelector('[data-account-bind-panel]');
    bindPanel?.addEventListener('toggle',()=>{if(bindPanel.open&&!bindPanel.dataset.captchaMounted){bindPanel.dataset.captchaMounted='true';captcha(bindPanel.querySelector('form'));}});
    if(profile){try{const value=await request('/api/connect/devices');if(generation!==turn)return;container.querySelector('[data-account-device-count]').textContent=`${value.devices.length} 台设备`;container.querySelector('[data-account-devices]').innerHTML=value.devices.length?deviceCards(value.devices):'<p class="account-note">暂无已连接设备。</p>';}catch(error){if(generation===turn)container.querySelector('[data-account-devices]').textContent=error.message;}if((getConfig().native||[]).includes('ai-balance'))await refreshBalance();}
  }
  container.addEventListener('submit',async event=>{
    if(event.target.matches('[data-account-ai-redeem]')){event.preventDefault();const form=event.target,button=form.querySelector('button'),generation=turn;button.disabled=true;try{await request('/api/account/ai/redeem',{code:form.elements.code.value});if(generation!==turn)return;form.elements.code.value='';feedback(form,'兑换成功',true);await refreshBalance();}catch(error){if(generation===turn)feedback(form,error.message);}finally{if(generation===turn)button.disabled=false;}return;}
    const form=event.target.closest('[data-account-auth],[data-account-bind]');if(!form)return;event.preventDefault();const generation=turn,button=form.querySelector('[type="submit"]');button.disabled=true;feedback(form,'');
    try{const bind=form.hasAttribute('data-account-bind'),mode=form.dataset.accountAuth;const value=await request(bind?'/api/account/contact':'/api/auth/'+mode,{...inputs(form),captchaToken:token});if(generation!==turn)return;setUser(value.user);onIdentity();if(resume){location.href=resume;return;}if(bind||location.hash==='#profile')await render('profile');else location.hash='profile';}
    catch(error){if(error.name!=='AbortError'&&generation===turn){feedback(form,error.message);resetCaptcha();button.disabled=false;}}
  });
  container.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;const generation=turn,form=button.closest('form');
    if(button.hasAttribute('data-ai-refresh')){button.disabled=true;try{await refreshBalance();}finally{if(generation===turn)button.disabled=false;}return;}
    if(button.hasAttribute('data-open-bind')){const panel=container.querySelector('[data-account-bind-panel]');if(panel){panel.open=true;panel.querySelector('input').focus();}return;}
    if(button.matches('[data-send-code],[data-send-bind]')){
      button.disabled=true;feedback(form,'');
      try{const value=inputs(form),bind=button.hasAttribute('data-send-bind'),register=form.dataset.accountAuth==='register';if(!bind&&register&&!value.identifier)throw new Error('请先填写邮箱或手机号');if(bind&&!value.email&&!value.phone)throw new Error('请先填写要绑定的联系方式');if(!bind&&!register&&!value.password)throw new Error('请先填写当前密码');const channel=value.identifier?.includes('@')?'email':'phone';const body=bind?value:register?{[channel]:value.identifier,invitationCode:value.invitationCode}:{identifier:value.identifier,password:value.password};await request(bind?'/api/account/contact-code':register?'/api/auth/'+channel+'-code':'/api/auth/login-code',{...body,captchaToken:token});if(generation!==turn)return;feedback(form,'验证码请求已提交，请注意查收。',true);cooldown(button);resetCaptcha();}catch(error){if(error.name!=='AbortError'&&generation===turn){feedback(form,error.message);button.disabled=false;resetCaptcha();}}return;
    }
    const error=button.closest('[data-device]')?.querySelector('[role="alert"]')||container.querySelector('[data-account-status]')||button.closest('.account-panel')?.querySelector('[role="alert"]');
    if(button.hasAttribute('data-account-logout')){button.disabled=true;try{await request('/api/auth/logout',{});if(generation!==turn)return;setUser(null);onIdentity();resume='';location.hash='login';}catch(failure){if(generation===turn){error.textContent=failure.message;button.disabled=false;}}return;}
    const device=button.closest('[data-device]');if(device&&button.matches('[data-device-save],[data-device-revoke]')){const revoke=button.hasAttribute('data-device-revoke');if(revoke&&!confirm('确定撤销这台设备的连接吗？'))return;button.disabled=true;try{await request('/api/connect/devices/'+device.dataset.device,revoke?undefined:{name:device.querySelector('input').value},revoke?'DELETE':'PUT');if(generation===turn)await render('profile');}catch(failure){if(generation===turn){error.textContent=failure.message;button.disabled=false;}}}
  });
  return {render,clear};
}
