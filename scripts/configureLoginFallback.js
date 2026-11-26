'use strict';
async function run(options){
 const count=Math.max(1,Math.min(3,Number(options.maxAttempts)||1));let result;
 for(let i=0;i<count;i++){
  const previous=result;result=await runOnce(options);
  if(result?.error==='login_attempt_budget'&&previous)return previous;
  if(result?.ok||result?.terminal||!['password_rejected','credentials_rejected'].includes(result?.error))return result;
  if(options.onProgress)await options.onProgress({credentialRejected:true});
 }
 return result;
}
async function runOnce({page,nome,login,password,begin,resume,refund,onProgress=async()=>{},assertHealthy=()=>{},attempt=require('./pcSessionLogin').attemptCredentialRelogin}){
 assertHealthy();
 if(resume){const continued=await resume();assertHealthy();if(continued?.ok===true){await page.goto('https://www.facebook.com/messages/',{waitUntil:'domcontentloaded',timeout:120000});assertHealthy();return continued;}if(continued?.terminal)return continued;}
 if(!await begin())return {ok:false,error:'login_attempt_budget'};
 let submitted=false;
 try {
 const result=await attempt(page,nome,{login,password,onProgress:async event=>{if(event.submitted)submitted=true;await onProgress(event)}});
 if(result?.submitted)submitted=true;
 assertHealthy();
 if(result?.ok!==true&&resume){const continued=await resume();assertHealthy();if(continued?.ok===true){await page.goto('https://www.facebook.com/messages/',{waitUntil:'domcontentloaded',timeout:120000});assertHealthy();return continued;}if(continued?.terminal)return continued;}
 if(result?.ok!==true)return result||{ok:false,error:'login_result_missing'};
 // Credential login ends outside Messenger; final verification needs the real target.
 await page.goto('https://www.facebook.com/messages/',{waitUntil:'domcontentloaded',timeout:120000});
 assertHealthy();
 return result;
 } finally {if(!submitted&&refund)await refund();}
}
function canRemediate(reason){return /^(login_form|login_wall|login_required|aymh_continue|aymh|password_only)$/.test(String(reason||'').toLowerCase())}
module.exports={run,canRemediate};
