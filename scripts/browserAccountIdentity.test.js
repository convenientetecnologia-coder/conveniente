'use strict';const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{paint,attach}=require('./browserAccountIdentity');
test('account badge uses plain text, survives repeat mounting and never blocks clicks',()=>{
 const els=new Map(),root={appendChild:e=>els.set(e.id,e)},document={documentElement:root,getElementById:id=>els.get(id),createElement:()=>({style:{},setAttribute(){}}),addEventListener(){}};
 const fn=vm.runInNewContext('('+paint.toString()+')',{document});fn({name:'account-id',label:'<img onerror=bad>',city:'Aracaju'});fn({name:'account-id',label:'Tadeu',city:'Aracaju'});
 assert.equal(els.size,1);const badge=[...els.values()][0];assert.equal(badge.textContent,'Tadeu · Aracaju');assert.equal(badge.title,'account-id');assert.match(badge.style.cssText,/pointer-events:none/);
});
test('identity installs locally for existing and future pages without navigation or proxy acquisition',async()=>{
 const calls=[];let created;const page=()=>({evaluateOnNewDocument:async(_fn,p)=>calls.push(['new',p]),evaluate:async(_fn,p)=>calls.push(['current',p])});
 await attach({browser:{pages:async()=>[page()],on:(_e,fn)=>created=fn},name:'id',label:'Osvaldo',city:'Florianópolis'});created({page:async()=>page()});await new Promise(setImmediate);assert.equal(calls.length,4);assert.equal(calls[0][1].name,'id');assert.deepEqual(Object.keys(calls[0][1]).sort(),['city','label','name']);
});
