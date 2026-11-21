'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{install}=require('./virtusStartupGuard');
test('startup repair budget remains finite and leaves lease cleanup margin',()=>{let deadline;install({browser:{once(){}},session:{},setTimer:(_fn,ms)=>(deadline=ms,{unref(){}})});assert.equal(deadline,360000);assert.ok(deadline<600000)});
test('expired startup closes browser even if releasing session throws, without duplicate timeout work',async()=>{
 let tick,disconnected,closed=0,releases=0,errors=0,cleared=0;const notes=[];
 install({browser:{once:(_e,fn)=>disconnected=fn,isConnected:()=>true,close:async()=>closed++},session:{snapshot:()=>({startupFinished:false}),noteInbox:r=>notes.push(r),close:async()=>{releases++;throw Error('cleanup_failed')}},setTimer:fn=>(tick=fn,{unref(){}}),clearTimer:()=>cleared++,onError:()=>errors++});
 tick();tick();await new Promise(setImmediate);assert.equal(closed,1);assert.equal(releases,1);assert.equal(errors,1);assert.equal(notes[0].state,'startup_timeout');disconnected();assert.equal(cleared,1);
});
test('finished startup retains the working browser',async()=>{let tick;install({browser:{once(){},close:async()=>{throw Error('must_not_close')}},session:{snapshot:()=>({startupFinished:true}),close:async()=>{throw Error('must_not_release')}},setTimer:fn=>(tick=fn,{unref(){}})});tick();await new Promise(setImmediate)});
