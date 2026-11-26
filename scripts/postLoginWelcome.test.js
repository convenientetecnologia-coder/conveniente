'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{advance,inspect}=require('./postLoginWelcome');
async function fixture(html,action){
 const browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',r=>r.respond({status:200,contentType:'text/html',body:html}));await page.goto('https://www.facebook.com/login/after/');return await action(page,browser)}finally{await browser.close()}
}
test('Ignore text without a button role and Ignore inside a frame both advance',{timeout:25000},async()=>{
 await fixture('<main></main>',async page=>{
  for(const framed of [false,true]){
   await page.setContent(framed?'<iframe style="width:500px;height:300px"></iframe>':'<div role="none"><span onclick="window.clicked=true;this.remove()">Ignorar</span></div>');
   if(framed)await page.$eval('iframe',e=>e.srcdoc='<div role="none"><span onclick="parent.postMessage(\'done\',\'*\');this.remove()">Ignorar</span></div>');
   await page.evaluate(()=>{window.clicked=false;window.addEventListener('message',()=>window.clicked=true)});
   const result=await advance(page,{timeoutMs:7000,authenticated:()=>page.evaluate(()=>window.clicked===true)});
   assert.equal(result.ok,true,JSON.stringify({framed,result}));assert.equal(result.dismissed,true);
  }
 });
});
test('nested sole Ignore waits for delayed prompt, clicks once, waits for authenticated next screen',{timeout:20000},async()=>{
 await fixture('<p>Carregando</p><script>window.clicks=0;setTimeout(()=>document.body.innerHTML=`<h1>Uma nova etapa</h1><div aria-hidden="true"><button>Ignorar</button></div><div role="button" aria-label="Ignorar" onclick="window.clicks++;document.body.innerHTML=\'Carregando\';setTimeout(()=>document.body.innerHTML=\'<main role=feed>Pronto</main>\',600)"><div role="none"><span>Ignorar</span></div></div>`,600)</script>',async page=>{
  const result=await advance(page,{timeoutMs:8000,authenticated:()=>page.evaluate(()=>!!document.querySelector('[role=feed]'))});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.dismissed,true);assert.equal(await page.evaluate(()=>window.clicks),1);
 });
});
test('English notice and unrelated background buttons cannot block the requested Ignore action',{timeout:15000},async()=>{
 await fixture('<nav><button>Home</button><button>Menu</button></nav><div role="dialog"><h1>Welcome to your account</h1><p>We suspect this might need your attention.</p><div role="button" aria-label="Dismiss this notice" onclick="window.clicked=true;this.parentElement.remove();document.body.insertAdjacentHTML(\'beforeend\',\'<main role=feed>Ready</main>\')"><div role="none"><span>Ignorar</span></div></div></div>',async page=>{
  const result=await advance(page,{timeoutMs:7000,authenticated:()=>page.evaluate(()=>!!document.querySelector('[role=feed]'))});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.dismissed,true);assert.equal(await page.evaluate(()=>window.clicked),true);
 });
});
test('without Ignore, password and code inputs remain with their existing login stage',{timeout:10000},async()=>{
 await fixture('<input type=password><button>Continuar</button>',async page=>{const state=await page.evaluate(inspect);assert.equal(state.hasIgnore,false);assert.equal(state.otherStep,true);assert.equal((await advance(page)).skipped,true)});
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
