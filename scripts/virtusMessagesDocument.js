'use strict';
function inspectDocument(){
 const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
 if(!document.body||document.readyState==='loading')return {ready:false,reason:'document_loading'};
 const text=norm(document.body.innerText||document.body.textContent);
 if(/err_internet_disconnected|err_proxy_connection_failed|err_tunnel_connection_failed|err_connection_reset/.test(text))return {ready:false,reason:'browser_network_error'};
 if(/nao foi possivel carregar as conversas|couldn.t load (your )?(chats|conversations)/.test(text))return {ready:false,reason:'conversations_load_failed'};
 const heading=[...document.querySelectorAll('h1,[role="heading"]')].some(e=>visible(e)&&/^(conversas|chats|messenger|marketplace)$/.test(norm(e.innerText||e.textContent)));
 const grid=[...document.querySelectorAll('[role="grid"],[role="navigation"][aria-label]')].some(e=>visible(e)&&/convers|chat|messag|marketplace/.test(norm(e.getAttribute('aria-label'))));
 const links=[...document.querySelectorAll('a[href*="/messages/t/"],a[href*="/messages/e2ee/t/"]')].filter(visible).length;
 const loading=[...document.querySelectorAll('[role="progressbar"],[aria-busy="true"],[data-visualcompletion="loading-state"]')].filter(visible).length;
 const styled=getComputedStyle(document.body).fontFamily.toLowerCase();
 const sheets=document.styleSheets;
 const hasStyles=sheets===undefined||[...sheets].some(s=>!s.disabled&&s.ownerNode?.id!=='virtus_antiselect_style_v1'&&(!s.ownerNode||s.ownerNode.sheet));
 if(!hasStyles||/times new roman/.test(styled))return {ready:false,reason:'styles_unavailable'};
 if(!heading||!grid)return {ready:false,reason:'messages_shell_incomplete'};
 if(loading)return {ready:false,reason:'messages_loading',loading};
 const empty=/nenhuma (conversa|mensagem)|no (chats|messages|conversations)|suas mensagens|your messages/.test(text);
 if(!links&&!empty)return {ready:false,reason:'conversation_list_unconfirmed'};
 return {ready:true,reason:'ready',links,empty};
}
async function wait({page,timeoutMs=120000,stableMs=2000,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const start=clock();let since=null,last,reasonSince=start,reason;
 while(clock()-start<=timeoutMs){last=await page.evaluate(inspectDocument);if(last.reason!==reason){reason=last.reason;reasonSince=clock();}if(last.ready){if(since===null)since=clock();if(clock()-since>=stableMs)return last;}else since=null;await sleep(250);}
 const error=Error('virtus_messages_document_not_ready');error.details={...last,waitedMs:clock()-start,unchangedReasonMs:clock()-reasonSince};throw error;
}
const recoveryTimes=new WeakMap();
async function ensure({page,probe=wait,clock=Date.now,cooldownMs=600000,onRecovery=()=>{}}){
 try{return await probe({page});}catch(error){
  const reason=error.details?.reason;
  // A reload is justified only by explicit broken-document evidence, never silence or absence of new messages.
  const stalled=['messages_shell_incomplete','messages_loading','conversation_list_unconfirmed','document_loading'].includes(reason)&&error.details.waitedMs>=120000&&error.details.unchangedReasonMs>=30000;
  if((!['styles_unavailable','conversations_load_failed','browser_network_error'].includes(reason)&&!stalled)||typeof page.reload!=='function')throw error;
  // This function runs inside a proven proxy turn. Never navigate after the browser goes offline.
  if(typeof page.evaluate==='function'&&!(await page.evaluate(()=>navigator.onLine===true)))throw error;
  const previous=recoveryTimes.get(page);
  if(previous!==undefined&&clock()-previous<cooldownMs)throw error;
  recoveryTimes.set(page,clock());onRecovery({reason,at:clock()});
  await page.reload({waitUntil:'domcontentloaded',timeout:120000});
  return probe({page,timeoutMs:60000});
 }
}
async function recoverBrowserError({page,clock=Date.now,cooldownMs=600000,onRecovery=()=>{}}){
 if(typeof page.evaluate!=='function')return {reloaded:false};
 const broken=await page.evaluate(()=>{
  const text=String(document.body?.innerText||'');
  return {error:/ERR_INTERNET_DISCONNECTED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_RESET/.test(text),online:navigator.onLine===true};
 });
 if(!broken?.error)return {reloaded:false};
 if(!broken.online)throw Error('virtus_browser_still_offline');
 const previous=recoveryTimes.get(page);
 if(previous!==undefined&&clock()-previous<cooldownMs)throw Error('virtus_browser_error_recovery_cooldown');
 recoveryTimes.set(page,clock());onRecovery({reason:'browser_network_error',at:clock()});
 await page.reload({waitUntil:'domcontentloaded',timeout:120000});
 return {reloaded:true};
}
async function threadNavigationGuard(page){
 try{
  if(!page?.__ctVirtusProxySession&&!page?.browser?.()?.__ctVirtusProxy)return {allowed:true};
  const document=await page.evaluate(inspectDocument);
  return {allowed:document.ready===true,document};
 }catch{return {allowed:false,document:{ready:false,reason:'document_probe_failed'}};}
}
module.exports={inspectDocument,wait,ensure,recoverBrowserError,threadNavigationGuard};
