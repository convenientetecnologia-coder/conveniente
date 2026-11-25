'use strict';

// Dismiss only the informational Meta account arrival notice, never a security gate.
function inspect({mark=false}={}){
 const marker='data-ct-meta-arrival-close';
 const norm=t=>String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&!e.closest('[aria-hidden="true"],[inert]')};
 if(mark)for(const e of document.querySelectorAll('['+marker+']'))e.removeAttribute(marker);
 for(const dialog of document.querySelectorAll('[role="dialog"],[aria-modal="true"]')){
  if(!visible(dialog))continue;
  const t=norm(dialog.innerText||dialog.textContent);
  if(!t.includes('sua conta meta chegou')||!t.includes('sua conta atualizada funciona nos apps e dispositivos da meta'))continue;
  for(const button of dialog.querySelectorAll('button,[role="button"]')){
   const aria=norm(button.getAttribute('aria-label')),text=norm(button.innerText||button.textContent);
   if(!visible(button)||button.disabled||button.getAttribute('aria-disabled')==='true')continue;
   if(!['fechar','close','dismiss'].includes(aria)&&!['×','✕','✖','x'].includes(text))continue;
   if(mark)button.setAttribute(marker,'1');
   return {present:true,closable:true};
  }
  return {present:true,closable:false};
 }
 return {present:false};
}
async function dismiss(page,{timeoutMs=5000,confirmMs=5000}={}){
 const guard=()=>require('./interactionLease').assert(page);
 guard();const found=await page.evaluate(inspect,{mark:true});
 if(!found.present)return found;
 if(!found.closable)return {...found,closed:false,reason:'close_not_available'};
 const handle=await page.$('[data-ct-meta-arrival-close="1"]');
 if(!handle)return {...found,closed:false,reason:'close_disappeared'};
 try{
  const ready=await require('./interactionReadiness').waitElement(page,handle,{timeoutMs});
  if(!ready.ok)return {...found,closed:false,reason:ready.reason};
  guard();await handle.click();
  const until=Date.now()+confirmMs;
  while(Date.now()<until){guard();if(!(await page.evaluate(inspect,{mark:false})).present)return {...found,closed:true};await new Promise(r=>setTimeout(r,150));}
  return {...found,closed:false,reason:'close_unconfirmed'};
 }finally{await handle.dispose().catch(()=>{});}
}
module.exports={inspect,dismiss};
