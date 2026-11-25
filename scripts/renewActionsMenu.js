'use strict';
const names=['renovar no marketplace','renovar classificados','renovar','renew in marketplace','renew on marketplace','renew listings','renew'];
async function inspect(page){
 require('./interactionLease').assert(page);
 return page.evaluate(names=>{
  const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&!el.closest('[aria-hidden="true"],[inert]')};
  const items=[...document.querySelectorAll('[role="menuitem"],[role="menu"] [role="button"],[role="menu"] button,[role="menu"] a,[role="button"],button')].filter(visible);
  const menu=[];let target=null;
  for(const el of items){
   const label=norm(el.getAttribute('aria-label')||el.innerText||el.textContent);
   const inMenu=!!el.closest('[role="menu"]')||el.getAttribute('role')==='menuitem';
   if(inMenu&&menu.length<20)menu.push({label:label.slice(0,100),enabled:!el.disabled&&!el.closest('[aria-disabled="true"],[aria-busy="true"]')});
   if(!names.includes(label)||(!inMenu&&/^(renovar|renew|renew listings|renovar classificados)$/.test(label)))continue;
   const candidate={label,enabled:!el.disabled&&!el.closest('[aria-disabled="true"],[aria-busy="true"]'),inMenu};
   if(!target||candidate.enabled&&!target.enabled)target=candidate;
  }
  return {target,menu};
 },names);
}
async function openAndChoose(page,{timeoutMs=120000,deadlineAt=0,onAudit=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const until=Math.min(Date.now()+timeoutMs,Number(deadlineAt)||Infinity),remaining=()=>Math.max(1,until-Date.now());
 const controls=require('./interactionReadiness');
 let snapshot=await inspect(page);
 if(!snapshot.target){
  const opened=await controls.clickControl(page,['Ações','Actions'],{exact:true,timeoutMs:remaining()});
  if(!opened.ok)return {ok:false,error:'actions_not_clickable',menu:snapshot.menu};
 }

 while(Date.now()<until){
  snapshot=await inspect(page);const target=snapshot.target;
  if(target){
   if(target.enabled){
    const clicked=await controls.clickControl(page,[target.label],{exact:true,withinSelector:target.inMenu?'[role="menu"],[role="menuitem"]':null,timeoutMs:remaining()});
    onAudit('renew_option_click',{label:target.label,ok:clicked.ok===true,menu:snapshot.menu});
    return clicked.ok?{ok:true,menu:snapshot.menu}:{ok:false,error:'renew_option_not_clickable',menu:snapshot.menu};
   }
  }
  await sleep(250);
 }
 return {ok:false,error:snapshot.target&&!snapshot.target.enabled?'renew_option_disabled':'renew_menu_unconfirmed',menu:snapshot.menu};
}
module.exports={inspect,openAndChoose};
