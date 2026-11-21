'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
test('real outbox pump persists temporary failure, waits across restart, and completes the same command',async()=>{
 const pending=path.resolve('fixture/pending'),done=path.resolve('fixture/done'),file=path.join(pending,'command.json');
 const files=new Map([[file,JSON.stringify({id:'command',payload:{actions:[{stockAccountId:1}]},stockAccountIds:[1]})]]);
 let now=1000,calls=0,finished=0;const delays=[];
 function boot(){
  const context={__stockProvisionPumpInFlight:false,STOCK_PROVISION_PENDING_DIR:pending,STOCK_PROVISION_DONE_DIR:done,__edgeEnsureStockProvisionOutboxDirsSync(){},path,
   fs:{readdirSync:dir=>[...files.keys()].filter(k=>path.dirname(k)===dir).map(k=>path.basename(k)),readFileSync:p=>files.get(p),writeFileSync:(p,v)=>files.set(p,v),renameSync:(a,b)=>{if(!files.has(a))throw Error('missing');files.set(b,files.get(a));files.delete(a)},existsSync:p=>files.has(p),unlinkSync:p=>files.delete(p)},
   Date:{now:()=>now},require:n=>{assert.equal(n,'./scripts/stockProvisionRetry');return {retryPlan:(record,output)=>require('./stockProvisionRetry').retryPlan(record,output,now)}},forensicLog(){},__edgeNoteStockProvisionFinished(){finished++},__edgeKickStockProvisionPump(){},setTimeout:(_fn,ms)=>{delays.push(ms);return {unref(){}}},
   applyInfraCommands:async cmds=>{calls++;assert.equal(cmds[0].id,'command');return calls===1?{results:[{type:'stock_provision',details:{results:[{stockAccountId:1,ok:false,error:'carrier_unavailable'}]}}]}:{results:[{type:'stock_provision',details:{results:[{stockAccountId:1,ok:true} ]}}]}}
  };
  const start=source.indexOf('async function __edgePumpStockProvisionOutbox('),end=source.indexOf('\nfunction __edgeKickStockProvisionPump',start);
  return vm.runInNewContext(source.slice(start,end)+'\n__edgePumpStockProvisionOutbox',context);
 }
 await boot()();assert.equal(files.has(file),true);assert.equal(finished,0);assert.equal(calls,1);assert.equal(delays.at(-1),30000);
 now=2000;await boot()();assert.equal(calls,1);assert.equal(files.has(file),true);
 now=31001;await boot()();assert.equal(calls,2);assert.equal(finished,1);assert.equal(files.has(file),false);assert.equal(files.has(path.join(done,'command.json')),true);
});

