'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function wait(ms,signal){return new Promise((resolve,reject)=>{
 const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(signal.reason||Error('admission_canceled'))};
 const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve()},ms);
 if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
})}
async function run(root,action,{signal,onWait=()=>{},delayMs=1000,alive=pid=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}}}={}){
 fs.mkdirSync(root,{recursive:true});const file=path.join(root,'host-admission.lock'),token=crypto.randomUUID();
 for(;;){
  signal?.throwIfAborted();let handle;
  try{handle=fs.openSync(file,'wx',0o600);fs.writeFileSync(handle,JSON.stringify({pid:process.pid,token}));fs.closeSync(handle);break}
  catch(error){if(handle!==undefined)try{fs.closeSync(handle)}catch{};if(error.code!=='EEXIST')throw error;
   let owner;try{owner=JSON.parse(fs.readFileSync(file,'utf8'))}catch(readError){if(readError.code==='ENOENT')continue;
    try{if(Date.now()-fs.statSync(file).mtimeMs>10000)throw Error('host_admission_marker_unreadable')}catch(statError){if(statError.code==='ENOENT')continue;throw statError}
    onWait({state:'waiting_host_admission'});await wait(delayMs,signal);continue}
   if(Number.isSafeInteger(owner.pid)&&owner.pid>0&&!alive(owner.pid)){
    // Recheck identity immediately before removing a dead worker's marker.
    try{const current=JSON.parse(fs.readFileSync(file,'utf8'));if(current.token===owner.token&&current.pid===owner.pid)fs.unlinkSync(file)}catch(e){if(e.code!=='ENOENT')throw e}
    continue;
   }
   onWait({state:'waiting_host_admission'});await wait(delayMs,signal);
  }
 }
 try{return await action()}finally{
  try{const current=JSON.parse(fs.readFileSync(file,'utf8'));if(current.token===token)fs.unlinkSync(file)}catch(error){if(error.code!=='ENOENT')throw error}
 }
}
module.exports={run};
