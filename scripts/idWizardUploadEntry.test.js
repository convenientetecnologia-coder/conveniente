'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('actual wizard reaches attachment from an open upload step without missing helper functions',{timeout:20000},async()=>{
 const browser=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{
  const page=await browser.newPage();await page.setContent('<main role="main"><h1>Documento de identidade</h1><input type="file"><button>Adicionar arquivo</button></main>');
  const original=page.$.bind(page);let uploads=0;
  page.$=async selector=>selector==='input[type="file"]'?{uploadFile:async()=>{uploads++;throw Error('fixture_stop_before_upload')}}:original(selector);
  const result=await require('./robePostPublishId').runIdDocWizard(page,{idPath:__filename,deadlineAt:Date.now()+15000,nome:'fixture-upload-entry',source:'test'});
  assert.equal(uploads,1);assert.equal(result.error,'upload_failed:fixture_stop_before_upload');
 }finally{await browser.close()}
});
