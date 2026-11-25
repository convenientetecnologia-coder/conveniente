'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'marketplaceRenewListings.js'), 'utf8');
async function run(snapshot, timeoutMs = 20000) {
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
  return fn({}, { timeoutMs });
}
test('botão habilitado libera sem contagem', async () => {
 const r=await run({hasHeader:true,renewBtn:{enabled:true}});assert.equal(r.ok,true);assert.equal(r.reason,'ready');assert.equal(r.count,undefined);
});
test('botão desabilitado, ausente ou fora da tela não libera', async () => {
 for(const snap of [null,{hasHeader:true,renewBtn:null},{hasHeader:true,renewBtn:{enabled:false}},{hasHeader:false,renewBtn:{enabled:true}}]){const r=await run(snap);assert.equal(r.ok,false);assert.equal(r.reason,'renew_button_unavailable_timeout');}
});
test('botão transitório não libera', async () => {const r=await run(clock=>({hasHeader:true,renewBtn:{enabled:clock<4000}}));assert.equal(r.ok,false);});
test('botão disponível após carregamento libera', async () => {const r=await run(clock=>({hasHeader:true,renewBtn:{enabled:clock>=8000}}));assert.equal(r.ok,true);});

test('all blocked count can stay unchanged for two minutes before eligibility finishes', async () => {
 let lastRead=0;
 const result=await run(clock=>{
  lastRead=clock;
  return {hasHeader:true,renewBtn:{enabled:clock>=121000},loading:false,
   signature:clock<121000?'200 classificados não podem ser renovados':'25 não podem / 175 podem ser renovados'};
 },180000);
 assert.equal(result.ok,true);assert.equal(result.reason,'ready');assert.ok(lastRead>=127000);
});

test('unchanged blocked count until timeout remains unconfirmed, never definitive ineligibility',async()=>{
 const result=await run({hasHeader:true,renewBtn:{enabled:false},loading:false,signature:'200 classificados não podem ser renovados'},180000);
 assert.equal(result.ok,false);assert.equal(result.reason,'renew_button_unavailable_timeout');
});

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

test('loading indicator prevents readiness even when Renew is enabled',async()=>{assert.equal((await run({hasHeader:true,renewBtn:{enabled:true},loading:true,signature:'same'})).ok,false)});
test('list count or content changes reset the stability window',async()=>{const r=await run(clock=>({hasHeader:true,renewBtn:{enabled:true},signature:String(Math.floor(clock/4000))}));assert.equal(r.ok,false)});
test('slow list loading succeeds only after content and enabled control stabilize',async()=>{const r=await run(clock=>({hasHeader:true,renewBtn:{enabled:true},loading:clock<10000,signature:clock<10000?String(clock):'loaded'}));assert.equal(r.ok,true)});

test('scroll cannot turn missing DOM or perpetual loading into successful completion',async()=>{
 const a=source.indexOf('async function scrollToAgeThreshold('),b=source.indexOf('async function scrollToTop(',a);
 for(const snapshot of [null,{moved:false,loading:true,ageHit:false}]){
  const fn=vm.runInNewContext(source.slice(a,b)+';scrollToAgeThreshold',{Date,Math,SCROLL_STOP_AGE_DAYS:46,SCROLL_STUCK_TICKS_LIMIT:2,SCROLL_STEP_PX:380,SCROLL_INTERVAL_MS:900,progress:async()=>{},safeEvaluate:async()=>snapshot,sleep:async()=>{}});
  const result=await fn({},{scrollStopAgeDays:20});assert.equal(result.ok,false);assert.equal(result.reason,'listing_scroll_budget_exhausted');
 }
});
test('scroll cancellation stops before reading or scrolling the DOM',async()=>{
 const a=source.indexOf('async function scrollToAgeThreshold('),b=source.indexOf('async function scrollToTop(',a);let reads=0;
 const fn=vm.runInNewContext(source.slice(a,b)+';scrollToAgeThreshold',{Date,Math,SCROLL_STOP_AGE_DAYS:46,SCROLL_STUCK_TICKS_LIMIT:2,progress:async()=>{},safeEvaluate:async()=>{reads++},sleep:async()=>{}});
 assert.equal((await fn({},{isAborted:()=>true})).ok,false);assert.equal(reads,0);
});
