'use strict';
// One account's persistent browser; all remote capacity belongs to the CT lease.
class VirtusTurn {
 constructor({acquire,rail,prove,clock=Date.now,onState=()=>{},onTrace=async()=>{},beforeDisconnect=async()=>{}}){this.acquire=acquire;this.rail=rail;this.prove=prove;this.clock=clock;this.onState=onState;this.onTrace=onTrace;this.beforeDisconnect=beforeDisconnect;this.state='offline';this.closed=false;this.tail=Promise.resolve();this.lease=null;this.lastCheckedAt=0;this.lastTurn=null;this.failure=null;this.abort=new AbortController();}
 snapshot(){return {state:this.state,lastCheckedAt:this.lastCheckedAt,lastTurn:this.lastTurn?{...this.lastTurn}:null,failure:this.failure,operationId:this.lease?.operationId||null,offlinePlanned:!this.closed&&this.state!=='online',traffic:this.rail.trafficSnapshot()}}
 set(state){this.state=state;this.onState(this.snapshot())}
 cancelWaitingObservation(){if(this.state==='waiting'&&!this.lease&&['warm','observe','engaged'].includes(this.currentIntent))this.currentAbort?.abort(Error('virtus_observation_superseded_by_human'));}
 run(intent,action,{signal,lease:borrowedLease}={}){
  if(this.closed)return Promise.reject(Error('virtus_turn_closed'));
  const task=this.tail.catch(()=>{}).then(async()=>{
   if(this.closed)throw Error('virtus_turn_closed');this.lastTurn={intent,requestedAt:this.clock(),outcome:'waiting'};const trafficBefore=this.rail.trafficSnapshot();this.set('waiting');
   const localAbort=new AbortController();this.currentAbort=localAbort;this.currentIntent=intent;
   const combined=AbortSignal.any([this.abort.signal,localAbort.signal,...(signal?[signal]:[])]);
   try{
    combined.throwIfAborted();this.lease=borrowedLease||await this.acquire({intent,signal:combined});
    this.lastTurn.acquiredAt=this.clock();this.lastTurn.operationId=this.lease.operationId||null;this.lastTurn.outcome='acquired';
    if(this.closed)throw Error('virtus_turn_closed');combined.throwIfAborted();
    this.rail.flip(this.lease.hop);await this.prove();this.lastTurn.provedAt=this.clock();this.lastTurn.outcome='working';
    if(this.lease.snapshot().healthy===false)throw Error('virtus_transport_unhealthy');
    combined.throwIfAborted();
    this.set('online');let healthTimer;
    try{
      const unhealthy=new Promise((_,reject)=>{healthTimer=setInterval(()=>{
        if(this.lease?.snapshot().healthy===false){this.closed=true;this.rail.flip(null);reject(Error('virtus_transport_lost_during_turn'))}
      },250);healthTimer.unref?.()});
      const result=await Promise.race([Promise.resolve().then(()=>action(this.lease)),unhealthy]);
      this.lastTurn.actionEndedAt=this.clock();this.lastTurn.outcome=result?.ok===false?'incomplete':'action_completed';this.lastTurn.reason=result?.reason||result?.state||null;this.failure=result?.ok===false?String(this.lastTurn.reason||'visit_incomplete'):null;
      if(['warm','observe','engaged'].includes(intent)&&result?.ok===true){this.lastCheckedAt=this.clock();this.lastTurn.checkConfirmed=true;}return result;
    }finally{clearInterval(healthTimer)}

   }catch(error){this.failure=String(error.message||error);this.lastTurn.outcome='failed';this.lastTurn.reason=this.failure;throw error}
   finally{
    // Disconnect browser sockets BEFORE releasing the seat. No direct fallback.
    try{await this.beforeDisconnect()}catch(error){this.failure=String(error.message||error)}finally{this.rail.flip(null);this.set('releasing')}
    try{if(this.lease)await this.lease.close()}
    catch(error){this.failure=String(error.message||error);this.lastTurn.outcome='release_unconfirmed';this.lastTurn.reason=this.failure;this.closed=true;this.set('blocked');throw error}
    finally{this.lease=null;this.lastTurn.endedAt=this.clock();const after=this.rail.trafficSnapshot();this.lastTurn.up=Math.max(0,(after.proxyUp||0)-(trafficBefore.proxyUp||0));this.lastTurn.down=Math.max(0,(after.proxyDown||0)-(trafficBefore.proxyDown||0));if(this.state!=='blocked')this.set(this.closed?'closed':'offline');try{await this.onTrace({...this.lastTurn})}catch{}}
   }
  });this.tail=task.catch(()=>{});return task;
 }
 async close(){this.closed=true;this.abort.abort(Error('virtus_turn_closed'));this.rail.flip(null);await this.tail;await this.rail.close();this.set('closed')}
}
module.exports={VirtusTurn};
