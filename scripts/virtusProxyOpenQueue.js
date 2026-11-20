'use strict';
// A bounded set of independent starts, not a barrier for the whole batch.
class ProxyOpeningCoordinator {
 constructor({limit=2,clock=Date.now,cooldownMs=30000,maxFailures=1000,onResult=()=>{}}={}){if(!Number.isInteger(limit)||limit<1||limit>8)throw Error('invalid_open_limit');this.limit=limit;this.clock=clock;this.cooldownMs=cooldownMs;this.maxFailures=maxFailures;this.onResult=onResult;this.running=new Map();this.failures=new Map()}
 canStart(name){return !this.running.has(name)&&this.running.size<this.limit&&(this.failures.get(name)||0)<=this.clock()}
 start(name,action){if(!this.canStart(name))return false;
  const task=Promise.resolve().then(action).then(result=>{if(result?.ok===false)throw Error(result.error||'proxy_open_failed');this.failures.delete(name);return result}).catch(error=>{this.failures.delete(name);this.failures.set(name,this.clock()+this.cooldownMs);while(this.failures.size>this.maxFailures)this.failures.delete(this.failures.keys().next().value);return {ok:false,error:String(error.message||error)}}).then(result=>{try{this.onResult(name,result)}catch{}return result}).finally(()=>this.running.delete(name));
  this.running.set(name,task);return true;
 }
 snapshot(){return {running:Array.from(this.running.keys()),limit:this.limit,cooling:this.failures.size}}
 async settled(){await Promise.all(this.running.values())}
}
function readyMayRunDuringBatch({proxy,kind,owner}={}){return !!proxy&&(kind==='open_all_map'||(!kind&&/^open_all_map:/i.test(String(owner||''))))}
module.exports={ProxyOpeningCoordinator,readyMayRunDuringBatch};
