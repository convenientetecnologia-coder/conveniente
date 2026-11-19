'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{begin}=require('./accountOperation'),clock=require('./clock');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cp2-account-')),events=[],config={eligiblePhoneIds:['p003'],heartbeatMs:15};class Client{
 async acquire(request){events.push('acquire');this.id=request.operationId;request.onWait({state:'queued'});if(!await request.isReady())throw Error('context_lost');return {status:{leaseId:'l',leaseGeneration:1,carrierGeneration:'g'},result:'not_started'}}
 async openRoute(){events.push('route');return {port:40000}}
 async possibleSideEffect(){const row=JSON.parse(fs.readFileSync(path.join(root,fs.readdirSync(root).find(n=>n.endsWith('.json')))));assert.equal(row.sent,true);events.push('possible')}
 async release(op,result){events.push('release:'+result);return {state:'released'}}
 async request(){events.push('reconcile');return {state:'released'}}
 }return {root,events,config,Client}}
test('operação persistida antes do envio; confirmação real fecha e permite execução seguinte',async()=>{
 const f=fixture();try{const h=await begin({nome:'fixture',purpose:'publish',...f});assert.equal(h.hop.port,40000);await h.possibleSideEffect();h.confirm();await h.close();assert.deepEqual(f.events,['acquire','route','possible','release:confirmed']);const next=await begin({nome:'fixture',purpose:'publish',...f});assert.notEqual(h.operationId,next.operationId);await next.close();assert.ok(fs.readdirSync(f.root).some(n=>n.endsWith('.history')))}finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('unknown após fechamento impede repetir negócio; outra conta segue independente',async()=>{
 const f=fixture();try{const h=await begin({nome:'fixture',purpose:'id',...f});await h.possibleSideEffect();await h.close();await assert.rejects(begin({nome:'fixture',purpose:'id',...f}),/unknown_requires_review/);assert.equal(f.events.filter(e=>e==='acquire').length,1);const other=await begin({nome:'another',purpose:'id',...f});await other.close()}finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('mesma conta/fluxo não ganha outra operação concorrente; preparo sem envio fecha not_started',async()=>{
 const f=fixture();try{const h=await begin({nome:'fixture',purpose:'renew',...f});await assert.rejects(begin({nome:'fixture',purpose:'renew',...f}),/operation_busy/);await h.close();assert.ok(f.events.includes('release:not_started'))}finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('relógio exclui espera da fila e mantém isolamento entre fluxos',async()=>{
 await clock.run(async()=>{assert.equal(clock.effective(100),100);clock.addWait(500);assert.equal(clock.effective(100),600);await clock.run(async()=>assert.equal(clock.effective(100),100));assert.equal(clock.effective(100),600)});assert.equal(clock.effective(100),100);
});
test('oferta expirada antes de ativar é reconciliada e refeita sem erro de conta ou replay',async()=>{
 const f=fixture();let attempt=0;class Client extends f.Client{async acquire(request){if(++attempt===1)throw Error('offer_not_ready');return super.acquire(request)}}
 try{const h=await begin({nome:'fixture',purpose:'renew',...f,Client});assert.equal(attempt,2);assert.ok(f.events.includes('reconcile'));await h.close();assert.equal(f.events.includes('possible'),false)}finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
