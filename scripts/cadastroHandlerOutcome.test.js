'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(require.resolve('./worker'),'utf8');
test('os dois handlers reais persistem resultado antes de devolver o controle ao index',async()=>{
 for(const method of ['configure','login_remediate'])for(const error of ['identity_required','still_login_required:login_form','HTTP/1.1 502 Bad Gateway']){
  const desired={perfis:{account:{provisioningPending:true,active:true,virtus:'on'}}},events=[];
  const helperStart=source.indexOf('async function finishAccountProvisioningResult('),helperEnd=source.indexOf('async function prepareCadastroBrowser(',helperStart);
  const marker='  async '+method+'(',start=source.indexOf(marker),end=source.indexOf('    finally{await closeCadastroBrowser(nome,cadastroBrowser)}',start)+'    finally{await closeCadastroBrowser(nome,cadastroBrowser)}\n  },'.length;
  const fn=vm.runInNewContext(source.slice(helperStart,helperEnd)+'\n({'+source.slice(start,end)+'}).'+method,{
   require,Date,__deltaAwaitHostBootReady:async()=>({ready:true}),lockProfileAction:async()=>({ok:false,error}),fileStore:{withDesiredFileLockUpdate:async fn=>{events.push('persisted');return fn(desired)}},provisionAudit:{append(){}},closeCadastroBrowser:async()=>events.push('closed')
  });
  const r=await fn({nome:'account'});assert.equal(r.error,error);assert.equal(events.at(-1),'closed');
  if(error.includes('502')){assert.equal(desired.perfis.account.provisioningPending,true);assert.equal(desired.perfis.account.provisioningResult,undefined)}else{assert.equal(desired.perfis.account.provisioningPending,false);assert.equal(desired.perfis.account.provisioningResult.state,'blocked');assert.deepEqual(events,['persisted','closed']);}
 }
});
