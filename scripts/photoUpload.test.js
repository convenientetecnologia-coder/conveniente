'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {photoConfirmation,watchPhotoUpload}=require('./photoUpload');
test('HTTP200 e miniatura local não provam upload sem photoID confirmado pelo servidor',()=>{
  for(const body of ['<html>erro</html>','{}','{"payload":{}}','{"error":1357054,"payload":{"photoID":"123"}}','{"errors":[{}]}'])assert.equal(photoConfirmation(200,body).ok,false);
  assert.equal(photoConfirmation(503,'{"payload":{"photoID":"123"}}').ok,false);
  assert.deepEqual(photoConfirmation(200,'for (;;);{"payload":{"photoID":"123456789"}}'),{ok:true,photoId:'123456789',status:200});
});
test('somente POST de upload com resposta válida e prévia pronta permite avançar',async()=>{
  const page=new EventEmitter();let previewReady,waits=0;
  page.waitForFunction=async()=>{waits++;await new Promise(done=>{previewReady=done;});return {dispose:async()=>{}};};
  const watch=watchPhotoUpload(page,{timeoutMs:2000});
  const response=method=>({request:()=>({method:()=>method}),url:()=> 'https://upload.facebook.com/ajax/react_composer/attachments/photo/upload',status:()=>200,text:async()=>'{"payload":{"photoID":"123456789"}}'});
  page.emit('response',response('OPTIONS'));await new Promise(setImmediate);assert.equal(waits,0);
  let finished=false;const result=watch.wait().then(value=>{finished=true;return value;});
  page.emit('response',response('POST'));await new Promise(setImmediate);
  assert.equal(waits,1);assert.equal(finished,false);
  previewReady();assert.equal((await result).ok,true);assert.equal(page.listenerCount('response'),0);
});
test('timeout, fechamento e cancelamento não geram falso positivo nem deixam listeners',async()=>{
  for(const mode of ['timeout','close','cancel']){
    const page=new EventEmitter(),watch=watchPhotoUpload(page,{timeoutMs:20});
    if(mode==='close')page.emit('close');
    if(mode==='cancel')watch.cancel();
    const result=await watch.wait();assert.equal(result.ok,false);assert.equal(page.listenerCount('response'),0);assert.equal(page.listenerCount('close'),0);
  }
});

test('prévia remota no sexto nível do cartão é reconhecida após photoID confirmado',async()=>{
 const page=new EventEmitter(),image={complete:true,naturalWidth:482,src:'https://cdn.example/photo.jpg'};
 const nodes=Array.from({length:6},(_,i)=>({getAttribute:()=>i===0?'Remover foto 1 de 1':'',querySelectorAll:()=>i===5?[image]:[]}));
 nodes.forEach((n,i)=>n.parentElement=nodes[i+1]||null);
 page.waitForFunction=async fn=>{const previous=global.document;try{global.document={images:[image],querySelectorAll:()=>[nodes[0]]};assert.equal(fn(),true);return {dispose:async()=>{}}}finally{global.document=previous}};
 const watch=watchPhotoUpload(page,{timeoutMs:1000});
 page.emit('response',{request:()=>({method:()=>'POST'}),url:()=>'https://upload.facebook.com/ajax/react_composer/attachments/photo/upload',status:()=>200,text:async()=>'{"payload":{"photoID":"123456789"}}'});
 assert.equal((await watch.wait()).preview,true);
});
