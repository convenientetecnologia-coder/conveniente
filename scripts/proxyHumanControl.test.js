'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{invoke,resume}=require('./proxyHumanControl');

test('manual entry waits for an actual human lease and is canceled when control has resumed',async()=>{
 let grant,entries=0;const waiting=new Promise(r=>grant=r);
 const ctrl={browser:{__ctVirtusProxy:{enterHuman:()=>waiting,snapshot:()=>({state:'waiting'})}}};
 await invoke({ctrl,read:()=>({}),update:async()=>{},guard:async()=>{},overlay:async()=>({panelReady:true}),snapshot:async()=>{},onReady:async()=>entries++});
 assert.equal(entries,0);ctrl.humanControl=false;grant();await new Promise(r=>setImmediate(r));assert.equal(entries,0);
});
test('panel appears while the chair is still queued; resume cancels without another chair or clearing flags',async()=>{
 let release,waiting=true,panels=0;const wait=new Promise(r=>release=r),flags={banned:true};let want={active:true,virtus:'on',humanHold:false,flags};
 const proxy={enterHuman:()=>wait,leaveHuman:async()=>{waiting=false;release()},snapshot:()=>({state:'waiting'}),resumeHuman:async fn=>{await proxy.leaveHuman();return fn()}};
 const ctrl={browser:{__ctVirtusProxy:proxy},trabalhando:true};const opts={ctrl,read:()=>want,update:async f=>want=f(want),guard:async()=>{},overlay:async()=>{panels++;return {panelReady:true}},snapshot:async()=>{},validate:async()=>({ok:true,state:'marketplace_ready'})};
 assert.equal((await invoke(opts)).panelReady,true);assert.equal(waiting,true);assert.equal(panels,1);assert.equal(ctrl.humanControl,true);
 assert.equal((await resume(opts)).state,'automation_resumed');assert.equal(waiting,false);assert.equal(want.humanHold,false);assert.equal(want.virtus,'on');assert.equal(want.flags.banned,true);assert.equal(ctrl.trabalhando,false);
});
test('missing panel evidence is reported as unconfirmed instead of claiming it appeared',async()=>{
 const ctrl={browser:{__ctVirtusProxy:{enterHuman:async()=>{},snapshot:()=>({state:'waiting'})}}};
 const result=await invoke({ctrl,read:()=>({active:true,virtus:'on'}),update:async()=>{},guard:async()=>{},overlay:async()=>({panelReady:false}),snapshot:async()=>{}});
 assert.equal(result.ok,false);assert.equal(result.panelReady,false);assert.equal(result.error,'human_panel_unconfirmed');
});

test('failed resume keeps human hold and does not claim automation resumed',async()=>{
 const ctrl={humanControl:true,trabalhando:false,browser:{__ctVirtusProxy:{resumeHuman:fn=>fn()}}};let want={active:true,humanHold:true,virtus:'off'},shown;
 const result=await resume({ctrl,read:()=>want,update:async f=>want=f(want),guard:async()=>{},overlay:async o=>shown=o,snapshot:async()=>{},validate:async()=>({ok:false,error:'captcha_present'})});assert.equal(result.ok,false);assert.equal(want.humanHold,true);assert.equal(ctrl.humanControl,true);assert.equal(ctrl.trabalhando,false);assert.equal(shown.hide,false);
});
