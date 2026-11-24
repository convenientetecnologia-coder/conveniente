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
module.exports={assert};
