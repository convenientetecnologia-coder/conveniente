'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const fallback=require('./configureLoginFallback');
test('rejected cookies reach one actual credential attempt in the configure handler',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'worker.js'),'utf8'),start=source.indexOf("          const driven = await require('./configureLoginFallback')"),end=source.indexOf('          if (driven && driven.terminal)',start);
 assert.ok(start>0&&end>start);const calls=[];
 const result=await vm.runInNewContext('(async()=>{'+source.slice(start,end)+';return driven})()',{
  require:name=>name==='./configureLoginFallback'?{run:args=>fallback.run({...args,attempt:async()=>{calls.push('password');return {ok:true}}})}:require(name),
  browserHelper:{detectLoginRequired:async()=>({loginRequired:true,reason:'login_form'})},rr:'login_form',workPage:{goto:async()=>calls.push('messages')},nome:'fixture',login2:'fixture',password2:'fixture',ctrl:{browser:{__ctCadastroProxy:{assertHealthy(){calls.push('healthy')},noteStage(){}}}},
  readLoginAttemptCount:async()=>0,LOGIN_ATTEMPT_MAX:2,bumpLoginAttemptCount:async()=>{calls.push('budget');return 1},stopLoginAfterBudget:async()=>{throw Error('unexpected')},provisionAudit:{append(){}},Date,Error
 });
 assert.equal(result.ok,true);assert.deepEqual(calls.filter(c=>c!=='healthy'),['budget','password','messages']);
});
test('budget, transport loss and rejected credentials cannot navigate or claim login',async()=>{
 let attempts=0,navigations=0;const opts={page:{goto:async()=>navigations++},begin:async()=>false,attempt:async()=>{attempts++;return {ok:true}}};
 assert.equal((await fallback.run(opts)).error,'login_attempt_budget');assert.equal(attempts,0);
 const refused=await fallback.run({...opts,begin:async()=>true,attempt:async()=>({ok:false,error:'login_not_accepted'})});assert.equal(refused.ok,false);assert.equal(navigations,0);
 await assert.rejects(fallback.run({...opts,assertHealthy:()=>{throw Error('cadastro_proxy_transport_unhealthy')}}),/transport_unhealthy/);assert.equal(attempts,0);
});
test('only ordinary authentication surfaces enter automatic proxy remediation',()=>{
 for(const reason of ['login_form','login_wall','aymh_continue'])assert.equal(fallback.canRemediate(reason),true);
 for(const reason of ['hacked_review','checkpoint','captcha','identity_required','two_factor','probe_failed',''])assert.equal(fallback.canRemediate(reason),false);
});
test('proxy health queues ordinary login recovery; it does not execute it inside the leased visit',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'worker.js'),'utf8'),start=source.indexOf('async page=>{',source.indexOf('proxyHealthCheck:')),end=source.indexOf('}:null,',start);assert.ok(start>0&&end>start);
 for(const reason of ['login_form','hacked_review']){let queued=0;
  const fn=vm.runInNewContext('('+source.slice(start,end+1)+')',{require:n=>n==='./virtusOnlineHealth'?{check:async()=>({ok:false,state:'login',reason})}:fallback,manifestStore:{update:async(_n,f)=>f({})},nome:'fixture',invalidateAccountFlagsCache(){},queueAutoLoginRemediate(){queued++},Date});
  assert.equal((await fn({})).ok,false);assert.equal(queued,reason==='login_form'?1:0);
 }
});
test('technical errors never persist login or rejected-credential flags in the real setters',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'worker.js'),'utf8');let writes=0;
 for(const name of ['setLoginRequiredFlag','setLoginRemediateFailedFlag']){
  const start=source.indexOf('async function '+name+'('),end=source.indexOf('\nasync function ',start+1);
  const fn=vm.runInNewContext(source.slice(start,end)+'\n'+name,{require:n=>require(n),manifestStore:{update:async()=>writes++},refuseOutsideCadastroMark:()=>false,Date});
  for(const reason of ['cadastro_ui_ready_timeout','cadastro_proxy_transport_unhealthy','pc_login_navigation_failed:detached Frame'])await fn('fixture',{reason});
 }
 assert.equal(writes,0);
});

test('trust-device continuation does not spend a password attempt and still enters final verification target',async()=>{
 let attempts=0,opened=0;const result=await fallback.run({page:{goto:async()=>opened++},resume:async()=>({ok:true,via:'trust_device_resume'}),begin:async()=>{attempts++;return true}});assert.equal(result.ok,true);assert.equal(attempts,0);assert.equal(opened,1);
 const blocked=await fallback.run({page:{},resume:async()=>({ok:false,terminal:'trust_device',error:'trust_device_unconfirmed'}),begin:async()=>{attempts++;return true}});assert.equal(blocked.ok,false);assert.equal(attempts,0);
});

test('trust screen appearing after password submission gets resumed before returning failure',async()=>{let checks=0;const result=await fallback.run({page:{goto:async()=>{}},begin:async()=>true,resume:async()=>++checks===1?null:{ok:true,via:'trust_device_resume'},attempt:async()=>({ok:false,error:'login_not_accepted'})});assert.equal(result.ok,true);assert.equal(checks,2)});
