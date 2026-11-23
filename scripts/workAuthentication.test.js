'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{assertAuthenticated}=require('./workAuthentication');
test('a newly expired session blocks publication even if old flags were healthy',async()=>{
 let man={};await assert.rejects(assertAuthenticated({},'fixture',{detect:async()=>({loginRequired:true,reason:'aymh_continue'}),persist:async(_n,f)=>{man=f(man)}}),/still_login_required:aymh_continue/);
 assert.equal(man.accountFlags.loginRequired,true);assert.equal(man.accountFlags.loginReason,'aymh_continue');
});
test('a detector failure cannot be swallowed and permit posting',async()=>{
 await assert.rejects(assertAuthenticated({},'fixture',{detect:async()=>{throw Error('transport lost')},persist:async()=>{throw Error('unexpected')}}),/transport lost/);
});
