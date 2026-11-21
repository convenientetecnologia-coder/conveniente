'use strict';const test=require('node:test'),assert=require('node:assert/strict');const {create}=require('./virtusProxySession');
test('quiet complete document is not reloaded or marked synchronized without new network',async()=>{
 const {session,calls,page}=await operationalFixture({reconnectWaitMs:0});let reloads=0,actions=0;
 page.setOfflineMode=async()=>{};page.reload=async()=>reloads++;
 page.evaluate=async fn=>fn.name==='inspectDocument'?{ready:true,reason:'ready'}:{error:false,online:true};
 await assert.rejects(session.run('observe',async()=>actions++),/reconnect_not_confirmed/);
 assert.equal(reloads,0);assert.equal(actions,0);assert.equal(session.snapshot().lastCheckedAt,0);assert.equal(calls.at(-1),'release');await session.close();
});
test('Proxy Não não provisiona nem abre canal',async()=>{let touched=false;assert.equal(await create({nome:'fixture',dependencies:{config:{virtus:{proxyEnabled:false}},cp2:{ensureConfig:()=>{touched=true}}}}),null);assert.equal(touched,false)});
test('Proxy Sim exige capacidade anunciada antes de criar comutador',async()=>{let opened=false;class Client{async capabilities(){return {virtusTurns:false}}}await assert.rejects(create({nome:'fixture',dependencies:{allowPilot:true,config:{virtus:{proxyEnabled:true}},cp2:{ensureConfig:async()=>{},readConfig:()=>({})},Client,rails:{createDirectSwitch:()=>{opened=true}}}}),/transport_not_ready/);assert.equal(opened,false)});
test('session usa requireProxy e só conecta durante turno concedido',async()=>{const calls=[];const rail={listen:async()=>12345,close:async()=>{},flip:h=>calls.push(h?'online':'offline'),trafficSnapshot:()=>({})};class Client{async capabilities(){return {virtusTurns:true}}}const session=await create({nome:'fixture',dependencies:{allowPilot:true,config:{virtus:{proxyEnabled:true}},Client,cp2:{ensureConfig:async()=>{},readConfig:()=>({}),begin:async opts=>{assert.equal(opts.purpose,'virtus');return {hop:{port:1},snapshot:()=>({healthy:true}),close:async()=>calls.push('released')}}},rails:{createDirectSwitch:opts=>{assert.equal(opts.requireProxy,true);return rail},proveThroughRail:async()=>'{"ip":"fixture"}',readExit:p=>p}}});assert.deepEqual(calls,[]);const events={};const page={url:()=> 'https://www.facebook.com/messages',on:(name,fn)=>events[name]=fn,setOfflineMode:async offline=>{if(!offline)session.noteNetwork()},waitForFunction:async()=>{}};session.attach({pages:async()=>[page],on:()=>{},once:()=>{}});await session.run('observe',async()=>calls.push('collect'));assert.deepEqual(calls,['online','collect','offline','released']);await session.turn.close()});
async function operationalFixture(observerDependencies={}){
 const calls=[],rail={listen:async()=>1,close:async()=>{},flip:h=>calls.push(h?'connect':'disconnect'),trafficSnapshot:()=>({directUp:0,directDown:0})};class Client{async capabilities(){return {virtusTurns:true}}}
 const session=await create({nome:'test',dependencies:{deliveryLedger:{accountBlocked:()=>false},...observerDependencies,allowPilot:true,confirmationTimeoutMs:20,config:{virtus:{proxyEnabled:true}},Client,cp2:{ensureConfig:async()=>{},readConfig:()=>({}),begin:async()=>({hop:{port:1},snapshot:()=>({healthy:true}),possibleSideEffect:async()=>calls.push('mark'),confirm:()=>calls.push('confirmed'),close:async()=>calls.push('release')})},rails:{createDirectSwitch:()=>rail,proveThroughRail:async()=>'{"ip":"fixture"}',readExit:x=>x}}});
 const page={url:()=> 'https://www.facebook.com/messages',on:()=>{},setOfflineMode:async offline=>{if(!offline)session.noteNetwork()},waitForFunction:async()=>{}};session.attach({pages:async()=>[page],on:()=>{},once:()=>{},isConnected:()=>true});return {session,calls,page};
}
test('humano aguarda cadeira e a devolve somente ao retomar',async()=>{const {session,calls}=await operationalFixture();await session.enterHuman();assert.equal(session.snapshot().humanHeld,true);assert.equal(calls.includes('release'),false);await session.leaveHuman();assert.equal(calls.at(-1),'release');assert.equal(session.snapshot().humanHeld,false);await session.close()});
test('composer vazio não confirma: exige eco com mensagem e conversa correspondentes',async()=>{const {session,calls}=await operationalFixture();await session.run('reply',async()=>{await session.beforeSend({threadKey:'thread',text:'Resposta de teste'});session.recordOutgoing({threadKey:'wrong',text:'Resposta de teste',messageId:'wrong',messageAt:Date.now()});session.recordOutgoing({threadKey:'thread',text:'outro texto',messageId:'wrong',messageAt:Date.now()});session.recordOutgoing({threadKey:'thread',text:'Resposta de teste',messageId:'server-id',messageAt:Date.now()});assert.equal((await session.confirmSend()).messageId,'server-id')});assert.equal(calls.filter(x=>x==='mark').length,1);assert.equal(calls.filter(x=>x==='confirmed').length,1);await session.close()});
test('eco histórico ou sem id não aprova envio nem repete ação',async()=>{const {session,calls}=await operationalFixture();await assert.rejects(session.run('reply',async()=>{await session.beforeSend({threadKey:'t',text:'olá'});session.recordOutgoing({threadKey:'t',text:'olá',messageId:'historical',messageAt:Date.now()-60000});session.recordOutgoing({threadKey:'t',text:'olá',messageAt:Date.now()});await session.confirmSend()}),/server_ack_unconfirmed/);assert.equal(calls.includes('confirmed'),false);assert.equal(calls.filter(x=>x==='mark').length,1);assert.equal(calls.at(-1),'release');await session.close()});

test('piloto persistente habilita somente a conta escolhida com configuração global desligada',async()=>{
 let probes=0;class Client{async capabilities(){probes++;return {virtusTurns:false}}}
 const dependencies={pilot:{version:1,enabled:true,accountId:'mario-fixture'},config:{virtus:{proxyEnabled:false}},cp2:{ensureConfig:async()=>{},readConfig:()=>({})},Client};
 assert.equal(await create({nome:'outra-conta',dependencies}),null);assert.equal(probes,0);
 await assert.rejects(create({nome:'mario-fixture',dependencies}),/transport_not_ready/);assert.equal(probes,1);
});

test('Proxy Sim global aceita outras contas sem a antiga trava do piloto',async()=>{class Client{async capabilities(){return {virtusTurns:false}}}await assert.rejects(create({nome:'outra-conta',dependencies:{pilot:null,config:{virtus:{proxyEnabled:true}},cp2:{ensureConfig:async()=>{},readConfig:()=>({})},Client}}),/transport_not_ready/)});

test('novo runtime substitui callbacks do observador sem duplicar timer e stop antigo não cancela o novo',async()=>{
 const ticks=[];let clears=0,oldCalls=0,newCalls=0;
 const {session}=await operationalFixture({revisitMs:0,setObserverInterval:fn=>{ticks.push(fn);return {unref(){}}},clearObserverInterval:()=>clears++});
 session.run=async(_intent,fn)=>fn();
 const old=session.startObserver({canObserve:()=>false,prepareInbox:async()=>{oldCalls++;throw Error('old')}});
 await ticks[0]();assert.equal(oldCalls,0);
 const current=session.startObserver({canObserve:()=>true,prepareInbox:async()=>{newCalls++;throw Error('expected_fixture_abort')}});
 assert.equal(ticks.length,1);await ticks[0]();assert.equal(newCalls,1);assert.equal(oldCalls,0);
 session.stopObserver(old);assert.equal(clears,0);await ticks[0]();assert.equal(newCalls,2);
 session.stopObserver(current);assert.equal(clears,1);
 session.startObserver({canObserve:()=>false});assert.equal(ticks.length,2);await session.close();
});

test('resposta pronta durante observação aproveita a cadeira ativa com confirmação correlacionada',async()=>{
 const ticks=[];const {session,calls}=await operationalFixture({setObserverInterval:fn=>{ticks.push(fn);return {unref(){}}},clearObserverInterval:()=>{}});
 let entered,release;const inside=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 session.startObserver({prepareInbox:async()=>{entered();await gate;return {ok:true,state:'marketplace_ready'}}});
 const tick=ticks[0]();await inside;
 const reply=session.run('reply',async()=>{await session.beforeSend({threadKey:'burst',text:'Resposta pronta'});session.recordOutgoing({threadKey:'burst',text:'Resposta pronta',messageId:'server-burst',messageAt:Date.now()});await session.confirmSend();return {ok:true}});
 release();assert.equal((await reply).ok,true);await tick;assert.equal(calls.filter(x=>x==='connect').length,1);assert.equal(calls.filter(x=>x==='confirmed').length,1);assert.equal(calls.filter(x=>x==='release').length,1);await session.close();
});
test('prazo humano devolve cadeira sem retomar automação por conta própria',async()=>{const {session,calls}=await operationalFixture({humanLeaseMs:20});await session.enterHuman();await new Promise(r=>setTimeout(r,50));assert.equal(session.snapshot().humanHeld,false);assert.equal(calls.filter(x=>x==='release').length,1);await session.close()});

test('latência de resposta só é calculada com mensagem recebida da mesma conversa',async()=>{const {session}=await operationalFixture();session.noteIncoming(Date.now()-5000,'timed-thread');await session.run('reply',async()=>{await session.beforeSend({threadKey:'timed-thread',text:'Resposta'});session.recordOutgoing({threadKey:'timed-thread',text:'Resposta',messageId:'timed-server',messageAt:Date.now()});await session.confirmSend()});assert.ok(session.snapshot().lastReplyTiming.customerToConfirmationMs>=5000);await session.run('reply',async()=>{await session.beforeSend({threadKey:'other-thread',text:'Outra'});session.recordOutgoing({threadKey:'other-thread',text:'Outra',messageId:'other-server',messageAt:Date.now()});await session.confirmSend()});assert.equal(session.snapshot().lastReplyTiming.customerToConfirmationMs,null);await session.close()});

test('fechar conta enquanto aguarda cadeira impede ativação tardia',async()=>{let wanted=false,proved=0;class Client{async capabilities(){return {virtusTurns:true}}}const rail={listen:async()=>1,flip(){},close:async()=>{},trafficSnapshot:()=>({})};const session=await create({nome:'cancelled-fixture',dependencies:{allowPilot:true,isReady:async()=>wanted,config:{virtus:{proxyEnabled:true}},Client,cp2:{ensureConfig:async()=>{},readConfig:()=>({}),begin:async opts=>{if(!await opts.isReady())throw Error('operation_context_lost');throw Error('unexpected_activation')}},rails:{createDirectSwitch:()=>rail,proveThroughRail:async()=>{proved++;return '{}'},readExit:p=>p}}});await assert.rejects(session.boot(),/context_lost/);assert.equal(proved,0);await session.close()});

test('ACK perdido persiste pendência e impede segundo efeito após recriar sessão',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),real=require('./virtusDeliveryLedger'),root=fs.mkdtempSync(path.join(os.tmpdir(),'session-delivery-'));
 const deliveryLedger={begin:row=>real.begin({...row,root}),confirm:(row,proof)=>real.confirm(row,proof,{root})};
 let first,second;try{
  first=await operationalFixture({deliveryLedger});
  await assert.rejects(first.session.run('reply',async()=>{await first.session.beforeSend({threadKey:'thread',text:'resposta',clientMessageId:'logical-reply'});await first.session.confirmSend()}),/server_ack_unconfirmed/);
  await first.session.close();second=await operationalFixture({deliveryLedger});
  await assert.rejects(second.session.run('reply',()=>second.session.beforeSend({threadKey:'thread',text:'resposta',clientMessageId:'logical-reply'})),/reconciliation_required/);
  assert.equal(first.calls.filter(x=>x==='mark').length,1);assert.equal(second.calls.includes('mark'),false);assert.equal(second.calls.includes('confirmed'),false);
 }finally{await first?.session.close();await second?.session.close();fs.rmSync(root,{recursive:true,force:true})}
});

test('pendência isola mensagem antiga sem impedir resposta nova da mesma conta',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),real=require('./virtusDeliveryLedger'),root=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-delivery-'));let f;
 try{real.defer({nome:'test',client_message_id:'legacy',thread_key:'thread',texto_resposta:'answer'},'legacy_unknown',{root});const deliveryLedger={accountBlocked:name=>real.accountBlocked(name,{root}),begin:row=>real.begin({...row,root}),confirm:(row,proof)=>real.confirm(row,proof,{root}),markUncertain:row=>real.markUncertain(row,{root})};f=await operationalFixture({deliveryLedger});await assert.rejects(f.session.run('reply',()=>f.session.beforeSend({threadKey:'thread',text:'answer',clientMessageId:'legacy'})),/reconciliation_required/);assert.equal(f.calls.includes('mark'),false);await f.session.run('reply',async()=>{await f.session.beforeSend({threadKey:'thread',text:'new answer',clientMessageId:'new'});f.session.recordOutgoing({threadKey:'thread',text:'new answer',messageId:'server-new',messageAt:Date.now()});await f.session.confirmSend()});assert.equal(f.calls.filter(c=>c==='mark').length,1);assert.equal(real.read('test','legacy',{root}).state,'reconciliation_required');assert.equal(real.read('test','new',{root}).state,'confirmed')}finally{await f?.session.close();fs.rmSync(root,{recursive:true,force:true})}
});

test('falha de transporte antes do observador não abandona navegador ativo congelado',async()=>{
 let safetyTick,closed=0,cleared=0,session;const rail={listen:async()=>1,close:async()=>{},flip(){},trafficSnapshot:()=>({})};class Client{async capabilities(){return {virtusTurns:true}}}
 session=await create({nome:'startup-failure',dependencies:{allowPilot:true,config:{virtus:{proxyEnabled:true}},Client,deliveryLedger:{accountBlocked:()=>false},setClosedBrowserInterval:fn=>{safetyTick=fn;return {unref(){}}},clearClosedBrowserInterval:()=>cleared++,cp2:{ensureConfig:async()=>{},readConfig:()=>({}),begin:async()=>({hop:{port:1},snapshot:()=>({healthy:true}),close:async()=>{throw Error('cp2_release_unconfirmed')}})},rails:{createDirectSwitch:()=>rail,proveThroughRail:async()=>'{"ip":"fixture"}',readExit:x=>x}}});const page={url:()=> 'https://www.facebook.com/messages',on(){},setOfflineMode:async offline=>{if(!offline)session.noteNetwork()},waitForFunction:async()=>{}};session.attach({pages:async()=>[page],on(){},once(){},isConnected:()=>true,close:async()=>closed++});await assert.rejects(session.run('observe',async()=>({ok:true})),/release_unconfirmed/);assert.equal(session.snapshot().startupFinished,false);assert.equal(session.snapshot().observer.registered,false);await safetyTick();assert.equal(closed,1);assert.equal(cleared,1);assert.equal(session.snapshot().state,'closed');await safetyTick();assert.equal(closed,1);
});
