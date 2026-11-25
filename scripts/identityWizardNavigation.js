'use strict';
async function inspect(page){
 require('./interactionLease').assert(page);
 try{return await page.evaluate(()=>{
  const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.visibility!=='hidden'&&s.display!=='none'&&!el.closest('[aria-hidden="true"],[inert]')};
  const dialogs=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible);
  const root=dialogs.at(-1)||document.querySelector('[role="main"]')||document.body;
  if(!root||document.readyState==='loading')return {ready:false};
  const buttons=[...root.querySelectorAll('button,[role="button"],a,[role="link"],[tabindex="0"]')].filter(visible).map(el=>({label:norm(el.getAttribute('aria-label')||el.innerText||el.textContent),enabled:!el.disabled&&!el.closest('[aria-disabled="true"],[aria-busy="true"]')}));
  const file=!!root.querySelector('input[type="file"]');
  const text=norm(root.innerText).slice(0,6000);
  const cnh=[...root.querySelectorAll('label,[role=radio],span,div')].some(el=>visible(el)&&/^(carteira de habilitacao|driver.?s? licen[cs]e)$/.test(norm(el.innerText)));
  // No DOM IDs, class names or enabled/disabled toggles: a re-render is not a new step.
  return {ready:true,buttons,file,text,cnh,signature:JSON.stringify([text,buttons.map(b=>b.label),file])};
 });}catch(error){if(/execution context.*destroy|cannot find context|context.*not found|cannot find.*context|inspected target navigated/i.test(String(error.message||error)))return {ready:false};throw error;}
}
async function navigate({page,deadlineAt,detect,selectCnh,reveal=async()=>{},record=()=>{},clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),stepTimeoutMs=60000,stableMs=700,click=(labels,timeoutMs)=>require('./interactionReadiness').clickControl(page,labels,{exact:true,withinDialog:true,timeoutMs})}){
 const terminal=new Set(['success','pending_review','marketplace_phone_confirm','marketplace_phone_entry','marketplace_phone_code','marketplace_phone_success']);
 let transitions=0,idleSince=clock();
 while(clock()<deadlineAt){
  await reveal();const screen=await detect();if(terminal.has(screen))return {ok:true,screen,transitions};
  let before=await inspect(page);
  if(!before.ready){if(clock()-idleSince>=stepTimeoutMs)return {ok:false,error:'identity_document_not_ready',screen,transitions};await sleep(250);continue;}
  if(screen==='upload_photo'||(before.file&&before.buttons.some(b=>/^(carregar|escolher arquivo|adicionar arquivo|upload)$/.test(b.label)))||/carregue uma foto (?:do seu|do) documento|upload a photo/.test(before.text))return {ok:true,screen:'upload_photo',transitions};
  if(before.cnh){
   const selected=await selectCnh();if(!selected?.ok)return {ok:false,error:'cnh_not_selected',screen,transitions};
   before=await inspect(page);
   if(!before.ready){await sleep(250);continue;}
  }
  const available=before.buttons.filter(b=>b.enabled).map(b=>b.label);
  const pick=patterns=>available.find(label=>patterns.some(p=>p.test(label)));
  const label=before.cnh?pick([/^(avancar|next)$/]):
   pick([/^(continuar|continue)$/])||pick([/^(carregar|enviar|upload|adicionar) (?:seu |your )?(?:documento de identidade|identity document|id)$/])||
   pick([/^(avancar|next)$/, /^a seguir:.*verificacao/, /^continue para a verificacao/])||
   pick([/^(?:confirme|confirmar|verificar|verifique)(?: sua)? identidade$/, /^(?:confirm|verify)(?: your)? identity$/]);
  if(!label){if(clock()-idleSince>=stepTimeoutMs)return {ok:false,error:'identity_control_not_ready',screen,transitions};await sleep(250);continue;}
  const clicked=await click([label],Math.max(1,Math.min(15000,deadlineAt-clock())));
  record({event:'control_click',screen,label,clicked:clicked?.ok===true});
  if(!clicked?.ok){if(clock()-idleSince>=stepTimeoutMs)return {ok:false,error:'identity_control_not_clickable',screen,transitions};await sleep(250);continue;}
  const until=Math.min(deadlineAt,clock()+stepTimeoutMs);let candidate=null,since=0,changed=false;
  while(clock()<until){
   await sleep(250);const nextScreen=await detect();if(terminal.has(nextScreen))return {ok:true,screen:nextScreen,transitions:transitions+1};
   const next=await inspect(page);if(!next.ready){candidate=null;since=0;continue;}
   if(next.signature!==before.signature){if(candidate!==next.signature){candidate=next.signature;since=clock();}if(clock()-since>=stableMs){changed=true;break;}}
   else{candidate=null;since=0;}
  }
  if(!changed)return {ok:false,error:'identity_transition_unconfirmed',screen,control:label,transitions};
  record({event:'transition_confirmed',screen,label});transitions++;idleSince=clock();
 }
 return {ok:false,error:'identity_navigation_budget_exhausted',transitions};
}
module.exports={navigate,inspect};
