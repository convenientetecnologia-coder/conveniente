'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{submit}=require('./credentialForm');
test('actual credential driver handles Continue, password-only, full form and no-chair without fresh navigation',{timeout:60000},async()=>{
 const browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await browser.newPage();let healthy=true;browser.__ctCadastroProxy={snapshot:()=>({healthy})};
 const form='<form onsubmit="event.preventDefault();window.sent=[this.querySelector(\'[name=email]\')?.value,this.pass.value];this.remove()"><input name=pass type=password><button type=submit>Entrar</button></form>';
 for(const mode of ['continue','password','credentials']){
  const html=mode==='continue'?'<button onclick="document.body.innerHTML=window.fixture">Continuar</button><button onclick="window.wrong=true">Usar outro perfil</button>':mode==='password'?form:form.replace('<input name=pass','<input name=email type=email><input name=pass');
  await page.setContent(html);await page.evaluate(f=>{window.fixture=f;window.sent=null;window.wrong=false},form);let fresh=0;const progress=[];
  const r=await submit(page,{login:'fixture@example.test',password:'fixture-secret',openFresh:async()=>fresh++,onProgress:async e=>progress.push(e),settleMs:1000});assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.entry,mode);assert.equal(fresh,0);assert.equal(await page.evaluate(()=>window.wrong),false);const sent=await page.evaluate(()=>window.sent);assert.equal(sent[1],'fixture-secret');if(mode==='credentials')assert.equal(sent[0],'fixture@example.test');assert.ok(progress.some(e=>e.submitted));
 }
 healthy=false;await page.setContent('<button onclick="window.clicked=true">Continuar</button><p>Usar outro perfil</p>');await assert.rejects(submit(page,{password:'fixture'}),/interaction_without_healthy_proxy_turn/);assert.equal(await page.evaluate(()=>window.clicked===true),false);
 healthy=true;await page.setContent('<input type=password aria-label="PIN">');assert.equal((await submit(page,{password:'fixture'})).error,'messenger_pin_pending');
 await page.setContent('<p>ERR_INTERNET_DISCONNECTED</p>');assert.equal((await submit(page,{password:'fixture'})).error,'login_transport_not_ready');
 }finally{await browser.close()}
});
