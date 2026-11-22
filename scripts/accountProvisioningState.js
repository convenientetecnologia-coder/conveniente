'use strict';
function unready(want){return want?.provisioningPending===true||['blocked','failed'].includes(want?.provisioningResult?.state)}
function restriction(error){
 const e=String(error||'').toLowerCase();
 if(/two_factor|two.factor|2fa/.test(e))return 'two_factor';
 if(/^(?:identity_required|identity_submitted|id_virtus)(?:$|:)|^configure_blocked_identity|^still_login_required:identity/.test(e))return 'identity_required';
 if(/captcha|checkpoint/.test(e))return 'captcha_checkpoint';
 if(/banned|disabled|suspended/.test(e))return 'banned';
 if(/whatsapp_confirm/.test(e))return 'whatsapp_confirm';
 if(/still_login_required|login_form|login_wall|login_not_accepted|login_attempt_budget|missing_credentials/.test(e))return 'login_required';
 return null;
}
async function settle(results,{update,audit=()=>{},now=Date.now}={}){
 const blocked=results.filter(r=>r?.profileName&&r.ok!==true&&!require('./stockProvisionRetry').isTransient(r.error));
 if(!blocked.length)return;
 await update(d=>{d.perfis=d.perfis||{};for(const r of blocked){const p=d.perfis[r.profileName];if(!p)continue;
  // A verified account cannot be demoted by a delayed result from an older attempt.
  if(p.provisioningPending!==true)continue;
  const reason=restriction(r.error);
  d.perfis[r.profileName]={...p,provisioningPending:false,provisioningResult:{state:reason?'blocked':'failed',reason:reason||'technical_failure',error:String(r.error||'cadastro_result_missing').slice(0,240),at:now()},active:false,virtus:'off'};
 }return d});
 for(const r of blocked)audit({event:'account_provisioning_blocked',nome:r.profileName,reason:restriction(r.error),error:String(r.error).slice(0,240),ts:now()});
}
module.exports={unready,restriction,settle};
