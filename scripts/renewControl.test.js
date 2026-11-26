'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'marketplaceRenewListings.js'),'utf8');
function extract(name,next,context={}){
 const start=source.indexOf('async function '+name+'('),end=source.indexOf(next,start);
 return vm.runInNewContext(source.slice(start,end)+'\n'+name,{require,Date,...context});
}
test('renew modal ignores background countdown and clicks visible nested control, never hidden duplicate',{timeout:20000},async()=>{
 const browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  await page.setContent('<main><span id="timer"></span><button onclick="window.bad=true">Renovar</button></main><div aria-label="Renovar classificados" role="dialog" aria-modal="true" style="position:fixed;inset:30px;background:white"><h2>Renovar classificados</h2><h3>4 classificados serão renovados</h3><div aria-hidden="true"><div role="button" aria-label="Renovar" aria-disabled="true" tabindex="-1" onclick="window.bad=true">Renovar</div></div><button onclick="window.bad=true">Cancelar</button><div aria-label="Renovar" role="button" tabindex="0" onclick="window.good=(window.good||0)+1" style="position:absolute;bottom:10px;right:10px;width:200px;height:40px"><div role="none"><span>Renovar</span><div role="none" data-visualcompletion="ignore" style="position:absolute;inset:0"></div></div></div></div>');
  await page.evaluate(()=>{window.timer=setInterval(()=>document.querySelector('#timer').textContent=String(Date.now()),30)});
  const stable=extract('waitRenewScreenStable','\n/**',{now:Date.now,sleep:ms=>new Promise(r=>setTimeout(r,ms)),progress:async()=>{},safeEvaluate:(p,fn)=>p.evaluate(fn),RENEW_READY_STABLE_MS:200,RENEW_SCREEN_WAIT_MS:3000});
  assert.equal((await stable(page,{timeoutMs:3000})).ok,true);
  const click=extract('clickRenewConfirmInDialog','async function clickRenewConfirm(');
  assert.equal((await click(page)).ok,true);
  assert.deepEqual(await page.evaluate(()=>({good:window.good,bad:!!window.bad})),{good:1,bad:false});
 }finally{await browser.close()}
});
test('uncertain final click is not replayed',async()=>{
 let calls=0;
 const fn=extract('clickRenewConfirm','async function waitBackToSelling(',{
  now:Date.now,progress:async()=>{},postRenewProcessTimeoutMs:()=>100,postRenewMinProcessMs:()=>0,
  clickRenewConfirmInDialog:async()=>{calls++;return {ok:false,attempted:true,reason:'control_click_failed'}}
 });
 const result=await fn({});assert.equal(result.ok,false);assert.equal(result.clicked,true);assert.equal(calls,1);
});

test('renew full page clicks the nested enabled footer and ignores disabled Cancel and hidden Renew', {timeout:25000}, async () => {
 const browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try {
  const page=await browser.newPage();
  const click=extract('clickRenewConfirmInDialog','async function clickRenewConfirm(');
  for (const role of ['role="main"','']) {
   await page.setContent('<section '+role+'><h2>Renovar classificados</h2><p>4 classificados serão renovados</p><div aria-hidden="true"><div role="button" aria-label="Renovar" onclick="window.bad=true">Renovar</div></div><div role="button" aria-label="Renovar" tabindex="0" style="width:200px;height:40px;position:relative" onclick="window.good=(window.good||0)+1"><div role="none"><span>Renovar</span><div style="position:absolute;inset:0"></div></div></div><div aria-hidden="true"><div aria-disabled="true" role="button" aria-label="Cancelar" tabindex="-1" onclick="window.bad=true">Cancelar</div></div></section>');
   await page.evaluate(()=>{window.good=0;window.bad=false});
   assert.equal((await click(page)).ok,true);
   assert.deepEqual(await page.evaluate(()=>({good:window.good,bad:window.bad})),{good:1,bad:false});
  }
  await page.setContent('<main><h2>Renovar classificados</h2><button onclick="window.bad=true">Renovar</button></main><div role="dialog">Outra ação</div>');
  assert.equal((await click(page)).reason,'renew_screen_not_ready');
  assert.equal(await page.evaluate(()=>!!window.bad),false);
 } finally { await browser.close(); }
});
