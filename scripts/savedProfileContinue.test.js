'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('saved-profile Continue advances to password with a valid chair; no chair means no click',{timeout:25000},async()=>{
 const b=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await b.newPage();let healthy=true;b.__ctCadastroProxy={snapshot:()=>({healthy})};
 await page.setContent('<div aria-hidden="true"><button onclick="window.wrong=true">Continuar</button></div><h1>Neto Tavares</h1><button tabindex="-1" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<input name=pass type=password>\')">Continuar</button><button onclick="window.wrong=true">Usar outro perfil</button>');
 const {tryClickAymhContinuar}=require('./browser');assert.equal((await tryClickAymhContinuar(page)).ok,true);assert.ok(await page.$('input[name=pass]'));assert.equal(await page.evaluate(()=>window.wrong===true),false);
 assert.equal((await tryClickAymhContinuar(page)).error,'already_has_login_inputs');
 healthy=false;await page.setContent('<button onclick="window.clicked=true">Continuar</button><p>Usar outro perfil</p>');
 const r=await tryClickAymhContinuar(page);assert.equal(r.ok,false);assert.match(r.error,/interaction_without_healthy_proxy_turn/);assert.equal(await page.evaluate(()=>window.clicked===true),false);
 }finally{await b.close()}
});
