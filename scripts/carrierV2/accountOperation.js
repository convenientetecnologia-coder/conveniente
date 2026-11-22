'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{OperationClient}=require('./client'),clock=require('./clock');
const ROOT=path.join(__dirname,'..','..','dados','carrier_v2_operations'),CONFIG=path.join(__dirname,'..','..','dados','carrier_v2_private','config.json');
let provisionedConfig=null;
function readConfig(){if(provisionedConfig)return provisionedConfig;if(!fs.existsSync(CONFIG))return null;const c=JSON.parse(fs.readFileSync(CONFIG,'utf8'));return c.enabled===true?c:null}
async function ensureConfig(){provisionedConfig=null;provisionedConfig=await require('./bootstrapClient').read();return provisionedConfig}
function location(nome,type){return path.join(ROOT,crypto.createHash('sha256').update(nome+'\0'+type).digest('hex')+'.json')}
function write(file,row){const tmp=file+'.'+process.pid+'.tmp';let fd;try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(row));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(tmp,file)}finally{if(fd!==null&&fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp)}}
const locks=new Set();
const waiting=new Map();
function lock(file){const f=file+'.lock';if(locks.has(f))throw Error('cp2_account_operation_busy');for(let n=0;n<2;n++){try{const fd=fs.openSync(f,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.fsyncSync(fd);fs.closeSync(fd);locks.add(f);return ()=>{locks.delete(f);fs.unlinkSync(f)}}catch(e){if(e.code!=='EEXIST')throw e;let old;try{old=JSON.parse(fs.readFileSync(f,'utf8'))}catch{throw Error('cp2_operation_lock_corrupt')}try{process.kill(old.pid,0)}catch(error){if(error.code==='ESRCH'){fs.unlinkSync(f);continue}throw Error('cp2_operation_owner_unreachable')}throw Error('cp2_account_operation_busy')}}throw Error('cp2_account_operation_busy')}
async function beginOnce({nome,purpose,intent='observe',hotUntil=0,observationRecovery=false,messageIsolation=false,authenticationRecovery=false,signal,isReady=async()=>true,onWait=()=>{},config=readConfig(),Client=OperationClient,root=ROOT,Ledger=null}){
 if(!config)throw Error('cp2_not_enabled');const type={publish:'publish',renew:'renew',id:'identity',virtus:'virtus',provision:'provision'}[purpose];if(!type)throw Error('cp2_flow_not_supported');
 fs.mkdirSync(root,{recursive:true});const journalType=type==='virtus'?'virtus_'+(intent==='reply'?'reply':intent==='human'?'human':'observe'):type;const file=root===ROOT?location(nome,journalType):path.join(root,crypto.createHash('sha256').update(nome+'\0'+journalType).digest('hex')+'.json'),unlock=lock(file);let row,client,op,closed=false;
 const persist=()=>write(file,row);
 try{
  if(type==='virtus'){const probe=new Client(config);const cap=await probe.capabilities();if(cap.virtusTurns!==true)throw Error('virtus_executor_upgrade_required');if(cap.rotation?.version!==1)throw Error('virtus_rotation_upgrade_required');}
  if(type==='provision'&&(await new Client(config).capabilities()).accountProvision!==true)throw Error('cadastro_proxy_executor_upgrade_required');
  const old=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  if(observationRecovery&&(type!=='virtus'||!['warm','observe','engaged'].includes(intent)))throw Error('cp2_observation_recovery_scope_invalid');
  if(old?.sent&&old.result!=='confirmed'){
   const isolatedVirtus=type==='virtus'&&messageIsolation===true;
   const authenticationRetry=type==='provision'&&authenticationRecovery===true;
   const durableBarrier=type==='virtus'&&!isolatedVirtus?(Ledger||require('../virtusDeliveryLedger')).accountBlocked(nome):false;
   const messageIsolatedReply=type==='virtus'&&intent==='reply'&&durableBarrier;
   if(!isolatedVirtus&&!authenticationRetry&&((!observationRecovery&&!messageIsolatedReply)||old.phase!=='closed'||!durableBarrier))throw Error('cp2_unknown_requires_review:'+old.operationId);
   const previous=new Client({...config,edgeGeneration:old.edgeGeneration});let terminal=await previous.request('/'+old.operationId);
   if(authenticationRetry)terminal=await require('./authenticationTransportRecovery').reconcile({client:previous,old,status:terminal,signal});
   if(!['released','canceled','expired','unknown','failed'].includes(terminal.state))throw Error('cp2_uncertain_transport_not_closed');
  }
  let resumeUnaccepted=false;
  if(old&&old.phase!=='closed'){
   const previous=new Client({...config,edgeGeneration:old.edgeGeneration});
   let status;
   try{status=await previous.request('/'+old.operationId)}catch(error){
    // Admission may never have reached the authority during maintenance.
    // Reuse the same ID and edge generation so a delayed enqueue is idempotent.
    if(error.message!=='operation_not_found'||old.phase!=='queued'||old.sent!==false||old.result!=='not_started'||old.lease)throw error;
    resumeUnaccepted=true;
   }
   if(status&&!['released','canceled','expired','unknown','failed'].includes(status.state)){
    const result=await previous.controlRequest('/'+old.operationId+(status.state==='queued'?'/cancel-queued':'/cancel'),status.state==='queued'?{expectedState:'queued'}:{leaseId:status.leaseId,leaseGeneration:status.leaseGeneration,carrierGeneration:status.carrierGeneration,businessResult:old.result==='confirmed'?'confirmed':'not_started'});
    if(!['released','canceled','expired'].includes(result.state))throw Error('cp2_previous_operation_not_closed');
   }
   // Preserve every prior journal before starting another operation.
  }
  if(old&&!resumeUnaccepted){
    if(type==='virtus'&&old.phase==='closed'&&(!old.sent||old.result==='confirmed')){
      const archive=file+'.completed.json';let history;try{history=JSON.parse(fs.readFileSync(archive,'utf8'))}catch{history={count:0,last:[]}}
      write(archive,{count:(history.count||0)+1,last:[...(history.last||[]),{operationId:old.operationId,at:old.at,sent:old.sent,result:old.result}].slice(-32)});
    }else{const archive=file+'.'+old.operationId+'.history';if(!fs.existsSync(archive))fs.copyFileSync(file,archive,fs.constants.COPYFILE_EXCL);else if(!fs.readFileSync(file).equals(fs.readFileSync(archive)))throw Error('cp2_history_conflict')}
  }
  row=resumeUnaccepted?old:{version:1,nome,type,...(type==='virtus'?{intent,operationSequence:(old?.operationSequence||0)+1}:{}),operationId:crypto.randomUUID(),edgeGeneration:crypto.randomUUID(),phase:'queued',sent:false,result:'not_started',at:Date.now()};persist();client=new Client({...config,edgeGeneration:row.edgeGeneration});
  const started=Date.now();
  const acquire=resume=>client.acquire({operationId:row.operationId,accountId:nome,type,...(type==='virtus'?{intent,operationSequence:row.operationSequence,serverAccountCount:rotationAccountCount(nome),hotUntil}:{}),eligiblePhoneIds:config.eligiblePhoneIds,signal,isReady:async()=>{await resume();return isReady()},onWait:status=>{row.phase='queued';persist();waiting.set(nome,{type,intent,operationId:row.operationId,since:started,state:status.state});onWait(status)}});
  try{op=type==='virtus'?await acquire(async()=>{}):await require('../robeQueue').withoutActiveSlot(acquire)}finally{if(type!=='virtus')clock.addWait(Date.now()-started);waiting.delete(nome)}

  row.phase='active';row.lease={leaseId:op.status.leaseId,leaseGeneration:op.status.leaseGeneration,carrierGeneration:op.status.carrierGeneration};persist();
  const route=await client.openRoute(op,{heartbeatMs:config.heartbeatMs});
  return {
   operationId:row.operationId,hop:{host:'127.0.0.1',port:route.port,user:'',pass:''},
   async possibleSideEffect(){if(observationRecovery)throw Error("cp2_readonly_effect_refused");if(row.sent)return;if(op.heartbeatError||op.transportError)throw Error('cp2_transport_not_healthy');row.sent=true;row.result='unknown';persist();await client.possibleSideEffect(op)},
   confirm(){row.result='confirmed';op.result='confirmed';persist()},
   async close(){if(closed)return;closed=true;try{await client.release(op,row.result);row.phase='closed';persist()}finally{unlock()}},
   snapshot(){return {operationId:row.operationId,type:row.type,phase:row.phase,sent:row.sent,result:row.result,healthy:!op.heartbeatError&&!op.transportError,reconciliationOnly:observationRecovery===true,absoluteDeadline:op.status.ack?.absoluteDeadline||null,rotation:op.status.rotation||null}}
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
function rotationAccountCount(nome){
 try{const desired=JSON.parse(fs.readFileSync(path.join(__dirname,'../../dados/desired.json'),'utf8'));return Math.max(1,Object.values(desired.perfis||{}).filter(p=>p?.active===true&&!p?.humanHold).length)}catch{return 1}
}
module.exports={readConfig,ensureConfig,begin,getWaiting:nome=>waiting.get(nome)||null};
