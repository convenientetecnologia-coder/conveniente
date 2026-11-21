'use strict';
function paint({name,label,city}){
 const id='ct-browser-account-identity';
 const caption=[label||name,city].filter(Boolean).join(' · ');
 const mount=()=>{
  if(!document.documentElement)return;
  let badge=document.getElementById(id);
  if(!badge){badge=document.createElement('div');badge.id=id;badge.setAttribute('data-ct-account-identity','1');badge.style.cssText='position:fixed;right:8px;bottom:8px;z-index:2147483646;max-width:340px;padding:5px 9px;border-radius:6px;background:rgba(15,23,42,.9);color:#fff;font:12px Arial,sans-serif;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 5px #0006';document.documentElement.appendChild(badge);}
  badge.textContent=caption;badge.title=name;
 };
 mount();document.addEventListener('DOMContentLoaded',mount,{once:true});
}
async function attach({browser,name,label,city,onError=()=>{}}){
 const payload={name:String(name||'').slice(0,160),label:String(label||'').slice(0,120),city:String(city||'').slice(0,100)};
 const installed=new WeakSet();
 const install=async page=>{if(!page||installed.has(page))return;installed.add(page);try{await page.evaluateOnNewDocument(paint,payload);await page.evaluate(paint,payload);}catch(error){installed.delete(page);onError(error);}};
 await Promise.all((await browser.pages()).map(install));
 browser.on('targetcreated',target=>target.page().then(install).catch(onError));
}
module.exports={paint,attach};
