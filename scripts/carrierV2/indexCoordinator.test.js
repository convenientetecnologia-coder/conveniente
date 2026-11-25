'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{Coordinator}=require('./indexCoordinator');
const job=(nome,purpose='virtus',intent='observe')=>({id:crypto.randomUUID(),nome,purpose,intent});
const wait=()=>new Promise(setImmediate);
async function settled(b,count){for(let i=0;i<500;i++){if([...b.jobs.values()].filter(j=>['granted','failed','canceled','closed'].includes(j.state)).length>=count)return;await wait()}throw Error('broker did not settle')}
function handle(){let phase='active',confirmed=false,closed=false;return {operationId:crypto.randomUUID(),hop:{host:'127.0.0.1',port:41000},snapshot:()=>({healthy:!closed,phase,result:confirmed?'confirmed':'not_started'}),possibleSideEffect:async()=>{},confirm:async()=>{confirmed=true},close:async()=>{phase='release_requested';closed=true},reconcileClosed:async()=>phase==='closed',proof(){phase='closed'}}}
test('Index serializes CT acquisition for all workers while allowing multiple active chairs',async()=>{
 let pending=0,peak=0;const b=new Coordinator({acquire:async options=>{peak=Math.max(peak,++pending);assert.equal(await options.isReady(),true);await wait();pending--;return handle()}});
 const rows=Array.from({length:105},(_,i)=>job('account-'+i));for(let i=0;i<rows.length;i++)b.enqueue(rows[i],'worker-'+i%8);
 await settled(b,105);assert.equal(peak,1);assert.equal(b.snapshot().active,105);assert.equal(b.snapshot().pendingCt,0);
 // Physical capacity remains the CT's responsibility; this fixture grants every request.
});
test('Index chooses a ready reply before cold observation and preserves aged work',async()=>{
 const order=[];let now=100000;const b=new Coordinator({clock:()=>now,acquire:async options=>{order.push(options.nome);return handle()}});
 b.enqueue(job('cold'),'w1');b.enqueue(job('signup','provision'),'w2');b.enqueue(job('reply','virtus','reply'),'w3');
 await settled(b,3);assert.deepEqual(order,['reply','signup','cold']);
 const aged=new Coordinator({clock:()=>now,acquire:async options=>{order.push(options.nome);return handle()}});
 const cold=job('old-cold');aged.enqueue(cold,'w1');now+=180000;aged.poll(cold.id,'w1');aged.enqueue(job('new-reply','virtus','reply'),'w2');await settled(aged,2);assert.deepEqual(order.slice(-2),['old-cold','new-reply']);
});
test('Index keeps the same account out of a second chair until CT proves prior closure',async()=>{
 const handles=[];const b=new Coordinator({acquire:async()=>{const h=handle();handles.push(h);return h}}),first=job('one'),next=job('one','virtus','reply');
 b.enqueue(first,'worker');await settled(b,1);b.enqueue(next,'worker');await wait();assert.equal(handles.length,1);
 await b.command(first.id,'worker','close');await b.sweep();assert.equal(b.jobs.get(next.id).state,'queued');
 handles[0].proof();await b.sweep();await settled(b,2);assert.equal(handles.length,2);
});
test('duplicate job, wrong worker and canceled queued task cannot create extra CT requests',async()=>{
 let calls=0;const b=new Coordinator({acquire:async()=>{calls++;return handle()}}),row=job('fixture');
 b.enqueue(row,'owner');b.enqueue(row,'owner');assert.throws(()=>b.poll(row.id,'other-worker'),/owner_mismatch/);await b.command(row.id,'owner','cancel');await wait();assert.equal(calls,0);
});
test('a failed worker releases only its own work and another worker remains healthy',async()=>{
 let live=true;const handles=[];const b=new Coordinator({acquire:async()=>{const h=handle();handles.push(h);return h}}),a=job('a'),other=job('b');
 b.enqueue(a,'w1',{alive:()=>live});b.enqueue(other,'w2');await settled(b,2);live=false;await b.sweep();
 assert.equal(b.jobs.get(a.id).state,'releasing');assert.equal(b.jobs.get(other.id).state,'granted');assert.equal((await b.command(a.id,'w1','status')).snapshot.healthy,false);
});
test('Index retries a lost release request rather than abandoning the chair',async()=>{
 const h=handle();let retries=0;h.close=async()=>{throw Error('network unavailable')};h.retryRelease=async()=>{retries++;h.proof()};const b=new Coordinator({acquire:async()=>h}),row=job('fixture');
 b.enqueue(row,'w');await settled(b,1);await assert.rejects(b.command(row.id,'w','close'),/network unavailable/);await b.sweep();assert.equal(retries,1);assert.equal(b.jobs.get(row.id).state,'closed');
});
test('a cancellation racing a grant still returns the chair and keeps closure owned by Index',async()=>{
 let granted;const h=handle(),b=new Coordinator({acquire:()=>new Promise(r=>granted=r)}),row=job('fixture');
 b.enqueue(row,'w');await wait();await b.command(row.id,'w','cancel');granted(h);await wait();await wait();
 assert.equal(b.jobs.get(row.id).state,'releasing');h.proof();await b.sweep();assert.equal(b.jobs.get(row.id).state,'closed');assert.equal(b.activeAccounts.has('fixture'),false);
});
test('completed history cannot fill the queue and stop future work',async()=>{
 let now=1000;const b=new Coordinator({limit:3,clock:()=>now,acquire:async()=>handle()});
 for(let i=0;i<10;i++){const row=job('account-'+i);b.enqueue(row,'w');for(let n=0;n<20&&b.jobs.get(row.id)?.state!=='granted';n++)await wait();const h=b.jobs.get(row.id).handle;await b.command(row.id,'w','close');h.proof();await b.sweep();now++}
 assert.ok(b.jobs.size<=3);assert.equal(b.activeAccounts.size,0);
});

test('authoritative closure unblocks a human request even if repeating release would always throw',async()=>{
 let proof=false,retries=0;const h=handle();h.close=async()=>{throw Error('lost release')};h.retryRelease=async()=>{retries++;throw Error('terminal operation rejects release')};h.reconcileClosed=async()=>proof;
 const b=new Coordinator({acquire:async()=>h}),old=job('same','publish'),human=job('same','virtus','human');b.enqueue(old,'old-worker');await settled(b,1);b.enqueue(human,'new-worker');await assert.rejects(b.command(old.id,'old-worker','close'),/lost release/);proof=true;await b.sweep();await settled(b,2);assert.equal(retries,0);assert.equal(b.jobs.get(old.id).state,'closed');assert.equal(b.jobs.get(human.id).state,'granted');
});

test('an expired healthy-owner lease is closed and still requires CT closure before reuse',async()=>{
 let healthy=true,proof=false,closed=0;const h=handle();h.snapshot=()=>({healthy,phase:'active'});h.close=async()=>{closed++};h.reconcileClosed=async()=>proof;const b=new Coordinator({acquire:async()=>h}),a=job('expired','publish');b.enqueue(a,'live-worker');await settled(b,1);healthy=false;await b.sweep();assert.equal(closed,1);assert.equal(b.jobs.get(a.id).state,'releasing');proof=true;await b.sweep();assert.equal(b.jobs.get(a.id).state,'closed');
});
