'use strict';
async function snapshot(page){return page.evaluate(()=>{
 const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none'};
 const grid=Array.from(document.querySelectorAll('[role="grid"][aria-label]')).find(g=>norm(g.getAttribute('aria-label')).toLowerCase()==='marketplace'&&visible(g));
 if(!grid)return {ready:false,reason:'grid_missing',signature:''};
 const rows=Array.from(grid.querySelectorAll('[role="row"]')).filter(visible),links=Array.from(grid.querySelectorAll('a[href*="/messages/t/"],a[href*="/messages/e2ee/t/"]')).filter(visible);
 const loading=Array.from(grid.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-visualcompletion="loading-state"],[aria-label*="Carregando"],[aria-label*="Loading"]')).filter(visible).length;
 const unmounted=rows.filter(r=>!norm(r.innerText||r.textContent)&&!r.querySelector('a[href*="/messages/"]')).length;
 const text=norm(grid.innerText||grid.textContent).toLowerCase();const empty=/nenhuma (conversa|mensagem)|nao ha conversas|não há conversas|sem mensagens|no (messages|conversations)/.test(text);
 let hash=2166136261;const material=links.map(a=>(a.getAttribute('href')||'')+'|'+norm(a.innerText||a.textContent)).join('\n');for(let n=0;n<material.length;n++)hash=Math.imul(hash^material.charCodeAt(n),16777619);
 const avatarPending=Array.from(grid.querySelectorAll('img')).filter(e=>visible(e)&&(!e.complete||e.naturalWidth===0)).length;
 return {ready:loading===0&&unmounted===0&&(links.length>0||empty),reason:loading?'loading':unmounted?'rows_unmounted':links.length===0&&!empty?'empty_unconfirmed':'ready',rows:rows.length,links:links.length,loading,unmounted,empty,avatarPending,signature:(hash>>>0).toString(16)+':'+rows.length+':'+links.length};
})}
async function wait({probe,network=()=>({}),clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=90000,minimumMs=10000,stableMs=3000,pollMs=500}){
 const start=clock();let stableSince=null,lastSignature=null,last;
 while(clock()-start<=timeoutMs){
  last=await probe();const net=network(),now=clock();const fresh=!net.connectedAt||net.lastNetworkAt>=net.connectedAt;
  if(last.ready&&fresh&&!(net.pending>0)){if(last.signature!==lastSignature)stableSince=now;else if(stableSince===null)stableSince=now;lastSignature=last.signature;
   if(now-start>=minimumMs&&now-stableSince>=stableMs)return {...last,waitedMs:now-start,freshNetwork:fresh,pendingRelevant:net.pending||0};
  }else{stableSince=null;lastSignature=null}
  await sleep(pollMs);
 }
 const error=Error('virtus_inbox_not_settled');error.details={...last,waitedMs:clock()-start};throw error;
}
module.exports={snapshot,wait};
