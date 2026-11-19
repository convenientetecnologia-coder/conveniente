'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
test('sem credencial o bootstrap falha antes da rede com diagnóstico específico',async()=>{
 const module={exports:{}};let fetched=false;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'bootstrapClient.js'),'utf8'),{module,__dirname,require:id=>id==='node:fs'?{readFileSync:()=> 'fixture-host'}:id==='../ctConfig'?{readCtConfig:()=>({ctBaseUrl:'https://api.convenientetecnologia.com',logIngestSecret:''})}:require(id),process:{env:{}},Date,AbortSignal,fetch:async()=>{fetched=true;throw Error('unexpected')}});
 await assert.rejects(module.exports.read(),/cp2_bootstrap_credentials_missing/);assert.equal(fetched,false);
});
test('autoconfig pede credencial ausente e a falha original é registrada antes do erro de proxy',()=>{
 const dashboard=fs.readFileSync(path.join(__dirname,'../dashboard.js'),'utf8');
 const expression=dashboard.match(/const needsConfig = ([^\r\n]+);/)[1];
 const cfg={ctBaseUrl:'https://api.convenientetecnologia.com',textVerifiedApiKey:'x',textVerifiedApiUsername:'x',antiCaptchaApiKey:'x',oxylabsProxyUser:'x',oxylabsProxyPassword:'x'};
 assert.equal(vm.runInNewContext(expression,{cfg,process:{env:{}}}),true);
 assert.equal(vm.runInNewContext(expression,{cfg:{...cfg,logIngestSecret:'fixture'},process:{env:{}}}),false);
 assert.match(fs.readFileSync(path.join(__dirname,'../robeRail.js'),'utf8'),/step:'carrier_v2_admission_failed',purpose,error/);
 assert.match(fs.readFileSync(path.join(__dirname,'../robe.js'),'utf8'),/proxy_mobile_unavailable:' \+ String\(proved\?\.error/);
});
