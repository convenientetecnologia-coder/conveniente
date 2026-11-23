'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(require.resolve('./browser'),'utf8').replace(/\r/g,''),start=source.indexOf('function readSuspendedDocument()'),end=source.indexOf('\nasync function detectAccountSuspended',start);
function probe({text='',raw='',path='/messages/t/123',heading='',hidden=false,social=true}={}){
 const node=t=>({innerText:t,getBoundingClientRect:()=>({width:200,height:80}),closest:()=>null});
 const document={title:'Facebook',body:{innerText:text,textContent:raw},querySelectorAll:s=>s==='h1,h2,span,div'?[node(text)]:s.includes('[role="feed"]')?(social?[node('Conversas')]:[]):heading?[node(heading)]:[]};
 return vm.runInNewContext('('+source.slice(start,end)+')()',{document,location:{href:'https://web.facebook.com'+path,pathname:path},getComputedStyle:()=>({display:hidden?'none':'block',visibility:'visible'})});
}
test('chat or feed quoting suspension text cannot ban an account',()=>{
 assert.equal(probe({text:'Sua conta foi suspensa. Não está visível no Facebook'}).hit,false);
 assert.equal(probe({text:'Sua conta foi suspensa',path:'/',social:true}).hit,false);
 assert.equal(probe({raw:'Sua conta foi suspensa',text:''}).hit,false);
});
test('visible account restriction and explicit disabled checkpoint still block',()=>{
 assert.equal(probe({text:'Desabilitamos sua conta',heading:'Desabilitamos sua conta',path:'/index.php',social:false}).hit,true);
 assert.equal(probe({text:'Sua conta foi suspensa',path:'/checkpoint/123',social:false}).hit,true);
 assert.equal(probe({path:'/checkpoint/disabled',text:'',social:false}).hit,true);
 assert.equal(probe({text:'Desabilitamos sua conta',heading:'Desabilitamos sua conta',path:'/index.php',social:false,hidden:true}).hit,false);
});
test('suspension checks run on the official web Facebook host',async()=>{
 const begin=source.indexOf('async function detectAccountSuspended('),finish=source.indexOf('\n  return { banned: false };\n}',begin)+'\n  return { banned: false };\n}'.length;
 const fn=vm.runInNewContext('('+source.slice(begin,finish)+')',{URL,require:n=>require(n),isMarketplaceDocCheckpointUrl:()=>false,readSuspendedDocument(){},setTimeout});
 let probes=0;const result=await fn({url:()=> 'https://web.facebook.com/checkpoint/disabled',evaluate:async()=>{probes++;return {hit:true,disabledCheckpoint:true}}});assert.equal(result.banned,true);assert.equal(probes,1);
});
