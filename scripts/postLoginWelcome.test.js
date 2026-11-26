'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{advance,inspect}=require('./postLoginWelcome');
async function fixture(html,action){
 const browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',r=>r.respond({status:200,contentType:'text/html',body:html}));await page.goto('https://www.facebook.com/login/after/');return await action(page,browser)}finally{await browser.close()}
}
test('nested sole Ignore waits for delayed prompt, clicks once, waits for authenticated next screen',{timeout:20000},async()=>{
 await fixture('<p>Carregando</p><script>window.clicks=0;setTimeout(()=>document.body.innerHTML=`<h1>Uma nova etapa</h1><div aria-hidden="true"><button>Ignorar</button></div><div role="button" aria-label="Ignorar" onclick="window.clicks++;document.body.innerHTML=\'Carregando\';setTimeout(()=>document.body.innerHTML=\'<main role=feed>Pronto</main>\',600)"><div role="none"><span>Ignorar</span></div></div>`,600)</script>',async page=>{
  const result=await advance(page,{timeoutMs:8000,authenticated:()=>page.evaluate(()=>!!document.querySelector('[role=feed]'))});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.dismissed,true);assert.equal(await page.evaluate(()=>window.clicks),1);
 });
});
test('unrecognized competing action, password, security notice and old automation warning are never clicked',{timeout:15000},async()=>{
 await fixture('<div></div>',async page=>{
  for(const html of ['<button>Ignorar</button><button>Salvar</button>','<input type=password><button>Ignorar</button>','<p>Confirme sua identidade</p><button>Ignorar</button>','<p>Suspeitamos que o comportamento da sua conta seja automatizado</p><button>Ignorar</button>']){
   await page.setContent(html);const state=await page.evaluate(inspect);assert.ok(state.blocked||!state.soleIgnore);
  }
 });
});
test('unchanged Ignore after click is unconfirmed and never automatically clicked twice',{timeout:15000},async()=>{
 await fixture('<h1>Mais uma etapa</h1><button onclick="window.clicks=(window.clicks||0)+1">Ignorar</button>',async page=>{
  const result=await advance(page,{timeoutMs:3000,authenticated:async()=>true});assert.equal(result.ok,false);assert.equal(result.error,'login_welcome_result_unconfirmed');assert.equal(await page.evaluate(()=>window.clicks),1);
 });
});
test('unhealthy chair blocks the page inspection before any click',async()=>{
 const page={browser:()=>({__ctIsolatedFlow:{proxyRequired:true,rail:{isProxyArmed:false,operationSnapshot:()=>({healthy:false,closed:true})}}}),evaluate:()=>{throw Error('must_not_touch')}};
 await assert.rejects(advance(page),/interaction_without_healthy_proxy_turn/);
});
