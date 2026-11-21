'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
function finish(items){
 const start=source.indexOf('function __edgeRememberStockProvisionFinished('),end=source.indexOf('\nfunction __edgeNoteStockProvisionFinished',start);
 const list=[],context={__edgeLoadStockProvisionFinishedSync:()=>list,__edgeStockFinishShouldReturn:()=>true,__edgeEnsureStockProvisionOutboxDirsSync(){},__stockProvisionFinished:[],STOCK_PROVISION_FINISHED_PATH:'fixture',fs:{writeFileSync(){},renameSync(){}},Date};
 vm.runInNewContext(source.slice(start,end)+'\n__edgeRememberStockProvisionFinished',context)(items);return list;
}
test('failed configuration retains its error and never returns an existing profile to stock',()=>{
 const [r]=finish([{stockAccountId:1,profileName:'existing',ok:false,error:'carrier_unavailable'}]);assert.equal(r.error,'carrier_unavailable');assert.equal(r.returnToStock,false);assert.equal(r.ok,false);
});
test('success clears error; missing profile can return; completion history is bounded',()=>{
 const rows=finish([{stockAccountId:1,profileName:'existing',ok:true,error:'old'},{stockAccountId:2,ok:false,error:'provision_lock_busy'}]);assert.equal(rows[0].error,null);assert.equal(rows[1].returnToStock,true);assert.equal(rows[1].error,'provision_lock_busy');
 assert.equal(finish(Array.from({length:40},(_,i)=>({stockAccountId:i+1,profileName:'p'+i,ok:false}))).length,20);
});
