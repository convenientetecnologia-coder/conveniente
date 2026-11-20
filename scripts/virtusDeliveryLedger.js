'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),DB=require('better-sqlite3');
const lifetime=require('./virtusDeliveryLifetime');
const ROOT=path.join(process.env.ProgramData||process.env.PROGRAMDATA||path.resolve(__dirname,'../dados'),'Conveniente','virtus_delivery_ledger');
const liveClaims=new Set();
const claimKey=(root,account,id)=>JSON.stringify([path.resolve(root),account,id]);
function ownerRunning(row){if(row.attemptActive!==true)return false;if(!Number.isSafeInteger(row.attemptOwnerPid)||row.attemptOwnerPid<1)throw fail('virtus_delivery_attempt_owner_invalid');try{process.kill(row.attemptOwnerPid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw fail('virtus_delivery_attempt_owner_unreachable')}}
const MAX_RECORD_BYTES=65536,MAX_ROWS=5000,MAX_PAYLOAD_BYTES=32*1024*1024,RETRY_GRACE_MS=120000;
const hash=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
function fail(code){const error=Error(code);error.deliveryReconciliationRequired=true;return error}
function identity(value){if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.includes('\0')||value.length>2048)throw fail('virtus_delivery_identity_invalid');return value}
function encoded(value){const raw=JSON.stringify(value);if(Buffer.byteLength(raw)>MAX_RECORD_BYTES)throw fail('virtus_delivery_record_too_large');return raw}
function open(root){fs.mkdirSync(root,{recursive:true});const db=new DB(path.join(root,'delivery.sqlite'));try{db.pragma('busy_timeout=5000');db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('wal_autocheckpoint=256');db.pragma('journal_size_limit=1048576');const pageSize=db.pragma('page_size',{simple:true});db.pragma('max_page_count='+Math.floor(1024*1024*1024/pageSize));db.exec("CREATE TABLE IF NOT EXISTS deliveries(account TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(account,id));CREATE TABLE IF NOT EXISTS pending(account TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(account,id));CREATE INDEX IF NOT EXISTS deliveries_state ON deliveries(json_extract(body,'$.state'));CREATE INDEX IF NOT EXISTS deliveries_message_id ON deliveries(account,json_extract(body,'$.evidence.messageId'));");return db}catch(error){db.close();throw error}}
function use(root,fn){let db;try{db=open(root);return fn(db)}catch(error){if(error.deliveryReconciliationRequired||error.deliveryCommandRejected)throw error;const wrapped=fail('virtus_delivery_storage_unavailable');wrapped.cause=error;wrapped.storageCode=String(error.code||error.name||'unknown');throw wrapped}finally{db?.close()}}
function validate(row,account,id){
 if(!row||row.version!==1||row.account!==account||row.id!==id||!['confirmed','reconciliation_required','retry_ready'].includes(row.state)||typeof row.thread!=='string'||!row.thread||!/^[a-f0-9]{64}$/.test(row.contentHash)||typeof row.attemptId!=='string'||row.hashAlgorithm!=='sha256-utf8-exact-v1'||!Number.isFinite(row.createdAt))throw fail('virtus_delivery_record_invalid');
 if(row.state==='confirmed'&&!validEvidence(row,row.evidence))throw fail('virtus_delivery_record_invalid');return row;
}
function validEvidence(row,e){return !!e&&e.source==='facebook_server_event'&&e.account===row.account&&e.thread===row.thread&&e.clientMessageId===row.id&&e.attemptId===row.attemptId&&e.contentHash===row.contentHash&&typeof e.messageId==='string'&&!!e.messageId.trim()&&Number.isFinite(e.messageAt)&&e.messageAt>=(row.earliestAttemptAt??row.createdAt)-2000&&e.messageAt<=Date.now()+5000}
function get(db,account,id){const r=db.prepare('SELECT body FROM deliveries WHERE account=? AND id=?').get(account,id);return r?validate(JSON.parse(r.body),account,id):null}
function pending(db,account,id){const found=db.prepare('SELECT body FROM pending WHERE account=? AND id=?').get(account,id);if(!found)return null;let row;try{row=JSON.parse(found.body)}catch{throw fail('virtus_delivery_pending_invalid')}
 if(row.version!==1||row.state!=='reconciliation_required'||row.account!==account||row.id!==id||!Number.isFinite(row.createdAt)||typeof row.thread!=='string'||!row.record||row.record.nome!==account||(row.record.client_message_id||row.record.id)!==id||row.record.thread_key!==row.thread||typeof row.record.texto_resposta!=='string'||row.contentHash!==hash(row.record.texto_resposta))throw fail('virtus_delivery_pending_invalid');return row;
}
function read(account,id,{root=ROOT}={}){identity(account);identity(id);return use(root,db=>get(db,account,id)||pending(db,account,id))}
function same(row,thread,text){if(row.thread!==identity(thread)||row.contentHash!==hash(text))throw fail('virtus_delivery_identity_conflict')}
function budget(db,body,previousBody=null){const n=db.prepare("SELECT SUM(n) n,SUM(bytes) bytes FROM (SELECT COUNT(*) n,COALESCE(SUM(length(CAST(body AS BLOB))),0) bytes FROM deliveries WHERE json_extract(body,'$.state') IS NULL OR json_extract(body,'$.state')<>'confirmed' UNION ALL SELECT COUNT(*),COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM pending)").get();const nextActive=JSON.parse(body).state!=='confirmed',previousActive=previousBody!==null&&JSON.parse(previousBody).state!=='confirmed';if(n.n+(nextActive?1:0)-(previousActive?1:0)>MAX_ROWS||n.bytes+(nextActive?Buffer.byteLength(body):0)-(previousActive?Buffer.byteLength(previousBody):0)>MAX_PAYLOAD_BYTES)throw fail('virtus_delivery_capacity_reconciliation_required')}
function begin({account,id,thread,text,issued_at,issuedAt,root=ROOT}){
 identity(account);identity(id);identity(thread);if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>MAX_RECORD_BYTES/2)throw fail('virtus_delivery_identity_invalid');
 const result=use(root,db=>db.transaction(()=>{const blocked=pending(db,account,id);if(blocked){same(blocked,thread,text);throw fail('virtus_delivery_reconciliation_required')}const old=get(db,account,id);if(old){same(old,thread,text);if(old.state!=='retry_ready')throw fail(old.state==='confirmed'?'virtus_delivery_already_confirmed':'virtus_delivery_reconciliation_required')}
  const now=Date.now(),commandIssuedAt=old?(old.issuedAt??lifetime.issuedAtOf(old.record||{id})):lifetime.assertNewCommand({client_message_id:id,issued_at,issuedAt},{now}),row={...old,version:1,account,id,thread,issuedAt:commandIssuedAt,contentHash:hash(text),hashAlgorithm:'sha256-utf8-exact-v1',attemptId:crypto.randomUUID(),state:'reconciliation_required',error:null,hasAttempted:true,nextRetryAt:0,createdAt:now,earliestAttemptAt:old?.earliestAttemptAt??now,lastAttemptAt:now,attemptOwnerPid:process.pid,attemptActive:true,retryCount:Math.min(1000000,(old?.retryCount||0)+(old?1:0)),record:old?.record||{nome:account,client_message_id:id,thread_key:thread,texto_resposta:text,...(commandIssuedAt!==null?{issued_at:commandIssuedAt}:{})}},raw=encoded(row);budget(db,raw,old?encoded(old):null);db.prepare('INSERT OR REPLACE INTO deliveries VALUES(?,?,?)').run(account,id,raw);return row;
 }).immediate());liveClaims.add(claimKey(root,account,id));return result;
}
function confirm(row,evidence,{root=ROOT}={}){const result=use(root,db=>db.transaction(()=>{
 const old=get(db,identity(row.account),identity(row.id));if(!old||old.attemptId!==row.attemptId)throw fail('virtus_delivery_attempt_mismatch');
 if(!validEvidence(old,evidence))throw fail('virtus_delivery_server_evidence_missing');
 if(old.state==='confirmed'){if(old.evidence.messageId!==evidence.messageId||old.evidence.messageAt!==evidence.messageAt)throw fail('virtus_delivery_evidence_conflict');return old}
  const next={...old,state:'confirmed',confirmedAt:Date.now(),evidence},raw=encoded(next);budget(db,raw,encoded(old));db.prepare('UPDATE deliveries SET body=? WHERE account=? AND id=?').run(raw,old.account,old.id);db.prepare('DELETE FROM pending WHERE account=? AND id=?').run(old.account,old.id);return next;
 }).immediate());liveClaims.delete(claimKey(root,row.account,row.id));return result}
function inspect({account,id,thread,text,root=ROOT}){const row=read(account,id,{root});if(row)same(row,thread,text);return row?.state==='retry_ready'?null:row}
function isUncertain(error){return error?.deliveryReconciliationRequired===true||/^virtus_(?:send_server_ack_unconfirmed|send_unconfirmed_no_replay|delivery_)/.test(String(error?.message||error||''))}
function envelope(record){return Object.fromEntries(['server_id','serverId','hostId','registrationEpoch','registration_epoch','operation_sequence','operationSequence','type','issued_at','issuedAt'].filter(k=>record[k]!==undefined).map(k=>[k,record[k]]))}
function defer(record,error,{root=ROOT}={}){
 const account=identity(record.nome),id=identity(record.client_message_id||record.id),thread=identity(record.thread_key),text=record.texto_resposta;if(typeof text!=='string')throw fail('virtus_delivery_identity_invalid');
 return use(root,db=>db.transaction(()=>{const done=get(db,account,id);if(done?.state==='confirmed'){same(done,thread,text);return done}const old=pending(db,account,id);
  if(old){
    if(old.version!==1||old.state!=='reconciliation_required'||old.account!==account||old.id!==id||old.thread!==thread||old.contentHash!==hash(text)||!old.record||old.record.nome!==account||(old.record.client_message_id||old.record.id)!==id||old.record.thread_key!==thread||old.record.texto_resposta!==text||JSON.stringify(envelope(old.record))!==JSON.stringify(envelope(record)))throw fail('virtus_delivery_pending_conflict');
    if(old.error==='queued_before_dispatch'&&String(error)!=='queued_before_dispatch'){const next={...old,hasAttempted:false,error:String(error),nextRetryAt:Date.now()+30000},raw=encoded(next);budget(db,raw,encoded(old));db.prepare('UPDATE pending SET body=? WHERE account=? AND id=?').run(raw,account,id);return next}return old;
  }
  const row={version:1,account,id,thread,contentHash:hash(text),state:'reconciliation_required',createdAt:Date.now(),error:String(error),record},raw=encoded(row);budget(db,raw);db.prepare('INSERT INTO pending VALUES(?,?,?)').run(account,id,raw);return row;
 }).immediate());
}
function stage(record,{root=ROOT}={}){
 const account=identity(record.nome),id=identity(record.client_message_id||record.id);
 const existing=read(account,id,{root});
 if(existing){same(existing,record.thread_key,record.texto_resposta);if(existing.record&&JSON.stringify(envelope(existing.record))!==JSON.stringify(envelope(record)))throw fail('virtus_delivery_pending_conflict');return existing}
 lifetime.assertNewCommand(record);
 return defer(record,'queued_before_dispatch',{root});
}
function retryAt(row){const base=row.state==='retry_ready'||row.hasAttempted===false||row.error==='queued_before_dispatch'?0:(row.lastAttemptAt??row.createdAt)+RETRY_GRACE_MS;return Math.max(base,Number(row.nextRetryAt)||0)}
function listDue({root=ROOT,now=Date.now(),limit=32,eligible=()=>true}={}){
 if(!Number.isFinite(now))throw fail('virtus_delivery_clock_invalid');
 return use(root,db=>{
  const rows=new Map();
  for(const r of db.prepare('SELECT account,id FROM pending').all()){const row=pending(db,r.account,r.id);rows.set(JSON.stringify([r.account,r.id]),row)}
  for(const r of db.prepare("SELECT account,id FROM deliveries WHERE json_extract(body,'$.state') IS NULL OR json_extract(body,'$.state')<>'confirmed'").all()){const row=get(db,r.account,r.id);rows.set(JSON.stringify([r.account,r.id]),row)}
  return [...rows.values()].filter(row=>row.state!=='confirmed'&&retryAt(row)<=now&&!liveClaims.has(claimKey(root,row.account,row.id))&&!ownerRunning(row)).sort((a,b)=>retryAt(a)-retryAt(b)||a.createdAt-b.createdAt).map(row=>{
   if(!row.record)throw fail('virtus_delivery_record_missing');same(row,row.record.thread_key,row.record.texto_resposta);
   if(row.record.nome!==row.account||(row.record.client_message_id||row.record.id)!==row.id)throw fail('virtus_delivery_record_invalid');
   return {...row.record};
  }).filter(eligible).slice(0,Math.max(1,Math.min(128,Math.floor(limit)||32)));
 });
}
function prepareRetry({account,id,thread,text,root=ROOT,now=Date.now()}){
 identity(account);identity(id);if(!Number.isFinite(now))throw fail('virtus_delivery_clock_invalid');
 return use(root,db=>db.transaction(()=>{
  const delivery=get(db,account,id),waiting=pending(db,account,id),old=delivery||waiting;
  if(!old)throw fail('virtus_delivery_record_missing');same(old,thread,text);if(waiting)same(waiting,thread,text);
  if(old.state==='confirmed')return old;
  if(liveClaims.has(claimKey(root,account,id))||ownerRunning(old)||retryAt(old)>now)throw fail('virtus_delivery_retry_not_due');
  if(old.state==='retry_ready')return old;
  const staged=old.hasAttempted===false||old.error==='queued_before_dispatch',legacyAt=Number(old.record?.ts),earliest=old.earliestAttemptAt??(staged?undefined:(Number.isFinite(legacyAt)&&legacyAt>0&&legacyAt<=now?legacyAt:old.createdAt));
  const next={...old,version:1,attemptId:old.attemptId||crypto.randomUUID(),hashAlgorithm:'sha256-utf8-exact-v1',issuedAt:old.issuedAt??lifetime.issuedAtOf(waiting?.record||old.record||{id}),state:'retry_ready',retryCount:old.retryCount||0,...(earliest!==undefined?{earliestAttemptAt:earliest}:{}),record:waiting?.record||old.record};
  const raw=encoded(next);if(waiting)db.prepare('DELETE FROM pending WHERE account=? AND id=?').run(account,id);
  budget(db,raw,delivery?encoded(delivery):null);db.prepare('INSERT OR REPLACE INTO deliveries VALUES(?,?,?)').run(account,id,raw);return next;
 }).immediate());
}
// Caller must supply only parsed, server-originated messages classified as this account's own.
// Text/time correlation is deliberately labelled; it is not a wire-level client-id acknowledgement.
function recordServerEcho({account,thread,text,messageId,messageAt,root=ROOT,onAmbiguous=()=>{}}){
 identity(account);identity(thread);identity(messageId);if(typeof text!=='string'||!Number.isFinite(Number(messageAt))||Number(messageAt)>Date.now()+5000)return null;messageAt=Number(messageAt);
 const result=use(root,db=>db.transaction(()=>{
  const duplicateId=db.prepare("SELECT id FROM deliveries WHERE account=? AND json_extract(body,'$.state')='confirmed' AND json_extract(body,'$.evidence.messageId')=? LIMIT 1").get(account,messageId),duplicate=duplicateId?get(db,account,duplicateId.id):null;if(duplicate)return duplicate.thread===thread&&duplicate.contentHash===hash(text)?duplicate:null;
  const rows=new Map();for(const r of db.prepare('SELECT id FROM pending WHERE account=?').all(account))rows.set(r.id,pending(db,account,r.id));for(const r of db.prepare("SELECT id FROM deliveries WHERE account=? AND (json_extract(body,'$.state') IS NULL OR json_extract(body,'$.state')<>'confirmed')").all(account))rows.set(r.id,get(db,account,r.id));
  const matches=[...rows.values()].filter(r=>r.state!=='confirmed'&&r.thread===thread&&r.contentHash===hash(text)&&r.hasAttempted!==false&&r.error!=='queued_before_dispatch'&&messageAt>=(r.earliestAttemptAt??(Number(r.record?.ts)>0?Number(r.record.ts):r.createdAt))-2000);
  if(matches.length!==1){if(matches.length>1)onAmbiguous({account,thread,messageId,logicalIds:matches.map(r=>r.id)});return null}
  const old=matches[0],at=old.earliestAttemptAt??(Number(old.record?.ts)>0?Number(old.record.ts):old.createdAt),row={...old,attemptId:old.attemptId||crypto.randomUUID(),hashAlgorithm:'sha256-utf8-exact-v1',earliestAttemptAt:at,issuedAt:old.issuedAt??lifetime.issuedAtOf(old.record||{id:old.id})};
  const evidence={source:'facebook_server_event',correlation:'thread_text_server_time',account,thread,clientMessageId:row.id,attemptId:row.attemptId,contentHash:row.contentHash,messageId,messageAt};if(!validEvidence(row,evidence))return null;
  const next={...row,state:'confirmed',confirmedAt:Date.now(),evidence},raw=encoded(next),previous=get(db,account,row.id);
  db.prepare('DELETE FROM pending WHERE account=? AND id=?').run(account,row.id);budget(db,raw,previous?encoded(previous):null);db.prepare('INSERT OR REPLACE INTO deliveries VALUES(?,?,?)').run(account,row.id,raw);return next;
 }).immediate());if(result)liveClaims.delete(claimKey(root,result.account,result.id));return result;
}
function snooze({account,id,error,delayMs=30000,root=ROOT}){
 identity(account);identity(id);const delay=Math.max(4000,Math.min(60000,Number(delayMs)||30000));
 return use(root,db=>db.transaction(()=>{const row=get(db,account,id)||pending(db,account,id);if(!row)throw fail('virtus_delivery_record_missing');if(row.state==='confirmed')return row;
  const next={...row,error:String(error||'retry_delayed'),nextRetryAt:Date.now()+delay,...(row.error==='queued_before_dispatch'?{hasAttempted:false}:{})},raw=encoded(next);budget(db,raw,encoded(row));const table=get(db,account,id)?'deliveries':'pending';db.prepare('UPDATE '+table+' SET body=? WHERE account=? AND id=?').run(raw,account,id);return next;
 }).immediate());
}
function listReceipts({root=ROOT,limit=32,now=Date.now(),eligible=()=>true}={}){return use(root,db=>{
 if(!Number.isFinite(now))throw fail('virtus_delivery_clock_invalid');
 const found=[],maximum=Math.max(1,Math.min(128,Math.floor(limit)||32));
 for(const ref of db.prepare("SELECT account,id FROM deliveries WHERE json_extract(body,'$.state')='confirmed' AND NOT COALESCE(json_extract(body,'$.reportedAt'),0) AND COALESCE(json_extract(body,'$.reportRetryAt'),0)<=? ORDER BY json_extract(body,'$.confirmedAt')").iterate(now)){
  const row=get(db,ref.account,ref.id);if(!row.record||row.record.nome!==row.account||(row.record.client_message_id||row.record.id)!==row.id)throw fail('virtus_delivery_record_missing');same(row,row.record.thread_key,row.record.texto_resposta);const record={...row.record};if(eligible(record))found.push(record);if(found.length>=maximum)break;
 }
 return found;
})}
function compactReported(row,now){
 if(row.record){if(row.record.nome!==row.account||(row.record.client_message_id||row.record.id)!==row.id)throw fail('virtus_delivery_record_invalid');same(row,row.record.thread_key,row.record.texto_resposta)}
 const issuedAt=Number.isSafeInteger(row.issuedAt)&&row.issuedAt>0?row.issuedAt:lifetime.issuedAtOf(row.record||{id:row.id});
 const next={...row,reportedAt:row.reportedAt||now,issuedAt};
 for(const key of ['record','error','nextRetryAt','attemptActive','attemptOwnerPid','reportRetryAt','reportError'])delete next[key];
 return next;
}
function markReported({account,id,root=ROOT}){identity(account);identity(id);return use(root,db=>db.transaction(()=>{const row=get(db,account,id);if(!row||row.state!=='confirmed')throw fail('virtus_delivery_not_confirmed');const next=compactReported(row,Date.now()),raw=encoded(next);budget(db,raw,encoded(row));db.prepare('UPDATE deliveries SET body=? WHERE account=? AND id=?').run(raw,account,id);return next}).immediate())}
function markReportPending({account,id,error,delayMs=60000,root=ROOT}){identity(account);identity(id);return use(root,db=>db.transaction(()=>{
 const row=get(db,account,id);if(!row||row.state!=='confirmed')throw fail('virtus_delivery_not_confirmed');
 // reportedAt means the CT accepted the receipt, not merely local enqueueing.
 // A later duplicate transport error cannot revoke that accepted receipt.
 if(row.reportedAt)return row;
 if(!row.record)throw fail('virtus_delivery_record_missing');
 const next={...row,reportRetryAt:Date.now()+Math.max(4000,Math.min(60000,Number(delayMs)||60000)),reportError:String(error||'confirmation_report_failed')};delete next.reportedAt;
 const raw=encoded(next);budget(db,raw,encoded(row));db.prepare('UPDATE deliveries SET body=? WHERE account=? AND id=?').run(raw,account,id);return next;
}).immediate())}
function maintain({root=ROOT,now=Date.now()}={}){
 if(!Number.isFinite(now))throw fail('virtus_delivery_clock_invalid');
 return use(root,db=>{
  const result=db.transaction(()=>{
   let compacted=0,pruned=0;
   const old=db.prepare("SELECT account,id FROM deliveries WHERE json_extract(body,'$.state')='confirmed' AND COALESCE(json_extract(body,'$.reportedAt'),0)>0 AND json_type(body,'$.record') IS NOT NULL LIMIT 1024").all();
   for(const ref of old){const row=get(db,ref.account,ref.id),next=compactReported(row,now);db.prepare('UPDATE deliveries SET body=? WHERE account=? AND id=?').run(encoded(next),ref.account,ref.id);compacted++}
   const eligible=db.prepare("SELECT account,id FROM deliveries WHERE json_extract(body,'$.state')='confirmed' AND COALESCE(json_extract(body,'$.reportedAt'),0)>0 AND COALESCE(json_extract(body,'$.issuedAt'),0)>0 AND json_extract(body,'$.issuedAt')<?").all(now-lifetime.RECEIPT_RETENTION_MS);
   for(const ref of eligible){const row=get(db,ref.account,ref.id);if(!Number.isSafeInteger(row.issuedAt)||row.issuedAt<=0||!row.reportedAt)continue;db.prepare('DELETE FROM deliveries WHERE account=? AND id=?').run(ref.account,ref.id);pruned++}
   return {compacted,pruned};
  }).immediate();
  const checkpoint=db.pragma('wal_checkpoint(TRUNCATE)')[0];
  return {...result,checkpointBusy:Number(checkpoint?.busy)||0,pageSize:db.pragma('page_size',{simple:true}),maxPageCount:db.pragma('max_page_count',{simple:true})};
 });
}
function markUncertain(row,{root=ROOT}={}){use(root,db=>db.transaction(()=>{const old=get(db,row.account,row.id);if(!old||old.attemptId!==row.attemptId||old.state==='confirmed')return;const next={...old,attemptActive:false,lastAttemptAt:Date.now()},raw=encoded(next);budget(db,raw,encoded(old));db.prepare('UPDATE deliveries SET body=? WHERE account=? AND id=?').run(raw,row.account,row.id)}).immediate());liveClaims.delete(claimKey(root,row.account,row.id))}
function accountBlocked(account,{root=ROOT}={}){identity(account);return use(root,db=>{
 if(db.prepare('SELECT 1 FROM pending WHERE account=? LIMIT 1').get(account))return true;
 const rows=db.prepare("SELECT id,body FROM deliveries WHERE account=? AND (json_extract(body,'$.state') IS NULL OR json_extract(body,'$.state')<>'confirmed')").all(account);
 return rows.some(r=>{const row=validate(JSON.parse(r.body),account,r.id);return row.state==='reconciliation_required'&&!liveClaims.has(claimKey(root,account,r.id))});
})}
module.exports={begin,confirm,read,inspect,isUncertain,defer,accountBlocked,markUncertain,stage,listDue,prepareRetry,claimRetry:prepareRetry,recordServerEcho,snooze,listReceipts,markReported,markReportPending,maintain,RETRY_GRACE_MS,ROOT};
