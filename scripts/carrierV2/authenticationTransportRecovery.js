'use strict';
const terminal=s=>['released','canceled','expired','unknown','failed'].includes(s?.state);
async function reconcile({client,old,status,signal,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=60000}){
 if(terminal(status))return status;
 if(signal?.aborted)throw signal.reason||Error('operation_canceled');
 if(status.state==='queued')status=await client.controlRequest('/'+old.operationId+'/cancel-queued',{expectedState:'queued'});
 else if(['granted','activating','active','grace'].includes(status.state)){
  if(!status.leaseId||!Number.isSafeInteger(status.leaseGeneration)||!status.carrierGeneration)throw Error('cp2_authentication_previous_identity_missing');
  status=await client.controlRequest('/'+old.operationId+'/cancel',{leaseId:status.leaseId,leaseGeneration:status.leaseGeneration,carrierGeneration:status.carrierGeneration,businessResult:'unknown'});
 }
 const deadline=clock()+timeoutMs;
 while(!terminal(status)){
  if(signal?.aborted)throw signal.reason||Error('operation_canceled');
  if(clock()>=deadline)throw Error('cp2_uncertain_transport_not_closed');
  await sleep(Math.min(500,Math.max(1,deadline-clock())));
  status=await client.request('/'+old.operationId);
 }
 return status;
}
module.exports={reconcile};
