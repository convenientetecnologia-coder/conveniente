'use strict';const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{inspectDocument,wait}=require('./virtusMessagesDocument');
test('proxy reply fallback cannot navigate over a loading or broken document; network mode remains unchanged',async()=>{
 const {threadNavigationGuard}=require('./virtusMessagesDocument');let evaluations=0;
 const page={__ctVirtusProxySession:{},evaluate:async()=>{evaluations++;return {ready:false,reason:'document_loading'}}};
 assert.equal((await threadNavigationGuard(page)).allowed,false);
 page.evaluate=async()=>({ready:true});assert.equal((await threadNavigationGuard(page)).allowed,true);
 page.evaluate=async()=>{throw Error('target_lost')};assert.equal((await threadNavigationGuard(page)).allowed,false);
 const direct={evaluate:async()=>{throw Error('must_not_probe_network_mode')}};assert.equal((await threadNavigationGuard(direct)).allowed,true);
 assert.equal(evaluations,1);
});
function probe({heading=true,grid=true,links=2,loading=0,font='Arial',text='Conversas',state='complete',sheets}={}){
 const element={innerText:'Conversas',getAttribute:()=> 'Conversas',getBoundingClientRect:()=>({width:200,height:200})};
 const document={readyState:state,styleSheets:sheets,body:{innerText:text},querySelectorAll:s=>s.startsWith('h1')?(heading?[element]:[]):s.startsWith('[role="grid"')?(grid?[element]:[]):s.startsWith('a[')?Array(links).fill(element):Array(loading).fill(element)};
 return vm.runInNewContext('('+inspectDocument.toString()+')()',{document,getComputedStyle:()=>({fontFamily:font,visibility:'visible',display:'block'})});
}
test('skeleton, splash, missing styles and explicit load failure cannot validate inbox',()=>{
 for(const options of [{heading:false,grid:false,links:0},{loading:3},{font:'Times New Roman'},{text:'Não foi possível carregar as conversas'},{links:0},{state:'loading'}])assert.equal(probe(options).ready,false);
 assert.equal(probe().ready,true);assert.equal(probe({links:0,text:'Conversas Nenhuma conversa'}).ready,true);
});
test('missing or disabled stylesheets fail even when font is Arial',()=>{
 assert.equal(probe({sheets:[]}).reason,'styles_unavailable');
 assert.equal(probe({sheets:[{disabled:true}]}).ready,false);
 assert.equal(probe({sheets:[{disabled:false,ownerNode:{id:'virtus_antiselect_style_v1',sheet:{}}}]}).reason,'styles_unavailable');
 assert.equal(probe({sheets:[{disabled:false}]}).ready,true);
});
test('stalled shell requires full timeout evidence, online browser and cooldown; reload is never success',async()=>{
 const {ensure}=require('./virtusMessagesDocument');let reloads=0,online=true,attempt=0;
 const page={evaluate:async()=>online,reload:async()=>reloads++};
 const fail=(waitedMs,unchangedReasonMs)=>{const e=Error('incomplete');e.details={reason:'messages_shell_incomplete',waitedMs,unchangedReasonMs};return e};
 for(const evidence of [[119999,60000],[120000,29999]])await assert.rejects(ensure({page,probe:async()=>{throw fail(...evidence)}}));
 assert.equal(reloads,0);online=false;
 await assert.rejects(ensure({page,probe:async()=>{throw fail(120000,120000)}}));assert.equal(reloads,0);
 online=true;
 await assert.rejects(ensure({page,clock:()=>1000,probe:async()=>{attempt++;throw fail(120000,120000)}}));
 assert.equal(attempt,2);assert.equal(reloads,1);
 await assert.rejects(ensure({page,clock:()=>2000,probe:async()=>{throw fail(120000,120000)}}));assert.equal(reloads,1);
});
test('Chrome network error never counts as a ready Facebook document',()=>{assert.equal(probe({text:'ERR_INTERNET_DISCONNECTED'}).reason,'browser_network_error')});
test('Chrome error is reloaded only after online switch and only once per recovery window',async()=>{
 const {recoverBrowserError}=require('./virtusMessagesDocument');let online=false,reloads=0;
 const page={evaluate:async()=>({error:true,online}),reload:async()=>reloads++};
 await assert.rejects(recoverBrowserError({page,clock:()=>1000}),/still_offline/);assert.equal(reloads,0);
 online=true;assert.equal((await recoverBrowserError({page,clock:()=>1000})).reloaded,true);assert.equal(reloads,1);
 await assert.rejects(recoverBrowserError({page,clock:()=>2000}),/cooldown/);assert.equal(reloads,1);
 page.evaluate=async()=>({error:false,online:true});assert.equal((await recoverBrowserError({page})).reloaded,false);
});
test('document must remain ready; timeout retains exact failure evidence',async()=>{
 let now=0;const page={evaluate:async()=>({ready:now>=500,reason:'messages_loading'})};
 const ready=await wait({page,clock:()=>now,sleep:async ms=>now+=ms,stableMs:500,timeoutMs:1500});assert.equal(ready.ready,true);assert.equal(now,1000);
 now=0;page.evaluate=async()=>({ready:false,reason:'styles_unavailable'});await assert.rejects(wait({page,clock:()=>now,sleep:async ms=>now+=ms,timeoutMs:500}),e=>e.details.reason==='styles_unavailable');
});
test('reload only repairs proven broken document, is bounded and requires readiness afterwards',async()=>{
 const {ensure}=require('./virtusMessagesDocument');let reloads=0,attempts=0,now=1000;const page={reload:async()=>reloads++};
 const broken=()=>{const e=Error('not_ready');e.details={reason:'styles_unavailable'};return e};
 const result=await ensure({page,clock:()=>now,probe:async()=>{if(++attempts===1)throw broken();return {ready:true}}});assert.equal(result.ready,true);assert.equal(reloads,1);
 await assert.rejects(ensure({page,clock:()=>now+1,probe:async()=>{throw broken()}}));assert.equal(reloads,1);
 const quiet={reload:async()=>reloads++};await assert.rejects(ensure({page:quiet,probe:async()=>{const e=broken();e.details.reason='messages_shell_incomplete';throw e}}));assert.equal(reloads,1);
 now+=600001;await assert.rejects(ensure({page,clock:()=>now,probe:async()=>{throw broken()}}));assert.equal(reloads,2);
});
