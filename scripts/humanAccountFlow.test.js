'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {run}=require('./humanAccountFlow');
function fixture(){
 let healthy=true,effects=0,confirmed=0,borrowed=0,watched=0,cleaned=0,armed=0;
 const browser={},lease={snapshot:()=>({healthy,absoluteDeadline:(Date.now()+600000)/1000}),possibleSideEffect:async()=>effects++,confirm:async()=>confirmed++};
 const options={audit:()=>{},browser,nome:'account',proxy:{runHumanAction:async action=>{borrowed++;return action(lease)}},security:async()=>{},authenticate:async()=>{},watch:()=>{watched++;return {arm:()=>armed++,cleanup:()=>cleaned++,snapshot:()=>({finished:true,transportOk:true,operationConfirmed:true})}}};
 return {browser,options,fail:()=>healthy=false,counts:()=>({effects,confirmed,borrowed,watched,cleaned,armed})};
}
test('manual ID receives the original browser context, confirms a real result, and restores context without closing',async()=>{
 const f=fixture();const result=await run({...f.options,kind:'id'},async()=>{
  const context=require('./isolatedAccountFlow').context({browser:()=>f.browser},'id');
  assert.equal(context.humanBorrowed,true);assert.equal(context.proxyRequired,true);
  await context.rail.armAndProve({});await context.rail.markIdentityStart();return {ok:true,identityFlowConfirmed:true};
 });
 assert.equal(result.ok,true);assert.equal(f.browser.__ctIsolatedFlow,undefined);
 assert.deepEqual(f.counts(),{effects:1,confirmed:1,borrowed:1,watched:0,cleaned:0,armed:0});
});
test('manual renewal requires network mutation evidence and never releases the borrowed chair',async()=>{
 const f=fixture();await run({...f.options,kind:'renew'},async()=>{
  const rail=f.browser.__ctIsolatedFlow.rail;await rail.armAndProve({});await rail.markPublishClick();
  assert.equal((await rail.waitPublishTransport()).ok,true);await rail.releaseProxy();return {ok:true};
 });assert.deepEqual(f.counts(),{effects:1,confirmed:1,borrowed:1,watched:1,cleaned:1,armed:1});
});
test('renewal transport failure cannot be confirmed from an optimistic UI',async()=>{
 const f=fixture();await run({...f.options,kind:'renew',watch:()=>({arm(){},cleanup(){},snapshot:()=>({finished:true,transportOk:true,operationConfirmed:false})})},async()=>{
  const rail=f.browser.__ctIsolatedFlow.rail;await rail.armAndProve({});await rail.markPublishClick();assert.equal((await rail.waitPublishTransport()).ok,false);return {ok:false};
 });assert.equal(f.counts().confirmed,0);
});
test('lost chair blocks mutations and cleanup runs after failure',async()=>{
 const f=fixture();await assert.rejects(run({...f.options,kind:'renew'},async()=>{
  const rail=f.browser.__ctIsolatedFlow.rail;await rail.armAndProve({});f.fail();assert.equal(rail.isProxyArmed,false);await rail.markPublishClick();
 }),/transport_unhealthy/);assert.equal(f.counts().effects,0);assert.equal(f.counts().cleaned,1);assert.equal(f.browser.__ctIsolatedFlow,undefined);
});
test('busy isolated browser is never overwritten',async()=>{
 const f=fixture(),previous={kind:'publish'};f.browser.__ctIsolatedFlow=previous;
 await assert.rejects(run({...f.options,kind:'id'},async()=>{}),/browser_action_busy/);assert.equal(f.browser.__ctIsolatedFlow,previous);
});
