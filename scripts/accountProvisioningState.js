'use strict';
const {AsyncLocalStorage}=require('async_hooks');
const cadastroMarks=new AsyncLocalStorage();
function unready(want){return want?.provisioningPending===true||['blocked','failed'].includes(want?.provisioningResult?.state)}
function restriction(error){
 const e=String(error||'').toLowerCase();
 if(/two_factor|two.factor|2fa/.test(e))return 'two_factor';
 if(/^(?:identity_required|identity_submitted|id_virtus)(?:$|:)|^configure_blocked_identity|^still_login_required:identity/.test(e))return 'identity_required';
 if(/captcha|checkpoint/.test(e))return 'captcha_checkpoint';
 if(/marketplace_disabled/.test(e))return 'marketplace_disabled';
 if(/banned|disabled|suspended/.test(e))return 'banned';
 if(/whatsapp_confirm/.test(e))return 'whatsapp_confirm';
 if(/still_login_required|login_form|login_wall|login_not_accepted|login_attempt_budget|missing_credentials/.test(e))return 'login_required';
 if(/appeal/.test(e))return 'appeal_submitted';
 if(/messenger_pin/.test(e))return 'messenger_pin';
 return null;
}
function deferred(error){
 const e=String(error||'');
 return /^(?:host_boot_not_ready|configure_requires_provision_lock)$/.test(e)||/provision_lock_busy|already_opening/.test(e);
}
function retryDelayMs(attempts){return Math.min(300000,30000*2**Math.min(4,Math.max(0,attempts-1)))}
function mayWriteCadastroMark(isWriting,pending){return isWriting===true||pending!==true}
function cadastroIsWriting(){return cadastroMarks.getStore()===true}
function runAsCadastro(fn){return cadastroMarks.run(true,fn)}
function nextCadastro(perfis,now,allow=()=>true){
 const due=[];let soonest=null;
 for(const [nome,p] of Object.entries(perfis||{})){
  if(!p||p.provisioningPending!==true||!allow(nome))continue;
  const at=Number(p.provisioningNextAt||0)||0;
  if(at>now){if(soonest==null||at<soonest)soonest=at;continue}
  due.push({nome,at});
 }
 due.sort((a,b)=>a.at-b.at||(a.nome<b.nome?-1:a.nome>b.nome?1:0));
 if(due.length)return {nome:due[0].nome,waitMs:0};
 if(soonest!=null)return {nome:null,waitMs:Math.max(0,soonest-now)};
 return null;
}
async function settle(results,{update,audit=()=>{},now=Date.now}={}){
 const rows=results.filter(r=>r?.profileName&&r.ok!==true);
 if(!rows.length)return;
 const ts=now();
 const events=[];
 await update(d=>{d.perfis=d.perfis||{};for(const r of rows){const p=d.perfis[r.profileName];if(!p||p.provisioningPending!==true)continue;
  const error=String(r.error||'cadastro_result_missing').slice(0,240);
  const reason=restriction(error);
  if(reason){
   d.perfis[r.profileName]={...p,provisioningPending:false,provisioningResult:{state:'blocked',reason,error,at:ts},active:false,virtus:'off'};
   events.push({event:'account_provisioning_blocked',nome:r.profileName,reason,error,ts});
   continue;
  }
  if(deferred(error)){
   d.perfis[r.profileName]={...p,provisioningPending:true,provisioningNextAt:ts+30000,active:false,virtus:'off'};
   events.push({event:'account_provisioning_deferred',nome:r.profileName,error,ts});
   continue;
  }
  const attempts=Math.min(5,(Number(p.provisioningAttempts)||0)+1);
  if(attempts>=5){
   d.perfis[r.profileName]={...p,provisioningPending:false,provisioningAttempts:attempts,provisioningNextAt:0,provisioningResult:{state:'failed',reason:'cadastro_attempts_exhausted',error,at:ts},active:false,virtus:'off'};
   events.push({event:'account_provisioning_exhausted',nome:r.profileName,attempts,error,ts});
  }else{
   const {provisioningResult,...keep}=p;
   d.perfis[r.profileName]={...keep,provisioningPending:true,provisioningAttempts:attempts,provisioningNextAt:ts+retryDelayMs(attempts),provisioningLastError:error,active:false,virtus:'off'};
   events.push({event:'account_provisioning_retry',nome:r.profileName,attempts,error,ts});
  }
 }return d});
 for(const row of events)audit(row);
}
module.exports={unready,restriction,settle,nextCadastro,mayWriteCadastroMark,cadastroIsWriting,runAsCadastro};
