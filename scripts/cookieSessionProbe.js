'use strict';
async function run({inject,navigate,inspect,assertHealthy=()=>{},onProgress=async()=>{},now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=180000,loginGraceMs=30000,maxAttempts=3}){
 for(let attempt=1;attempt<=maxAttempts;attempt++){
  assertHealthy();await onProgress({stage:'cookies',cookiesAttempted:true,cookieAttempts:attempt});
  await inject();assertHealthy();await onProgress({cookiesInjected:true});await navigate();
  const began=now(),until=began+timeoutMs;let gateSince=null;
  while(now()<until){
   assertHealthy();const state=await inspect();assertHealthy();
   if(state?.terminal)throw Error(state.terminal);
   if(state?.ready&&state.authenticated){await onProgress({cookiesRestored:true});return {ok:true,in:true,attempts:attempt};}
   if(state?.ready&&state.loginGate){
    if(gateSince===null)gateSince=now();
    if(now()-gateSince>=2500&&now()-began>=loginGraceMs)break;
   }else gateSince=null;
   await sleep(500);
  }
  if(gateSince===null||now()-gateSince<2500||now()-began<loginGraceMs)throw Error('cookie_session_unconfirmed');
 }
 await onProgress({cookiesRestored:false,cookiesRejected:true,cookieAttempts:maxAttempts});
 return {ok:false,in:false,loggedOut:true,reason:'cookies_login_required',attempts:maxAttempts};
}
module.exports={run};
