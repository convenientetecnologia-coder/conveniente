'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
function fixture(data,ok=true){let calls=0;const module={exports:{}};vm.runInNewContext(fs.readFileSync(require('path').join(__dirname,'bootstrapClient.js'),'utf8'),{module,__dirname,require:id=>id==='node:fs'?{readFileSync:()=> '11111111-1111-1111-1111-111111111111'}:id==='../ctConfig'?{readCtConfig:()=>({logIngestSecret:'fixture-secret'})}:require(id),process:{env:{}},Date,AbortSignal,fetch:async(url,options)=>{calls++;assert.equal(url,'https://api.convenientetecnologia.com/api/carrier-v2/bootstrap');assert.equal(options.headers['x-log-secret'],'fixture-secret');return {ok,json:async()=>data}}});return {read:module.exports.read,calls:()=>calls}}
test('bootstrap recebe token próprio e compartilha apenas uma requisição concorrente',async()=>{
 const f=fixture({ok:true,baseUrl:'https://api.convenientetecnologia.com/api/carrier-v2',token:'x'.repeat(64),eligiblePhoneIds:['p001','p002']});const [a,b]=await Promise.all([f.read(),f.read()]);assert.equal(a,b);assert.equal(f.calls(),1);assert.equal(a.eligiblePhoneIds.length,2);
});
test('host sem autorização não recebe configuração nem disponibilidade fictícia',async()=>{
 const f=fixture({ok:false,error:'cp2_server_not_assigned'},false);await assert.rejects(f.read(),/not_assigned/);
 const invalid=fixture({ok:true,baseUrl:'http://elsewhere',token:'x'.repeat(64),eligiblePhoneIds:['p001']});await assert.rejects(invalid.read(),/bootstrap_invalid/);
});
