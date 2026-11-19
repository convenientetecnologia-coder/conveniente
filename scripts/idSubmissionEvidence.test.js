'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{classify,read}=require('./idSubmissionEvidence'),fs=require('node:fs'),vm=require('node:vm');
test('confirmar identidade e texto de análise genérico nunca comprovam envio',()=>{
 for(const text of ['Confirme sua identidade para publicar. Seu classificado será analisado.','Confirmar identidade. Informações serão enviadas para análise.','Identidade Pronto anúncio em análise'])assert.equal(classify({text}).confirmed,false);
 for(const control of ['Confirmar identidade','Confirme sua identidade','Avançar','Continuar','Enviar'])assert.equal(classify({text:'Confirmação de identidade em andamento',controls:[control]}).confirmed,false);
});
test('somente estados explícitos de envio/análise de identidade são reconhecidos',()=>{
 assert.equal(classify({text:'Confirmação de identidade em andamento',controls:['Pronto']}).kind,'pending');
 assert.equal(classify({text:'Suas informações foram enviadas',controls:['Fechar']}).kind,'submitted');
 assert.equal(classify({text:'Identity verification is under review'}).confirmed,true);
});
test('amostra sem escopo não confirma; ação pendente vence texto final de outro diálogo',async()=>{
 assert.equal((await read({evaluate:async()=>[]})).confirmed,false);
 const result=await read({evaluate:async()=>[{text:'Suas informações foram enviadas',controls:['Fechar']},{text:'Confirmar identidade',controls:['Confirmar identidade']}]});assert.equal(result.confirmed,false);
});
test('atalho já enviado recusa ausência de evidência e Pronto que não foi clicado',async()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'robePostPublishId.js'),'utf8'),start=source.indexOf('async function finishAlreadySubmitted('),end=source.indexOf('async function scrollSellingToTop(',start);
 for(const confirmed of [false,true]){let closed=false;const fn=vm.runInNewContext(source.slice(start,end)+'\nfinishAlreadySubmitted',{require:()=>({read:async()=>({confirmed,kind:'pending'})}),logEvt(){},isPendingReviewScreen:async()=>true,clickProntoIfPresent:async()=>false,recordIdFailure:async()=>{},sleep:async()=>{},WAIT_STEP_MS:0,Date,closeSuccessDialog:async()=>closed=true});const result=await fn({},{});assert.equal(result.ok,false);assert.equal(closed,false);assert.equal(result.error,confirmed?'pronto_not_clicked':'already_submitted_not_confirmed')}
});
