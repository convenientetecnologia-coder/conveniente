'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{wait}=require('./virtusInboxReady');
function fixture(probe,network){let now=0;return {probe:()=>probe(now),network:()=>network?network(now):{},clock:()=>now,sleep:async ms=>{now+=ms},timeoutMs:1000,minimumMs:200,stableMs:100,pollMs:50}}
const ready={ready:true,signature:'a',rows:3,links:3,loading:0,unmounted:0};
test('lista pronta ainda respeita tempo mínimo online',async()=>{const r=await wait(fixture(()=>ready));assert.ok(r.waitedMs>=200)});
test('skeleton visível nunca é considerado visita concluída',async()=>{await assert.rejects(wait(fixture(()=>({...ready,ready:false,reason:'rows_unmounted',unmounted:2}))),/not_settled/)});
test('mudança de linhas reinicia a janela de estabilidade',async()=>{const r=await wait({...fixture(now=>({...ready,signature:now<250?'a':'b'})),minimumMs:300,stableMs:150});assert.ok(r.waitedMs>=400)});
test('requisição de mensagens pendente impede liberação aprovada',async()=>{const r=await wait(fixture(()=>ready,now=>({connectedAt:1,lastNetworkAt:2,pending:now<350?1:0})));assert.ok(r.waitedMs>=450)});
test('conteúdo em cache sem evento novo não comprova reconexão da inbox',async()=>{await assert.rejects(wait(fixture(()=>ready,()=>({connectedAt:100,lastNetworkAt:50,pending:0}))),/not_settled/)});
test('fotos pendentes não bloqueiam texto e links carregados',async()=>{const r=await wait(fixture(()=>({...ready,avatarPending:5})));assert.equal(r.avatarPending,5)});
test('lista vazia explicitamente confirmada é válida',async()=>{const r=await wait(fixture(()=>({...ready,links:0,rows:0,empty:true})));assert.equal(r.empty,true)});
