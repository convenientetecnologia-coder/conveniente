'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{OperationClient}=require('./client'),clock=require('./clock');
const ROOT=path.join(__dirname,'..','..','dados','carrier_v2_operations'),CONFIG=path.join(__dirname,'..','..','dados','carrier_v2_private','config.json');
function readConfig(){if(!fs.existsSync(CONFIG))return null;const c=JSON.parse(fs.readFileSync(CONFIG,'utf8'));return c.enabled===true?c:null}
function location(nome,type){return path.join(ROOT,crypto.createHash('sha256').update(nome+'\0'+type).digest('hex')+'.json')}
function write(file,row){const tmp=file+'.'+process.pid+'.tmp';let fd;try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(row));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(tmp,file)}finally{if(fd!==null&&fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp)}}
const locks=new Set();
const waiting=new Map();
function lock(file){const f=file+'.lock';if(locks.has(f))throw Error('cp2_account_operation_busy');for(let n=0;n<2;n++){try{const fd=fs.openSync(f,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.fsyncSync(fd);fs.closeSync(fd);locks.add(f);return ()=>{locks.delete(f);fs.unlinkSync(f)}}catch(e){if(e.code!=='EEXIST')throw e;let old;try{old=JSON.parse(fs.readFileSync(f,'utf8'))}catch{throw Error('cp2_operation_lock_corrupt')}try{process.kill(old.pid,0)}catch(error){if(error.code==='ESRCH'){fs.unlinkSync(f);continue}throw Error('cp2_operation_owner_unreachable')}throw Error('cp2_account_operation_busy')}}throw Error('cp2_account_operation_busy')}
async function beginOnce({nome,purpose,signal,isReady=async()=>true,onWait=()=>{},config=readConfig(),Client=OperationClient,root=ROOT}){
 if(!config)throw Error('cp2_not_enabled');const type={publish:'publish',renew:'renew',id:'identity'}[purpose];if(!type)throw Error('cp2_flow_not_supported');
 fs.mkdirSync(root,{recursive:true});const file=root===ROOT?location(nome,type):path.join(root,crypto.createHash('sha256').update(nome+'\0'+type).digest('hex')+'.json'),unlock=lock(file);let row,client,op,closed=false;
 const persist=()=>write(file,row);
 try{
  const old=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  if(old?.sent&&old.result!=='confirmed')throw Error('cp2_unknown_requires_review:'+old.operationId);
  if(old&&old.phase!=='closed'){
   const previous=new Client({...config,edgeGeneration:old.edgeGeneration});
   const status=await previous.request('/'+old.operationId);
   if(!['released','canceled','expired','unknown','failed'].includes(status.state)){
    const result=await previous.request('/'+old.operationId+(status.state==='queued'?'/cancel-queued':'/cancel'),status.state==='queued'?{expectedState:'queued'}:{leaseId:status.leaseId,leaseGeneration:status.leaseGeneration,carrierGeneration:status.carrierGeneration,businessResult:old.result==='confirmed'?'confirmed':'not_started'});
    if(!['released','canceled','expired'].includes(result.state))throw Error('cp2_previous_operation_not_closed');
   }
   // Preserve every prior journal before starting another operation.
  }
  if(old){const archive=file+'.'+old.operationId+'.history';if(!fs.existsSync(archive))fs.copyFileSync(file,archive,fs.constants.COPYFILE_EXCL);else if(!fs.readFileSync(file).equals(fs.readFileSync(archive)))throw Error('cp2_history_conflict')}
  row={version:1,nome,type,operationId:crypto.randomUUID(),edgeGeneration:crypto.randomUUID(),phase:'queued',sent:false,result:'not_started',at:Date.now()};persist();client=new Client({...config,edgeGeneration:row.edgeGeneration});
  const started=Date.now();
  try{op=await require('../robeQueue').withoutActiveSlot(resume=>client.acquire({operationId:row.operationId,accountId:nome,type,eligiblePhoneIds:config.eligiblePhoneIds,signal,isReady:async()=>{await resume();return isReady()},onWait:status=>{row.phase='queued';persist();waiting.set(nome,{type,operationId:row.operationId,since:started,state:status.state});onWait(status)}}))}finally{clock.addWait(Date.now()-started);waiting.delete(nome)}
  row.phase='active';row.lease={leaseId:op.status.leaseId,leaseGeneration:op.status.leaseGeneration,carrierGeneration:op.status.carrierGeneration};persist();
  const route=await client.openRoute(op,{heartbeatMs:config.heartbeatMs});
  return {
   operationId:row.operationId,hop:{host:'127.0.0.1',port:route.port,user:'',pass:''},
   async possibleSideEffect(){if(row.sent)return;if(op.heartbeatError||op.transportError)throw Error('cp2_transport_not_healthy');row.sent=true;row.result='unknown';persist();await client.possibleSideEffect(op)},
   confirm(){row.result='confirmed';op.result='confirmed';persist()},
   async close(){if(closed)return;closed=true;try{await client.release(op,row.result);row.phase='closed';persist()}finally{unlock()}},
   snapshot(){return {operationId:row.operationId,type:row.type,phase:row.phase,sent:row.sent,result:row.result}}
  };
 }catch(error){if(op)try{await client.release(op,row?.result||'not_started')}catch{}unlock();throw error}
}
async function begin(options){
 for(;;){
  if(options.signal?.aborted)throw options.signal.reason||Error('operation_canceled');
  try{return await beginOnce(options)}catch(error){
   // An offer may expire while another local account owns the worker slot.
   // No action was activated/sent in these cases: reconcile old admission,
   // then request another offer rather than flagging an account error.
   if(!['offer_not_ready','cp2_terminal:expired','cp2_terminal:canceled'].includes(error.message)||options.signal?.aborted)throw error;
   options.onWait?.({state:'waiting_authority',reason:'offer_expired_before_activation'});
  }
 }
}
module.exports={readConfig,begin,getWaiting:nome=>waiting.get(nome)||null};
