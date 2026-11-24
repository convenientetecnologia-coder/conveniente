'use strict';const test=require('node:test'),assert=require('node:assert/strict');
const html='<style>body{font-family:Arial}</style><div role="dialog"><h2>Insira seu PIN para restaurar suas conversas</h2><p>Algumas mensagens estão faltando. Insira seu PIN para restaurar o histórico de conversa.</p><input id="mw-numeric-code-input-prevent-composer-focus-steal" type="password" maxlength="6" aria-label="PIN" autocomplete="one-time-code" inputmode="numeric"><a>Esqueceu o PIN?</a></div><input id="other">';
test('real PIN field is not account password; successful entry waits for modal disappearance',{timeout:30000},async()=>{
 process.env.MESSENGER_PIN='123456';const browser=require('./browser'),b=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{b.__ctCadastroProxy={snapshot:()=>({healthy:true})};const page=await b.newPage();await page.setContent(html);
 assert.equal((await browser.classifyFacebookLoginSurface(page)).kind,'messenger_pin');
 await page.evaluate(()=>document.querySelector('input[aria-label=PIN]').addEventListener('input',e=>{if(e.target.value.length===6){window.accepted=e.target.value==='123456';document.querySelector('[role=dialog]').remove()}}));
 const result=await browser.tryDismissMessengerPinModal(page,{maxTries:1});assert.equal(result.ok,true);assert.equal(result.dismissed,true);assert.equal(await page.evaluate(()=>window.accepted),true);
 }finally{await b.close();delete process.env.MESSENGER_PIN}
});
test('focus stolen during PIN typing stops before sending the remaining digits to another field',{timeout:25000},async()=>{
 process.env.MESSENGER_PIN='123456';const browser=require('./browser'),b=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{b.__ctCadastroProxy={snapshot:()=>({healthy:true})};const page=await b.newPage();await page.setContent(html);
 await page.evaluate(()=>document.querySelector('input[aria-label=PIN]').addEventListener('input',e=>{if(e.target.value.length===2)document.querySelector('#other').focus()}));
 const result=await browser.tryDismissMessengerPinModal(page,{maxTries:1});assert.equal(result.ok,false);assert.equal(result.error,'pin_input_focus_or_value_changed');assert.equal(await page.$eval('#other',e=>e.value),'');assert.equal(await page.$eval('input[aria-label=PIN]',e=>e.value.length),2);
 }finally{await b.close();delete process.env.MESSENGER_PIN}
});
