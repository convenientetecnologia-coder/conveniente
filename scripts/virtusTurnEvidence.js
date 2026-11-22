'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const ROOT=path.join(__dirname,'../dados/perfis'),LIMIT=48;
async function record(account,trace,{root=ROOT}={}){
 if(typeof account!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(account))throw Error('invalid_evidence_account');
 const file=path.join(root,account,'virtus_turn_history.json');
 let rows=[];try{if((await fs.stat(file)).size<=128*1024){const old=JSON.parse(await fs.readFile(file,'utf8'));if(Array.isArray(old))rows=old.slice(-(LIMIT-1))}}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error}
 const safe={};for(const key of ['intent','requestedAt','acquiredAt','operationId','provedAt','actionEndedAt','outcome','reason','checkConfirmed','endedAt','up','down'])if(trace[key]!==undefined){const v=trace[key];safe[key]=typeof v==='string'?v.slice(0,180):typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)?v:null;}
 rows.push(safe);await fs.mkdir(path.dirname(file),{recursive:true});
 const temp=file+'.'+process.pid+'.tmp';try{await fs.writeFile(temp,JSON.stringify(rows));await fs.rename(temp,file)}finally{await fs.unlink(temp).catch(()=>{})}
 return rows.length;
}
module.exports={record,LIMIT};
