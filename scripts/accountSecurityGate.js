'use strict';
function inspect(){
 if(!/^(?:www\.|web\.|m\.|mbasic\.)?(?:facebook|messenger)\.com$/.test(location.hostname))return {state:'none'};
 const norm=t=>String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
 const text=norm(document.body?.innerText),headings=[...document.querySelectorAll('h1,h2,[role="heading"],[role="dialog"],[aria-modal="true"]')].filter(visible).filter(e=>!e.closest('[role="grid"],[role="feed"],[role="row"]')).map(e=>norm(e.innerText));
 const social=[...document.querySelectorAll('[role="grid"],[role="feed"]')].some(visible);
 const prompt=/confirme que esta conta (?:da meta )?e sua|confirmar que esta conta e sua|entre com outro dispositivo para desbloquear|confirm this (?:meta )?account is yours/;
 const dialog=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible).find(e=>prompt.test(norm(e.innerText)));
 const security=headings.some(t=>prompt.test(t))||(!social&&prompt.test(text)&&/restringimos sua conta|pode ter sido (?:invadida|hackeada)|provar que esta conta|belongs to you/.test(text));
 const gateText=dialog?norm(dialog.innerText):!social?text:headings.join(' ');
 const verification=security||!social&&/\/checkpoint|\/two_step_verification|\/auth_platform/.test(location.pathname);
 if(verification&&/selfie.{0,50}video|video.{0,50}selfie|grave (?:um|uma).{0,25}video/.test(gateText))return {state:'selfie',reason:'identity_confirm_selfie'};
 if(security&&/codigo|code/.test(gateText)){
  const options=social&&!dialog?[]:[...(dialog||document).querySelectorAll('button,[role="button"],label,[role="radio"],li')].filter(visible).map(e=>norm(e.innerText));
  const phone=options.some(t=>/codigo|code/.test(t)&&/telefone|phone/.test(t))||/(?:receb\w*|envi\w*|receive|send).{0,45}(?:codigo|code).{0,45}(?:telefone|phone)/.test(gateText);
  const whatsapp=options.some(t=>/codigo|code/.test(t)&&/whatsapp/.test(t))||/(?:receb\w*|envi\w*|receive|send).{0,45}(?:codigo|code).{0,45}whatsapp/.test(gateText);
  if(phone||whatsapp)return {state:'code',phone,whatsapp,reason:phone&&whatsapp?'account_code_phone_whatsapp':phone?'account_code_phone':'account_code_whatsapp'};
 }
 const starts=['comecar','iniciar etapas de seguranca','get started','start security steps'];
 const entry=security&&[...document.querySelectorAll('button,[role="button"],a[role="link"]')].some(e=>visible(e)&&starts.includes(norm(e.innerText)));
 return entry?{state:'entry',reason:'account_security_entry'}:security?{state:'security',reason:'account_security_unresolved'}:{state:'none'};
}
const attempted=new WeakMap();
async function check({page,nome,advance=true,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),persist=save}){
 let current=await page.evaluate(inspect);
 if(current.state==='entry'&&advance){
  const last=attempted.get(page);
  if(last===undefined||clock()-last>=45000){
   attempted.set(page,clock());
   const clicked=await page.evaluate(()=>{
    const norm=t=>String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
    const prompt=/confirme que esta conta (?:da meta )?e sua|confirmar que esta conta e sua|entre com outro dispositivo para desbloquear|confirm this (?:meta )?account is yours/;
    const scope=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible).find(e=>prompt.test(norm(e.innerText)))||document;
    if(!prompt.test(norm(scope===document?document.body?.innerText:scope.innerText)))return false;
    if(scope===document&&[...document.querySelectorAll('[role="grid"],[role="feed"]')].some(visible))return false;
    for(const e of scope.querySelectorAll('button,[role="button"],a[role="link"]')){const r=e.getBoundingClientRect(),s=getComputedStyle(e);if(r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&e.getAttribute('aria-disabled')!=='true'&&['comecar','iniciar etapas de seguranca','get started','start security steps'].includes(norm(e.innerText))){e.click();return true}}return false;
   });
   if(clicked){const until=clock()+45000;let readySince=null;while(clock()<until){await sleep(500);current=await page.evaluate(inspect);if(['code','selfie'].includes(current.state))break;if(current.state==='none'){if(readySince===null)readySince=clock();if(clock()-readySince>=2000)break}else readySince=null;}}
  }
 }
 if(['selfie','code'].includes(current.state)){await persist(nome,current);return {ok:false,...current};}
 if(current.state!=='none')return {ok:false,...current,reason:'security_step_unconfirmed'};
 return {ok:true,state:'ready'};
}
async function save(nome,state){
 await require('./manifestStore').update(nome,man=>{man=man||{};const f=man.accountFlags=man.accountFlags||{};
  if(state.state==='code'){f.accountCodePhone=state.phone===true;f.accountCodeWhatsapp=state.whatsapp===true;f.accountCodeAt=Date.now();f.accountCodeReason=state.reason;f.identityRequired=false;f.identitySubmitted=false;}
  else{f.identityRequired=true;f.identityRequiredAt=Date.now();f.identityRequiredSource='account_security_gate';}
  man.accountSecurity={state:state.state,reason:state.reason,at:Date.now()};return man;
 });
}
function fromFlags(flags={}){
 if(flags.banned)return 'banned';
 if(flags.accountCodePhone||flags.accountCodeWhatsapp)return 'account_code';
 if(flags.identityRequired||flags.identitySubmitted)return 'identity_required';
 if(flags.captchaCheckpoint)return 'captcha_checkpoint';
 if(flags.twoFactor)return 'two_factor';
 if(flags.whatsappConfirm)return 'whatsapp_confirm';
 if(flags.idVirtus)return 'id_virtus';
 if(flags.marketplaceDisabled)return 'marketplace_disabled';
 return null;
}
async function assertAllowed(page,nome){
 const browser=require('./browser');const ban=await browser.detectAccountSuspended(page);
 if(ban.banned){await require('./manifestStore').update(nome,m=>{m=m||{};m.accountFlags={...m.accountFlags,banned:true,bannedAt:Date.now(),bannedReason:ban.reason,bannedText:ban.snippet};return m});throw Error('account_security:banned')}
 const result=await check({page,nome});if(!result.ok)throw Error('account_security:'+result.reason);
 return result;
}
module.exports={inspect,check,assertAllowed,fromFlags};
