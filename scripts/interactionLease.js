'use strict';
// Local check only: no network requests and no new chair acquisition here.
function assert(page){
 const browser=typeof page?.browser==='function'?page.browser():null;
 const cadastro=browser?.__ctCadastroProxy;
 if(cadastro&&cadastro.snapshot()?.healthy!==true)throw failure('cadastro');
 const isolated=browser?.__ctIsolatedFlow;
 if(isolated?.proxyRequired===true){
  const rail=isolated.rail,state=rail?.operationSnapshot?.();
  if(rail?.isProxyArmed!==true||state?.healthy!==true)throw failure('isolated');
  return;
 }
 const session=page?.__ctVirtusProxySession||browser?.__ctVirtusProxy;
 if(session){const state=session.snapshot();if(state.state!=='online'||!state.operationId||session.turn?.lease?.snapshot()?.healthy!==true)throw failure('virtus')}
}
function failure(flow){const e=Error('interaction_without_healthy_proxy_turn:'+flow);e.code='interaction_without_healthy_proxy_turn';return e}
// Wait without reading or changing the page. Only the existing authority can restore health.
async function wait(page,{timeoutMs=30000,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const started=clock();
 const budget=require('./interactionBudget').timeout(page,timeoutMs,started);
 for(;;){
  try{assert(page);return}catch(error){
   if(error.code!=='interaction_without_healthy_proxy_turn')throw error;
   const browser=page?.browser?.(),state=browser?.__ctIsolatedFlow?.rail?.operationSnapshot?.();
   if(page?.isClosed?.()||state?.closed||state?.absoluteDeadline&&clock()>=state.absoluteDeadline*1000||clock()-started>=budget)throw error;
   await sleep(Math.min(250,budget-(clock()-started)));
  }
 }
}
module.exports={assert,wait};
