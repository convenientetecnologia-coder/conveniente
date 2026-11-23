'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{reason}=require('./terminalAccountPolicy');
test('every configured terminal category closes without requiring automatic deletion',()=>{
 for(const flags of [{banned:true},{captchaCheckpoint:true},{twoFactor:true},{marketplaceDisabled:true},{idVirtus:true},{identityRequired:true},{identitySubmitted:true},{whatsappConfirm:true},{accountCodePhone:true},{accountCodeWhatsapp:true}])assert.ok(reason(flags));
 for(const flags of [{},{loginRequired:true,loginReason:'login_form'},{loginRemediateFailed:true},{marketplaceDocError:true},{proxyPublishError:true}])assert.equal(reason(flags),null);
});
test('worker disconnects the proxy before closing the blocked browser, once, preserving account data',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('./worker'),'utf8'),start=source.indexOf('const terminalClosePending=new Set();'),end=source.indexOf('\nasync function ensureTerminalHumanHoldOnce',start);
 const events=[],tasks=[];const ctrl={browser:{__ctVirtusProxy:{close:async()=>events.push('proxy-disconnected')}}};
 const schedule=vm.runInNewContext(source.slice(start,end)+';scheduleTerminalBrowserClose',{Set,setImmediate:fn=>tasks.push(fn),require:()=>({reason}),controllers:new Map([['a',ctrl]]),isRobeBusy:()=>false,isProfileOpening:()=>false,readAccountFlags:async()=>({whatsappConfirm:true}),syncClosedTerminalDesiredState:async()=>events.push('desired-off'),handlers:{deactivate:async args=>{assert.equal(args.policy,'preserveDesired');events.push('browser-closed');return {ok:true}}},provisionAudit:{append(){}},Date});
 schedule('a',{whatsappConfirm:true});schedule('a',{whatsappConfirm:true});assert.equal(tasks.length,1);await tasks[0]();assert.deepEqual(events,['desired-off','proxy-disconnected','browser-closed']);
});
test('legacy WhatsApp and new phone flags share the same optional cleanup category',()=>{
 const cleanup=require('./dailyTerminalCleanup');for(const flags of [{whatsappConfirm:true},{accountCodePhone:true},{accountCodeWhatsapp:true},{whatsappConfirm:true,accountCodePhone:true}]){
 assert.equal(cleanup.classifyTerminalDelete(flags).delete,false);
 assert.equal(cleanup.classifyTerminalDelete(flags,{deleteKinds:{account_code:true}}).category,'account_code');
 }
});
