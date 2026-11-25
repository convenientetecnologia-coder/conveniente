'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const navigation=require('./identityWizardNavigation'),id=require('./robePostPublishId'),shared=require('./humanAccountFlow');
let browser;
test.before(async()=>{browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']})});
test.after(async()=>browser?.close());
async function fixture(steps,{mode='div',delay=50}={}){
 const page=await browser.newPage();await page.setContent('<main role="main"></main>');
 await page.evaluate(({steps,mode,delay})=>{
  window.steps=steps;window.stage=0;window.clicks=[];window.bad=0;
  window.render=()=>{
   const state=steps[window.stage],root=document.querySelector('main');
   if(!state){root.innerHTML='<h1>Carregue uma foto do seu documento</h1><input type=file><button>Carregar</button>';return;}
   const headings={confirm:'Confirme sua identidade',intro:'Confirme sua identidade com um documento usando reconhecimento facial',continue:'Verificação de identidade: ajude-nos a verificar seu documento',load:'Escolha como enviar sua identidade',intro2:'Confirme sua identidade com um documento. Antes de começar',cnh:'Escolha um tipo de documento'};
   const label={confirm:'Confirmar identidade',intro:'Avançar',continue:'Continuar',load:'Carregar documento de identidade',intro2:'Avançar',cnh:'Avançar'}[state];
   root.innerHTML='<h1>'+headings[state]+'</h1><div aria-hidden=true><button onclick="window.bad++">'+label+'</button></div><button disabled>'+label+'</button>'+(state==='cnh'?'<div role="radio" aria-checked="false" tabindex="0" onclick="this.setAttribute(\'aria-checked\',\'true\');document.querySelector(\'#next\').removeAttribute(\'aria-disabled\');document.querySelector(\'#next\').style.background=\'rgb(8,102,255)\'"><span>Carteira de habilitação</span></div>':'')+
    (mode==='native'?'<button id="next">'+label+'</button>':'<div id="next" class="random'+Math.random()+'" role="'+(mode==='focusable'?'none':'button')+'" tabindex="0" aria-label="'+label+'"><div><span>'+label+'</span><div data-visualcompletion="ignore"></div></div></div>');
   const button=document.querySelector('#next');button.style.cssText='display:block;width:330px;height:48px;background:rgb(8,102,255);color:white';
   if(state==='cnh'){button.setAttribute('aria-disabled','true');button.style.background='rgb(200,200,200)'}
   button.onclick=()=>{if(button.getAttribute('aria-disabled')==='true'){window.bad++;return}window.clicks.push(state);setTimeout(()=>{window.stage++;window.render()},delay)};
  };window.render();
 },{steps,mode,delay});return page;
}
async function navigate(page,options={}){
 const deadlineAt=Date.now()+40000;
 return navigation.navigate({page,deadlineAt,detect:()=>id.detectIdWizardScreen(page),selectCnh:()=>id.waitCnhSelected(page,{maxMs:5000,deadlineAt}),stableMs:100,...options});
}
for(const mode of ['div','native'])for(const steps of [
 ['confirm','intro','continue','load','intro2','cnh'],
 ['continue','load','cnh'],
 ['load','cnh'],
 ['intro','intro2','cnh']
])test(mode+' buttons: '+steps.join(' → '),{timeout:45000},async()=>{
 const page=await fixture(steps,{mode});try{
  const lease={operationId:'human-fixture',snapshot:()=>({healthy:true,absoluteDeadline:(Date.now()+600000)/1000}),possibleSideEffect:async()=>{},confirm:async()=>{}};
  const result=await shared.run({browser,nome:'fixture',kind:'id',proxy:{runHumanAction:action=>action(lease)},audit:()=>{}},()=>navigate(page));
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.screen,'upload_photo');
  assert.deepEqual(await page.evaluate(()=>window.clicks),steps);assert.equal(await page.evaluate(()=>window.bad),0);
 }finally{await page.close()}
});
test('unchanged step is not clicked repeatedly or reported as advanced',{timeout:10000},async()=>{
 const page=await fixture(['continue'],{delay:30000});try{const result=await navigate(page,{stepTimeoutMs:1000});assert.equal(result.ok,false);assert.equal(result.error,'identity_transition_unconfirmed');assert.deepEqual(await page.evaluate(()=>window.clicks),['continue'])}finally{await page.close()}
});
test('slow transition is awaited instead of clicking again',{timeout:15000},async()=>{
 const page=await fixture(['continue'],{delay:2000});try{const result=await navigate(page,{stepTimeoutMs:5000});assert.equal(result.ok,true);assert.deepEqual(await page.evaluate(()=>window.clicks),['continue'])}finally{await page.close()}
});
test('lost chair prevents even the first navigation click',async()=>{
 const page=await fixture(['continue']);browser.__ctIsolatedFlow={kind:'id',proxyRequired:true,rail:{isProxyArmed:true,operationSnapshot:()=>({healthy:false})}};
 try{await assert.rejects(navigate(page),/interaction_without_healthy_proxy_turn/);assert.deepEqual(await page.evaluate(()=>window.clicks),[])}finally{delete browser.__ctIsolatedFlow;await page.close()}
});

test('selling banner is not an open wizard; opening today listing exposes the real Confirmar identidade button',async()=>{
 const page=await browser.newPage();try{
  const hints=id.dateHintsSP();
  await page.setContent('<main role="main"><div style="width:650px"><span>Confirme sua identidade para publicar este e futuros classificados</span><a href="/marketplace/item/123456789012345">Mudança, Frete, super promoção hoje Carreto</a><div>Em estoque · Anunciado em '+hints.todayDay+'/'+hints.todayMonth+'</div><button aria-label="Mais opções">...</button></div></main>');
  await page.evaluate(()=>{document.querySelector('a').onclick=event=>{event.preventDefault();document.body.innerHTML='<main role="main"><div role="button" tabindex="0" aria-label="Confirmar identidade">Confirmar identidade</div></main>';}});
  assert.equal(await id.detectIdWizardScreen(page),'listing_identity_required');
  const opened=await id.openActionNeededListing(page,{mode:'today'});assert.equal(opened.listedToday,true);assert.equal(opened.clicked,true,JSON.stringify(opened));
  assert.equal(await id.detectIdWizardScreen(page),'confirm');
 }finally{await page.close()}
});
test('focusable wrapper with nested role-none spans advances without requiring a button role',async()=>{
 const page=await fixture(['intro','continue'],{mode:'focusable'});try{assert.equal((await navigate(page)).ok,true);assert.deepEqual(await page.evaluate(()=>window.clicks),['intro','continue'])}finally{await page.close()}
});
test('document without body is a loading state, not an exception',async()=>{
 const page=await browser.newPage();try{
  await page.setContent('<h1>Before navigation</h1>');
  await page.evaluate(()=>document.documentElement.replaceChildren());
  assert.equal((await navigation.inspect(page)).ready,false);
 }finally{await page.close()}
});
test('destroyed execution context is retried but unhealthy transport is never swallowed',async()=>{
 const page={browser:()=>({}),evaluate:async()=>{throw Error('Execution context was destroyed, most likely because of a navigation.')}};
 assert.equal((await navigation.inspect(page)).ready,false);
 page.browser=()=>({__ctIsolatedFlow:{proxyRequired:true,rail:{isProxyArmed:false}}});
 await assert.rejects(navigation.inspect(page),/interaction_without_healthy_proxy_turn/);
});
test('real document navigation followed by the full upload introduction continues without replaying clicks',{timeout:20000},async()=>{
 const page=await browser.newPage();let firstClicks=0;
 await page.setRequestInterception(true);
 page.on('request',request=>request.respond({status:200,contentType:'text/html',body:'<!doctype html><main role="main"><h1>Carregar seu documento de identidade</h1><p>Para continuar a vender e enviar mensagens no Marketplace, precisamos de uma foto do seu documento de identidade oficial. Pode ser uma carteira de habilitação, passaporte ou outro tipo de documento de identidade.</p><p>Não aceitamos fotos de telas de computador, telas de celular ou fotocópias. Se houver algum problema, enviaremos um email.</p><div role="button" tabindex="0" aria-label="Carregar documento de identidade" onclick="document.querySelector(\'main\').innerHTML=\'<h1>Carregue uma foto do seu documento</h1><input type=file><button>Carregar</button>\'"><div role="none"><span>Carregar documento de identidade</span><div data-visualcompletion="ignore"></div></div></div></main>'}));
 try{
  await page.setContent('<main role="main"><h1>Confirme sua identidade com um documento</h1><button>Avançar</button></main>');
  await page.exposeFunction('recordFirstClick',()=>firstClicks++);
  await page.evaluate(()=>document.querySelector('button').onclick=()=>{window.recordFirstClick();location.href='https://fixture.invalid/identity'});
  const result=await navigate(page,{stepTimeoutMs:6000});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.screen,'upload_photo');assert.equal(firstClicks,1);
 }finally{await page.close()}
});
