'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),stages=require('./operationStages');
test('later unconfirmed side effect never borrows an earlier publish confirmation',()=>{
 const row={type:'publish',sent:true,result:'confirmed'};assert.equal(stages.begin(row,'identity',1),true);
 assert.equal(row.result,'unknown');assert.equal(row.stageResults.publish.state,'confirmed');assert.equal(stages.begin(row,'identity',2),false);
 assert.throws(()=>stages.begin(row,'renew'),/previous_stage/);stages.confirm(row,3);assert.equal(row.stageResults.identity.state,'confirmed');
 stages.begin(row,'renew',4);assert.equal(row.result,'unknown');assert.equal(row.stageResults.identity.state,'confirmed');stages.confirm(row,5);
 stages.begin(row,'virtus',6);assert.equal(row.result,'unknown');assert.equal(row.stageResults.renew.state,'confirmed');
 assert.throws(()=>stages.begin({type:'identity'},'renew'),/invalid_account_stage/);
});
