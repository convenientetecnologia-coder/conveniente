'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {waitStable,waitControl}=require('./interactionReadiness');
function fixture(probe,{closed=()=>false}={}){let ms=0;return {run:options=>waitStable(()=>probe(ms),{timeoutMs:10000,stableMs:1500,pollMs:250,clock:()=>ms,sleep:async n=>{ms+=n},isClosed:()=>closed(ms),...options}),time:()=>ms}}
test('partially clipped footer button uses its visible hit-tested area instead of an obscured center',{timeout:15000},async()=>{
 const browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.setContent('<div style="position:relative;width:400px;height:100px;overflow:hidden"><button style="position:absolute;top:90px;left:20px;width:250px;height:40px" onclick="window.clicked=true">Avançar</button></div>');
  const result=await require('./interactionReadiness').clickControl(page,['avancar'],{exact:true,timeoutMs:3000,stableMs:200});assert.equal(result.ok,true);assert.equal(await page.evaluate(()=>window.clicked),true);
 }finally{await browser.close()}
});
test('aguarda carregamento lento e estabilidade do alvo sem clicar antes',async()=>{const f=fixture(ms=>ms<5000?{ready:false}:{ready:true,signature:'Enviar'});const r=await f.run();assert.equal(r.ok,true);assert.equal(r.waitedMs,6500)});
test('troca de DOM, bloqueio e erro de contexto reiniciam a janela de estabilidade',async()=>{const f=fixture(ms=>{if(ms===1000)throw Error('context destroyed');if(ms===2500)return {ready:false};return {ready:true,signature:ms<2000?'old':'new'}});assert.equal((await f.run()).waitedMs,4250)});
test('controle nunca pronto falha fechado; browser encerrado interrompe a espera',async()=>{assert.equal((await fixture(()=>({ready:false})).run()).ok,false);assert.equal((await fixture(()=>({ready:true,signature:'a'}),{closed:ms=>ms>=500}).run()).reason,'page_closed')});
test('tempo de CPU bloqueada além do prazo não aprova controle atrasado',async()=>{let ms=0;const r=await waitStable(async()=>{ms+=20000;return {ready:true,signature:'a'}},{timeoutMs:10000,clock:()=>ms,sleep:async n=>{ms+=n}});assert.equal(r.ok,false)});
test('navegador real: ignora botão desabilitado, espera layout estável e overlay sair',{timeout:20000},async()=>{
 const p=require('puppeteer');const b=await p.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await b.newPage();await page.setContent('<button disabled id="b">Enviar</button><div id="cover" style="position:fixed;inset:0;background:white"></div><script>setTimeout(()=>document.querySelector("#b").disabled=false,500);setTimeout(()=>document.querySelector("#cover").remove(),1000)</script>');const r=await waitControl(page,['Enviar'],{exact:true,stableMs:500,timeoutMs:8000,pollMs:100});assert.equal(r.ok,true);assert.ok(r.waitedMs>=1400);assert.equal(await page.evaluate(()=>document.querySelector('#b').disabled),false)}finally{await b.close()}
});

test('real browser: menuitem renewal and hidden duplicate Continue target use the visible stable control',{timeout:25000},async()=>{
 const {clickControl}=require('./interactionReadiness'),p=require('puppeteer'),b=await p.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await b.newPage();await page.setContent('<div aria-hidden="true"><button onclick="window.bad=true">Continuar</button></div><button tabindex="-1" onclick="window.good=true">Continuar</button><div role="menuitem" onclick="window.renew=true" style="width:250px;height:40px">Renovar no Marketplace</div>');
 assert.equal((await clickControl(page,['Continuar'],{exact:true,stableMs:100,timeoutMs:2000,pollMs:50})).ok,true);
 assert.deepEqual(await page.evaluate(()=>({good:window.good===true,bad:window.bad===true})),{good:true,bad:false});
 assert.equal((await clickControl(page,['Renovar no Marketplace'],{exact:true,stableMs:100,timeoutMs:2000,pollMs:50})).ok,true);assert.equal(await page.evaluate(()=>window.renew),true);
 }finally{await b.close()}
});
test('real browser: covered duplicate cannot starve an available target; remounted controls wait again',{timeout:25000},async()=>{
 const {clickControl}=require('./interactionReadiness'),p=require('puppeteer'),b=await p.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await b.newPage();await page.setContent('<button style="position:absolute;top:0;left:0;width:120px;height:40px" onclick="window.bad=true">Continuar</button><div style="position:absolute;top:0;left:0;width:120px;height:40px;background:white;z-index:10"></div><button id="good" style="position:absolute;top:100px" onclick="window.good=true">Continuar</button><script>setTimeout(()=>{const e=document.querySelector("#good");e.replaceWith(e.cloneNode(true))},100)</script>');
 const r=await clickControl(page,['Continuar'],{exact:true,stableMs:300,pollMs:50,timeoutMs:3000});assert.equal(r.ok,true);assert.ok(r.waitedMs>=350);assert.equal(await page.evaluate(()=>window.good===true&&!window.bad),true);
 }finally{await b.close()}
});

test('real browser: a chair lost during the stable-control wait prevents the click',{timeout:20000},async()=>{
 const {clickControl}=require('./interactionReadiness'),p=require('puppeteer'),b=await p.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await b.newPage();await page.setContent('<button onclick="window.clicked=true">Continuar</button>');let healthy=true;
 page.__ctVirtusProxySession={snapshot:()=>({state:healthy?'online':'offline',operationId:'test-chair'}),turn:{lease:{snapshot:()=>({healthy})}}};
 const timer=setTimeout(()=>healthy=false,150);const r=await clickControl(page,['Continuar'],{exact:true,stableMs:600,pollMs:50,timeoutMs:3000});clearTimeout(timer);
 assert.equal(r.ok,false);assert.match(r.reason,/interaction_without_healthy_proxy_turn/);assert.equal(await page.evaluate(()=>window.clicked===true),false);
 }finally{await b.close()}
});
