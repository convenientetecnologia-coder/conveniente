'use strict';

// Borrowing never transfers ownership: only the human session releases this chair.
async function run({browser,nome,kind,proxy,watch=require('./robePublishEvidence').watch,security=(page,n)=>require('./accountSecurityGate').assertAllowed(page,n),authenticate=(page,n)=>require('./workAuthentication').assertAuthenticated(page,n),audit=event=>require('./provisionAudit').append(event)},action){
 if(!['id','renew'].includes(kind))throw Error('human_action_kind_invalid');
 return proxy.runHumanAction(async lease=>{
  const previous=browser.__ctIsolatedFlow;
  if(previous)throw Error('human_browser_action_busy');
  let evidence;
  const note=(event,extra={})=>{try{audit({ts:Date.now(),event,nome,kind,operationId:lease.operationId,...extra})}catch{}};
  const healthy=()=>{const s=lease.snapshot();if(s.healthy!==true||s.absoluteDeadline&&Date.now()>=s.absoluteDeadline*1000)throw Error('human_action_transport_unhealthy');return s;};
  const rail={
   operationSnapshot(){return lease.snapshot();},
   get isProxyArmed(){try{healthy();return true}catch{return false}},
   async armAndProve(page){
    healthy();
    await security(page,nome);
    await authenticate(page,nome);
    healthy();if(kind==='renew'&&!evidence)evidence=watch(page,{operation:'renew'});
    return {ok:true,provider:'human_shared_chair'};
   },
   async markIdentityStart(){healthy();await lease.possibleSideEffect();},
   async confirmIdentity(){healthy();await lease.confirm();},
   async markPublishClick(){healthy();await lease.possibleSideEffect();evidence?.arm();},
   async waitPublishTransport(){
    const until=Math.min(Date.now()+30000,healthy().absoluteDeadline*1000||Infinity);
    let snap=evidence?.snapshot()||{};
    while(Date.now()<until&&(!snap.finished||snap.bodyPending)&&!snap.failed){healthy();await new Promise(r=>setTimeout(r,100));snap=evidence?.snapshot()||{};}
    healthy();const result={...snap,ok:snap.transportOk===true&&snap.operationConfirmed===true,provider:'human_shared_chair'};
    if(result.ok)await lease.confirm();return result;
   },
   async releaseProxy(){healthy();},
  };
  try{
   const deadlineAt=healthy().absoluteDeadline*1000-3000;
   if(!Number.isFinite(deadlineAt)||deadlineAt<=Date.now())throw Error('human_action_deadline_invalid');
   note('human_shared_action_begin');
   browser.__ctIsolatedFlow={kind,proxyRequired:true,rail,deadlineAt,humanBorrowed:true};
   const result=await action();
   if(kind==='id'&&result?.ok&&(result.marked||result.alreadySubmitted||result.marketplacePhoneVerified||result.identityFlowConfirmed))await rail.confirmIdentity();
   note('human_shared_action_done',{ok:result?.ok===true});return result;
  }catch(error){note('human_shared_action_failed',{error:String(error.message||error).slice(0,160)});throw error;}finally{evidence?.cleanup();if(previous===undefined)delete browser.__ctIsolatedFlow;else browser.__ctIsolatedFlow=previous;}
 });
}
module.exports={run};
