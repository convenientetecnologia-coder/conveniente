'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{eligible,recover}=require('./cadastroRecovery');
const manifest={login:'fixture',password:'fixture',cookies:[{name:'c_user',value:'123'},{name:'xs',value:'fixture'}],accountFlags:{loginAttemptCount:0}};
const want={active:false,provisioningResult:{state:'blocked',error:'still_login_required:login_form',at:1}};
test('old unattempted cookie-only block is queued once, preserving evidence and requiring verification',async()=>{
 let desired={perfis:{a:structuredClone(want)}};const opts={snapshot:structuredClone(desired),read:async()=>manifest,update:async f=>{desired=f(desired)},now:()=>100};
 assert.deepEqual(await recover(opts),['a']);assert.equal(desired.perfis.a.provisioningPending,true);assert.equal(desired.perfis.a.active,false);assert.equal(desired.perfis.a.virtus,'off');assert.deepEqual(desired.perfis.a.credentialRecoveryPreviousResult,want.provisioningResult);
 desired.perfis.a.provisioningPending=false;desired.perfis.a.provisioningResult=want.provisioningResult;
 assert.deepEqual(await recover({...opts,snapshot:structuredClone(desired)}),[]);
});
test('real attempted login, restrictions, missing credentials, human hold and foreign shards are preserved',async()=>{
 assert.equal(eligible(want,{...manifest,accountFlags:{loginAttemptCount:1}}),false);
 for(const flag of ['captchaCheckpoint','idVirtus','banned','twoFactor','whatsappConfirm'])assert.equal(eligible(want,{...manifest,accountFlags:{[flag]:true}}),false);
 assert.equal(eligible({...want,humanHold:true},manifest),false);assert.equal(eligible(want,{...manifest,cookies:[]}),false);
 assert.equal(eligible({...want,provisioningResult:{state:'blocked',error:'configure_blocked_checkpoint_captcha'}},manifest),false);
 assert.deepEqual(await recover({snapshot:{perfis:{a:want}},allow:()=>false,read:async()=>{throw Error('wrong shard')},update:()=>{throw Error('unexpected')}}),[]);
});
test('concurrent newer result is never overwritten by recovery',async()=>{
 const desired={perfis:{a:{...want,provisioningResult:{...want.provisioningResult,at:2}}}};
 assert.deepEqual(await recover({snapshot:{perfis:{a:want}},read:async()=>manifest,update:async f=>f(desired)}),[]);assert.equal(desired.perfis.a.provisioningResult.at,2);
});
test('one unreadable manifest cannot prevent the remaining accounts from recovering',async()=>{
 let desired={perfis:{bad:structuredClone(want),good:structuredClone(want)}};
 const result=await recover({snapshot:structuredClone(desired),read:async n=>{if(n==='bad')throw Error('invalid json');return manifest},update:async f=>{desired=f(desired)}});
 assert.deepEqual(result,['good']);assert.equal(desired.perfis.bad.provisioningResult.state,'blocked');
});
