'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {waitStable,waitControl}=require('./interactionReadiness');
function fixture(probe,{closed=()=>false}={}){let ms=0;return {run:options=>waitStable(()=>probe(ms),{timeoutMs:10000,stableMs:1500,pollMs:250,clock:()=>ms,sleep:async n=>{ms+=n},isClosed:()=>closed(ms),...options}),time:()=>ms}}
test('aguarda carregamento lento e estabilidade do alvo sem clicar antes',async()=>{const f=fixture(ms=>ms<5000?{ready:false}:{ready:true,signature:'Enviar'});const r=await f.run();assert.equal(r.ok,true);assert.equal(r.waitedMs,6500)});
test('troca de DOM, bloqueio e erro de contexto reiniciam a janela de estabilidade',async()=>{const f=fixture(ms=>{if(ms===1000)throw Error('context destroyed');if(ms===2500)return {ready:false};return {ready:true,signature:ms<2000?'old':'new'}});assert.equal((await f.run()).waitedMs,4250)});
test('controle nunca pronto falha fechado; browser encerrado interrompe a espera',async()=>{assert.equal((await fixture(()=>({ready:false})).run()).ok,false);assert.equal((await fixture(()=>({ready:true,signature:'a'}),{closed:ms=>ms>=500}).run()).reason,'page_closed')});
test('tempo de CPU bloqueada além do prazo não aprova controle atrasado',async()=>{let ms=0;const r=await waitStable(async()=>{ms+=20000;return {ready:true,signature:'a'}},{timeoutMs:10000,clock:()=>ms,sleep:async n=>{ms+=n}});assert.equal(r.ok,false)});
test('navegador real: ignora botão desabilitado, espera layout estável e overlay sair',{timeout:20000},async()=>{
 const p=require('puppeteer');const b=await p.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await b.newPage();await page.setContent('<button disabled id="b">Enviar</button><div id="cover" style="position:fixed;inset:0;background:white"></div><script>setTimeout(()=>document.querySelector("#b").disabled=false,500);setTimeout(()=>document.querySelector("#cover").remove(),1000)</script>');const r=await waitControl(page,['Enviar'],{exact:true,stableMs:500,timeoutMs:8000,pollMs:100});assert.equal(r.ok,true);assert.ok(r.waitedMs>=1400);assert.equal(await page.evaluate(()=>document.querySelector('#b').disabled),false)}finally{await b.close()}
});
