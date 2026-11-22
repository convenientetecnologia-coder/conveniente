'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {record,LIMIT}=require('./virtusTurnEvidence');
test('turn history is bounded, atomic, excludes payloads and rejects path traversal',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'turn-evidence-'));
 try{
  for(let i=0;i<LIMIT+3;i++)await record('account-1',{operationId:String(i),outcome:'incomplete',reason:'messages_loading',password:'SECRET',message:'CUSTOMER'}, {root});
  const text=await fs.readFile(path.join(root,'account-1','virtus_turn_history.json'),'utf8'),rows=JSON.parse(text);
  assert.equal(rows.length,LIMIT);assert.equal(rows[0].operationId,'3');assert.equal(text.includes('SECRET'),false);assert.equal(text.includes('CUSTOMER'),false);assert.equal((await fs.readdir(path.join(root,'account-1'))).length,1);
  await assert.rejects(record('../bad',{}, {root}),/invalid_evidence_account/);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
