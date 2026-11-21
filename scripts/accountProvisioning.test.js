'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {stopForConfigure}=require('./runtimeStop');
const source=fs.readFileSync(require('node:path').join(__dirname,'worker.js'),'utf8');
test('stock rejects HTTP success envelopes containing failed activation or start-work',()=>{
 const dashboard=fs.readFileSync(require('node:path').join(__dirname,'dashboard.js'),'utf8');
 for(const number of [4,8]){
  const start=dashboard.indexOf('          const rr'+number+' ='),end=dashboard.indexOf('          return r'+number+';',start);
  assert.ok(start>0&&end>start);
  const check=vm.runInNewContext('(function(r'+number+'){'+dashboard.slice(start,end)+'return true;})');
  assert.throws(()=>check({ok:true,result:{ok:false,error:'account_configure_pending'}}),/account_configure_pending/);
  assert.throws(()=>check({ok:true,result:{}}));
  assert.equal(check({ok:true,result:{ok:true}}),true);
  assert.equal(check({ok:true}),true);
 }
});
test('cadastro recusa espera infinita e para o runtime se ele resolver atrasado',async()=>{
 let resolve,stopped=0;const pending=new Promise(r=>{resolve=r});
 await assert.rejects(stopForConfigure([pending],15),/configure_virtus_stop_timeout/);
 resolve({stop:async()=>{stopped++}});
 await new Promise(r=>setImmediate(r));assert.equal(stopped,1);
});
test('runtime pronto é parado uma vez; falha não vira cadastro liberado',async()=>{
 let stopped=0;const runtime={stop:async()=>{stopped++}};await stopForConfigure([runtime,runtime,null],30);assert.equal(stopped,1);
 await assert.rejects(stopForConfigure([{stop:async()=>{throw Error('stop_failed')}}],30),/stop_failed/);
});
test('cadastro pendente ou configurando não inicia nenhum motor',()=>{
 const start=source.indexOf('function startVirtusByEngine('),end=source.indexOf('  // Fonte de verdade operacional',start);
 for(const pending of [true,false])for(const configuring of [true,false]){
  if(!pending&&!configuring)continue;
  const fn=vm.runInNewContext(source.slice(start,end)+'throw Error("engine_started");}\nstartVirtusByEngine',{
   isAccountProvisioningPending:()=>pending,isProfileHumanHeld:()=>false,controllers:new Map([['test',{configurando:configuring}]]),provisionAudit:{append(){}},Date
  });assert.equal(fn({},'test',{}),null);
 }
});
test('conclusão só libera conta explicitamente pendente e preserva flags alheias',async()=>{
 const start=source.indexOf('function isAccountProvisioningPending('),end=source.indexOf('function automationAllowed(',start);
 const desired={perfis:{test:{provisioningPending:true,humanHold:true,active:true,virtus:'off'}}};let manifestWrites=0;
 const api=vm.runInNewContext(source.slice(start,end)+'\n({isAccountProvisioningPending,completeAccountProvisioning})',{
  readJsonFile:()=>desired,desiredPath:'synthetic',manifestStore:{update:async(_n,fn)=>{manifestWrites++;assert.ok(fn({}).configuredAt)}},fileStore:{withDesiredFileLockUpdate:async fn=>fn(desired)},provisionAudit:{append(){}},Date
 });assert.equal(api.isAccountProvisioningPending('test'),true);await api.completeAccountProvisioning('test','verified');
 assert.equal(api.isAccountProvisioningPending('test'),false);assert.equal(desired.perfis.test.humanHold,true);assert.equal(desired.perfis.test.virtus,'off');
 await api.completeAccountProvisioning('test','verified');assert.equal(manifestWrites,1);
});
test('caminho soberano e fila automática também respeitam cadastro pendente',()=>{
 const start=source.indexOf('async function __deltaResolveVirtusRunner(');
 assert.match(source.slice(start,start+350),/isAccountProvisioningPending\(nome\)/);
 const queue=source.indexOf('function queueAutoLoginRemediate(');
 assert.match(source.slice(queue,queue+300),/isAccountProvisioningPending\(nome\)/);
 assert.match(source,/await stopVirtus\(nome, \{ configure: true \}\)/);
});

test('painel usa execução real, e cadastro pendente nunca é anunciado online',()=>{
 const html=fs.readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8');
 assert.match(html,/p\.provisioningPending \? 'Cadastro pendente' : 'Virtus '\+\(p\.virtusOnline/);
 const marker=source.indexOf('  provisioningPending: isAccountProvisioningPending(nome),');
 assert.ok(marker>0);
 const expression=source.slice(marker,marker+1600).match(/virtusOnline: ([^\r\n]+),/)[1];
 for(const pending of [true,false])for(const configuring of [true,false])for(const runtime of [true,false]){
  const online=vm.runInNewContext(expression,{nome:'test',isAccountProvisioningPending:()=>pending,controllers:new Map([['test',{configurando:configuring,virtus:runtime}]])});
  assert.equal(online,!pending&&!configuring&&runtime);
 }
});
