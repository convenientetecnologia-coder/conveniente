'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'marketplaceRenewListings.js'), 'utf8');
async function run(snapshot) {
  let clock = 1000;
  const start = source.indexOf('async function waitRenewScreenStable(');
  const end = source.indexOf('\n/**', start);
  const fn = vm.runInNewContext(source.slice(start, end) + '\nwaitRenewScreenStable', {
    now: () => clock,
    sleep: async ms => { clock += ms; },
    progress: async () => {},
    safeEvaluate: async () => typeof snapshot === 'function' ? snapshot(clock) : snapshot,
    RENEW_SCREEN_WAIT_MS: 20000,
    RENEW_READY_MIN_ELAPSED_MS: 12000,
    RENEW_READY_STABLE_MS: 6000
  });
  return fn({});
}
test('botão habilitado libera sem contagem', async () => {
 const r=await run({hasHeader:true,renewBtn:{enabled:true}});assert.equal(r.ok,true);assert.equal(r.reason,'ready');assert.equal(r.count,undefined);
});
test('botão desabilitado, ausente ou fora da tela não libera', async () => {
 for(const snap of [null,{hasHeader:true,renewBtn:null},{hasHeader:true,renewBtn:{enabled:false}},{hasHeader:false,renewBtn:{enabled:true}}]){const r=await run(snap);assert.equal(r.ok,false);assert.equal(r.reason,'renew_button_unavailable_timeout');}
});
test('botão transitório não libera', async () => {const r=await run(clock=>({hasHeader:true,renewBtn:{enabled:clock<4000}}));assert.equal(r.ok,false);});
test('botão disponível após carregamento libera', async () => {const r=await run(clock=>({hasHeader:true,renewBtn:{enabled:clock>=8000}}));assert.equal(r.ok,true);});

test('sucesso sem quantidade persiste renovação e entra na contagem de contas', async () => {
 const planSource=fs.readFileSync(require('node:path').join(__dirname,'marketplaceRenewPlan.js'),'utf8');
 const start=planSource.indexOf('async function markDoneToday(');
 const end=planSource.indexOf('async function getStatusSnapshot(',start);
 const manifest={};
 const mark=vm.runInNewContext(planSource.slice(start,end)+'\nmarkDoneToday',{
   Date,clampInt:()=>0,todaySaoPaulo:()=> '2026-11-18',
   manifestStore:{update:async(_nome,patch)=>patch(manifest)}
 });
 await mark('test',{count:0,renewed:true,nowMs:12345});
 assert.equal(manifest.accountFlags.renovadosAt,12345);
 assert.equal(manifest.accountFlags.renovadosLastCount,0);
 const aggregate=require('./renewMetrics').aggregateRenovadosFromPerfis;
 assert.deepEqual(aggregate([{...manifest.accountFlags,marketplaceRenewDoneToday:true}]),{renovados:1,renovados_qtd:0});
});
