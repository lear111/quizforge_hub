const panel=document.querySelector('[data-request]');
panel.addEventListener('click',async event=>{
  const button=event.target.closest('[data-decision]');if(!button||button.disabled)return;
  const controls=[...panel.querySelectorAll('button')],error=panel.querySelector('[role="alert"]');controls.forEach(item=>item.disabled=true);error.textContent='';
  try{
    const response=await fetch('/api/connect/authorize',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:panel.dataset.request,decision:button.dataset.decision})});
    const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'授权未完成，请重试');location.href=result.redirect;
  }catch(failure){error.textContent=failure.message;controls.forEach(item=>item.disabled=false);}
});
