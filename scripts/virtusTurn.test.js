'use strict';const test=require('node:test'),assert=require('node:assert/strict');const {VirtusTurn}=require('./virtusTurn');
test('lost release keeps the browser offline and resumes only after authoritative closure',async()=>{
 let terminal=false,acquired=0;const lease={hop:{},snapshot:()=>({healthy:true}),close:async()=>{throw Error('control_requires_reconciliation')},reconcileClosed:async()=>terminal};
 const f=fixture({acquire:async()=>{acquired++;return lease}});
 await assert.rejects(f.turn.run('observe',async()=>({ok:true})),/reconciliation/);
 assert.equal(await f.turn.reconcileTransport(),false);assert.equal(f.turn.closed,true);assert.equal(acquired,1);
 terminal=true;assert.equal(await f.turn.reconcileTransport(),true);assert.equal(f.turn.state,'offline');assert.equal(f.turn.closed,false);assert.equal(acquired,1);
});
test('late action must settle before a recovered transport can run another visit',async()=>{
 let settle,healthy=true;const f=fixture({acquire:async()=>({hop:{},snapshot:()=>({healthy}),close:async()=>{}})});
 const keep=setTimeout(()=>{},2000);
 try{
  const run=f.turn.run('observe',async()=>{healthy=false;await new Promise(r=>settle=r)});
  await assert.rejects(run,/transport_lost/);assert.equal(await f.turn.reconcileTransport(),false);
  settle();await new Promise(setImmediate);assert.equal(await f.turn.reconcileTransport(),true);
 }finally{clearTimeout(keep)}
});
function fixture(overrides={}){const calls=[],rail={flip:h=>calls.push(h?'connect':'disconnect'),trafficSnapshot:()=>({directUp:0,directDown:0}),close:async()=>calls.push('rail_closed')};const lease={operationId:'fixture',hop:{port:1},snapshot:()=>({healthy:true}),close:async()=>calls.push('release')};return {calls,turn:new VirtusTurn({rail,acquire:async()=>{calls.push('acquire');return lease},prove:async()=>calls.push('prove'),...overrides})}}
test('sem cadeira não executa ação; desconecta antes de devolver capacidade',async()=>{const f=fixture();await f.turn.run('observe',async()=>{f.calls.push('collect');return {ok:true}});assert.deepEqual(f.calls,['acquire','connect','prove','collect','disconnect','release']);assert.equal(f.turn.snapshot().state,'offline');assert.ok(f.turn.snapshot().lastCheckedAt)});
test('falha da prova não deixa ação usar rede e ainda encerra lease',async()=>{const f=fixture({prove:async()=>{throw Error('proof_failed')}});await assert.rejects(f.turn.run('reply',async()=>f.calls.push('send')),/proof_failed/);assert.equal(f.calls.includes('send'),false);assert.equal(f.calls.at(-1),'release');assert.equal(f.turn.snapshot().state,'offline')});
test('duas tarefas da mesma conta nunca usam o navegador simultaneamente',async()=>{let active=0,peak=0;const f=fixture();const action=async()=>{peak=Math.max(peak,++active);await new Promise(setImmediate);active--};await Promise.all([f.turn.run('observe',action),f.turn.run('reply',action)]);assert.equal(peak,1);assert.equal(f.calls.filter(x=>x==='release').length,2)});
test('fechamento não confirmado bloqueia novos turnos',async()=>{const f=fixture({acquire:async()=>({hop:{port:1},snapshot:()=>({healthy:true}),close:async()=>{throw Error('release_unconfirmed')}})});await assert.rejects(f.turn.run('observe',async()=>{}),/release_unconfirmed/);await assert.rejects(f.turn.run('reply',async()=>{}),/turn_closed/);assert.equal(f.turn.snapshot().state,'blocked')});
test('cancelamento enquanto aguarda cadeira não abre conexão',async()=>{const f=fixture({acquire:({signal})=>new Promise((r,j)=>signal.addEventListener('abort',()=>j(signal.reason),{once:true}))});const run=f.turn.run('observe',async()=>f.calls.push('collect'));await new Promise(setImmediate);await f.turn.close();await assert.rejects(run,/turn_closed/);assert.equal(f.calls.includes('connect'),false)});

test('perda de transporte em um turno bloqueia novas ações e devolve recurso',async()=>{let healthy=true;const f=fixture({acquire:async()=>({hop:{port:1},snapshot:()=>({healthy}),close:async()=>f.calls.push('release')})});const keepAlive=setTimeout(()=>{},2000);try{await assert.rejects(f.turn.run('human',async()=>{healthy=false;await new Promise(()=>{})}),/transport_lost_during_turn/);assert.equal(f.calls.at(-1),'release');await assert.rejects(f.turn.run('reply',async()=>{}),/turn_closed/)}finally{clearTimeout(keepAlive)}});

test('visita incompleta devolve cadeira sem avançar última verificação aprovada',async()=>{let now=100;const f=fixture({clock:()=>now});await f.turn.run('observe',async()=>({ok:true}));assert.equal(f.turn.snapshot().lastCheckedAt,100);now=200;await f.turn.run('observe',async()=>({ok:false,state:'incomplete'}));assert.equal(f.turn.snapshot().lastCheckedAt,100);assert.equal(f.calls.filter(x=>x==='release').length,2)});
test('conexão e função sem resultado não confirmam verificação; registro só ocorre depois de liberar',async()=>{const traces=[];const f=fixture({onTrace:async r=>{assert.equal(f.calls.at(-1),'release');traces.push(r)}});await f.turn.run('observe',async()=>{});assert.equal(f.turn.snapshot().lastCheckedAt,0);assert.equal(traces.length,1);assert.equal(traces[0].operationId,'fixture');assert.equal(traces[0].checkConfirmed,undefined);await f.turn.run('observe',async()=>({ok:false,state:'incomplete',reason:'messages_loading'}));assert.equal(traces[1].outcome,'incomplete');assert.equal(traces[1].reason,'messages_loading')});
test('queued human cancellation preserves the session for its next normal visit',async()=>{
 let first=true;const f=fixture({acquire:({signal})=>first?(first=false,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))):Promise.resolve({hop:{},snapshot:()=>({healthy:true}),close:async()=>{}})}),cancel=new AbortController();
 const human=f.turn.run('human',async()=>{throw Error('must_not_run')},{signal:cancel.signal});const observed=assert.rejects(human,/human_canceled/);await new Promise(setImmediate);cancel.abort(Error('virtus_human_canceled'));await observed;
 assert.equal(f.turn.closed,false);await f.turn.run('observe',async()=>({ok:true}));assert.ok(f.turn.lastCheckedAt);
});
test('shared account chair does not request or release another authority lease',async()=>{
 const f=fixture({acquire:async()=>{throw Error('second_chair')}});let returned=0;
 await f.turn.run('warm',async()=>({ok:true}),{lease:{operationId:'parent',hop:{},snapshot:()=>({healthy:true}),close:async()=>returned++}});
 assert.equal(returned,1);assert.equal(f.turn.lastTurn.operationId,'parent');
});
