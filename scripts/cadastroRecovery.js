'use strict';
function eligible(want,manifest){
 if(!want||want.provisioningPending||want.humanHold||Number(want.credentialRecoveryVersion)>=4)return false;
 const flags=manifest?.accountFlags||{},technicalFlag=require('./loginTechnicalRecovery').eligible(flags)||(flags.loginRequired===true&&require('./stockProvisionRetry').isTransient(manifest?.loginTechnicalRecovery?.previousReason)&&manifest?.loginFlow?.stage!=='verified');
 const result=want.provisioningResult||(technicalFlag?{state:'failed',error:flags.loginRemediateFailedReason}:null);
 if(!result||!['blocked','failed'].includes(result.state))return false;
 if(['banned','captchaCheckpoint','idVirtus','identityRequired','identitySubmitted','twoFactor','whatsappConfirm','accountCodePhone','accountCodeWhatsapp','marketplaceDisabled','appealSubmitted'].some(k=>flags[k]===true))return false;
 const attempts=Number(flags.loginAttemptCount||0);
 if(attempts>=2)return false;
 const ordinary=result.state==='blocked'&&/^still_login_required:(login_form|login_wall|not_in|trust_device)$/.test(result.error);
 const legacyIdentity=result.error==='cadastro_account_identity_mismatch'&&String(manifest.expectedFacebookUserId||'')===String(manifest.login||'')&&manifest.expectedFacebookUserIdSource!=='ct_stock';
 const technical=technicalFlag||(['blocked','failed'].includes(result.state)&&require('./stockProvisionRetry').isTransient(result.error));
 if(Number(want.credentialRecoveryVersion)>=3&&!technical)return false;
 if(!ordinary&&!technical&&!legacyIdentity)return false;
 let identity;try{identity=require('./cadastroIdentity').expected(manifest)}catch{return false}
 return (!!identity||Number(manifest.stockAccountId)>0)&&!!String(manifest.login||manifest.email||manifest.user||manifest.username||'').trim()&&!!String(manifest.password||manifest.pass||'').trim();
}
async function recover({snapshot,read,update,allow=()=>true,audit=()=>{},now=Date.now}){
 const recovered=[];
 for(const [nome,want]of Object.entries(snapshot?.perfis||{})){
  if(!allow(nome)||!want)continue;
  let manifest;try{manifest=await read(nome);}catch{audit({ts:now(),event:'cadastro_recovery_manifest_unavailable',nome});continue;}
  if(!eligible(want,manifest))continue;
  let changed=false;
  await update(d=>{const current=d.perfis?.[nome];
   if(!eligible(current,manifest)||JSON.stringify(current.provisioningResult)!==JSON.stringify(want.provisioningResult))return d;
   const {provisioningResult,...keep}=current;
   d.perfis[nome]={...keep,active:false,virtus:'off',provisioningPending:true,provisioningAttempts:0,provisioningNextAt:now(),credentialRecoveryVersion:4,credentialRecoveryPreviousResult:provisioningResult||{state:'failed',error:manifest.accountFlags?.loginRemediateFailedReason}};
   changed=true;return d;
  });
  if(changed){recovered.push(nome);audit({ts:now(),event:'cadastro_credential_flow_requeued',nome,previousError:want.provisioningResult?.error||manifest.accountFlags?.loginRemediateFailedReason});}
 }
 return recovered;
}
module.exports={eligible,recover};
