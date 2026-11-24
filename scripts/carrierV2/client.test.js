'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {OperationClient}=require('./client');
const uuid=()=>crypto.randomUUID();
test('release reconciliation error checks authoritative terminal without repeating business',async()=>{
 const c=client(),op={operationId:uuid(),status:{},result:'confirmed'},paths=[];
 c.request=async path=>{paths.push(path);if(path.endsWith('/release'))throw Error('control_requires_reconciliation');return {state:'released',businessResult:'confirmed'}};
 const result=await c.release(op);assert.equal(result.state,'released');assert.equal(paths.length,2);assert.equal(paths.some(p=>/ready|side-effect/.test(p)),false);
});
test('release com resposta perdida consulta terminal sem repetir ação de negócio',async()=>{
 const c=client(),paths=[];const op={operationId:uuid(),status:{leaseId:'l',leaseGeneration:1,carrierGeneration:uuid()},result:'confirmed'};
 c.request=async path=>{paths.push(path);if(path.endsWith('/release')){const error=Error('carrier_ack_timeout');error.retryable=true;throw error}return {state:'released',businessResult:'confirmed'}};
 const final=await c.release(op,'confirmed');assert.equal(final.state,'released');assert.equal(paths.filter(p=>p.endsWith('/release')).length,1);assert.equal(paths.some(p=>/ready|side-effect/.test(p)),false);
});
test('não permite rede HTTP remota nem operação sem identificação',()=>{
 assert.throws(()=>new OperationClient({baseUrl:'http://example.com/api/carrier-v2',token:'test'}),/tls_required/);
 assert.throws(()=>new OperationClient({baseUrl:'https://example.com/api/carrier-v2'}),/server_id_required/);
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

test('HTTP e WS usam ID de servidor sem Authorization mesmo com token antigo',()=>{const c=new OperationClient({baseUrl:'https://example.com/api/carrier-v2',serverId:'11111111-1111-1111-1111-111111111111',token:'old'});assert.equal(c.headers()['x-server-id'],c.serverId);assert.equal(c.headers().authorization,undefined)});

test('heartbeat e marcação do clique aguardam a mesma fila de controle',async()=>{
 const c=client();
 const binding={protocolVersion:2,contractRevision:2,instanceId:uuid(),resourceId:uuid(),executorFence:1,authorityEpoch:uuid(),carrierGeneration:uuid(),operationId:uuid(),leaseId:uuid(),leaseGeneration:1,serverId:uuid()};
 const op={operationId:binding.operationId,binding,status:{...binding,state:'active'},result:'not_started'};
 let done;const gate=new Promise(r=>done=r),paths=[];
 c.request=async path=>{paths.push(path);if(path.endsWith('/heartbeat')){await gate;return {...binding,state:'active',acknowledgment:{...binding,source:'carrier',kind:'heartbeat_ack'}}}return {state:'active'}};
 const heartbeat=c.heartbeat(op),mark=c.possibleSideEffect(op);await new Promise(setImmediate);
 assert.equal(paths.length,1);assert.match(paths[0],/heartbeat$/);done();await Promise.all([heartbeat,mark]);
 assert.equal(paths.length,2);assert.match(paths[1],/possible-side-effect$/);assert.equal(op.result,'unknown');
});
test('liberação espera controle anterior e bloqueia novos efeitos sem repetir clique',async()=>{
 const c=client(),op={operationId:uuid(),status:{leaseId:'l',leaseGeneration:1,carrierGeneration:uuid()},result:'confirmed'};
 let done;const gate=new Promise(r=>done=r),paths=[];
 const pending=c.control(op,async()=>{paths.push('pending');await gate});
 c.request=async path=>{paths.push(path);return {state:'released'}};
 const release=c.release(op);const effect=c.possibleSideEffect(op);await new Promise(setImmediate);assert.deepEqual(paths,['pending']);done();await pending;await release;await assert.rejects(effect,/operation_closing/);assert.equal(paths.filter(p=>p.endsWith('/release')).length,1);assert.equal(paths.some(p=>p.endsWith('/possible-side-effect')),false);
});
test('busy conhecido tenta somente controle; timeout incerto não é repetido',async()=>{
 const c=client();let n=0;c.request=async()=>{if(++n<3)throw Error('operation_control_in_flight');return {ok:true}};
 assert.equal((await c.controlRequest('/control',{})).ok,true);assert.equal(n,3);
 n=0;c.request=async()=>{n++;throw Error('carrier_ack_timeout')};await assert.rejects(c.controlRequest('/control',{}),/ack_timeout/);assert.equal(n,1);
});

test('release ocupado aguarda apenas controle sem bloquear definitivamente o turno',async()=>{const c=client(),op={operationId:uuid(),status:{leaseId:'l',leaseGeneration:1,carrierGeneration:uuid()},result:'not_started'};let calls=0;c.request=async()=>{if(++calls<=5)throw Error('operation_control_in_flight');return {state:'released'}};const r=await c.release(op);assert.equal(r.state,'released');assert.equal(calls,6)});
