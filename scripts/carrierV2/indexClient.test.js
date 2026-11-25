'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Coordinator}=require('./indexCoordinator'),worker=require('./indexClient');
test('worker declares work; Index obtains, confirms and releases the actual chair',async()=>{
 const events=[];let phase='active',proved=false,readyCalls=0,cleared=0;
 const broker=new Coordinator({acquire:async options=>{events.push('index_acquire');assert.equal(await options.isReady(),true);return {operationId:'fixture-operation',hop:{host:'127.0.0.1',port:41004},snapshot:()=>({phase,healthy:true}),possibleSideEffect:async()=>events.push('index_effect'),confirm:async()=>events.push('index_confirm'),close:async()=>{events.push('index_release');phase='release_requested'},reconcileClosed:async()=>proved}}});
 const request=async message=>{try{return message.action==='enqueue'?broker.enqueue(message.job,'worker',{ready:ticket=>worker.ready(ticket)}):await broker.command(message.ticket,'worker',message.action,message.stage)}catch(error){return {ok:false,error:error.message}}};
 const remote=await worker.begin({nome:'fixture',purpose:'virtus',intent:'reply',isReady:async()=>{readyCalls++;return true}},{request,pollMs:0,setTimer:()=>({unref(){}}),clearTimer:()=>cleared++});
 assert.equal(remote.operationId,'fixture-operation');assert.equal(remote.hop.port,41004);assert.equal(readyCalls,1);
 await remote.possibleSideEffect();await remote.confirm();await remote.close();assert.equal(cleared,1);assert.equal(remote.snapshot().healthy,false);assert.equal(await remote.reconcileClosed(),false);
 proved=true;assert.equal(await remote.reconcileClosed(),true);assert.deepEqual(events,['index_acquire','index_effect','index_confirm','index_release']);
});
test('Index unavailable cannot turn into direct Internet or a fabricated grant',async()=>{
 const abort=new AbortController();let requested=0;
 await assert.rejects(worker.begin({nome:'fixture',purpose:'virtus',signal:abort.signal,onWait:()=>abort.abort(Error('operator canceled'))},{request:async()=>{requested++;return {ok:false,error:'ipc_send_failed'}},pollMs:0}),/operator canceled/);assert.ok(requested>=1);
});

test('unhealthy lease is returned even while its worker stays alive, unblocking the same account only after closure proof',async()=>{
 let healthy=true,phase='active',proof=false,timer,closed=0;const broker=new Coordinator({acquire:async()=>({operationId:'expired-operation',hop:{port:1},snapshot:()=>({healthy,phase}),close:async()=>{closed++;phase='release_requested'},reconcileClosed:async()=>proof})});
 const request=async m=>{try{return m.action==='enqueue'?broker.enqueue(m.job,'worker',{ready:id=>worker.ready(id)}):await broker.command(m.ticket,'worker',m.action,m.stage)}catch(e){return{ok:false,error:e.message}}};
 const old=await worker.begin({nome:'account',purpose:'publish'},{request,pollMs:0,setTimer:fn=>{timer=fn;return{unref(){}}},clearTimer:()=>{}});
 const human={id:require('crypto').randomUUID(),nome:'account',purpose:'virtus',intent:'human'};broker.enqueue(human,'worker');await new Promise(setImmediate);assert.equal(broker.jobs.get(human.id).state,'queued');
 healthy=false;await timer();assert.equal(closed,1);assert.equal(old.snapshot().healthy,false);assert.equal(broker.jobs.get(human.id).state,'queued');proof=true;healthy=true;await broker.sweep();for(let i=0;i<10&&broker.jobs.get(human.id).state!=='granted';i++)await new Promise(setImmediate);assert.equal(broker.jobs.get(human.id).state,'granted');
});
