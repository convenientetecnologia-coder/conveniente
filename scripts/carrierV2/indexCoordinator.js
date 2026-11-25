'use strict';
const priority=job=>job.intent==='reply'||job.intent==='human'?120:job.purpose==='provision'?90:job.intent==='warm'?60:job.intent==='engaged'?30:0;
class Coordinator{
 constructor({acquire,clock=Date.now,audit=()=>{},limit=2000}={}){
  this.acquire=acquire||(async options=>{const operations=require('./accountOperation');await operations.ensureConfig();return operations.begin({...options,_indexOwned:true})});this.clock=clock;this.audit=audit;this.limit=limit;
  this.jobs=new Map();this.acquiring=null;this.activeAccounts=new Set();this.scheduled=false;this.sweeping=false;
 }
 event(event,job,extra={}){try{this.audit({ts:this.clock(),event:'proxy_index_'+event,nome:job.nome,purpose:job.purpose,intent:job.intent,jobId:job.id,operationId:job.handle?.operationId,...extra})}catch{}}
 public(job){return {ok:true,ticket:job.id,state:job.state,error:job.error||null,operationId:job.handle?.operationId||null,...(job.state==='granted'?{hop:job.handle.hop,snapshot:job.handle.snapshot()}:{}),...(job.state==='closed'?{closed:true}:{})}}
 enqueue(input,owner,{ready=async()=>true,alive=()=>true}={}){
  if(!/^[a-f0-9-]{36}$/i.test(input.id||'')||!String(input.nome||'').trim()||!['virtus','publish','id','renew','provision'].includes(input.purpose)||!['warm','observe','engaged','reply','human'].includes(input.intent||'observe'))throw Error('invalid_proxy_job');
  const existing=this.jobs.get(input.id);if(existing){this.owned(input.id,owner);if(existing.nome!==input.nome||existing.purpose!==input.purpose||existing.intent!==(input.intent||'observe'))throw Error('proxy_job_conflict');existing.seen=this.clock();return this.public(existing)}
  this.prune();if(this.jobs.size>=this.limit)throw Error('proxy_index_queue_full');
  const job={id:input.id,nome:input.nome,purpose:input.purpose,intent:input.intent||'observe',hotUntil:Number(input.hotUntil)||0,messageIsolation:input.messageIsolation===true,observationRecovery:input.observationRecovery===true,authenticationRecovery:input.authenticationRecovery===true,owner,ready,alive,at:this.clock(),seen:this.clock(),state:'queued',abort:new AbortController(),tail:Promise.resolve()};
  this.jobs.set(job.id,job);this.event('queued',job);this.kick();return this.public(job);
 }
 owned(id,owner){const job=this.jobs.get(id);if(!job)throw Error('proxy_job_not_found');if(job.owner!==owner)throw Error('proxy_job_owner_mismatch');return job}
 poll(id,owner){const job=this.owned(id,owner);job.seen=this.clock();return this.public(job)}
 kick(){if(this.scheduled||this.acquiring)return;this.scheduled=true;setImmediate(()=>{this.scheduled=false;this.pump().catch(()=>{})})}
 async pump(){
  if(this.acquiring)return;
  const now=this.clock(),queue=[...this.jobs.values()].filter(j=>j.state==='queued'&&!this.activeAccounts.has(j.nome));
  queue.sort((a,b)=>(priority(b)+(now-b.at)/1000)-(priority(a)+(now-a.at)/1000)||a.at-b.at);
  const job=queue[0];if(!job)return;
  if(!job.alive()||now-job.seen>90000){job.state='canceled';job.ended=now;this.event('canceled',job,{reason:'worker_unavailable'});this.kick();return}
  this.acquiring=job;job.state='acquiring';this.event('requesting',job);
  try{
   const handle=await this.acquire({nome:job.nome,purpose:job.purpose,intent:job.intent,hotUntil:job.hotUntil,messageIsolation:job.messageIsolation,observationRecovery:job.observationRecovery,authenticationRecovery:job.authenticationRecovery,signal:job.abort.signal,isReady:async()=>job.alive()&&!job.abort.signal.aborted&&await job.ready(job.id),onWait:()=>{}});
   job.handle=handle;
   this.activeAccounts.add(job.nome);
   if(job.abort.signal.aborted||!job.alive()){job.state='releasing';await handle.close();return}
   job.state='granted';job.seen=this.clock();this.activeAccounts.add(job.nome);this.event('granted',job,{waitMs:this.clock()-job.at});
  }catch(error){job.error=String(error.message||error);job.state=job.handle?'releasing':job.abort.signal.aborted?'canceled':'failed';if(!job.handle)job.ended=this.clock();this.event('failed',job,{error:job.error})}
  finally{this.acquiring=null;this.kick()}
 }
 async command(id,owner,action,stage){
  const job=this.owned(id,owner);job.seen=this.clock();
  if(action==='status'){const snapshot=job.handle?.snapshot()||{};return {ok:true,state:job.state,snapshot:{...snapshot,healthy:job.state==='granted'&&snapshot.healthy===true},operationId:job.handle?.operationId}}
  if(action==='cancel'&&!job.handle){job.abort.abort(Error('proxy_job_canceled'));job.state='canceled';job.ended=this.clock();this.kick();return {ok:true,state:'canceled'}}
  if(!job.handle)throw Error('proxy_job_not_granted');
  if(action==='reconcile'){const closed=job.state==='closed'||await job.handle.reconcileClosed();if(closed)this.closed(job);return {ok:true,closed,state:job.state}}
  const execute=async()=>{
   if(action==='start'){if(job.state!=='granted')throw Error('proxy_job_not_granted');this.event('started',job);return {ok:true}}
   if(action==='effect'){if(job.state!=='granted')throw Error('proxy_job_not_granted');await job.handle.possibleSideEffect(stage);this.event('effect',job,{stage:stage||null});return {ok:true,snapshot:job.handle.snapshot()}}
   if(action==='confirm'){if(job.state!=='granted')throw Error('proxy_job_not_granted');await job.handle.confirm(stage);this.event('confirmed',job,{stage:stage||null});return {ok:true,snapshot:job.handle.snapshot()}}
   if(action==='close'||action==='cancel'){
    if(job.state==='closed')return {ok:true,state:'closed'};
    job.state='releasing';job.closing=true;this.event('release_requested',job);
    try{await job.handle.close()}finally{job.closing=false}
    if(job.handle.snapshot().phase==='closed')this.closed(job);
    this.kick();return {ok:true,state:job.state,releaseAccepted:true};
   }
   throw Error('invalid_proxy_job_action');
  };
  const task=job.tail.catch(()=>{}).then(execute);job.tail=task.catch(()=>{});return task;
 }
 closed(job){job.state='closed';job.ended=this.clock();this.activeAccounts.delete(job.nome);this.event('closed',job);this.kick()}
 prune(){
  const now=this.clock();for(const [id,j]of this.jobs)if(j.ended&&now-j.ended>600000)this.jobs.delete(id);
  // Completion history must not consume the work queue's whole capacity.
  if(this.jobs.size>=this.limit){const ended=[...this.jobs.values()].filter(j=>j.ended).sort((a,b)=>a.ended-b.ended);for(const job of ended){if(this.jobs.size<Math.max(1,this.limit-128))break;this.jobs.delete(job.id)}}
 }
 async sweep(){
  if(this.sweeping)return;this.sweeping=true;
  try{for(const job of this.jobs.values()){
   if(['queued','acquiring'].includes(job.state)&&(!job.alive()||this.clock()-job.seen>90000)){job.abort.abort(Error('proxy_worker_unavailable'));job.state='canceled';job.ended=this.clock();}
   if(job.state==='granted'&&(!job.alive()||this.clock()-job.seen>90000||job.handle.snapshot().healthy===false)){await this.command(job.id,job.owner,'close').catch(e=>{job.error=e.message});}
   if(job.state==='releasing'&&!job.closing)try{
    // A lost release can fail again after CT already closed this exact operation.
    // Closure proof must be checked before retrying a request that can keep failing.
    if(await job.handle.reconcileClosed()){this.closed(job);continue;}
    if(!['closed','release_requested'].includes(job.handle.snapshot().phase)&&job.handle.retryRelease)await job.handle.retryRelease();
    if(await job.handle.reconcileClosed())this.closed(job);
   }catch(error){job.error=String(error.message||error)}
  }this.prune();this.kick()}finally{this.sweeping=false}
 }
 snapshot(){const jobs=[...this.jobs.values()];return {owner:'index',pendingCt:this.acquiring?1:0,queued:jobs.filter(j=>j.state==='queued').length,active:jobs.filter(j=>j.state==='granted').length,releasing:jobs.filter(j=>j.state==='releasing').length,jobs:jobs.filter(j=>!j.ended).map(j=>({nome:j.nome,purpose:j.purpose,intent:j.intent,state:j.state,waitMs:this.clock()-j.at}))}}
}
let singleton;
function instance(){if(!singleton){singleton=new Coordinator({audit:row=>require('../provisionAudit').append(row)});const timer=setInterval(()=>singleton.sweep().catch(()=>{}),5000);timer.unref()}return singleton}
module.exports={Coordinator,instance,priority};
