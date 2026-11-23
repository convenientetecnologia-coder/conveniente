'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),identity=require('./cadastroIdentity');
test('numeric login is never accepted as a Facebook identity',()=>{
 assert.equal(identity.expected({login:'5599999999999',cookies:[]}), '');
 assert.equal(identity.expected({login:'5599999999999',expectedFacebookUserId:'5599999999999',cookies:[]}), '');
});
test('legacy numeric-login reference is repaired only from matching assigned stock and actual cookie identity',async()=>{
 const manifest={stockAccountId:42,login:'5599999999999',expectedFacebookUserId:'5599999999999',cookies:[{name:'c_user',value:'100000001'}]};let saved;
 const binding={ok:true,stockAccountId:42,login:manifest.login,expectedFacebookUserId:'100000001'};
 const opts={nome:'test',manifest,fetchAssigned:async()=>binding,save:async f=>saved=f(manifest)};
 assert.equal(await identity.resolve(opts),'100000001');assert.equal(saved.expectedFacebookUserIdSource,'ct_stock');assert.equal(saved.expectedFacebookUserId,'100000001');
 for(const wrong of [{stockAccountId:43},{login:'other'},{expectedFacebookUserId:'100000002'}])await assert.rejects(identity.resolve({...opts,fetchAssigned:async()=>({...binding,...wrong})}),/identity/);
});
test('a genuinely different trusted identity cannot be silently replaced by a cookie',()=>{
 assert.throws(()=>identity.expected({login:'phone',expectedFacebookUserId:'100000001',expectedFacebookUserIdSource:'ct_stock',cookies:[{name:'c_user',value:'100000002'}]}),/identity_mismatch/);
});
