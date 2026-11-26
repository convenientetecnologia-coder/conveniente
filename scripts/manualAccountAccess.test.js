'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(require('path').join(__dirname,'worker.js'),'utf8');
test('closed browser can be opened for human inspection without clearing cadastro flags',async()=>{
 const start=source.indexOf('  async invoke_human({ nome }) {')+'  async invoke_human({ nome }) {'.length;
 const end=source.indexOf('    return lockProfileAction(nome, async () => {',start);
 for(const live of [false,true]){
  const calls=[],flags={provisioningPending:false,provisioningResult:{state:'blocked'}};
  const fn=vm.runInNewContext('(async function({nome}){'+source.slice(start,end)+';return {ok:true};})',{
   controllers:new Map(),isLiveBrowserCtrl:()=>live,lockProfileAction:async(n,fn)=>fn(),activateOnce:async(n,s,o,opts)=>{calls.push(opts.networkPurpose);return {ok:true}}
  });
  assert.equal((await fn({nome:'fixture'})).ok,true);assert.deepEqual(calls,live?[]:['human']);assert.equal(flags.provisioningResult.state,'blocked');
 }
});
test('manual opening of an unready account routes to human; bulk activation stays in guarded automation',async()=>{
 const start=source.indexOf('  async activate({ nome, operator }) {')+'  async activate({ nome, operator }) {'.length;
 const end=source.indexOf('    return lockProfileAction(nome, async () => {',start);
 for(const [operator,human]of [['ui',true],['admin',true],['unknown',true],['bulk_open_all',false],['stock_provision:batch',false]]){
  let calls=0;
  const fn=vm.runInNewContext('(async function({nome,operator}){'+source.slice(start,end)+';return {ok:false,error:"account_configure_pending"};})',{
   __deltaAwaitHostBootReady:async()=>({ready:true}),isAccountProvisioningPending:()=>true,handlers:{invoke_human:async()=>{calls++;return {ok:true}}}
  });
  const r=await fn({nome:'fixture',operator});assert.equal(calls,human?1:0);assert.equal(r.ok,human);
 }
});
test('failed manual opening cannot report an available browser',async()=>{
 const start=source.indexOf('  async invoke_human({ nome }) {')+'  async invoke_human({ nome }) {'.length,end=source.indexOf('    return lockProfileAction(nome, async () => {',start);
 const fn=vm.runInNewContext('(async function({nome}){'+source.slice(start,end)+';throw Error("must not proceed");})',{
  controllers:new Map(),isLiveBrowserCtrl:()=>false,lockProfileAction:async(n,fn)=>fn(),activateOnce:async()=>({ok:false,error:'carrier_unavailable'})
 });
 assert.equal((await fn({nome:'fixture'})).error,'carrier_unavailable');
});
