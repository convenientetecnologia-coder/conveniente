'use strict';
// Wait on an observed, enabled target, not a fixed delay or global network-idle.
// A changed target resets the stability window. Only clickControl performs a click; no reloads or implicit replays.
async function waitStable(probe,{timeoutMs=60000,stableMs=1500,pollMs=250,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),isClosed=()=>false}={}){
 const started=clock();let signature=null,since=0,last=null;
 while(clock()-started<timeoutMs){
  if(isClosed())return {ok:false,reason:'page_closed'};
  try{last=await probe()}catch(error){if(error?.code==='interaction_without_healthy_proxy_turn')return {ok:false,reason:error.message,waitedMs:clock()-started};last=null}
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
 const hidden=el.closest('[aria-hidden="true"]');
 const staleIdentityRoot=hidden?.id==='scrollview'&&/^\/checkpoint\/1501092823525282\//.test(location.pathname)&&!hidden.parentElement?.closest('[aria-hidden="true"]');
 if(el.disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[aria-busy="true"],[aria-disabled="true"],[inert]')||(hidden&&!staleIdentityRoot))return {ready:false};
 const style=getComputedStyle(el);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return {ready:false};
 const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return {ready:false};
 if(r.bottom<0||r.top>=innerHeight||r.right<0||r.left>=innerWidth){el.scrollIntoView({block:'center',inline:'nearest'});return {ready:false}}
 let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
 for(let parent=el.parentElement;parent;parent=parent.parentElement){const ps=getComputedStyle(parent),pr=parent.getBoundingClientRect();if(/hidden|auto|scroll|clip/.test(ps.overflowX)){left=Math.max(left,pr.left+parent.clientLeft);right=Math.min(right,pr.left+parent.clientLeft+parent.clientWidth)}if(/hidden|auto|scroll|clip/.test(ps.overflowY)){top=Math.max(top,pr.top+parent.clientTop);bottom=Math.min(bottom,pr.top+parent.clientTop+parent.clientHeight)}}
 if(right-left<2||bottom-top<2){el.scrollIntoView({block:'center',inline:'nearest'});return {ready:false}}
 const x=(left+right)/2,y=(top+bottom)/2;
 const hit=document.elementFromPoint(x,y);if(!hit||!(hit===el||el.contains(hit)))return {ready:false};
 const registry=window.__ctReadyTargets||(window.__ctReadyTargets={next:0,ids:new WeakMap()});if(!registry.ids.has(el))registry.ids.set(el,++registry.next);
 return {ready:true,x,y,signature:[registry.ids.get(el),location.href,el.tagName,el.getAttribute('aria-label')||el.textContent?.trim().slice(0,160)||'',Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height),Math.round(x),Math.round(y)].join('|')};
}
async function waitElement(page,handle,options={}){
 options={...options,timeoutMs:require('./interactionBudget').timeout(page,options.timeoutMs??60000)};
 return waitStable(()=>{require('./interactionLease').assert(page);return page.evaluate(inspectElement,handle)},{...options,isClosed:()=>page.isClosed?.()===true});
}
async function controlHandle(page,labels,{exact=false,withinDialog=false,excludeSubstrings=[],withinSelector=null}={}){
 require('./interactionLease').assert(page);
 const wanted=(Array.isArray(labels)?labels:[labels]).map(x=>String(x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim()).filter(Boolean);
 return page.evaluateHandle(({wanted,exact,withinDialog,excludeSubstrings,withinSelector})=>{
  const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  const roots=withinSelector?[...document.querySelectorAll(withinSelector)]:withinDialog?[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]'),document]:[document];let offscreen=null;
  const selector='button,[role="button"],[role="menuitem"],a,[role="link"],[role="radio"],[role="option"],input[type="button"],input[type="submit"],div[tabindex="0"]';
  for(const root of roots)for(const el of [...(root.matches?.(selector)?[root]:[]),...root.querySelectorAll(selector)]){
   const a=norm(el.getAttribute('aria-label')),t=norm(el.innerText||el.textContent||el.value);
   if(excludeSubstrings.some(x=>a.includes(norm(x))||t.includes(norm(x)))||!wanted.some(p=>exact?(a===p||t===p):(a.includes(p)||t.includes(p))))continue;
   const r=el.getBoundingClientRect(),style=getComputedStyle(el);
   const hidden=el.closest('[aria-hidden="true"]'),staleIdentityRoot=hidden?.id==='scrollview'&&/^\/checkpoint\/1501092823525282\//.test(location.pathname)&&!hidden.parentElement?.closest('[aria-hidden="true"]');
   if(r.width<2||r.height<2||style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0||el.disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[aria-busy="true"],[aria-disabled="true"],[inert]')||(hidden&&!staleIdentityRoot))continue;
   if(r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth){offscreen=offscreen||el;continue}
   let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
 for(let parent=el.parentElement;parent;parent=parent.parentElement){const ps=getComputedStyle(parent),pr=parent.getBoundingClientRect();if(/hidden|auto|scroll|clip/.test(ps.overflowX)){left=Math.max(left,pr.left+parent.clientLeft);right=Math.min(right,pr.left+parent.clientLeft+parent.clientWidth)}if(/hidden|auto|scroll|clip/.test(ps.overflowY)){top=Math.max(top,pr.top+parent.clientTop);bottom=Math.min(bottom,pr.top+parent.clientTop+parent.clientHeight)}}
   if(right-left<2||bottom-top<2){offscreen=offscreen||el;continue}
   const hit=document.elementFromPoint((left+right)/2,(top+bottom)/2);
   if(hit&&(hit===el||el.contains(hit)))return el;
  }
  if(offscreen){offscreen.scrollIntoView({block:'center',inline:'nearest'});return offscreen}return null;
 },{wanted,exact,withinDialog,excludeSubstrings,withinSelector});
}
async function waitControl(page,labels,{timeoutMs=15000,...options}={}){
 timeoutMs=require('./interactionBudget').timeout(page,timeoutMs);
 return waitStable(async()=>{
  const handle=await controlHandle(page,labels,options);
  try{const el=handle.asElement();return el?await page.evaluate(inspectElement,el):null}finally{await handle.dispose()}
 },{timeoutMs,...options,isClosed:()=>page.isClosed?.()===true});
}
async function clickControl(page,labels,{timeoutMs=15000,...options}={}){
 timeoutMs=require('./interactionBudget').timeout(page,timeoutMs);
 const started=Date.now();let handle=null;
 try{
  // Hold the exact element that became stable; do not re-select a hidden duplicate.
  const result=await waitStable(async()=>{
   if(handle)await handle.dispose();handle=await controlHandle(page,labels,options);
   const el=handle.asElement();return el?await page.evaluate(inspectElement,el):null;
  },{timeoutMs,...options,isClosed:()=>page.isClosed?.()===true});
  if(!result.ok)return result;
  const el=handle?.asElement(),proof=el?await page.evaluate(inspectElement,el):null;if(!proof?.ready)return {ok:false,reason:'control_changed_before_click'};
  require('./interactionLease').assert(page);await page.mouse.click(proof.x,proof.y);return {ok:true,via:'stable_handle',waitedMs:Date.now()-started};
 }catch(error){return {ok:false,reason:'control_click_failed',error:String(error.message||error)}}
 finally{if(handle)await handle.dispose().catch(()=>{})}
}
module.exports={waitStable,waitElement,waitControl,clickControl};
