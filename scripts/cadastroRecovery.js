'use strict';
function eligible(want,manifest){
 if(!want||want.provisioningPending||want.humanHold||Number(want.credentialRecoveryVersion)>=3)return false;
 const result=want.provisioningResult,flags=manifest?.accountFlags||{};
 if(!result||!['blocked','failed'].includes(result.state))return false;
 if(['banned','captchaCheckpoint','idVirtus','identityRequired','identitySubmitted','twoFactor','whatsappConfirm','accountCodePhone','accountCodeWhatsapp','marketplaceDisabled','appealSubmitted'].some(k=>flags[k]===true))return false;
 const attempts=Number(flags.loginAttemptCount||0);
 if(attempts>=2)return false;
 const ordinary=result.state==='blocked'&&/^still_login_required:(login_form|login_wall|not_in|trust_device)$/.test(result.error);
 const legacyIdentity=result.error==='cadastro_account_identity_mismatch'&&String(manifest.expectedFacebookUserId||'')===String(manifest.login||'')&&manifest.expectedFacebookUserIdSource!=='ct_stock';
 const technical=result.state==='failed'&&require('./stockProvisionRetry').isTransient(result.error);
 if(!ordinary&&!technical&&!legacyIdentity)return false;
 let identity;try{identity=require('./cadastroIdentity').expected(manifest)}catch{return false}
 return (!!identity||Number(manifest.stockAccountId)>0)&&!!String(manifest.login||manifest.email||manifest.user||manifest.username||'').trim()&&!!String(manifest.password||manifest.pass||'').trim();
}
async function recover({snapshot,read,update,allow=()=>true,audit=()=>{},now=Date.now}){
 const recovered=[];
 for(const [nome,want]of Object.entries(snapshot?.perfis||{})){
  if(!allow(nome)||!want?.provisioningResult)continue;
  let manifest;try{manifest=await read(nome);}catch{audit({ts:now(),event:'cadastro_recovery_manifest_unavailable',nome});continue;}
  if(!eligible(want,manifest))continue;
  let changed=false;
  await update(d=>{const current=d.perfis?.[nome];
   if(!eligible(current,manifest)||JSON.stringify(current.provisioningResult)!==JSON.stringify(want.provisioningResult))return d;
   const {provisioningResult,...keep}=current;
   d.perfis[nome]={...keep,active:false,virtus:'off',provisioningPending:true,provisioningAttempts:0,provisioningNextAt:now(),credentialRecoveryVersion:3,credentialRecoveryPreviousResult:provisioningResult};
   changed=true;return d;
  });
  if(changed){recovered.push(nome);audit({ts:now(),event:'cadastro_credential_flow_requeued',nome,previousError:want.provisioningResult.error});}
 }
 return recovered;
}
module.exports={eligible,recover};
