'use strict';
async function check(page,{browser=require('./browser'),clock=Date.now,securityCheck=null}={}){
 const banned=await browser.detectAccountSuspended(page);if(banned.banned)return {ok:false,state:'banned',reason:banned.reason};
 if(securityCheck){const security=await securityCheck(page);if(!security.ok)return security;}
 const captcha=await browser.detectCaptchaChallenge(page);if(captcha.ok===false)throw Error('virtus_captcha_probe_failed');if(captcha.present)return {ok:false,state:'captcha',reason:'captcha_present'};
 const identity=await browser.detectVirtusIdentityBlock(page);if(identity.blocked)return {ok:false,state:'identity',reason:identity.reason};
 const login=await browser.detectLoginRequired(page);if(login.loginRequired)return {ok:false,state:'login',reason:login.reason};
 const storage=await require('./messengerStorageNotice').dismiss(page);
 if(storage.present&&!storage.closed)return {ok:false,state:'storage_notice',reason:'close_unconfirmed'};
 const restore=await restoreNotice(page);
 if(restore.present){if(!restore.closed)return {ok:false,state:'restore_notice',reason:'close_unconfirmed'};}
 const historyWarning=await page.evaluate(()=>{const t=String(document.body?.innerText||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ');return t.includes('o historico da conversa esta faltando')&&t.includes('inserir pin')});
 let pin=await browser.detectMessengerPinModal(page);
 if(historyWarning&&!pin?.present){
  const marker='data-ct-proxy-pin-banner';
  const found=await page.evaluate(marker=>{
   const norm=t=>String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
   for(const el of document.querySelectorAll('['+marker+']'))el.removeAttribute(marker);
   for(const button of document.querySelectorAll('button,[role="button"]')){
    if(norm(button.innerText||button.textContent)!=='inserir pin')continue;
    const r=button.getBoundingClientRect();if(r.width<2||r.height<2||button.getAttribute('aria-disabled')==='true')continue;
    let parent=button.parentElement;
    for(let n=0;n<6&&parent&&parent!==document.body;n++,parent=parent.parentElement){if(norm(parent.innerText||parent.textContent).includes('o historico da conversa esta faltando')){button.setAttribute(marker,'1');return true}}
   }return false;
  },marker);
  if(found){const button=await page.$('['+marker+'="1"]');if(button){await button.click({delay:60});try{await page.waitForSelector('#mw-numeric-code-input-prevent-composer-focus-steal',{visible:true,timeout:5000})}catch{}pin=await browser.detectMessengerPinModal(page)}}
  if(!pin?.present)return {ok:false,state:'pin',reason:'history_missing_pin_banner'};
 }if(pin?.probeFailed)throw Error('virtus_pin_probe_failed');
 if(pin?.present){
  // Reuse the established account handler only for an existing PIN prompt.
  if(pin.kind!=='pin_input')return {ok:false,state:'pin',reason:pin.kind||'pin_required'};
  const now=clock();if(!page.__ctProxyPinAttemptAt||now-page.__ctProxyPinAttemptAt>=45000){page.__ctProxyPinAttemptAt=now;await browser.tryDismissMessengerPinModal(page,{logPrefix:'[VIRTUS_PROXY][PIN]',maxTries:1});}
  const after=await browser.detectMessengerPinModal(page);if(after?.probeFailed)throw Error('virtus_pin_probe_failed');if(after?.present)return {ok:false,state:'pin',reason:after.kind||'pin_required'};
 }
 return {ok:true,state:'ready'};
}
async function restoreNotice(page){
 const marker='data-ct-proxy-restore-close';
 const present=await page.evaluate(marker=>{
  const norm=t=>String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  for(const old of document.querySelectorAll('['+marker+']'))old.removeAttribute(marker);
  for(const dialog of document.querySelectorAll('[role="dialog"],[aria-modal="true"]')){
   const text=norm(dialog.innerText||dialog.textContent);
   if(!text.includes('nao e possivel restaurar o historico de conversas neste dispositivo')&&!text.includes("can't restore chat history on this device"))continue;
   const r=dialog.getBoundingClientRect();if(r.width<2||r.height<2)continue;
   for(const button of dialog.querySelectorAll('button,[role="button"]')){
    const label=norm(button.getAttribute('aria-label'));const b=button.getBoundingClientRect();
    if((label==='fechar'||label==='close')&&b.width>2&&b.height>2&&button.getAttribute('aria-disabled')!=='true'){button.setAttribute(marker,'1');return {present:true,closable:true}}
   }return {present:true,closable:false};
  }return {present:false};
 },marker);
 if(!present.present)return present;if(!present.closable)return {...present,closed:false};
 const close=await page.$('['+marker+'="1"]');if(!close)return {...present,closed:false};await close.click({delay:60});
 try{await page.waitForFunction(()=>!Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).some(d=>{const t=String(d.innerText||d.textContent).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim(),r=d.getBoundingClientRect();return r.width>2&&r.height>2&&(t.includes('nao e possivel restaurar o historico de conversas neste dispositivo')||t.includes("can't restore chat history on this device"))}),{timeout:5000});return {...present,closed:true}}catch{return {...present,closed:false}}
}
module.exports={check,restoreNotice};
