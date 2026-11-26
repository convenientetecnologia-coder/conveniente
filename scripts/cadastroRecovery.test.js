'use strict';
require('node:test')('old form-not-found verdict is recoverable without clearing password budget',()=>{
 const assert=require('node:assert/strict'),{eligible}=require('./cadastroRecovery');
 const want={provisioningResult:{state:'blocked',error:'login_form_not_found'}};
 const manifest={stockAccountId:42,login:'fixture',password:'fixture',accountFlags:{loginAttemptCount:1}};
 assert.equal(eligible(want,manifest),true);assert.equal(eligible(want,{...manifest,accountFlags:{loginAttemptCount:3}}),false);
});
const test=require('node:test'),assert=require('node:assert/strict'),{eligible,recover}=require('./cadastroRecovery');

test('new technical failure after version four can requeue once without clearing the actual submission count',async()=>{
 const m={stockAccountId:42,login:'fixture',password:'fixture',loginFlow:{at:200,error:'carrier_unavailable'},accountFlags:{loginAttemptCount:2}};
 let d={perfis:{a:{credentialRecoveryVersion:4,provisioningResult:{state:'blocked',error:'still_login_required:aymh_continue',at:100}}}};
 assert.deepEqual(await recover({snapshot:structuredClone(d),read:async()=>m,update:async f=>{d=f(d)},now:()=>300}),['a']);
 assert.equal(d.perfis.a.credentialRecoveryFlowAt,200);assert.equal(m.accountFlags.loginAttemptCount,2);
 d.perfis.a.provisioningPending=false;d.perfis.a.provisioningResult={state:'blocked',error:'still_login_required:aymh_continue',at:100};
 assert.equal(eligible(d.perfis.a,m),false);
 assert.equal(eligible({...d.perfis.a,credentialRecoveryFlowAt:0},{...m,accountFlags:{loginAttemptCount:3}}),false);
});
const manifest={login:'fixture',password:'fixture',cookies:[{name:'c_user',value:'123'},{name:'xs',value:'fixture'}],accountFlags:{loginAttemptCount:0}};
const want={active:false,provisioningResult:{state:'blocked',error:'still_login_required:login_form',at:1}};
test('old unattempted cookie-only block is queued once, preserving evidence and requiring verification',async()=>{
 let desired={perfis:{a:structuredClone(want)}};const opts={snapshot:structuredClone(desired),read:async()=>manifest,update:async f=>{desired=f(desired)},now:()=>100};
 assert.deepEqual(await recover(opts),['a']);assert.equal(desired.perfis.a.provisioningPending,true);assert.equal(desired.perfis.a.active,false);assert.equal(desired.perfis.a.virtus,'off');assert.deepEqual(desired.perfis.a.credentialRecoveryPreviousResult,want.provisioningResult);
 desired.perfis.a.provisioningPending=false;desired.perfis.a.provisioningResult=want.provisioningResult;
 assert.deepEqual(await recover({...opts,snapshot:structuredClone(desired)}),[]);
});
test('real attempted login, restrictions, missing credentials, human hold and foreign shards are preserved',async()=>{
 assert.equal(eligible(want,{...manifest,accountFlags:{loginAttemptCount:3}}),false);
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
 assert.equal(eligible(old,manifest),true);assert.equal(eligible({...old,credentialRecoveryVersion:3},manifest),true);assert.equal(eligible({...old,credentialRecoveryVersion:4},manifest),false);
 assert.equal(eligible(old,{...manifest,accountFlags:{loginAttemptCount:3}}),false);
 assert.equal(eligible({...want,credentialRecoveryVersion:2},manifest),true);
});

test('technical anti-loop failures without a provisioning result get one bounded recovery; restrictions do not',async()=>{
 const m={...manifest,stockAccountId:42,accountFlags:{loginRequired:true,loginReason:'aymh_continue',loginRemediateFailed:true,loginRemediateFailedReason:'kill_guard_until',loginAttemptCount:0}};
 let d={perfis:{a:{active:false,credentialRecoveryVersion:3}}};const opts={read:async()=>m,update:async f=>{d=f(d)}};
 assert.deepEqual(await recover({...opts,snapshot:structuredClone(d)}),['a']);assert.equal(d.perfis.a.credentialRecoveryVersion,4);assert.equal(d.perfis.a.provisioningPending,true);assert.equal(d.perfis.a.credentialRecoveryPreviousResult.error,'kill_guard_until');
 assert.equal(eligible({active:false},{...m,accountFlags:{...m.accountFlags,loginReason:'checkpoint_captcha',captchaCheckpoint:true}}),false);
 assert.equal(eligible({active:false},{...m,accountFlags:{...m.accountFlags,loginAttemptCount:3}}),false);
});
