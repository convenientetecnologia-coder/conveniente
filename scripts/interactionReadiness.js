'use strict';
// Wait on an observed, enabled target, not a fixed delay or global network-idle.
// No clicks/reloads/replays here. A changed target resets the stability window.
async function waitStable(probe,{timeoutMs=60000,stableMs=1500,pollMs=250,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),isClosed=()=>false}={}){
 const started=clock();let signature=null,since=0,last=null;
 while(clock()-started<timeoutMs){
  if(isClosed())return {ok:false,reason:'page_closed'};
  try{last=await probe()}catch{last=null}
  const stamp=clock();
  if(last?.ready&&last.signature){
   if(last.signature!==signature){signature=last.signature;since=stamp}
   if(stamp-since>=stableMs&&stamp-started<timeoutMs)return {ok:true,waitedMs:stamp-started};
  }else{signature=null;since=0}
  await sleep(Math.min(pollMs,Math.max(0,timeoutMs-(clock()-started))));
 }
 return {ok:false,reason:'control_not_stable',waitedMs:clock()-started};
}
function inspectElement(el){
 if(document.readyState==='loading'||!document.body||!el||!el.isConnected)return {ready:false};
 if(el.disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[aria-busy="true"],[aria-disabled="true"],[aria-hidden="true"],[inert]'))return {ready:false};
 const style=getComputedStyle(el);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return {ready:false};
 const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return {ready:false};
 if(r.bottom<0||r.top>=innerHeight||r.right<0||r.left>=innerWidth){el.scrollIntoView({block:'center',inline:'nearest'});return {ready:false}}
 const x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2));
 const hit=document.elementFromPoint(x,y);if(!hit||!(hit===el||el.contains(hit)))return {ready:false};
 const registry=window.__ctReadyTargets||(window.__ctReadyTargets={next:0,ids:new WeakMap()});if(!registry.ids.has(el))registry.ids.set(el,++registry.next);
 return {ready:true,signature:[registry.ids.get(el),location.href,el.tagName,el.getAttribute('aria-label')||el.textContent?.trim().slice(0,160)||'',Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)].join('|')};
}
async function waitElement(page,handle,options={}){
 return waitStable(()=>page.evaluate(inspectElement,handle),{...options,isClosed:()=>page.isClosed?.()===true});
}
async function waitControl(page,labels,{exact=false,withinDialog=false,timeoutMs=15000,...options}={}){
 const wanted=(Array.isArray(labels)?labels:[labels]).map(x=>String(x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim()).filter(Boolean);
 if(!wanted.length)return {ok:false,reason:'no_labels'};
 const probe=async()=>{
  const handle=await page.evaluateHandle(({wanted,exact,withinDialog})=>{
   const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
   const roots=withinDialog?[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]'),document]:[document];
   for(const root of roots)for(const el of root.querySelectorAll('button,[role="button"],a,[role="link"],[role="radio"],[role="option"],div[tabindex="0"]')){
    const a=norm(el.getAttribute('aria-label')),t=norm(el.innerText||el.textContent);if(!wanted.some(p=>exact?(a===p||t===p):(a.includes(p)||t.includes(p))))continue;
    const r=el.getBoundingClientRect(),style=getComputedStyle(el);if(r.width<2||r.height<2||style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0||el.disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[aria-busy="true"],[aria-disabled="true"],[inert]'))continue;
    return el;
   }return null;
  },{wanted,exact,withinDialog});
  try{const el=handle.asElement();return el?await page.evaluate(inspectElement,el):null}finally{await handle.dispose()}
 };
 return waitStable(probe,{timeoutMs,...options,isClosed:()=>page.isClosed?.()===true});
}
module.exports={waitStable,waitElement,waitControl};
