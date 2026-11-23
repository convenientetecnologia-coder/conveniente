'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),health=require('./proxyHealthFlags'),fallback=require('./configureLoginFallback');
test('login observed by Virtus reaches the recovery reader, including Continue',()=>{
 for(const reason of ['aymh_continue','login_form','login_wall']){
 const man=health.record({accountFlags:{banned:false}},{state:'login',reason},123);
 assert.equal(man.accountFlags.loginRequired,true);assert.equal(man.accountFlags.loginSource,'virtus_proxy_turn');assert.equal(man.accountFlags.loginAt,123);
 assert.equal(fallback.canRemediate(health.loginReason(man.accountFlags)),true);assert.equal(man.accountFlags.banned,false);
 }
});
test('existing incorrectly named observations remain recoverable without changing terminal flags',()=>{
 assert.equal(health.loginReason({loginRequiredReason:'aymh_continue'}),'aymh_continue');
 assert.equal(health.loginReason({loginReason:'login_wall',loginRequiredReason:'aymh_continue'}),'login_wall');
 assert.equal(health.record({accountFlags:{captchaCheckpoint:true}},{state:'login',reason:'login_form'}).accountFlags.captchaCheckpoint,true);
});
