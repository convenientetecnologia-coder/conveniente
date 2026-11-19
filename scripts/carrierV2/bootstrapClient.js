'use strict';
const fs=require('node:fs'),path=require('node:path');
let cached=null,until=0,pending=null;
async function load(){
 const {readCtConfig}=require('../ctConfig');const c=readCtConfig();
 const secret=String(c?.logIngestSecret||process.env.LOG_INGEST_SECRET||'').trim();
 let hostId='';try{hostId=fs.readFileSync(path.join(__dirname,'../../dados/.telemetry_hostid'),'utf8').trim()}catch{}
 if(!secret||!hostId)throw Error('cp2_bootstrap_credentials_missing');
 const response=await fetch('https://api.convenientetecnologia.com/api/carrier-v2/bootstrap',{method:'POST',headers:{'content-type':'application/json','x-log-secret':secret},body:JSON.stringify({hostId}),signal:AbortSignal.timeout(10000)});
 const data=await response.json();
 if(!response.ok||data.ok!==true)throw Error(data.error||'cp2_bootstrap_failed');
 if(data.baseUrl!=='https://api.convenientetecnologia.com/api/carrier-v2'||typeof data.token!=='string'||data.token.length<32||!Array.isArray(data.eligiblePhoneIds)||!data.eligiblePhoneIds.length||data.eligiblePhoneIds.some(id=>!['p001','p002'].includes(id)))throw Error('cp2_bootstrap_invalid');
 return {enabled:true,baseUrl:data.baseUrl,token:data.token,eligiblePhoneIds:data.eligiblePhoneIds,heartbeatMs:10000};
}
async function read(){if(Date.now()<until)return cached;if(pending)return pending;pending=load().then(value=>{cached=value;until=Date.now()+30000;return value}).finally(()=>{pending=null});return pending}
module.exports={read};
