'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{submit}=require('./credentialForm');
test('Continue waits through destroyed navigation contexts and delayed password mounting without replay',{timeout:25000},async()=>{
 const browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{
  const page=await browser.newPage();await page.setContent('<p>Usar outro perfil</p><button onclick="window.clicked++;document.body.innerHTML=\'<p>Carregando</p>\';setTimeout(()=>document.body.innerHTML=window.form,1800)">Continuar</button>');
  await page.evaluate(()=>{window.clicked=0;window.sent=0;window.form='<form onsubmit="event.preventDefault();window.sent++;this.replaceWith(document.createTextNode(42))"><input name="pass" type="password"><button type="submit">Entrar</button></form>'});
  const realEvaluate=page.evaluate.bind(page);let transitions=0;
  page.evaluate=async(fn,...args)=>{if(fn.name==='inspect'&&await realEvaluate(()=>window.clicked>0)&&transitions<3){transitions++;throw Error('Execution context was destroyed, most likely because of a navigation.')}return realEvaluate(fn,...args)};
  const events=[];const result=await submit(page,{password:'fixture',timeoutMs:8000,settleMs:2000,onProgress:e=>events.push(e)});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(transitions,3);assert.deepEqual(await realEvaluate(()=>({clicked:window.clicked,sent:window.sent})),{clicked:1,sent:1});assert.ok(events.some(e=>e.stage==='continue_loading'));
 }finally{await browser.close()}
});
test('missing password after Continue times out technically without submitting credentials',{timeout:15000},async()=>{
 const browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.setContent('<p>Usar outro perfil</p><button onclick="document.body.innerHTML=\'<p>Carregando</p>\'">Continuar</button>');const events=[];
 const result=await submit(page,{password:'fixture',timeoutMs:2000,onProgress:e=>events.push(e)});assert.equal(result.ok,false);assert.equal(result.error,'login_form_not_found');assert.equal(events.some(e=>e.submitted),false);
 }finally{await browser.close()}
});
test('actual credential driver handles Continue, password-only, full form and no-chair without fresh navigation',{timeout:60000},async()=>{
 const browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await browser.newPage();let healthy=true;browser.__ctCadastroProxy={snapshot:()=>({healthy})};
 const form='<form onsubmit="event.preventDefault();window.sent=[this.querySelector(\'[name=email]\')?.value,this.pass.value];this.replaceWith(document.createTextNode(42))"><input name=pass type=password><button type=submit>Entrar</button></form>';
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

test('post-submit waits through a loading page and reports an inconclusive timeout without replay', {timeout: 30000}, async () => {
  const browser = await require('puppeteer').launch({headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', args:['--no-sandbox']});
  try {
    const page = await browser.newPage();
    for (const slow of [true, false]) {
      await page.setContent('<form><input type="password"><button type="submit">Entrar</button></form>');
      await page.evaluate(slow => {
        window.clicks = 0;
        document.querySelector('form').onsubmit = event => {
          event.preventDefault();
          window.clicks++;
          document.body.textContent = 'Carregando...';
          if (slow) setTimeout(() => { document.body.textContent = 'Próxima etapa'; }, 700);
        };
      }, slow);
      const result = await submit(page, {password:'fixture', settleMs:slow ? 3000 : 500});
      assert.equal(await page.evaluate(() => window.clicks), 1);
      assert.equal(result.ok, slow);
      if (slow) assert.equal(await page.evaluate(() => document.body.textContent), 'Próxima etapa');
      else assert.equal(result.error, 'login_post_submit_timeout');
    }
  } finally { await browser.close(); }
});
