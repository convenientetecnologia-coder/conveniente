'use strict';
// Human time starts after a verified grant. Renewal never changes the CT's hard deadline.
class HumanProxyLease {
 constructor({run,beforeEnter=()=>{},notify=()=>{},holding=()=>{},lease=()=>null,state=()=>'',spanMs=300000,clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){Object.assign(this,{run,beforeEnter,notify,holding,lease,state,spanMs,clock,setTimer,clearTimer});this.current=null;this.serial=Promise.resolve();this.last={state:'idle'};}
 status(){const c=this.current,now=this.clock(),s=this.lease()?.snapshot();return {supported:true,...this.last,...(c?{state:c.resuming?'resuming':c.startedAt&&this.state()==='online'&&s?.healthy===true?'online':'waiting',requestedAt:c.requestedAt,startedAt:c.startedAt||null,expiresAt:c.expiresAt||null,absoluteDeadline:s?.absoluteDeadline?s.absoluteDeadline*1000:null,remainingMs:c.expiresAt?Math.max(0,c.expiresAt-now):0}:{}),serverNow:now};}
 changed(){this.notify(this.status());}
 arm(c){this.clearTimer(c.timer);const hard=this.lease()?.snapshot()?.absoluteDeadline;const until=hard?hard*1000-3000:Infinity;c.expiresAt=Math.min(this.clock()+this.spanMs,until);if(c.expiresAt<=this.clock())throw Error('human_proxy_deadline_reached');c.timer=this.setTimer(()=>{c.expired=true;c.resolveGate();},c.expiresAt-this.clock());c.timer?.unref?.();this.changed();}
 enter(){if(this.current)return this.current.ready;return this.start();}
 start(){
  this.beforeEnter();this.holding(true);let resolveReady,rejectReady,resolveGate;
  const c={requestedAt:this.clock(),cancel:new AbortController(),ready:new Promise((r,j)=>{resolveReady=r;rejectReady=j}),gate:new Promise(r=>resolveGate=r)};c.resolveGate=resolveGate;this.current=c;this.last={state:'waiting'};this.changed();
  c.task=Promise.resolve().then(()=>this.run(async()=>{c.startedAt=this.clock();this.arm(c);resolveReady(this.status());await c.gate;if(c.resumeAction){c.resuming=true;this.changed();return c.resumeAction(this.lease());}return {ok:true,humanFinished:true};},{signal:c.cancel.signal}));
  c.task.then(()=>{},rejectReady).finally(()=>{this.clearTimer(c.timer);c.resolveGate();if(this.current===c){this.current=null;this.last={state:c.expired?'expired':'idle',expiresAt:c.expiresAt||null};this.holding(false);this.changed();}}).catch(()=>{});
  c.ready.catch(()=>{});return c.ready;
 }
 async stop(){const c=this.current;if(!c){this.holding(false);return;}this.clearTimer(c.timer);c.cancel.abort(Error('virtus_human_canceled'));c.resolveGate();try{await c.task}catch(e){if(e.message!=='virtus_human_canceled')throw e}finally{if(this.current===c)this.current=null;this.holding(false);this.changed();}}
 serialize(fn){const task=this.serial.catch(()=>{}).then(fn);this.serial=task.catch(()=>{});return task;}
 renew(){return this.serialize(async()=>{const c=this.current,s=this.lease()?.snapshot();if(c?.startedAt&&!c.expired&&this.state()==='online'&&s?.healthy===true&&!c.resuming){const hard=s.absoluteDeadline?s.absoluteDeadline*1000-3000:Infinity;if(hard-this.clock()>=Math.min(30000,this.spanMs)){this.arm(c);return {ok:true,...this.status()};}}await this.stop();this.start();return {ok:true,...this.status()};});}
 leave(){this.resumeCancel?.abort(Error('virtus_human_canceled'));return this.serialize(()=>this.stop());}
 resume(validate){return this.serialize(async()=>{
  if(typeof validate!=='function')throw Error('human_resume_validation_required');const c=this.current,s=this.lease()?.snapshot();
  if(c?.startedAt&&this.state()==='online'&&s?.healthy===true){this.clearTimer(c.timer);c.resumeAction=validate;c.resuming=true;c.resolveGate();return await c.task;}
  await this.stop();this.holding(true);this.last={state:'resuming'};this.resumeCancel=new AbortController();this.changed();try{return await this.run(validate,{signal:this.resumeCancel.signal})}finally{this.resumeCancel=null;this.holding(false);this.last={state:'idle'};this.changed();}
 });}
}
module.exports={HumanProxyLease};
