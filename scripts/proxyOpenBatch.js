'use strict';
const fs=require('node:fs'),path=require('node:path');
const FILE=path.join(__dirname,'../dados/desired.json');
const TERMINAL=new Set(['ready','blocked','deferred']);
let cached={at:0,held:false};
function active(desired){return desired?._openAll?.active===true&&desired._openAll.mode==='proxy_bootstrap'}
function holds(){const now=Date.now();if(now-cached.at<1000)return cached.held;try{cached={at:now,held:active(JSON.parse(fs.readFileSync(FILE,'utf8')))}}catch(error){cached={at:now,held:error.code!=='ENOENT'}}return cached.held}
function apply(desired,{startedAt,observations,now=Date.now()}){
 const batch=desired?._openAll;if(!active(desired)||batch.startedAt!==startedAt)return {changed:false};
 const queue=[...new Set([...(batch.queue||[]),...Object.keys(desired.perfis||{}).filter(n=>desired.perfis[n]?.provisioningPending&&!desired.perfis[n]?.humanHold)])];
 const progress={...(batch.progress||{})};let changed=queue.length!==(batch.queue||[]).length;
 for(const [name,value]of Object.entries(observations)){
  if(!queue.includes(name))continue;
  const prior=progress[name];
  if(!prior||prior.state!==value.state||prior.reason!==value.reason){progress[name]={...value,at:now};changed=true}
 }
 const timedOut=now-startedAt>=2*60*60*1000;
 if(timedOut)for(const name of queue)if(!TERMINAL.has(progress[name]?.state)){progress[name]={state:'deferred',reason:'opening_batch_deadline',at:now};changed=true}
 const done=queue.every(name=>TERMINAL.has(progress[name]?.state));
 if(!changed&&!done)return {changed:false};
 batch.queue=queue;batch.progress=progress;
 if(done){batch.active=false;batch.doneAt=now;batch.partial=queue.some(n=>progress[n]?.state==='deferred');batch.summary={ready:0,blocked:0,deferred:0};for(const n of queue)batch.summary[progress[n].state]++;}
 return {changed:true,done,summary:batch.summary||null};
}
async function reconcile({snapshot,observe,update,allow=()=>true,now=Date.now,audit=()=>{}}){
 if(!active(snapshot))return;
 const batch=snapshot._openAll,observations={};
 const queue=[...new Set([...(batch.queue||[]),...Object.keys(snapshot.perfis||{}).filter(n=>snapshot.perfis[n]?.provisioningPending)])];
 for(const name of queue)if(allow(name))observations[name]=await observe(name,snapshot.perfis?.[name]||{},batch.startedAt);
 if(!apply(structuredClone(snapshot),{startedAt:batch.startedAt,observations,now:now()}).changed)return {changed:false};
 let result;await update(d=>{result=apply(d,{startedAt:batch.startedAt,observations,now:now()});return d});
 if(result?.done)audit({ts:now(),event:'proxy_open_batch_done',startedAt:batch.startedAt,...result.summary});
 return result;
}
module.exports={active,holds,apply,reconcile};
