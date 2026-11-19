'use strict';
const {isPhotoUploadUrl}=require('./mobilePublishProxy');

function photoConfirmation(status, text) {
  if (status < 200 || status >= 300) return {ok:false,reason:'photo_http_'+status};
  let data;
  try { data=JSON.parse(String(text).replace(/^for\s*\(;;\);?\s*/,'')); }
  catch { return {ok:false,reason:'photo_invalid_response'}; }
  let photoId=null,rejected=false,visited=0;
  function visit(node,parent='',depth=0) {
    if (!node || typeof node!=='object' || depth>18 || ++visited>15000) return;
    if (node.error || (Array.isArray(node.errors)&&node.errors.length)) rejected=true;
    for (const [key,value] of Object.entries(node)) {
      if ((/^(photo_?id|fbid)$/i.test(key) || (key==='id'&&/photo/i.test(parent))) && /^\d+$/.test(String(value))) photoId=String(value);
      visit(value,key,depth+1);
    }
  }
  visit(data);
  if (rejected) return {ok:false,reason:'photo_server_rejected'};
  return photoId ? {ok:true,photoId,status} : {ok:false,reason:'photo_id_unconfirmed'};
}

// Passive observation: native file input uploads the file. Never replay a POST,
// reload the page, or treat HTTP 200 / a local thumbnail as server confirmation.
function watchPhotoUpload(page,{timeoutMs=300000}={}) {
  const start=Date.now();
  let settled=false,validating=false,timer;
  let resolve;
  const result=new Promise(done=>{resolve=done;});
  function finish(value) {
    if(settled)return;
    settled=true;clearTimeout(timer);
    page.off('response',response);page.off('close',closed);
    resolve({...value,waitedMs:Date.now()-start});
  }
  const closed=()=>finish({ok:false,reason:'photo_page_closed'});
  async function response(res) {
    try {
      if(settled||validating||res.request().method()!=='POST'||!isPhotoUploadUrl(res.url()))return;
      const confirmation=photoConfirmation(res.status(),await res.text());
      if(settled)return;
      if(!confirmation.ok){finish(confirmation);return;}
      validating=true;
      const handle=await page.waitForFunction(()=>{
        const loaded=img=>img.complete&&img.naturalWidth>0;
        if(Array.from(document.images).some(img=>loaded(img)&&String(img.src||'').startsWith('blob:')))return true;
        return Array.from(document.querySelectorAll('[aria-label]')).some(el=>{
          if(!/remover foto|remove photo/i.test(el.getAttribute('aria-label')||''))return false;
          for(let p=el,i=0;p&&i<8;i++,p=p.parentElement)if(Array.from(p.querySelectorAll('img')).some(loaded))return true;
          return false;
        });
      },{timeout:Math.max(1,timeoutMs-(Date.now()-start))});
      await handle.dispose?.();
      finish({...confirmation,preview:true});
    } catch {
      if(validating)finish({ok:false,reason:'photo_preview_unconfirmed'});
      // A failed response body can precede the browser's own upload retry.
    }
  }
  page.on('response',response);page.once('close',closed);
  timer=setTimeout(()=>finish({ok:false,reason:'photo_upload_timeout'}),timeoutMs);
  return {wait:()=>result,cancel:()=>finish({ok:false,reason:'photo_upload_canceled'})};
}
module.exports={photoConfirmation,watchPhotoUpload};
