'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'api_perfis.js'),'utf8');
async function invoke({proxy=true,kind='stock_provision'}={}){
 const desired={_encerrarGen:0,perfis:{ready:{active:false,virtus:'off'},pending:{active:true,virtus:'off',provisioningPending:true,humanHold:true}}};let handler,releases=0,acquires=0,response;
 const current={active:true,lock:{owner:kind+':fixture',meta:{kind}}};
 const context={app:{post:(_url,fn)=>handler=fn},serverConfig:{readServerConfigEffective:()=>({virtus:{proxyEnabled:proxy}})},provisionLock:{get:()=>current,tryAcquire:()=>{acquires++;return {ok:false,error:'busy',lock:current.lock}},release:()=>{releases++}},fileStore:{desiredPath:'fixture',readJsonSafe:()=>desired,loadPerfisJson:()=>[{nome:'ready'},{nome:'pending'}],withDesiredFileLockUpdate:async fn=>fn(desired),clearBootStartClosedOnOpen(){}},manifestStore:{read:async()=>({accountFlags:{}})},workerClient:{resumeAfterStop(){},ensureCellsRunning:async()=>({ok:true}),reshuffleFairIfIdle:async()=>{throw Error('must_not_reshuffle_proxy')}},readEncerrarGen:()=>0,isAutomaticOpenAllOperator:()=>false,provisionAudit:{append(){}},logger:{warn(){}},process:{env:{}},Date,require:()=>({append:async()=>{},setCellsStopped(){},clearHumanHold(){}})};
 const start=source.indexOf("  app.post('/api/perfis/open-all-24h'"),end=source.indexOf('  // ========== ENDPOINT: ligar/desligar autopilot',start);assert.ok(start>0&&end>start);vm.runInNewContext(source.slice(start,end),context);
 await handler({headers:{}},{json:r=>(response=r)});return {response,desired,releases,acquires};
}
test('proxy open-all starts eligible accounts alongside cadastro without acquiring or releasing its lock',async()=>{
 const r=await invoke();assert.equal(r.response.ok,true);assert.equal(r.response.total,1);assert.equal(r.acquires,0);assert.equal(r.releases,0);assert.equal(r.desired.perfis.ready.active,true);assert.equal(r.desired.perfis.ready.virtus,'on');assert.equal(r.desired._autoOpen.enabled,true);assert.equal(r.desired._openAll.active,false);assert.equal(r.desired._openAll.mode,'proxy_independent');
 assert.equal(r.desired.perfis.pending.active,true);assert.equal(r.desired.perfis.pending.provisioningPending,true);assert.equal(r.desired.perfis.pending.humanHold,true);
});
test('close-all still blocks proxy opening; direct mode keeps its existing global lock protection',async()=>{
 const closed=await invoke({kind:'close_all'});assert.equal(closed.response.ok,false);assert.match(closed.response.error,/open_all_lock_busy/);assert.equal(closed.desired.perfis.ready.active,false);assert.equal(closed.releases,0);
 const direct=await invoke({proxy:false});assert.equal(direct.response.ok,false);assert.equal(direct.acquires,1);assert.equal(direct.releases,0);
});
test('stock lock exempts only independent proxy openings of accounts whose cadastro is complete',()=>{
 const {mayOpenAlongsideStock}=require('./virtusProxyOpenQueue');assert.equal(mayOpenAlongsideStock({proxy:true,pending:false,kind:'stock_provision'}),true);
 for(const extra of [{proxy:false},{pending:true},{kind:'close_all',owner:'close_all:fixture'}])assert.equal(mayOpenAlongsideStock({proxy:true,pending:false,kind:'stock_provision',...extra}),false);
});
test('supervisor permits independent proxy openings past stock lock, while pending cadastro stays isolated',()=>{
 const supervisor=fs.readFileSync(path.join(__dirname,'supervisor.js'),'utf8'),start=supervisor.indexOf('function podeAbrirNovoSlot('),end=supervisor.indexOf('  // Checagem de RAM',start);
 for(const pending of [false,true]){
  const fn=vm.runInNewContext(supervisor.slice(start,end)+"throw Error('reached_ram_checks');}podeAbrirNovoSlot",{Date,getFreeMB:()=>64000,fs:{readFileSync:()=>JSON.stringify({perfis:{ready:{provisioningPending:pending}}})},path,__dirname:path.resolve('fixture'),provisionLock:{get:()=>({active:true,lock:{owner:'stock_provision:other',meta:{kind:'stock_provision'}}}),ownerMatchesOperator:()=>false},pushEvent(){},require:n=>n==='./serverConfig'?{readServerConfigEffective:()=>({virtus:{proxyEnabled:true}})}:require('./virtusProxyOpenQueue')});
  if(pending)assert.equal(fn('ready').reason,'maintenance_provision');else assert.throws(()=>fn('ready'),/reached_ram_checks/);
 }
});
