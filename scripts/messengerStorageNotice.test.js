'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{matches,dismiss}=require('./messengerStorageNotice');
test('recognizes only informational secure storage notice, never PIN or identity prompts',()=>{
 assert.equal(matches('Alterações nas configurações de armazenamento seguro Após restaurar o histórico, a sincronização automática continuará.'),true);
 for(const text of ['Insira seu PIN para restaurar suas conversas','Confirme sua identidade','Excluir armazenamento seguro','Alterações nas configurações de armazenamento seguro'])assert.equal(matches(text),false);
});
test('OK requires confirmed dismissal; missing button never becomes success',async()=>{
 let clicks=0;const page={evaluate:async()=>({present:true,clickable:true}),$:async()=>({click:async()=>clicks++}),waitForFunction:async()=>{}};
 assert.equal((await dismiss(page)).closed,true);assert.equal(clicks,1);
 page.waitForFunction=async()=>{throw Error('still_visible')};assert.equal((await dismiss(page)).closed,false);
 page.$=async()=>null;assert.equal((await dismiss(page)).closed,false);
});
