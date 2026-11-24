'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('real composer waits for styles and mounted controls; splash and browser error never approve',{timeout:20000},async()=>{
 const b=await require('puppeteer').launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
 try{const page=await b.newPage(),{wait}=require('./composerReadiness');
 await page.setContent('<body>Facebook from Meta<script>setTimeout(()=>{document.body.insertAdjacentHTML("beforeend",\'<input type="file" style="display:none"><input aria-label="Título">\')},300);setTimeout(()=>{const s=document.createElement("style");s.textContent="body{font-family:Arial}";document.head.append(s)},800)</script></body>');
 const r=await wait(page,{timeoutMs:4000,stableMs:400,pollMs:100});assert.equal(r.ok,true);assert.ok(r.waitedMs>=1100);
 await page.setContent('<style>body{font-family:Arial}</style><body>ERR_INTERNET_DISCONNECTED<input type="file"><input aria-label="Título"></body>');assert.equal((await wait(page,{timeoutMs:300,stableMs:100,pollMs:50})).ok,false);
 await page.setContent('<style>body{font-family:Arial}</style><body>Facebook from Meta</body>');assert.equal((await wait(page,{timeoutMs:300,stableMs:100,pollMs:50})).ok,false);
 }finally{await b.close()}
});
test('composer detects a lost chair without touching the DOM',async()=>{
 let evaluated=0;const page={browser:()=>({__ctVirtusProxy:{snapshot:()=>({state:'offline'})}}),evaluate:async()=>{evaluated++}};
 const r=await require('./composerReadiness').wait(page);assert.equal(r.ok,false);assert.equal(evaluated,0);assert.match(r.reason,/interaction_without_healthy_proxy_turn/);
});
