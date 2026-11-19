'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'robePostPublishId.js'),'utf8');
function classify(text,buttons=[],proxy=false) {
 const elements=buttons.map(label=>({innerText:label,textContent:label,disabled:false,getAttribute:n=>n==='aria-label'?label:null,getBoundingClientRect:()=>({width:100,height:40,top:10,bottom:50}),closest:()=>null}));
 const document={body:{innerText:text},querySelectorAll:selector=>selector==='span,div,label'?[]:elements,querySelector:()=>null};
 const start=source.indexOf('async function detectIdWizardScreen('),end=source.indexOf('async function clickConfirmeSuaIdentidade(',start);
 const fn=vm.runInNewContext(source.slice(start,end)+'\ndetectIdWizardScreen',{document,window:{innerHeight:900},require:()=>({context:()=>proxy?{proxyRequired:true,rail:{isProxyArmed:true}}:null})});
 return fn({evaluate:async f=>f()});
}
test('tela real com política de 30 dias e botão Continuar não é introdução Avançar',async()=>{
 const text='Verificação de identidade. Ajude-nos a verificar seu documento de identidade. O documento escolhido deve incluir seu nome e data de nascimento. Seu documento de identidade será armazenado com segurança e excluído dentro de 30 dias após terminarmos de confirmar sua identidade. Se você escolher carregar um documento de identidade emitido pelo governo, cubra seu número de identificação. Continuar';
 assert.equal(await classify(text,['Continuar']),'continuar');
});
test('intro com reconhecimento facial permanece introdução e não sucesso',async()=>{
 assert.equal(await classify('Confirme sua identidade com um documento usando reconhecimento facial',['Avançar']),'identity_doc_intro');
});
test('recusa anterior e envio em análise continuam estados distintos',async()=>{
 assert.equal(await classify('Não foi possível verificar sua identidade. Tente novamente.',['Avançar']),'identity_retry');
 assert.equal(await classify('Confirmação de identidade em andamento. Normalmente analisamos suas informações em 48 horas.',['Pronto']),'pending_review');
});
test('erro real do Chrome em rota armada é falha de proxy, sem procurar botões',async()=>{
 await assert.rejects(classify('Não é possível acessar esse site. www.facebook.com demorou muito para responder. ERR_TIMED_OUT',[],true),/identity_proxy_navigation_failed:ERR_TIMED_OUT/);
 await assert.rejects(classify('Não é possível acessar esse site. ERR_TIMED_OUT',[],false),/identity_navigation_failed:ERR_TIMED_OUT/);
});

test('recuperação de tela vazia recarrega uma vez e respeita prazo, contexto e formulário',async()=>{
 const start=source.indexOf('async function recoverEmptyIdCheckpoint('),end=source.indexOf('async function waitForWizardScreen(',start);
 let reloads=0,empty=true,checkpoint=true,left=90000;
 const fn=vm.runInNewContext(source.slice(start,end)+'\nrecoverEmptyIdCheckpoint',{
  pageIsMarketplaceDocCheckpoint:()=>checkpoint,deadlineLeft:()=>left,logEvt(){},NAV_TIMEOUT_MS:45000
 });
 const page={evaluate:async()=>empty,reload:async()=>{reloads++}};
 assert.equal(await fn(page,{elapsedMs:1000}),false);
 empty=false;assert.equal(await fn(page,{elapsedMs:16000}),false);
 empty=true;checkpoint=false;assert.equal(await fn(page,{elapsedMs:16000}),false);
 checkpoint=true;left=10000;assert.equal(await fn(page,{elapsedMs:16000}),false);
 left=90000;assert.equal(await fn(page,{elapsedMs:16000}),true);
 assert.equal(await fn(page,{elapsedMs:20000}),false);assert.equal(reloads,1);
});
