'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),batch=require('./proxyOpenBatch');
const fixture=()=>({_openAll:{active:true,mode:'proxy_bootstrap',startedAt:100,queue:['a','b'],progress:{}},perfis:{a:{active:true},b:{active:true}}});
test('one worker finishing cannot release another worker opening; only verified or explicitly deferred results finish the batch',()=>{
 const d=fixture();assert.equal(batch.apply(d,{startedAt:100,observations:{a:{state:'ready',reason:'inbox_verified_offline'}},now:200}).done,false);assert.equal(batch.active(d),true);
 batch.apply(d,{startedAt:100,observations:{b:{state:'waiting',reason:'loading'}},now:300});assert.equal(batch.active(d),true);
 batch.apply(d,{startedAt:100,observations:{b:{state:'deferred',reason:'network_failed'}},now:400});assert.equal(batch.active(d),false);assert.deepEqual(d._openAll.summary,{ready:1,blocked:0,deferred:1});assert.equal(d.perfis.b.active,true);
});
test('recovered cadastro joins the batch, while a stale worker cannot finish a replacement batch',()=>{
 const d=fixture();d.perfis.c={provisioningPending:true};batch.apply(d,{startedAt:100,observations:{a:{state:'ready'},b:{state:'ready'}},now:200});assert.equal(batch.active(d),true);assert.ok(d._openAll.queue.includes('c'));
 assert.equal(batch.apply(d,{startedAt:99,observations:{c:{state:'ready'}},now:300}).changed,false);assert.equal(batch.active(d),true);
 batch.apply(d,{startedAt:100,observations:{c:{state:'blocked',reason:'whatsapp_confirm'}},now:400});assert.equal(batch.active(d),false);assert.equal(d._openAll.summary.blocked,1);
});
test('deadline releases the verified accounts without calling the unfinished ones healthy',()=>{
 const d=fixture();batch.apply(d,{startedAt:100,observations:{a:{state:'ready'}},now:100+7200000});assert.equal(batch.active(d),false);assert.equal(d._openAll.progress.b.state,'deferred');assert.equal(d._openAll.summary.ready,1);
});
test('the real serial queue keeps work queued until the opening barrier is released',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'virtusDelta.js'),'utf8'),start=source.indexOf('function createSerialQueue(opts)'),end=source.indexOf('\nasync function loadCookies',start);
 const create=vm.runInNewContext(source.slice(start,end)+';createSerialQueue',{Date,Promise,Math});let held=true,sent=0;
 const queue=create({isBlocked:()=>held});const job=queue(async()=>{sent++;return 'confirmed'});await new Promise(setImmediate);assert.equal(sent,0);assert.equal(queue.getDepth(),1);
 held=false;queue.wake();assert.equal(await job,'confirmed');assert.equal(sent,1);
 queue.setPaused(true);const other=queue(async()=>++sent);queue.wake();await new Promise(setImmediate);assert.equal(sent,1);queue.setPaused(false);await other;assert.equal(sent,2);
});
test('the worker requires a checked inbox and a released chair before marking bootstrap ready',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'worker.js'),'utf8'),start=source.indexOf('observe:async(n,w,startedAt)=>'),end=source.indexOf('\n        }});',start);
 assert.ok(start>0&&end>start);let snapshot={startupFinished:true,operationId:'still-online',lastInbox:{ok:true}};
 const controllers=new Map([['a',{browser:{__ctVirtusProxy:{snapshot:()=>snapshot}}}]]);
 const observe=vm.runInNewContext('('+source.slice(start+'observe:'.length,end)+'})',{controllers,readAccountFlags:async()=>({}),require:n=>{assert.equal(n,'./accountSecurityGate');return {fromFlags:()=>null}},isProfileOpening:()=>false,robeMeta:{}});
 assert.equal((await observe('a',{active:true},100)).state,'waiting');snapshot.operationId=null;
 assert.equal((await observe('a',{active:true},100)).state,'ready');snapshot.lastInbox={ok:false,state:'incomplete',reason:'css_missing'};
 assert.equal((await observe('a',{active:true},100)).state,'deferred');assert.equal((await observe('a',{provisioningPending:true},100)).state,'waiting');
 assert.equal((await observe('deleted',{},100)).state,'blocked');
});
