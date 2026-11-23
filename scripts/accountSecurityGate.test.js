'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),gate=require('./accountSecurityGate');
for(const state of [{state:'code',phone:true,whatsapp:false,reason:'account_code_phone'},{state:'code',phone:false,whatsapp:true,reason:'account_code_whatsapp'},{state:'code',phone:true,whatsapp:true,reason:'account_code_phone_whatsapp'},{state:'selfie',reason:'identity_confirm_selfie'}]){
 test('explicit security result is persisted and blocks automation: '+state.reason,async()=>{
  let saved;const result=await gate.check({nome:'test',page:{evaluate:async()=>state},persist:async(name,value)=>{assert.equal(name,'test');saved=value}});
  assert.equal(result.ok,false);assert.deepEqual(saved,state);
 });
}
test('security entry gets one bounded attempt; an unresolved screen never becomes healthy',async()=>{
 let now=0,clicks=0;const page={evaluate:async fn=>fn===gate.inspect?{state:'entry'}:(clicks++,true)};
 const options={nome:'test',page,clock:()=>now,sleep:async ms=>now+=ms,persist:async()=>{throw Error('not an identified restriction')}};
 assert.equal((await gate.check(options)).ok,false);assert.equal(clicks,1);assert.equal(now,45000);
});
test('ordinary page does not persist a restriction or click',async()=>{
 const result=await gate.check({nome:'test',page:{evaluate:async fn=>{assert.equal(fn,gate.inspect);return {state:'none'}}},persist:async()=>{throw Error('unexpected restriction')}});
 assert.equal(result.ok,true);assert.equal(gate.fromFlags({accountCodeWhatsapp:true}),'account_code');
});
