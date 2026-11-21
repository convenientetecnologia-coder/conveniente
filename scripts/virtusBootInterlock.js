'use strict';
function listenerReady(ctrl,expectedPage,{shuttingDown=false}={}){
 const page=ctrl?.deltaCdpEarPage;
 return !!(!shuttingDown&&ctrl&&!ctrl.deltaCdpClosing&&ctrl.deltaCdpSession&&page&&(!expectedPage||page===expectedPage)&&page.__deltaCdpEarAttached===true&&typeof ctrl.deltaCdpOnFrame==='function'&&!(typeof page.isClosed==='function'&&page.isClosed()));
}
async function holdNavigation({page,request,state,ready,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),onResult=()=>{}}){
 const start=clock();
 const current=()=>page.__deltaBootInterlock===state&&state.active===true&&!state.released&&!state.cancelled&&!(typeof page.isClosed==='function'&&page.isClosed());
 const evidence=phase=>{const result={phase,at:clock(),waitedMs:clock()-start};state.result=result;if(page.__deltaBootInterlock===state)try{onResult(result);}catch{}return result;};
 const abort=async()=>{
  state.cancelled=true;state.active=false;
  try{if(!request.isInterceptResolutionHandled?.())await request.abort('aborted');}catch{}
 };
 state.cancel=abort;
 try{
  evidence('waiting_listener');
  while(current()&&clock()<state.deadlineAt){
   const attached=await ready(page);
   if(attached===true&&clock()-start>=state.holdMs){
    if(!current())break;
    if(request.isInterceptResolutionHandled?.()){await abort();return evidence('request_already_resolved');}
    await request.continue();
    state.released=true;state.active=false;state.earReadyAtRelease=true;
    return evidence('released');
   }
   await sleep(Math.min(120,Math.max(1,state.deadlineAt-clock())));
  }
  const phase=clock()>=state.deadlineAt?'listener_timeout':'cancelled';
  await abort();return evidence(phase);
 }catch(error){await abort();evidence('failed');throw error;}
 finally{
  // An old navigation must never disable a newer navigation's interception.
  if(page.__deltaBootInterlock===state){
   if(state.disableInterceptionAfterRelease!==false)try{await page.setRequestInterception(false);}catch{}
   delete page.__deltaBootInterlock;
  }
 }
}
module.exports={listenerReady,holdNavigation};
