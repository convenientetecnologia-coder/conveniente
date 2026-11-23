'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./worker'),'utf8');
const start=source.indexOf('let cadastroRetryBusy = false;'),end=source.indexOf('async function resumeOneCadastro',start);
function fixture(perfis,extra={}){
 const calls=[],context={readJsonFile:()=>({perfis}),desiredPath:'fixture',provisionLock:{isActive:()=>false},require:()=>require('./accountProvisioningState'),controllers:new Map(),robeMeta:{},inShard:n=>n.startsWith('own'),setImmediate:fn=>calls.push(fn),resumeOneCadastro:async()=>{},...extra};
 const kick=vm.runInNewContext(source.slice(start,end)+'\nkickCadastroRetry',context);return {kick,calls};
}
test('an active profile in another worker cannot starve this worker signup queue',()=>{
 const f=fixture({own_pending:{provisioningPending:true},other_active:{active:true}});f.kick();f.kick();assert.equal(f.calls.length,1);
});
test('an actual opening in this worker still runs before signup',()=>{
 const f=fixture({own_pending:{provisioningPending:true},own_opening:{active:true}});f.kick();assert.equal(f.calls.length,0);
});
test('signup pending on an otherwise idle worker is work, not idle shutdown',()=>{
 const begin=source.indexOf('    const hasOpenIntent = (() => {',source.indexOf('async function nurseTick'));
 const finish=source.indexOf('    if (controllers.size === 0)',begin);
 const check=perfis=>vm.runInNewContext(source.slice(begin,finish)+'\nhasOpenIntent',{desired0:{perfis},autoOpenEnabled:false,inShard:n=>n.startsWith('own')});
 assert.equal(check({own_pending:{provisioningPending:true}}),true);assert.equal(check({other_pending:{provisioningPending:true}}),false);assert.equal(check({}),false);
});
