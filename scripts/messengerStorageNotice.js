'use strict';
function matches(text){const t=String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();return /alteracoes nas configuracoes de armazenamento seguro|changes to (your )?secure storage settings/.test(t)&&/sincronizacao automatica|automatic.*sync/.test(t);}
async function dismiss(page){
 const marker='data-ct-storage-notice-ok';
 const found=await page.evaluate(({marker})=>{
  const match=text=>{const t=String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();return /alteracoes nas configuracoes de armazenamento seguro|changes to (your )?secure storage settings/.test(t)&&/sincronizacao automatica|automatic.*sync/.test(t)};
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.visibility!=='hidden'&&s.display!=='none'};
  for(const e of document.querySelectorAll('['+marker+']'))e.removeAttribute(marker);
  for(const d of document.querySelectorAll('[role="dialog"],[aria-modal="true"]')){
   if(!visible(d)||!match(d.innerText||d.textContent))continue;
   for(const b of d.querySelectorAll('button,[role="button"]'))if(visible(b)&&String(b.innerText||b.textContent).trim().toLowerCase()==='ok'&&b.getAttribute('aria-disabled')!=='true'){b.setAttribute(marker,'1');return {present:true,clickable:true};}
   return {present:true,clickable:false};
  }return {present:false};
 },{marker});
 if(!found.present)return found;
 if(!found.clickable)return {...found,closed:false};
 const button=await page.$('['+marker+'="1"]');if(!button)return {...found,closed:false};await button.click({delay:60});
 try{await page.waitForFunction(({marker})=>{const b=document.querySelector('['+marker+'="1"]');if(!b)return true;const r=b.getBoundingClientRect();return r.width<2||r.height<2},{timeout:5000},{marker});return {...found,closed:true};}catch{return {...found,closed:false};}
}
module.exports={matches,dismiss};
