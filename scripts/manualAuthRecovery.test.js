'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),recovery=require('./manualAuthRecovery');
test('explicit new round preserves old evidence and credentials, keeps automation off until verification',()=>{
 const previous={state:'blocked',reason:'login_required',error:'login_attempt_budget'};
 const manifest={cookies:[{name:'fixture'}],login:'fixture',password:'fixture',accountFlags:{loginAttemptCount:3,loginRequired:true},loginFlow:{stage:'technical_wait'}};
 const result=recovery.prepare({active:false,provisioningResult:previous},manifest,1234);
 assert.equal(result.manifest.accountFlags.loginAttemptCount,0);assert.equal(result.manifest.accountFlags.loginRequired,true);assert.equal(result.manifest.manualAuthRecovery.previousAttempts,3);
 assert.equal(manifest.accountFlags.loginAttemptCount,3);assert.deepEqual(result.manifest.cookies,manifest.cookies);assert.deepEqual(result.desired.provisioningPreviousResult,previous);assert.equal(result.desired.active,false);assert.equal(result.desired.provisioningPending,true);
 assert.throws(()=>recovery.release(result.desired),/not_verified/);
 assert.equal(recovery.release({active:false}).active,true);
 for(const flag of ['banned','captchaCheckpoint','identityRequired','twoFactor','marketplaceDisabled'])assert.throws(()=>recovery.prepare({}, {accountFlags:{[flag]:true}}),/restricted/);
});
test('only successful manual flow queues work after the cadastro browser is closed',async()=>{
 for(const enabled of [false,true])for(const ok of [false,true]){
  const calls=[],result={ok};await recovery.finish(result,{enabled,close:async()=>calls.push('closed'),release:async()=>calls.push('queued'),audit:()=>calls.push('audit')});
  assert.deepEqual(calls,enabled&&ok?['closed','queued','audit']:['closed']);assert.equal(result.workQueued,enabled&&ok?true:undefined);assert.equal(result.online,undefined);
 }
});
test('failure to close the cadastro browser or remaining pending state cannot release automation',async()=>{
 let active=false;const result={ok:true};await assert.rejects(recovery.finish(result,{enabled:true,close:async()=>{throw Error('close_unconfirmed')},release:async()=>active=true}),/close_unconfirmed/);assert.equal(active,false);assert.equal(result.workQueued,undefined);
 await assert.rejects(recovery.finish(result,{enabled:true,close:async()=>{},release:async()=>recovery.release({provisioningPending:true})}),/not_verified/);assert.equal(result.workQueued,undefined);
});
test('actual worker manual entry reopens a closed profile with a fresh bounded round and preserves failure evidence',async()=>{
 const text=fs.readFileSync(require('node:path').join(__dirname,'worker.js'),'utf8');const a=text.indexOf('      if(manualAuthRecovery===true){'),b=text.indexOf("      await recordLoginFlow(nome,{stage:'queued'})",a);
 const original={accountFlags:{loginAttemptCount:3,loginRequired:true}},desired={perfis:{fixture:{active:false,provisioningResult:{state:'blocked',reason:'login_required'}}}};let saved=original;
 const fn=vm.runInNewContext('(async()=>{'+text.slice(a,b)+'})',{manualAuthRecovery:true,operator:'admin_configure:fixture:1',nome:'fixture',readJsonFile:()=>desired,desiredPath:'fixture',manifestStore:{read:async()=>saved,update:async(n,f)=>saved=f(saved)},controllers:new Map(),robeMeta:{},fileStore:{withDesiredFileLockUpdate:async f=>f(desired)},require:()=>recovery,provisionAudit:{append(){}},Date});
 await fn();assert.equal(saved.accountFlags.loginAttemptCount,0);assert.equal(saved.manualAuthRecovery.previousAttempts,3);assert.equal(desired.perfis.fixture.provisioningPending,true);assert.equal(desired.perfis.fixture.active,false);assert.equal(desired.perfis.fixture.provisioningPreviousResult.reason,'login_required');
});
