'use strict';
const crypto=require('node:crypto'),ipc=require('../workerIpc');
const readiness=new Map();
const delay=(ms,signal)=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason||Error('proxy_job_canceled'))};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},ms);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})});
async function ready(id){const entry=readiness.get(id);return !!entry&&!entry.signal?.aborted&&await entry.isReady()}
async function begin(options,{request=ipc.request,pollMs=1000,setTimer=setInterval,clearTimer=clearInterval}={}){
 const id=crypto.randomUUID(),job={id,nome:options.nome,purpose:options.purpose,intent:options.intent||'observe',hotUntil:options.hotUntil||0,messageIsolation:options.messageIsolation===true,observationRecovery:options.observationRecovery===true,authenticationRecovery:options.authenticationRecovery===true};
 const rpc=async(action,extra={})=>{const timeoutMs=['effect','confirm','close','cancel','reconcile'].includes(action)?120000:15000;const response=await request({type:'proxy:job',action,ticket:id,job,...extra},timeoutMs);if(!response?.ok)throw Error(response?.error||'proxy_index_unavailable');return response};
 readiness.set(id,{isReady:options.isReady||(()=>true),signal:options.signal});let granted=null;
 try{
  for(;;){
   options.signal?.throwIfAborted();
   let state;try{state=await rpc('enqueue')}catch(error){if(!['timeout','ipc_send_failed','proxy_index_unavailable','proxy_index_queue_full'].includes(error.message))throw error;options.onWait?.({state:'waiting_index'});await delay(pollMs,options.signal);continue}
   if(state.state==='granted'){granted=state;break}
   if(['failed','canceled','closed'].includes(state.state))throw Error(state.error||'proxy_index_job_'+state.state);
   options.onWait?.({state:state.state==='queued'?'waiting_index_queue':'waiting_authority',ticket:id});await delay(pollMs,options.signal);
  }
 }catch(error){try{await rpc('cancel')}catch{}throw error}
 finally{readiness.delete(id)}
 let last=granted.snapshot,lastAt=Date.now(),closed=false,checking=false,operationStarted=false,statusError=null;
 const refresh=response=>{if(response.snapshot){last=response.snapshot;lastAt=Date.now();statusError=null}return response};
 const timer=setTimer(async()=>{if(closed||checking)return;checking=true;try{refresh(await rpc('status'));if(last?.healthy===false||last?.absoluteDeadline&&Date.now()>=last.absoluteDeadline*1000)await api.close()}catch(error){statusError=String(error.message||error).slice(0,160);last={...last,healthy:false}}finally{checking=false}},2000);timer.unref?.();
 const assertHealthy=()=>{if(last?.healthy!==true||Date.now()-lastAt>30000||last.absoluteDeadline&&Date.now()>=last.absoluteDeadline*1000)throw Error('cp2_transport_not_healthy')};
 const api={operationId:granted.operationId,hop:granted.hop,
  async possibleSideEffect(stage){assertHealthy();refresh(await rpc('effect',{stage}));assertHealthy()},
  async confirm(stage){assertHealthy();refresh(await rpc('confirm',{stage}));},
  async close(){if(closed)return;closed=true;clearTimer(timer);await rpc('close',{operationId:granted.operationId})},
  async reconcileClosed(){return (await rpc('reconcile',{operationId:granted.operationId})).closed===true},
  snapshot(){return {...last,closed,statusError,statusAgeMs:Date.now()-lastAt,healthy:!closed&&last?.healthy===true&&Date.now()-lastAt<=30000&&(!last.absoluteDeadline||Date.now()<last.absoluteDeadline*1000)}},
 };
 try{await rpc('start');operationStarted=true;return api}finally{if(!operationStarted)await api.close().catch(()=>{})}
}
module.exports={begin,ready};
