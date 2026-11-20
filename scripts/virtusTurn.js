'use strict';
// One account's persistent browser; all remote capacity belongs to the CT lease.
class VirtusTurn {
 constructor({acquire,rail,prove,clock=Date.now,onState=()=>{},beforeDisconnect=async()=>{}}){this.acquire=acquire;this.rail=rail;this.prove=prove;this.clock=clock;this.onState=onState;this.beforeDisconnect=beforeDisconnect;this.state='offline';this.closed=false;this.tail=Promise.resolve();this.lease=null;this.lastCheckedAt=0;this.failure=null;this.abort=new AbortController();}
 snapshot(){return {state:this.state,lastCheckedAt:this.lastCheckedAt,failure:this.failure,operationId:this.lease?.operationId||null,offlinePlanned:!this.closed&&this.state!=='online',traffic:this.rail.trafficSnapshot()}}
 set(state){this.state=state;this.onState(this.snapshot())}
 run(intent,action){
  if(this.closed)return Promise.reject(Error('virtus_turn_closed'));
  const task=this.tail.catch(()=>{}).then(async()=>{
   if(this.closed)throw Error('virtus_turn_closed');this.set('waiting');
   try{
    this.lease=await this.acquire({intent,signal:this.abort.signal});
    if(this.closed)throw Error('virtus_turn_closed');
    this.rail.flip(this.lease.hop);await this.prove();
    if(this.lease.snapshot().healthy===false)throw Error('virtus_transport_unhealthy');
    this.set('online');let healthTimer;
    try{
      const unhealthy=new Promise((_,reject)=>{healthTimer=setInterval(()=>{
        if(this.lease?.snapshot().healthy===false){this.closed=true;this.rail.flip(null);reject(Error('virtus_transport_lost_during_turn'))}
      },250);healthTimer.unref?.()});
      const result=await Promise.race([Promise.resolve().then(()=>action(this.lease)),unhealthy]);
      if(['observe','engaged'].includes(intent)&&result?.ok!==false)this.lastCheckedAt=this.clock();return result;
    }finally{clearInterval(healthTimer)}

   }catch(error){this.failure=String(error.message||error);throw error}
   finally{
    // Disconnect browser sockets BEFORE releasing the seat. No direct fallback.
    try{await this.beforeDisconnect()}catch(error){this.failure=String(error.message||error)}finally{this.rail.flip(null);this.set('releasing')}
    try{if(this.lease)await this.lease.close()}
    catch(error){this.failure=String(error.message||error);this.closed=true;this.set('blocked');throw error}
    finally{this.lease=null;if(this.state!=='blocked')this.set(this.closed?'closed':'offline')}
   }
  });this.tail=task.catch(()=>{});return task;
 }
 async close(){this.closed=true;this.abort.abort(Error('virtus_turn_closed'));this.rail.flip(null);await this.tail;await this.rail.close();this.set('closed')}
}
module.exports={VirtusTurn};
