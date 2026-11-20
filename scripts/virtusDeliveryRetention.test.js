'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),DB=require('better-sqlite3'),ledger=require('./virtusDeliveryLedger'),lifetime=require('./virtusDeliveryLifetime');
function fixture(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'delivery-retention-'));try{return fn(root)}finally{fs.rmSync(root,{recursive:true,force:true})}}
const record=(id,issued_at)=>({nome:'account',client_message_id:id,thread_key:'thread',texto_resposta:'Resposta confirmada',...(issued_at!==undefined?{issued_at}:{})});
function confirmed(root,id,issued_at){const r=record(id,issued_at),row=ledger.begin({account:r.nome,id,thread:r.thread_key,text:r.texto_resposta,issued_at,root});const evidence={source:'facebook_server_event',account:row.account,thread:row.thread,clientMessageId:row.id,attemptId:row.attemptId,contentHash:row.contentHash,messageId:'mid:'+id,messageAt:Date.now()};return ledger.confirm(row,evidence,{root})}
function withNow(now,fn){const previous=Date.now;try{Date.now=()=>now;return fn()}finally{Date.now=previous}}

test('mais de 5000 comprovantes confirmados não consomem quota dos trabalhos ativos',()=>fixture(root=>{
 const now=Date.now(),template=confirmed(root,'template',now);ledger.markReported({account:'account',id:'template',root});
 const db=new DB(path.join(root,'delivery.sqlite')),put=db.prepare('INSERT INTO deliveries VALUES(?,?,?)');
 db.transaction(()=>{for(let n=0;n<5001;n++){const id='done:'+n,row={...template,id,record:{...template.record,client_message_id:id},evidence:{...template.evidence,clientMessageId:id,messageId:'mid:'+id}};put.run('account',id,JSON.stringify(row))}})();db.close();
 const next=ledger.begin({account:'account',id:'new-work',thread:'thread',text:'Resposta nova',root});assert.equal(next.state,'reconciliation_required');
 assert.equal(ledger.accountBlocked('account',{root}),false);
 assert.equal(ledger.listReceipts({root,limit:2}).length,2);
}));

test('comprovante reportado é compactado e expira; replay antigo com ts renovado continua recusado',()=>fixture(root=>{
 const now=Date.now(),id='md_ia_delta:123:'+now;confirmed(root,id,now);
 const compact=ledger.markReported({account:'account',id,root});assert.equal(compact.record,undefined);assert.equal(compact.error,undefined);assert.equal(compact.evidence.messageId,'mid:'+id);assert.equal(compact.issuedAt,now);
 const later=now+9*86400000;assert.equal(ledger.maintain({root,now:later}).pruned,1);assert.equal(ledger.read('account',id,{root}),null);
 withNow(later,()=>{
  assert.throws(()=>ledger.stage({...record(id,now),ts:later},{root}),/delivery_command_expired/);
  assert.throws(()=>ledger.begin({account:'account',id,thread:'thread',text:'Resposta confirmada',root}),/delivery_command_expired/);
  assert.throws(()=>ledger.stage({...record(id,later),ts:later},{root}),/delivery_command_expired/);
 });
}));

test('comprovante genérico sem data e pendência não confirmada nunca são podados por manutenção',()=>fixture(root=>{
 const now=Date.now();confirmed(root,'generic-without-issued');ledger.markReported({account:'account',id:'generic-without-issued',root});
 ledger.stage(record('pending-with-issued',now),{root});const later=now+30*86400000;
 const maintained=ledger.maintain({root,now:later});assert.equal(maintained.pruned,0);assert.equal(ledger.read('account','generic-without-issued',{root}).state,'confirmed');assert.equal(ledger.read('account','pending-with-issued',{root}).state,'reconciliation_required');
 withNow(later,()=>assert.equal(ledger.stage(record('pending-with-issued',now),{root}).state,'reconciliation_required'));
}));

test('recibo sem reportedAt continua disponível mesmo após idade de retenção',()=>fixture(root=>{
 const now=Date.now();confirmed(root,'unreported',now);const later=now+30*86400000;
 assert.equal(ledger.maintain({root,now:later}).pruned,0);assert.equal(ledger.listReceipts({root})[0].client_message_id,'unreported');assert.ok(ledger.read('account','unreported',{root}).record);
}));

test('filtro de elegibilidade ocorre antes do limite em trabalhos e recibos',()=>fixture(root=>{
 for(let n=0;n<34;n++)ledger.stage(record('work:'+n),{root});
 const due=ledger.listDue({root,limit:1,eligible:r=>r.client_message_id==='work:33'});assert.equal(due.length,1);assert.equal(due[0].client_message_id,'work:33');
 for(let n=0;n<34;n++)confirmed(root,'receipt:'+n);
 const receipts=ledger.listReceipts({root,limit:1,eligible:r=>r.client_message_id==='receipt:33'});assert.equal(receipts.length,1);assert.equal(receipts[0].client_message_id,'receipt:33');
}));

test('limite físico de 1 GiB respeita page_size real do SQLite',()=>fixture(root=>{
 const db=new DB(path.join(root,'delivery.sqlite'));db.pragma('page_size=8192');db.exec('CREATE TABLE page_size_fixture(x)');db.close();
 ledger.read('account','missing',{root});const limits=ledger.maintain({root});assert.equal(limits.pageSize,8192);assert.equal(limits.maxPageCount,131072);assert.equal(limits.pageSize*limits.maxPageCount,1024*1024*1024);
}));

test('data explícita inválida ou futura é recusada; data genérica ausente não é inventada',()=>{
 const now=Date.now();assert.equal(lifetime.issuedAtOf({id:'generic'}),null);
 assert.throws(()=>lifetime.assertNewCommand({id:'generic',issued_at:'invalid'},{now}),/issued_at_invalid/);
 assert.throws(()=>lifetime.assertNewCommand({id:'generic',issued_at:now+300001},{now}),/issued_at_invalid/);
 assert.equal(lifetime.assertNewCommand({id:'generic',issued_at:now+300000},{now}),now+300000);
});

test('falha de confirmação no CT conserva recibo completo e respeita atraso antes de outra tentativa',()=>fixture(root=>{
 const now=Date.now();confirmed(root,'ct-receipt',now);
 const pending=ledger.markReportPending({account:'account',id:'ct-receipt',error:'http_403',delayMs:120000,root});
 assert.ok(pending.record);assert.equal(pending.reportedAt,undefined);assert.equal(pending.reportError,'http_403');
 assert.ok(pending.reportRetryAt<=Date.now()+60000);assert.equal(ledger.listReceipts({root,now:pending.reportRetryAt-1}).length,0);
 assert.equal(ledger.listReceipts({root,now:pending.reportRetryAt})[0].client_message_id,'ct-receipt');
 assert.equal(ledger.maintain({root,now:now+30*86400000}).pruned,0);
 const accepted=ledger.markReported({account:'account',id:'ct-receipt',root});assert.equal(accepted.record,undefined);assert.equal(accepted.reportError,undefined);assert.equal(accepted.reportRetryAt,undefined);
 assert.equal(ledger.listReceipts({root,now:now+31*86400000}).length,0);
}));

test('erro de transporte duplicado não revoga recibo já aceito pelo CT',()=>fixture(root=>{
 confirmed(root,'accepted');const row=ledger.markReported({account:'account',id:'accepted',root});
 const again=ledger.markReportPending({account:'account',id:'accepted',error:'late_http_error',root});
 assert.equal(again.reportedAt,row.reportedAt);assert.equal(again.reportError,undefined);assert.equal(ledger.listReceipts({root}).length,0);
}));

test('JSON corrompido não é ignorado pelos filtros SQL de trabalhos e recibos',()=>fixture(root=>{
 ledger.read('account','missing',{root});const db=new DB(path.join(root,'delivery.sqlite'));db.exec('DROP INDEX deliveries_state; DROP INDEX deliveries_message_id');db.prepare('INSERT INTO deliveries VALUES(?,?,?)').run('account','broken','{"broken":');db.close();
 for(const read of [()=>ledger.listDue({root}),()=>ledger.listReceipts({root}),()=>ledger.accountBlocked('account',{root}),()=>ledger.maintain({root})])assert.throws(read,/virtus_delivery_storage_unavailable/);
}));
