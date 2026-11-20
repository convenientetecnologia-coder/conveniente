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

function pendingJournal(f,patch={}){const crypto=require('node:crypto'),row={version:1,nome:'fixture',type:'renew',operationId:crypto.randomUUID(),edgeGeneration:crypto.randomUUID(),phase:'queued',sent:false,result:'not_started',at:Date.now(),...patch};const file=path.join(f.root,crypto.createHash('sha256').update('fixture\0renew').digest('hex')+'.json');fs.writeFileSync(file,JSON.stringify(row));return {file,row}}
test('pedido nunca recebido durante indisponibilidade retoma mesmo ID sem repetir negócio',async()=>{
 const f=fixture(),prior=pendingJournal(f);let id;class Client extends f.Client{async request(){throw Error('operation_not_found')}async acquire(request){id=request.operationId;return super.acquire(request)}}
 try{const h=await begin({nome:'fixture',purpose:'renew',...f,Client});assert.equal(id,prior.row.operationId);assert.equal(h.operationId,prior.row.operationId);assert.equal(JSON.parse(fs.readFileSync(prior.file)).edgeGeneration,prior.row.edgeGeneration);assert.equal(f.events.includes('possible'),false);await h.close()}finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('ausência no CT não autoriza refazer operação previamente ativada ou com lease',async()=>{
 for(const patch of [{phase:'active'},{lease:{leaseId:'previous'}},{sent:true,result:'unknown'}]){const f=fixture();pendingJournal(f,patch);class Client extends f.Client{async request(){throw Error('operation_not_found')}}try{await assert.rejects(begin({nome:'fixture',purpose:'renew',...f,Client}),/operation_not_found|unknown_requires_review/);assert.equal(f.events.includes('acquire'),false)}finally{fs.rmSync(f.root,{recursive:true,force:true})}}
});

test('observação de transporte encerrado preserva unknown e recusa qualquer novo efeito',async()=>{
 const crypto=require('node:crypto'),f=fixture(),old={version:1,nome:'fixture',type:'virtus',intent:'engaged',operationSequence:7,operationId:crypto.randomUUID(),edgeGeneration:crypto.randomUUID(),phase:'closed',sent:true,result:'unknown',lease:{leaseId:'old'},at:Date.now()};const file=path.join(f.root,crypto.createHash('sha256').update('fixture\0virtus_observe').digest('hex')+'.json');fs.writeFileSync(file,JSON.stringify(old));let observedSequence;
 class Client extends f.Client{async capabilities(){return {virtusTurns:true,rotation:{version:1}}}async request(){return {state:'released',businessResult:'unknown'}}async acquire(request){observedSequence=request.operationSequence;return super.acquire(request)}}
 try{const h=await begin({nome:'fixture',purpose:'virtus',intent:'warm',observationRecovery:true,...f,Client,Ledger:{accountBlocked:()=>true}});assert.equal(observedSequence,8);assert.equal(h.snapshot().reconciliationOnly,true);await assert.rejects(h.possibleSideEffect(),/readonly_effect_refused/);assert.equal(f.events.includes('possible'),false);assert.ok(fs.readdirSync(f.root).some(n=>n.endsWith('.history')));const archive=fs.readdirSync(f.root).find(n=>n.endsWith('.history'));assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,archive))).result,'unknown');await h.close()}finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('observação incerta não contorna transporte ativo nem ausência de barreira durável',async()=>{
 const crypto=require('node:crypto');for(const blocked of [true,false]){const f=fixture(),old={nome:'fixture',operationSequence:1,operationId:crypto.randomUUID(),edgeGeneration:crypto.randomUUID(),phase:'closed',sent:true,result:'unknown'};fs.writeFileSync(path.join(f.root,crypto.createHash('sha256').update('fixture\0virtus_observe').digest('hex')+'.json'),JSON.stringify(old));class Client extends f.Client{async capabilities(){return {virtusTurns:true,rotation:{version:1}}}async request(){return {state:'active'}}}try{await assert.rejects(begin({nome:'fixture',purpose:'virtus',observationRecovery:true,...f,Client,Ledger:{accountBlocked:()=>blocked}}),/transport_not_closed|unknown_requires_review/);assert.equal(f.events.includes('acquire'),false)}finally{fs.rmSync(f.root,{recursive:true,force:true})}}
});

test('resposta nova usa transporte encerrado anterior com isolamento durável por mensagem',async()=>{
 const crypto=require('node:crypto'),f=fixture(),old={version:1,nome:'fixture',type:'virtus',intent:'reply',operationSequence:4,operationId:crypto.randomUUID(),edgeGeneration:crypto.randomUUID(),phase:'closed',sent:true,result:'unknown',at:Date.now()};const file=path.join(f.root,crypto.createHash('sha256').update('fixture\0virtus_reply').digest('hex')+'.json');fs.writeFileSync(file,JSON.stringify(old));class Client extends f.Client{async capabilities(){return {virtusTurns:true,rotation:{version:1}}}async request(){return {state:'released'}}}
 try{const h=await begin({nome:'fixture',purpose:'virtus',intent:'reply',...f,Client,Ledger:{accountBlocked:()=>true}});assert.notEqual(h.operationId,old.operationId);assert.equal(h.snapshot().reconciliationOnly,false);await h.possibleSideEffect();h.confirm();await h.close();const archive=fs.readdirSync(f.root).find(n=>n.endsWith('.history'));assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,archive))).result,'unknown')}finally{fs.rmSync(f.root,{recursive:true,force:true})}
});

test('crash após efeito não prende Virtus quando CT já encerrou transporte, sem apagar unknown',async()=>{
 const crypto=require('node:crypto');for(const state of ['active','released']){const f=fixture(),old={version:1,nome:'fixture',type:'virtus',intent:'reply',operationSequence:8,operationId:crypto.randomUUID(),edgeGeneration:crypto.randomUUID(),phase:'active',sent:true,result:'unknown',at:Date.now()};const file=path.join(f.root,crypto.createHash('sha256').update('fixture\0virtus_reply').digest('hex')+'.json');fs.writeFileSync(file,JSON.stringify(old));class Client extends f.Client{async capabilities(){return {virtusTurns:true,rotation:{version:1}}}async request(){return {state}}}
 try{if(state==='active'){await assert.rejects(begin({nome:'fixture',purpose:'virtus',intent:'reply',messageIsolation:true,...f,Client,Ledger:{accountBlocked:()=>false}}),/transport_not_closed/);assert.equal(f.events.includes('acquire'),false)}else{const h=await begin({nome:'fixture',purpose:'virtus',intent:'reply',messageIsolation:true,...f,Client,Ledger:{accountBlocked:()=>false}});assert.notEqual(h.operationId,old.operationId);await h.close();const archive=fs.readdirSync(f.root).find(n=>n.endsWith('.history'));assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,archive))).result,'unknown')}}finally{fs.rmSync(f.root,{recursive:true,force:true})}}
});

test('cadastro retomado preserva histórico de autenticação e só abre após transporte anterior terminal',async()=>{
 const crypto=require('node:crypto');for(const terminal of [false,true]){const f=fixture(),old={version:1,nome:'fixture',type:'provision',operationId:crypto.randomUUID(),edgeGeneration:crypto.randomUUID(),phase:'active',sent:true,result:'unknown',at:Date.now()};const file=path.join(f.root,crypto.createHash('sha256').update('fixture\0provision').digest('hex')+'.json');fs.writeFileSync(file,JSON.stringify(old));class Client extends f.Client{async capabilities(){return {accountProvision:true}}async request(){return {state:terminal?'released':'active'}}}
 try{if(!terminal){await assert.rejects(begin({nome:'fixture',purpose:'provision',authenticationRecovery:true,...f,Client}),/transport_not_closed/);assert.equal(f.events.includes('acquire'),false)}else{const h=await begin({nome:'fixture',purpose:'provision',authenticationRecovery:true,...f,Client});assert.notEqual(h.operationId,old.operationId);const archive=fs.readdirSync(f.root).find(n=>n.endsWith('.history'));assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,archive))).result,'unknown');await h.close()}}finally{fs.rmSync(f.root,{recursive:true,force:true})}}
});
