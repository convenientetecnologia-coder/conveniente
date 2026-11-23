'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{restoreMissingCookies}=require('./stockProvisionResume');
const cookies=[{name:'c_user',value:'123',domain:'.facebook.com'},{name:'xs',value:'fixture-session',domain:'.facebook.com'}];
test('resume repairs missing identity before configure without injecting or claiming success',async()=>{
 const calls=[];assert.deepEqual(await restoreMissingCookies({profileName:'bauru-1',manifest:{cookies:[{name:'datr',value:'fixture'}]},cookies,httpJson:async(...args)=>{calls.push(args);return {ok:true}}}),{restored:true});
 assert.equal(calls[0][0],'/api/perfis/bauru-1/stock-update');assert.equal(calls[0][1].body.applyCookies,0);assert.deepEqual(calls[0][1].body.cookies,cookies);
});
test('resume preserves valid session and refuses a different identity or invalid source',async()=>{
 const httpJson=async()=>{throw Error('unexpected mutation')};
 assert.deepEqual(await restoreMissingCookies({manifest:{cookies},cookies,httpJson}),{restored:false});
 await assert.rejects(restoreMissingCookies({manifest:{cookies:[{name:'c_user',value:'456'}]},cookies,httpJson}),/identity_mismatch/);
 await assert.rejects(restoreMissingCookies({manifest:{},cookies:[],httpJson}),/source_cookies_invalid/);
});
test('resume stops when saving repaired cookies fails',async()=>{
 await assert.rejects(restoreMissingCookies({manifest:{},cookies,httpJson:async()=>({ok:false})}),/restore_failed/);
});
