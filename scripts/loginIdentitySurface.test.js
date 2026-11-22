'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./browser'),'utf8');
const start=source.indexOf('async function detectLoginRequired(page)');
const end=source.indexOf('\n/**',start);
const detect=vm.runInNewContext('('+source.slice(start,end)+')',{LR_TWO_FLOOR_OFF:true,isMarketplaceDocCheckpointUrl:()=>false});
function page({text='',raw='',path='/messages',heading='',dialog='',login=false}={}){
 const element=t=>({innerText:t,textContent:t,getAttribute:()=>'',getBoundingClientRect:()=>({width:200,height:80}),offsetWidth:200,offsetHeight:80});
 const document={title:'Facebook',body:{innerText:text,textContent:raw},querySelector:s=>login&&/royal_login_form|input\[name="email"\]|input\[name="pass"\]/.test(s)?element(''):null,querySelectorAll:s=>s.includes('[aria-modal="true"]')?[...(heading?[element(heading)]:[]),...(dialog?[element(dialog)]:[])]:s==='h1,h2,span,div'?(text?[element(text)]:[]):[]};
 const location={href:'https://www.facebook.com'+path,pathname:path};
 return {url:()=>location.href,evaluate:async(fn,arg)=>vm.runInNewContext('('+fn.toString()+')('+JSON.stringify(arg)+')',{document,location,getComputedStyle:()=>({visibility:'visible',display:'block'})})};
}
test('unrendered script/style text is not a selfie checkpoint',async()=>{
 const result=await detect(page({raw:'{"video":true,"styles":"align-self:center"}'}));
 assert.equal(result.loginRequired,false);
});
test('ordinary conversation mentioning selfie and video is not account identity failure',async()=>{
 const result=await detect(page({text:'Conversas A selfie ficou boa. Depois mando outro vídeo.'}));
 assert.equal(result.loginRequired,false);
});
test('explicit visible checkpoint and identity dialog still block',async()=>{
 for(const options of [{path:'/checkpoint/123',text:'Grave uma selfie de vídeo para confirmar sua identidade'},{text:'Grave uma selfie de vídeo',dialog:'Confirme sua identidade'}]){
  const result=await detect(page(options));assert.equal(result.loginRequired,true);assert.equal(result.reason,'identity_confirm_selfie');
 }
});
test('canonical login form remains a real login failure',async()=>{
 const result=await detect(page({path:'/login',text:'Entrar no Facebook E-mail ou telefone Esqueceu a senha?',login:true}));assert.equal(result.loginRequired,true);assert.equal(result.reason,'login_form');
});
