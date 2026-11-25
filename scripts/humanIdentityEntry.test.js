'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./robePostPublishId'),'utf8');
function fixture({done=false,screen='listing_identity_required',opened=true}={}){
 const events=[];
 const fn=vm.runInNewContext(source.slice(source.indexOf('async function runHumanVerifyId('),source.indexOf('module.exports ='))+';runHumanVerifyId',{
  require:()=>({context:()=>({}),armIdentity:async()=>events.push('arm')}),
  isDoneToday:async()=>done,takeIdentityTab:async()=>({}),releaseIdentityTab:()=>{},pageHandleState:()=>({ok:true}),
  dismissTurbineUpsell:async()=>{},detectIdWizardScreen:async()=>screen,
  ensureSellingFeed:async()=>events.push('selling'),
  tryOpenActionNeededAtTop:async(_p,options)=>{events.push('listing:'+options.mode);return {openedOk:opened,scan:{found:opened,listedToday:opened,reason:opened?null:'action_stale_not_today'}}},
  runIdDocWithFallback:async()=>{events.push('wizard');return {ok:false,error:'fixture_stop_before_upload'}},
  logEvt(){},sleep:async()=>{},TOP_SCAN_ATTEMPTS_HUMAN:1,WAIT_STEP_MS:0,BUDGET_TOTAL_MS:420000,ID_PNG_PATH:'fixture',recordIdFailure:async()=>{},shouldMarkDocError:()=>false,Date
 });return {run:()=>fn({page:{},nome:'fixture'}),events};
}
test('human ID opens today listing before entering the wizard instead of treating the banner as a button',async()=>{
 const f=fixture();assert.equal((await f.run()).error,'fixture_stop_before_upload');assert.deepEqual(f.events,['selling','listing:today','wizard']);
});
test('old or absent listing does not fall back to any old account listing',async()=>{
 const f=fixture({opened:false});assert.equal((await f.run()).error,'no_action_needed');assert.deepEqual(f.events,['selling','listing:today']);
});
test('real open wizard is reused without opening another listing',async()=>{
 const f=fixture({screen:'confirm'});await f.run();assert.deepEqual(f.events,['arm','wizard']);
});
test('ID already done today skips before opening pages or taking the tab',async()=>{
 const f=fixture({done:true});assert.equal((await f.run()).reason,'already_done_today');assert.deepEqual(f.events,[]);
});

test('a checkpoint URL or an inventory banner alone never proves the identity prompt opened',async()=>{
 const a=source.indexOf('async function waitListingIdentityPrompt('),b=source.indexOf('/** Compat: scan antigo',a);
 for(const [snapshot,screen,expected]of [[{hasBtn:false,onCheckpoint:false},'listing_identity_required',false],[{hasBtn:false,onCheckpoint:true},'unknown',false],[{hasBtn:true,onCheckpoint:false},'confirm',true],[{hasBtn:false,onCheckpoint:true},'continuar',true]]){
  let now=0;const fn=vm.runInNewContext(source.slice(a,b)+';waitListingIdentityPrompt',{Date:{now:()=>now},deadlineLeft:()=>10000,sleep:async ms=>now+=ms,detectIdWizardScreen:async()=>screen});
  assert.equal(!!await fn({evaluate:async()=>snapshot},{maxMs:3000}),expected);
 }
});
