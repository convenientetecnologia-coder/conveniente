'use strict';
class ProxyOpenReadiness {
 constructor({probe,clock=Date.now,recheckMs=15000,onResult=()=>{}}){this.probe=probe;this.clock=clock;this.recheckMs=recheckMs;this.onResult=onResult;this.nextAt=0;this.inflight=null;this.result={ready:false,reason:'checking_transport',at:0}}
 check(){if(!this.inflight&&this.clock()>=this.nextAt){this.nextAt=this.clock()+this.recheckMs;this.inflight=Promise.resolve().then(this.probe).then(value=>{this.result={...value,ready:value?.ready===true,at:this.clock()}}).catch(error=>{this.result={ready:false,reason:String(error.message||error),at:this.clock()}}).finally(()=>{this.inflight=null;try{this.onResult(this.result)}catch{}})}return this.result}
 snapshot(){return {...this.result,checking:!!this.inflight,nextCheckAt:this.nextAt}}
 async settled(){await this.inflight}
}
module.exports={ProxyOpenReadiness};
