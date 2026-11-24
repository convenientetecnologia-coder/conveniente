'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{run}=require('./hostAdmission');
function folder(){return fs.mkdtempSync(path.join(os.tmpdir(),'host-admission-'))}
test('separate worker processes share the same one-pending-admission slot',async()=>{
 const {execFile}=require('node:child_process'),{promisify}=require('node:util'),exec=promisify(execFile),root=folder(),moduleFile=path.join(__dirname,'hostAdmission.js');
 const script=`const fs=require('fs'),path=require('path'),{run}=require(process.argv[2]);(async()=>{for(let i=0;i<4;i++)await run(process.argv[1],async()=>{fs.appendFileSync(path.join(process.argv[1],'events.jsonl'),JSON.stringify({event:'enter',pid:process.pid})+'\\n');await new Promise(r=>setTimeout(r,10));fs.appendFileSync(path.join(process.argv[1],'events.jsonl'),JSON.stringify({event:'exit',pid:process.pid})+'\\n')},{delayMs:2})})().catch(e=>{console.error(e.message);process.exitCode=1})`;
 try{await Promise.all(Array.from({length:3},()=>exec(process.execPath,['-e',script,root,moduleFile],{windowsHide:true,timeout:15000})));
 let active=0,peak=0;for(const line of fs.readFileSync(path.join(root,'events.jsonl'),'utf8').trim().split('\n')){active+=JSON.parse(line).event==='enter'?1:-1;peak=Math.max(peak,active)}assert.equal(peak,1);assert.equal(active,0);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('fifteen account requests from one server produce one outstanding CT admission',async()=>{
 const root=folder();let active=0,peak=0,completed=0;try{
 await Promise.all(Array.from({length:15},()=>run(root,async()=>{peak=Math.max(peak,++active);await new Promise(setImmediate);active--;completed++},{delayMs:2})));
 assert.equal(peak,1);assert.equal(completed,15);assert.equal(fs.existsSync(path.join(root,'host-admission.lock')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('failure releases admission; canceling a waiter never removes the current owner',async()=>{
 const root=folder();try{
 await assert.rejects(run(root,async()=>{throw Error('fixture failure')}),/fixture failure/);
 let release;const owner=run(root,()=>new Promise(r=>release=r));await new Promise(setImmediate);
 const abort=new AbortController();const waiter=run(root,async()=>assert.fail('canceled waiter entered'),{signal:abort.signal,delayMs:2});abort.abort(Error('canceled'));
 await assert.rejects(waiter,/canceled/);assert.equal(fs.existsSync(path.join(root,'host-admission.lock')),true);release();await owner;
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('dead worker marker is recovered without stealing a live owner',async()=>{
 const root=folder();try{fs.writeFileSync(path.join(root,'host-admission.lock'),JSON.stringify({pid:123456,token:'dead'}));assert.equal(await run(root,async()=>42,{alive:()=>false}),42)}finally{fs.rmSync(root,{recursive:true,force:true})}
});
