'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {openAndChoose}=require('./renewActionsMenu'),renew=require('./marketplaceRenewListings');
let browser;
test.before(async()=>{browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']})});
test.after(async()=>browser?.close());
async function fixture(label,{standalone=false,disabled=false,delay=50}={}){
 const page=await browser.newPage();await page.setContent('<button onclick="window.wrong=true">Configurações</button><button id=actions>Ações</button><button onclick="window.wrong=true">Renovar</button><div id=portal></div>');
 await page.evaluate(({label,standalone,disabled,delay})=>{
  window.opens=0;window.renewed=0;document.querySelector('#actions').onclick=()=>{window.opens++;setTimeout(()=>{
   document.querySelector('#portal').innerHTML=(standalone?'':'<div role=menu>')+'<div role=menuitem aria-hidden=true>'+label+'</div><div id=renew role=menuitem tabindex=0 '+(disabled?'aria-disabled=true':'')+'>'+label+'</div>'+(standalone?'':'</div>');
   document.querySelector('#renew').onclick=()=>{window.renewed++;document.querySelector('#portal').innerHTML='<h1>Renovar classificados</h1>'};
  },delay)};
 },{label,standalone,disabled,delay});return page;
}
test('exact action labels do not click Configurações',async()=>{
 const page=await fixture('Renovar no Marketplace');try{assert.equal((await renew.clickByLabels(page,['Ações'],{timeoutMs:3000,exactOnly:true})).ok,true);assert.equal(await page.evaluate(()=>window.wrong===true),false);assert.equal(await page.evaluate(()=>window.opens),1)}finally{await page.close()}
});
for(const label of ['Renovar no Marketplace','Renovar classificados','Renovar','Renew on Marketplace','Renew listings'])test('chooses the active menu option: '+label,{timeout:10000},async()=>{
 const page=await fixture(label);try{const result=await openAndChoose(page,{timeoutMs:8000});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(await page.evaluate(()=>({opens:window.opens,renewed:window.renewed,wrong:!!window.wrong})),{opens:1,renewed:1,wrong:false})}finally{await page.close()}
});
test('standalone menuitem is a valid scoped click root',{timeout:10000},async()=>{
 const page=await fixture('Renovar',{standalone:true});try{assert.equal((await openAndChoose(page,{timeoutMs:8000})).ok,true);assert.equal(await page.evaluate(()=>window.renewed),1)}finally{await page.close()}
});
test('disabled option never becomes a successful renewal or a claimed zero eligible result',{timeout:10000},async()=>{
 const page=await fixture('Renovar no Marketplace',{disabled:true});try{const result=await openAndChoose(page,{timeoutMs:3000});assert.equal(result.ok,false);assert.equal(result.error,'renew_option_disabled');assert.equal(await page.evaluate(()=>window.renewed),0)}finally{await page.close()}
});
test('menu loading is awaited without toggling Actions twice',{timeout:10000},async()=>{
 const page=await fixture('Renovar no Marketplace',{delay:2000});try{assert.equal((await openAndChoose(page,{timeoutMs:8000})).ok,true);assert.equal(await page.evaluate(()=>window.opens),1)}finally{await page.close()}
});
test('lost chair prevents opening Actions',async()=>{
 const page=await fixture('Renovar no Marketplace');browser.__ctIsolatedFlow={proxyRequired:true,rail:{isProxyArmed:true,operationSnapshot:()=>({healthy:false})}};
 try{await assert.rejects(openAndChoose(page,{timeoutMs:3000}),/interaction_without_healthy_proxy_turn/);assert.equal(await page.evaluate(()=>window.opens),0)}finally{delete browser.__ctIsolatedFlow;await page.close()}
});
