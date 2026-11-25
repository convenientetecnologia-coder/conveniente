'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),notice=require('./metaAccountArrivalNotice');
const title='Sua Conta Meta chegou',description='Sua conta atualizada funciona nos apps e dispositivos da Meta, facilitando o login, o controle das configurações e a proteção das suas informações.';
const html=({heading=title,copy=description,close='document.querySelector("[role=dialog]").remove()',disabled=false}={})=>`<button onclick="window.wrong=true">×</button><div role="dialog"><h2>${heading}</h2><p>${copy}</p><button aria-label="Fechar" tabindex="-1" ${disabled?'disabled':''} onclick='${close}'><svg width="24" height="24"></svg></button><button onclick="window.wrong=true">Ver as novidades</button></div>`;
test('Meta notice closes only its own X, requires disappearance, and preserves security dialogs',{timeout:35000},async()=>{
 const b=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const p=await b.newPage();let healthy=true;b.__ctCadastroProxy={snapshot:()=>({healthy})};
  await p.setContent(html());assert.equal((await notice.dismiss(p)).closed,true);assert.equal(await p.evaluate(()=>window.wrong===true),false);
  for(const heading of ['Confirme sua identidade','Insira seu PIN para restaurar suas conversas','Sua Conta Meta precisa de confirmação']){await p.setContent(html({heading}));assert.equal((await notice.dismiss(p)).present,false);assert.ok(await p.$('[role=dialog]'));}
  await p.setContent(html({disabled:true}));assert.equal((await notice.dismiss(p)).closed,false);
  await p.setContent(html({close:'window.clicked=true'}));assert.equal((await notice.dismiss(p,{confirmMs:200})).closed,false);assert.equal(await p.evaluate(()=>window.clicked),true);
  await p.setContent(html());healthy=false;await assert.rejects(notice.dismiss(p),/interaction_without_healthy_proxy_turn/);assert.ok(await p.$('[role=dialog]'));
  healthy=true;setTimeout(()=>healthy=false,150);const lost=await notice.dismiss(p,{timeoutMs:2000});assert.equal(lost.closed,false);assert.ok(await p.$('[role=dialog]'));
  healthy=true;await p.setContent(html());const browser={detectAccountSuspended:async()=>({banned:false}),detectCaptchaChallenge:async()=>({ok:true,present:false}),detectVirtusIdentityBlock:async()=>({blocked:false}),detectLoginRequired:async()=>({loginRequired:false}),detectMessengerPinModal:async()=>({present:false})};const result=await require('./virtusOnlineHealth').check(p,{browser});assert.equal(result.ok,true);assert.equal(await p.$('[role=dialog]'),null);
 }finally{await b.close()}
});
