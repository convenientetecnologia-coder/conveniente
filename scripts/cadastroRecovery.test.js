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
 assert.equal(eligible(want,{...manifest,accountFlags:{loginAttemptCount:2}}),false);
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
test('rejected cookie jar requires a known identity or assigned-stock reference',()=>{
 assert.equal(eligible(want,{login:'123456789012345',password:'fixture',cookies:[],sessionRejected:true}),false);
 assert.equal(eligible(want,{stockAccountId:42,login:'phone',password:'fixture',cookies:[],sessionRejected:true}),true);
 assert.equal(eligible(want,{login:'fixture@example.test',password:'fixture',cookies:[]}),false);
});
test('version three permits the remaining budget once, without resetting real password attempts',()=>{
 const old={...want,credentialRecoveryVersion:1,provisioningResult:{state:'failed',error:'fetch failed'}};
 assert.equal(eligible(old,manifest),true);assert.equal(eligible({...old,credentialRecoveryVersion:3},manifest),false);
 assert.equal(eligible(old,{...manifest,accountFlags:{loginAttemptCount:2}}),false);
 assert.equal(eligible({...want,credentialRecoveryVersion:2},manifest),true);
});
