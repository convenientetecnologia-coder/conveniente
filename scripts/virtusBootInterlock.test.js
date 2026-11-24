'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{listenerReady,holdNavigation}=require('./virtusBootInterlock');
function fixture({attached=true,deadline=5000}={}){
 let now=0,handled=false;const calls=[],page={__deltaCdpEarAttached:true,isClosed:()=>false,setRequestInterception:async on=>calls.push(on?'intercept':'unintercept')};
 const ctrl={deltaCdpSession:{},deltaCdpEarPage:page,deltaCdpOnFrame:attached?()=>{}:null};
 const request={isInterceptResolutionHandled:()=>handled,continue:async()=>{handled=true;calls.push('navigate')},abort:async()=>{handled=true;calls.push('abort')}};
 const state={active:true,released:false,cancelled:false,deadlineAt:deadline,holdMs:3000};page.__deltaBootInterlock=state;
 return {page,ctrl,request,state,calls,options:{page,request,state,ready:()=>listenerReady(ctrl,page),clock:()=>now,sleep:async ms=>{now+=ms}}};
}
test('fresh account captures first frame: installed listener releases navigation before any WebSocket exists',async()=>{
 const f=fixture();f.ctrl.wsSignatureCandidateAt=0;
 assert.equal(listenerReady(f.ctrl,f.page),true);
 const result=await holdNavigation(f.options);assert.equal(result.phase,'released');assert.ok(result.waitedMs>=3000);assert.deepEqual(f.calls,['navigate','unintercept']);
});
test('missing listener times out and aborts instead of holding document forever or pretending ready',async()=>{
 const f=fixture({attached:false});const result=await holdNavigation(f.options);assert.equal(result.phase,'listener_timeout');assert.deepEqual(f.calls,['abort','unintercept']);assert.equal(f.state.released,false);
});
test('stale page, closed page and detached/shutting-down controller cannot pass capture gate',()=>{
 const f=fixture();assert.equal(listenerReady(f.ctrl,{}),false);assert.equal(listenerReady(f.ctrl,f.page,{shuttingDown:true}),false);
 f.ctrl.deltaCdpClosing=true;assert.equal(listenerReady(f.ctrl,f.page),false);f.ctrl.deltaCdpClosing=false;
 f.page.isClosed=()=>true;assert.equal(listenerReady(f.ctrl,f.page),false);
});
test('navigation cancellation aborts the held request and stops the waiter',async()=>{
 const f=fixture({attached:false});let wake;f.options.sleep=()=>new Promise(r=>wake=r);
 const task=holdNavigation(f.options);await new Promise(setImmediate);
 await f.state.cancel();wake();const result=await task;
 assert.equal(result.phase,'cancelled');assert.deepEqual(f.calls,['abort','unintercept']);
});
test('old waiter never disables interception or removes state belonging to a new navigation',async()=>{
 const f=fixture({attached:false});let wake;f.options.sleep=()=>new Promise(r=>wake=r);
 const task=holdNavigation(f.options);await new Promise(setImmediate);
 const replacement={active:true};f.page.__deltaBootInterlock=replacement;wake();await task;
 assert.equal(f.page.__deltaBootInterlock,replacement);assert.deepEqual(f.calls,['abort']);
});
test('worker capture predicate accepts installed listener without waiting for the page to generate its first socket',()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync(require.resolve('./worker'),'utf8');
 const start=source.indexOf('function __deltaIsBootEarReady('),end=source.indexOf('async function __deltaPrepareBootInterlockEar',start);
 const f=fixture();const context={controllers:new Map([['account',f.ctrl]]),_shuttingDown:false,require:name=>{assert.equal(name,'./virtusBootInterlock');return {listenerReady}}};
 const ready=vm.runInNewContext('('+source.slice(start,end).trim()+')',context);
 assert.equal(ready('account',f.page),true);assert.equal(ready('account',{}),false);
});

test('listener becoming ready cannot release a held navigation after the chair has been lost',async()=>{
 const f=fixture();f.page.__ctVirtusProxySession={snapshot:()=>({state:'offline',operationId:'old'})};
 await assert.rejects(holdNavigation(f.options),/interaction_without_healthy_proxy_turn/);assert.equal(f.calls.includes('navigate'),false);assert.equal(f.calls.includes('abort'),true);
});
