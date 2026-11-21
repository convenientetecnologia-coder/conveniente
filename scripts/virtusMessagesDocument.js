'use strict';
function inspectDocument(){
 const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
 if(!document.body||document.readyState==='loading')return {ready:false,reason:'document_loading'};
 const text=norm(document.body.innerText||document.body.textContent);
 if(/nao foi possivel carregar as conversas|couldn.t load (your )?(chats|conversations)/.test(text))return {ready:false,reason:'conversations_load_failed'};
 const heading=[...document.querySelectorAll('h1,[role="heading"]')].some(e=>visible(e)&&/^(conversas|chats|messenger|marketplace)$/.test(norm(e.innerText||e.textContent)));
 const grid=[...document.querySelectorAll('[role="grid"],[role="navigation"][aria-label]')].some(e=>visible(e)&&/convers|chat|messag|marketplace/.test(norm(e.getAttribute('aria-label'))));
 const links=[...document.querySelectorAll('a[href*="/messages/t/"],a[href*="/messages/e2ee/t/"]')].filter(visible).length;
 const loading=[...document.querySelectorAll('[role="progressbar"],[aria-busy="true"],[data-visualcompletion="loading-state"]')].filter(visible).length;
 const styled=getComputedStyle(document.body).fontFamily.toLowerCase();
 if(/times new roman/.test(styled))return {ready:false,reason:'styles_unavailable'};
 if(!heading||!grid)return {ready:false,reason:'messages_shell_incomplete'};
 if(loading)return {ready:false,reason:'messages_loading',loading};
 const empty=/nenhuma (conversa|mensagem)|no (chats|messages|conversations)|suas mensagens|your messages/.test(text);
 if(!links&&!empty)return {ready:false,reason:'conversation_list_unconfirmed'};
 return {ready:true,reason:'ready',links,empty};
}
async function wait({page,timeoutMs=120000,stableMs=2000,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const start=clock();let since=null,last;
 while(clock()-start<=timeoutMs){last=await page.evaluate(inspectDocument);if(last.ready){if(since===null)since=clock();if(clock()-since>=stableMs)return last;}else since=null;await sleep(250);}
 const error=Error('virtus_messages_document_not_ready');error.details=last;throw error;
}
const recoveryTimes=new WeakMap();
async function ensure({page,probe=wait,clock=Date.now,cooldownMs=600000,onRecovery=()=>{}}){
 try{return await probe({page});}catch(error){
  const reason=error.details?.reason;
  // A reload is justified only by explicit broken-document evidence, never silence or absence of new messages.
  if(!['styles_unavailable','conversations_load_failed'].includes(reason)||typeof page.reload!=='function')throw error;
  const previous=recoveryTimes.get(page);
  if(previous!==undefined&&clock()-previous<cooldownMs)throw error;
  recoveryTimes.set(page,clock());onRecovery({reason,at:clock()});
  await page.reload({waitUntil:'domcontentloaded',timeout:120000});
  return probe({page});
 }
}
module.exports={inspectDocument,wait,ensure};
