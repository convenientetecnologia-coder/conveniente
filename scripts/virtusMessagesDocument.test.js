'use strict';const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{inspectDocument,wait}=require('./virtusMessagesDocument');
function probe({heading=true,grid=true,links=2,loading=0,font='Arial',text='Conversas',state='complete'}={}){
 const element={innerText:'Conversas',getAttribute:()=> 'Conversas',getBoundingClientRect:()=>({width:200,height:200})};
 const document={readyState:state,body:{innerText:text},querySelectorAll:s=>s.startsWith('h1')?(heading?[element]:[]):s.startsWith('[role="grid"')?(grid?[element]:[]):s.startsWith('a[')?Array(links).fill(element):Array(loading).fill(element)};
 return vm.runInNewContext('('+inspectDocument.toString()+')()',{document,getComputedStyle:()=>({fontFamily:font,visibility:'visible',display:'block'})});
}
test('skeleton, splash, missing styles and explicit load failure cannot validate inbox',()=>{
 for(const options of [{heading:false,grid:false,links:0},{loading:3},{font:'Times New Roman'},{text:'Não foi possível carregar as conversas'},{links:0},{state:'loading'}])assert.equal(probe(options).ready,false);
 assert.equal(probe().ready,true);assert.equal(probe({links:0,text:'Conversas Nenhuma conversa'}).ready,true);
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
