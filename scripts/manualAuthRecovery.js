'use strict';
// An explicit operator request starts a new bounded round; automatic retries cannot reset it.
function prepare(want,manifest,at=Date.now()){
 const flags=manifest?.accountFlags||{};
 const restriction=['banned','captchaCheckpoint','marketplaceDisabled','identityRequired','identitySubmitted','twoFactor','idVirtus','whatsappConfirm','accountCodePhone','accountCodeWhatsapp','appealSubmitted'].find(k=>flags[k]===true);
 if(restriction)throw Error('manual_auth_recovery_restricted:'+restriction);
 const previousAttempts=Number(flags.loginAttemptCount)||0;
 const {provisioningResult,...keep}=want||{};
 return {previousAttempts,
  manifest:{...manifest,accountFlags:{...flags,loginAttemptCount:0},manualAuthRecovery:{at,previousAttempts,
   previousFlow:Object.fromEntries(['at','entry','stage','error','cookieAttempts','cookiesRejected','credentialRejections','credentialsSubmitted'].filter(k=>manifest?.loginFlow?.[k]!==undefined).map(k=>[k,manifest.loginFlow[k]]))}},
  desired:{...keep,active:false,virtus:'off',humanHold:false,provisioningPending:true,provisioningAttempts:0,provisioningDeferrals:0,provisioningNextAt:0,...(provisioningResult?{provisioningPreviousResult:provisioningResult}:{})}
 };
}
function release(want){
 if(want?.provisioningPending||want?.provisioningResult)throw Error('manual_auth_recovery_not_verified');
 return {...want,active:true,virtus:'on',humanHold:false};
}
async function finish(result,{enabled,close,release,audit=()=>{}}){
 await close();
 if(enabled!==true||result?.ok!==true)return;
 await release();result.authenticationVerified=true;result.workQueued=true;
 try{audit()}catch{}
}
module.exports={prepare,release,finish};
