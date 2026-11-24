'use strict';
function inspect({vehicle=false}={}){
 if(!document.body||document.readyState==='loading')return {ready:false,reason:'document_loading'};
 const text=String(document.body.innerText||'');if(/ERR_(?:INTERNET_DISCONNECTED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|CONNECTION_RESET)/i.test(text))return {ready:false,reason:'browser_network_error'};
 const font=getComputedStyle(document.body).fontFamily.toLowerCase();
 if(/times new roman/.test(font)||![...document.styleSheets].some(s=>!s.disabled))return {ready:false,reason:'styles_unavailable'};
 const file=document.querySelector('input[type="file"][accept*="image"],input[type="file"]');
 const title=[...document.querySelectorAll('input')].find(e=>['Título','Title'].includes(e.getAttribute('aria-label'))||['Título','Title'].includes(e.getAttribute('placeholder')));
 const label=[...document.querySelectorAll('label[role="combobox"],[role="combobox"]')].find(e=>/categoria|category/i.test(e.innerText||e.textContent)||vehicle&&/tipo de ve[ií]culo|vehicle type|\bano\b|\byear\b/i.test(e.innerText||e.textContent));
 const target=title||label;if(!file||!target)return {ready:false,reason:'composer_controls_missing'};
 const r=target.getBoundingClientRect(),s=getComputedStyle(target);
 if(r.width<2||r.height<2||s.display==='none'||s.visibility==='hidden'||target.closest('[aria-busy="true"],[aria-hidden="true"],[inert]'))return {ready:false,reason:'composer_not_mounted'};
 return {ready:true,signature:[location.href,file.isConnected,target.tagName,Math.round(r.width),Math.round(r.height)].join('|')};
}
async function wait(page,{timeoutMs=120000,vehicle=false,...options}={}){
 return require('./interactionReadiness').waitStable(()=>{require('./interactionLease').assert(page);return page.evaluate(inspect,{vehicle})},{timeoutMs,stableMs:1000,pollMs:250,...options,isClosed:()=>page.isClosed?.()===true});
}
async function waitBody(page,{timeoutMs=120000,...options}={}){
 return require('./interactionReadiness').waitStable(()=>{require('./interactionLease').assert(page);return page.evaluate(()=>({ready:!!document.body&&document.readyState!=='loading',signature:location.href}))},{timeoutMs,stableMs:250,pollMs:250,...options,isClosed:()=>page.isClosed?.()===true});
}
module.exports={inspect,wait,waitBody};
