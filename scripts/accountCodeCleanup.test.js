'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),cleanup=require('./dailyTerminalCleanup'),config=require('./serverConfig');
test('code cleanup covers telephone, WhatsApp and both, only when explicitly enabled',()=>{
 for(const flags of [{accountCodePhone:true},{accountCodeWhatsapp:true},{accountCodePhone:true,accountCodeWhatsapp:true}]){
  assert.equal(cleanup.classifyTerminalDelete(flags).delete,false);
  assert.equal(cleanup.classifyTerminalDelete(flags,{deleteKinds:{account_code:true}}).delete,true);
 }
 const normalized=config.buildNormalizedConfig({terminalAccountCleanup:{deleteKinds:{account_code:true,selfie_video:true}}},{});
 assert.equal(normalized.terminalAccountCleanup.deleteKinds.account_code,true);assert.equal(normalized.terminalAccountCleanup.deleteKinds.selfie_video,true);
 assert.equal(cleanup.classifyTerminalDelete({banned:true,accountCodePhone:true},{deleteKinds:{banned:true,account_code:false}}).category,'banned');
});
