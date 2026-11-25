'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const flow=require('./humanAccountFlow');
function fixture(human=true){
 const source=fs.readFileSync(require.resolve('./worker'),'utf8');
 const id=source.slice(source.indexOf("  async ['human-verify-id']("),source.indexOf("  async ['anuncio-run']("));
 const renew=source.slice(source.indexOf("  async ['renew-listings']("),source.indexOf("  /**\n   * REMOVIDO: renovação fused"));
 let borrowed=0,locked=0,actions=0;
 const browser={isConnected:()=>true},page={browser:()=>browser};
 const lease={operationId:'human-operation',snapshot:()=>({healthy:true,absoluteDeadline:(Date.now()+600000)/1000}),confirm:async()=>{},possibleSideEffect:async()=>{}};
 browser.__ctVirtusProxy={runHumanAction:async action=>{assert.equal(locked,0,'do not hold profile lock while waiting');borrowed++;return action(lease)}};
 const ctrl={browser,mainPage:page,humanControl:human},controllers=new Map([['account',ctrl]]);
 const module={exports:{}};
 const action=kind=>{actions++;assert.equal(locked,1);assert.equal(browser.__ctIsolatedFlow?.kind,human?kind:undefined);return {ok:true}};
 vm.runInNewContext('const handlers={'+id+renew+'};module.exports=handlers',{
  module,controllers,robeMeta:{},logger:{info(){}},provisionAudit:{append(){}},
  lockProfileAction:async(_n,fn)=>{locked++;try{return await fn()}finally{locked--}},
  robePostPublishId:{runHumanVerifyId:async({page:received})=>{assert.equal(received,page);return action('id')}},
  runRenewListingsForProfile:async()=>action('renew'),snapshotStatusAndWrite:async()=>{},clearAccountFlags:async()=>{},
  require:name=>{assert.equal(name,'./humanAccountFlow');return {run:(options,fn)=>flow.run({...options,audit:()=>{}},fn)}}
 });
 return {handlers:module.exports,ctrl,browser,counts:()=>({borrowed,locked,actions})};
}
for(const [method,args]of [['human-verify-id',{}],['renew-listings',{mode:'manual'}]]){
 test(method+' in human mode borrows once before taking the profile lock',async()=>{const f=fixture();assert.equal((await f.handlers[method]({nome:'account',...args})).ok,true);assert.deepEqual(f.counts(),{borrowed:1,locked:0,actions:1});assert.equal(f.browser.__ctIsolatedFlow,undefined)});
 test(method+' outside human mode retains the existing isolated entry point',async()=>{const f=fixture(false);assert.equal((await f.handlers[method]({nome:'account',...args})).ok,true);assert.equal(f.counts().borrowed,0)});
 test(method+' cannot start while returning to automation',async()=>{const f=fixture();f.ctrl._proxyHumanResuming=true;assert.equal((await f.handlers[method]({nome:'account',...args})).error,'human_resume_in_progress');assert.equal(f.counts().actions,0)});
}
