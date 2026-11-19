'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {OperationClient}=require('./client');
const uuid=()=>crypto.randomUUID();
test('release com resposta perdida consulta terminal sem repetir ação de negócio',async()=>{
 const c=client(),paths=[];const op={operationId:uuid(),status:{leaseId:'l',leaseGeneration:1,carrierGeneration:uuid()},result:'confirmed'};
 c.request=async path=>{paths.push(path);if(path.endsWith('/release')){const error=Error('carrier_ack_timeout');error.retryable=true;throw error}return {state:'released',businessResult:'confirmed'}};
 const final=await c.release(op,'confirmed');assert.equal(final.state,'released');assert.equal(paths.filter(p=>p.endsWith('/release')).length,1);assert.equal(paths.some(p=>/ready|side-effect/.test(p)),false);
});
test('não permite rede HTTP remota nem operação sem token',()=>{
 assert.throws(()=>new OperationClient({baseUrl:'http://example.com/api/carrier-v2',token:'test'}),/tls_required/);
 assert.throws(()=>new OperationClient({baseUrl:'https://example.com/api/carrier-v2'}),/token_required/);
});
function client(){const c=new OperationClient({baseUrl:'http://127.0.0.1/api/carrier-v2',token:'test',allowLoopbackTest:true});c.wait=async()=>{};return c;}
test('fila não executa readiness, heartbeat ou efeito de negócio enquanto aguarda',async()=>{
 const c=client(),lease={leaseId:'lease',leaseGeneration:1,carrierGeneration:uuid()},requests=[];let polls=0,ready=0,waits=0;
 c.request=async(path,body)=>{requests.push({path,body});if(path.endsWith('/ready'))return {state:'active',binding:{synthetic:true},...lease};if(body?.accountId)return {state:'queued'};return ++polls<3?{state:'queued',nextPollAfterMs:2000}:{state:'granted',...lease}};
 const id=uuid(),op=await c.acquire({operationId:id,accountId:'synthetic',type:'publish',eligiblePhoneIds:['p001'],isReady:async()=>{ready++;return true},onWait:()=>waits++});
 assert.equal(op.operationId,id);assert.equal(ready,1);assert.equal(waits,3);assert.equal(requests.filter(x=>x.path.endsWith('/ready')).length,1);assert.equal(requests.some(x=>/side-effect|heartbeat/.test(x.path)),false);
});
test('contexto perdido cancela oferta sem ativar nem consumir efeito',async()=>{
 const c=client(),requests=[],lease={state:'granted',leaseId:'old',leaseGeneration:1,carrierGeneration:uuid()};
 c.request=async(path,body)=>{requests.push(path);return lease};
 await assert.rejects(c.acquire({operationId:uuid(),accountId:'synthetic',type:'renew',eligiblePhoneIds:['p001'],isReady:async()=>false}),/context_lost/);
 assert.equal(requests.some(x=>x.endsWith('/ready')),false);assert.ok(requests.some(x=>x.endsWith('/cancel')));
});
test('resultado unknown terminal não repete ativação ou envio',async()=>{
 const c=client(),paths=[];c.request=async path=>{paths.push(path);return {state:'unknown'}};
 await assert.rejects(c.acquire({operationId:uuid(),accountId:'synthetic',type:'identity',eligiblePhoneIds:['p001']}),/cp2_terminal:unknown/);
 assert.equal(paths.some(p=>p.endsWith('/ready')),false);
});
test('abort em espera remove timer e mantém identidade para cancelamento',async()=>{
 const c=client(),abort=new AbortController(),paths=[];c.wait=OperationClient.prototype.wait;
 c.request=async path=>{paths.push(path);return {state:'queued',nextPollAfterMs:30000}};
 const op=c.acquire({operationId:uuid(),accountId:'synthetic',type:'identity',eligiblePhoneIds:['p001'],signal:abort.signal,onWait:()=>abort.abort(Error('operator_canceled'))});
 await assert.rejects(op,/operator_canceled/);assert.ok(paths.some(p=>p.endsWith('/cancel-queued')));
});
test('cópias de protocolo e transporte CT/edge não divergem',{skip:!process.env.CT_SOURCE_ROOT},()=>{
 const fs=require('node:fs'),path=require('node:path');
 for(const file of ['protocol.js','session.js'])assert.equal(fs.readFileSync(path.join(__dirname,file),'utf8'),fs.readFileSync(path.join(process.env.CT_SOURCE_ROOT,'lib/carrierV2',file),'utf8'));
});
