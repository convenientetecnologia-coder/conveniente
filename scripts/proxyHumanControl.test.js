'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{invoke,resume}=require('./proxyHumanControl');
test('panel appears while the chair is still queued; resume cancels without another chair or clearing flags',async()=>{
 let release,waiting=true,panels=0;const wait=new Promise(r=>release=r),flags={banned:true};let want={active:true,virtus:'on',humanHold:false,flags};
 const proxy={enterHuman:()=>wait,leaveHuman:async()=>{waiting=false;release()},snapshot:()=>({state:'waiting'})};
 const ctrl={browser:{__ctVirtusProxy:proxy},trabalhando:true};const opts={ctrl,read:()=>want,update:async f=>want=f(want),guard:async()=>{},overlay:async()=>{panels++;return {panelReady:true}},snapshot:async()=>{}};
 assert.equal((await invoke(opts)).panelReady,true);assert.equal(waiting,true);assert.equal(panels,1);assert.equal(ctrl.humanControl,true);
 assert.equal((await resume(opts)).state,'automation_resumed');assert.equal(waiting,false);assert.equal(want.humanHold,false);assert.equal(want.virtus,'on');assert.equal(want.flags.banned,true);assert.equal(ctrl.trabalhando,true);
});
test('missing panel evidence is reported as unconfirmed instead of claiming it appeared',async()=>{
 const ctrl={browser:{__ctVirtusProxy:{enterHuman:async()=>{},snapshot:()=>({state:'waiting'})}}};
 const result=await invoke({ctrl,read:()=>({active:true,virtus:'on'}),update:async()=>{},guard:async()=>{},overlay:async()=>({panelReady:false}),snapshot:async()=>{}});
 assert.equal(result.ok,false);assert.equal(result.panelReady,false);assert.equal(result.error,'human_panel_unconfirmed');
});
