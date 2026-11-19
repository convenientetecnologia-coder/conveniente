'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{RobeQueue}=require('./robeQueue');
const turn=()=>new Promise(r=>setImmediate(r));
test('conta aguardando proxy solta worker; retoma só após ação vizinha terminar',async()=>{
 const q=new RobeQueue(),events=[];let proxyReady,neighborDone;const waitProxy=new Promise(r=>proxyReady=r),waitNeighbor=new Promise(r=>neighborDone=r);
 let firstDone,secondDone;const first=new Promise(r=>firstDone=r),second=new Promise(r=>secondDone=r);
 q.enqueue('a',async()=>{events.push('a.prepare');await q.withoutActiveSlot(async()=>{events.push('a.wait');await waitProxy});events.push('a.publish');firstDone()});
 q.enqueue('b',async()=>{events.push('b.start');await waitNeighbor;events.push('b.end');secondDone()});
 await turn();await turn();assert.equal(q.executando.nome,'b');assert.equal(q.isActive('a'),true);assert.equal(q.enqueue('a',()=>{}),false);
 proxyReady();await turn();assert.equal(events.includes('a.publish'),false);neighborDone();await second;await first;assert.deepEqual(events,['a.prepare','a.wait','b.start','b.end','a.publish']);await turn();assert.equal(q.activeCount(),0);
});
test('cancelamento na espera retoma slot para limpeza e deixa fila continuar',async()=>{
 const q=new RobeQueue();let release;const wait=new Promise(r=>release=r),events=[];let done;const ended=new Promise(r=>done=r);
 q.enqueue('a',async()=>{try{await q.withoutActiveSlot(async()=>{await wait;throw Error('canceled')})}catch(e){assert.equal(q.executando.nome,'a');events.push(e.message)}done()});q.enqueue('b',async()=>events.push('b'));
 await turn();await turn();release();await ended;await turn();assert.deepEqual(events,['b','canceled']);assert.equal(q.activeCount(),0);
});
test('readiness recupera slot antes de ativar lease; não fica ativo esperando outro worker',async()=>{
 const q=new RobeQueue(),events=[];let offered,neighborDone,done;const grant=new Promise(r=>offered=r),neighbor=new Promise(r=>neighborDone=r),finished=new Promise(r=>done=r);
 q.enqueue('a',async()=>{await q.withoutActiveSlot(async resume=>{await grant;await resume();assert.equal(q.executando.nome,'a');events.push('activate')});events.push('business');done()});
 q.enqueue('b',async()=>{events.push('b');await neighbor});await turn();await turn();offered();await turn();assert.equal(events.includes('activate'),false);neighborDone();await finished;assert.deepEqual(events,['b','activate','business']);
});
test('pausar novos lançamentos não impede retomada para limpeza de cancelamento',async()=>{
 const q=new RobeQueue();let cancel,done;const wait=new Promise((r,j)=>cancel=j),finished=new Promise(r=>done=r);let cleaned=false;
 q.enqueue('a',async()=>{try{await q.withoutActiveSlot(()=>wait)}catch{cleaned=true}done()});await turn();q.setPausePredicate(()=>true);cancel(Error('stop'));await finished;assert.equal(cleaned,true);await turn();assert.equal(q.activeCount(),0);
});
test('fila de proxy cheia mantém número limitado de navegadores preparados',async()=>{
 const q=new RobeQueue({maxProxyWaiters:1}),events=[];let release,done;const wait=new Promise(r=>release=r),finished=new Promise(r=>done=r);
 q.enqueue('a',async()=>{await q.withoutActiveSlot(()=>wait);events.push('a.end')});q.enqueue('b',async()=>{events.push('b.start');done()});
 await turn();await turn();assert.deepEqual(events,[]);assert.equal(q._suspended.size,1);release();await finished;assert.deepEqual(events,['a.end','b.start']);
});
