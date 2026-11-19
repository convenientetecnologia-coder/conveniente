'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'robe.js'),'utf8');
const begin=source.indexOf('async function isLocalizacaoValida(page)'),end=source.indexOf('// —',begin);
function validate({text='Goiânia',invalid=false,disabled=true,icon=false}={}){
 const next={getAttribute:key=>key==='aria-label'?'Avançar':key==='aria-disabled'?String(disabled):null,disabled:false};
 const input={value:text,getAttribute:()=>String(invalid),closest:()=>icon?{nextElementSibling:{querySelector:()=>({})}}:null};
 const document={querySelector:()=>input,querySelectorAll:()=>[next]};
 const fn=vm.runInNewContext(source.slice(begin,end)+'\nisLocalizacaoValida',{document});
 return fn({evaluate:async callback=>callback()});
}
test('texto de localização e ícone não aprovam formulário com Avançar desabilitado',async()=>{
 assert.equal(await validate(),false);assert.equal(await validate({icon:true}),false);
});
test('localização só está pronta quando preenchida, válida e próxima etapa habilitada',async()=>{
 assert.equal(await validate({disabled:false}),true);
 assert.equal(await validate({disabled:false,invalid:true}),false);
 assert.equal(await validate({disabled:false,text:''}),false);
});
