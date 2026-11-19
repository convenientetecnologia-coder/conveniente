'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('mede Avançar e Publicar separadamente e preserva ordem do fluxo',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'robe.js'),'utf8'),a=source.indexOf('async function clickFlowExactRetry('),b=source.indexOf('// --- O PATCH PRINCIPAL',a);
 const events=[],clicks=[],actions=[{kind:'avancar',handle:'next'},{kind:'publicar',handle:'publish'}];let n=0;
 const rail={trafficSnapshot:()=>({proxyUp:n++,proxyDown:100})};
 const run=vm.runInNewContext(source.slice(a,b)+'\nclickFlowExactRetry',{dismissListingError:async()=>{},dismissOpenListbox:async()=>{},findFooterAction:async()=>actions.shift(),clickOnce:async(_p,h)=>clicks.push(h),sleep:async()=>{},stepLog:{appendJSONL:(_n,_f,row)=>events.push(row)}});
 const result=await run({browser:()=>({__ctRobeRail:rail})},'fixture');
 assert.deepEqual(clicks,['next','publish']);assert.equal(result.publishClicked,true);
 assert.deepEqual(events.map(e=>e.action),['avancar','publicar']);assert.equal(events[1].sequence[0],'avancar');assert.equal(events[0].traffic.proxyUp,0);assert.equal(events[1].traffic.proxyUp,1);
});
