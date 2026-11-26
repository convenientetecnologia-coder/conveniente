'use strict';const test=require('node:test'),assert=require('node:assert/strict'),flow=require('./loginFlowState');

test('combined verdict requires three cookie gates plus explicit credential rejection and clears on cookie refresh',()=>{
 let f=flow.evolve(null,{cookiesAttempted:true,cookieAttempts:3,cookiesRejected:true},10);
 f=flow.evolve(f,{error:'login_result_unconfirmed'},20);assert.equal(flow.summarize({loginFlow:f}).key,'technical_wait');
 f=flow.evolve(f,{error:'password_rejected'},30);assert.doesNotMatch(flow.summarize({loginFlow:f}).label,/cookies e dados/);
 for(let i=0;i<3;i++)f=flow.evolve(f,{credentialRejected:true},31+i);
 assert.match(flow.summarize({loginFlow:f}).label,/cookies e dados/);
 f=flow.evolve(f,{cookiesRefreshed:true,verified:true},40);assert.equal(f.cookiesRejected,false);assert.equal(f.cookiesRefreshedAt,40);assert.equal(flow.summarize({loginFlow:f}),null);
});
test('new attempts never inherit old password-submission evidence',()=>{const a=flow.evolve({entry:'password',credentialsSubmitted:true,error:'password_rejected'},{stage:'queued'},10);assert.equal(a.credentialsSubmitted,undefined);assert.equal(a.error,undefined);assert.equal(a.entry,undefined)});
test('continue entry survives password and verification stages',()=>{let a=flow.evolve(null,{entry:'continue',stage:'continue'});a=flow.evolve(a,{entry:'password',stage:'verifying',submitted:true});assert.equal(a.entry,'continue');assert.equal(a.credentialsSubmitted,true);assert.equal(flow.summarize({loginFlow:a}).key,'verifying')});
test('technical errors and generic legacy failures never imply rejected password',()=>{for(const error of ['kill_guard_until','login_form_not_found','login_result_unconfirmed'])assert.equal(flow.evolve(null,{error}).stage,'technical_wait');assert.equal(flow.summarize({loginRemediateFailed:true,loginRemediateFailedReason:'login_remediate_failed'}).key,'incomplete');assert.equal(flow.evolve(null,{error:'password_rejected'}).stage,'password_rejected')});
test('hard restrictions take precedence and verified login clears its badge',()=>{for(const k of ['banned','captchaCheckpoint','twoFactor','identityRequired','marketplaceDisabled'])assert.equal(flow.summarize({[k]:true,loginRequired:true,loginFlow:{stage:'password'}}),null);assert.equal(flow.summarize({loginFlow:{stage:'verified'}}),null)});

test('newer confirmed publication supersedes old login history, while current or newer gates remain visible', () => {
 const {summarize,authenticated}=require('./loginFlowState');
 const flow={stage:'incomplete',at:100,error:'login_not_completed'};
 assert.equal(summarize({loginFlow:flow,authenticatedAt:200}),null);
 assert.equal(summarize({loginFlow:flow,authenticatedAt:50}).key,'incomplete');
 assert.equal(summarize({loginFlow:flow,authenticatedAt:200,loginRequired:true}).key,'incomplete');
 assert.equal(summarize({loginFlow:{...flow,at:300},authenticatedAt:200}).key,'incomplete');
 assert.equal(authenticated({loginFlow:flow},200).loginFlow.stage,'verified');
 assert.equal(authenticated({loginFlow:{...flow,at:300}},200).loginFlow.stage,'incomplete');
});
