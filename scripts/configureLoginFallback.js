'use strict';
async function run({page,nome,login,password,begin,resume,assertHealthy=()=>{},attempt=require('./pcSessionLogin').attemptCredentialRelogin}){
 assertHealthy();
 if(resume){const continued=await resume();assertHealthy();if(continued?.ok===true){await page.goto('https://www.facebook.com/messages/',{waitUntil:'domcontentloaded',timeout:120000});assertHealthy();return continued;}if(continued?.terminal)return continued;}
 if(!await begin())return {ok:false,error:'login_attempt_budget'};
 const result=await attempt(page,nome,{login,password});
 assertHealthy();
 if(result?.ok!==true&&resume){const continued=await resume();assertHealthy();if(continued?.ok===true){await page.goto('https://www.facebook.com/messages/',{waitUntil:'domcontentloaded',timeout:120000});assertHealthy();return continued;}if(continued?.terminal)return continued;}
 if(result?.ok!==true)return result||{ok:false,error:'login_result_missing'};
 // Credential login ends outside Messenger; final verification needs the real target.
 await page.goto('https://www.facebook.com/messages/',{waitUntil:'domcontentloaded',timeout:120000});
 assertHealthy();
 return result;
}
function canRemediate(reason){return /^(login_form|login_wall|login_required|aymh_continue|aymh|password_only)$/.test(String(reason||'').toLowerCase())}
module.exports={run,canRemediate};
