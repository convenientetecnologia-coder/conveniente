'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(require.resolve('./worker'),'utf8');
test('cadastro enfileirado não pede cadeira enquanto espera execução da mesma conta',async()=>{
 const start=source.indexOf('  async configure({ nome, operator } = {}) {')+'  async configure({ nome, operator } = {}) {'.length,end=source.indexOf("      logger.info('[HANDLER] configure chamada'",start);
 let release,prepared=0;const wait=new Promise(r=>release=r);
 const fn=vm.runInNewContext('(async function(nome,operator){'+source.slice(start,end)+'return {ok:true};});}finally{await closeCadastroBrowser(nome,cadastroBrowser)}})',{
  __deltaAwaitHostBootReady:async()=>({ready:true}),lockProfileAction:async(_n,run)=>{await wait;return run()},prepareCadastroBrowser:async()=>{prepared++;return {browser:{}}},closeCadastroBrowser:async()=>{}
 });const result=fn('account','test');await new Promise(setImmediate);assert.equal(prepared,0);release();assert.equal((await result).ok,true);assert.equal(prepared,1);
});
test('relogin negado pelo controlador não abre Chrome nem consome cadeira',async()=>{
 const marker='  async login_remediate({ nome, operator, options } = {}) {',start=source.indexOf(marker)+marker.length,end=source.indexOf('      const snapPolicy = ramPolicy.snapshotPolicy();',start);let prepared=0;
 const fn=vm.runInNewContext('(async function(nome,operator,options){'+source.slice(start,end)+'return {ok:true};});}finally{await closeCadastroBrowser(nome,cadastroBrowser)}})',{
  __deltaAwaitHostBootReady:async()=>({ready:true}),lockProfileAction:async(_n,run)=>run(),prepareCadastroBrowser:async()=>{prepared++;return {browser:{}}},isAccountProvisioningPending:()=>true,closeCadastroBrowser:async()=>{},supervisorClient:{requestPermit:async()=>({ok:false,error:'busy'})},provisionAudit:{append(){}},queueAutoLoginRemediate:()=>true,Date,process:{env:{}}
 });const result=await fn('account','test',{});assert.equal(result.error,'governor_busy');assert.equal(prepared,0);
});
