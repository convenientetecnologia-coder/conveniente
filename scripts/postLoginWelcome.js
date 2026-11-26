'use strict';
// Only invoked after this credential driver's submission. Not a global dismiss rule.
function inspect(){
 const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&!e.closest('[aria-hidden="true"],[inert]')};
 if(!/(^|\.)(facebook|messenger)\.com$/.test(location.hostname))return {blocked:true};
 if(!document.body||document.readyState==='loading')return {loading:true};
 const buttons=[...document.querySelectorAll('button,[role="button"],a,[role="link"],input[type="submit"],input[type="button"],div[tabindex="0"]')].filter(e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!e.closest('[aria-disabled="true"]'));
 const wanted=['ignorar','skip','ignore'];
 const hasIgnore=buttons.some(e=>wanted.includes(norm(e.getAttribute('aria-label')))||wanted.includes(norm(e.innerText||e.textContent||e.value)));
 // The operator requested this button after password submission. Background controls
 // and the language of the notice must not prevent its lookup.
 const inputs=[...document.querySelectorAll('input')].filter(visible);
 const otherStep=buttons.length>0||inputs.some(e=>e.type==='password'||/pin|code|codigo|otp|approvals/i.test([e.name,e.id,e.autocomplete,e.getAttribute('aria-label')].join(' ')));
 return {hasIgnore,otherStep,signature:location.href+'|'+buttons.map(e=>norm(e.getAttribute('aria-label')||e.innerText||e.value)).join('|')};
}
async function advance(page,{authenticated=async()=>false,onProgress=async()=>{},timeoutMs=180000}={}){
 const until=Date.now()+require('./interactionBudget').timeout(page,timeoutMs);let clicked=false,stableAt=0,signature=null;
 while(Date.now()<until){
  await require('./interactionLease').wait(page);
  let state;
  try{state=await page.evaluate(inspect)}catch(error){
   if(!/execution context was destroyed|cannot find.*context|context.*destroyed|inspected target navigated/i.test(String(error.message||error)))throw error;
   await new Promise(r=>setTimeout(r,250));continue;
  }
  if(state.blocked)return clicked?{ok:false,error:'login_welcome_next_step_unconfirmed'}:{ok:true,skipped:true};
  if(state.hasIgnore){
   stableAt=0;
   if(!clicked){
    const hit=await require('./interactionReadiness').clickControl(page,['Ignorar','Skip','Ignore'],{exact:true,timeoutMs:Math.min(30000,Math.max(0,until-Date.now()))});
    if(!hit.ok)return {ok:false,error:'login_welcome_click_unconfirmed'};
    clicked=true;await onProgress({stage:'welcome_loading',welcomeDismissClicked:true});
   }
  }else if(!state.loading){
   // A click is not success: wait for the prompt to disappear and authentication to be observed.
   if(await authenticated()){
    if(signature!==state.signature||!stableAt){signature=state.signature;stableAt=Date.now()}
    if(Date.now()-stableAt>=2000)return {ok:true,dismissed:clicked};
   }else if(state.otherStep)return clicked?{ok:false,error:'login_welcome_next_step_unconfirmed'}:{ok:true,skipped:true};
   else stableAt=0;
  }
  await new Promise(r=>setTimeout(r,250));
 }
 return {ok:false,error:clicked?'login_welcome_result_unconfirmed':'login_post_submit_surface_unconfirmed'};
}
module.exports={inspect,advance};
