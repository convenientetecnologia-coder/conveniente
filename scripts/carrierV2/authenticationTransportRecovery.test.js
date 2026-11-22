'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{reconcile}=require('./authenticationTransportRecovery');
test('autenticação espera fechamento confirmado antes de permitir outra tentativa',async()=>{
 const events=[],old={operationId:'old'},status={state:'active',leaseId:'lease',leaseGeneration:3,carrierGeneration:'generation'};
 const result=await reconcile({old,status,client:{controlRequest:async(path,body)=>{events.push({path,body});return {state:'releasing'}},request:async()=>{events.push('closed');return {state:'unknown'}}},sleep:async()=>{}});
 assert.equal(result.state,'unknown');assert.equal(events[0].path,'/old/cancel');assert.equal(events[0].body.businessResult,'unknown');assert.equal(events[1],'closed');
});
test('transporte sem confirmação termina em erro limitado, nunca em sucesso local',async()=>{
 let now=0;await assert.rejects(reconcile({old:{operationId:'old'},status:{state:'releasing'},client:{request:async()=>({state:'releasing'})},clock:()=>now,sleep:async ms=>{now+=ms},timeoutMs:1000}),/transport_not_closed/);assert.equal(now,1000);
});
test('sem identidade do lease não envia cancelamento e não autoriza substituição',async()=>{
 let canceled=false;await assert.rejects(reconcile({old:{operationId:'old'},status:{state:'active'},client:{controlRequest:async()=>{canceled=true}}}),/identity_missing/);assert.equal(canceled,false);
});
test('operação terminal e cancelamento pelo usuário não abrem novas requisições',async()=>{
 const client={request:async()=>{throw Error('unexpected')}};assert.equal((await reconcile({old:{},status:{state:'released'},client})).state,'released');
 await assert.rejects(reconcile({old:{},status:{state:'releasing'},client,signal:{aborted:true,reason:Error('operator_stop')}}),/operator_stop/);
});
