'use strict';
class Activity {
 constructor({clock=Date.now,activeMs=60*60*1000,replyWaitMs=15000}={}){this.clock=clock;this.activeMs=activeMs;this.replyWaitMs=replyWaitMs;this.lastInboundAt=0;this.lastReplyAt=0;this.waitUntil=0}
 incoming(at){const now=this.clock();if(!Number.isFinite(at)||at<=this.lastInboundAt||at>now+5000||now-at>this.activeMs)return false;this.lastInboundAt=at;this.waitUntil=now+this.replyWaitMs;return true}
 replied(){this.lastReplyAt=this.clock();this.waitUntil=0}
 complete(){this.waitUntil=0;this.lastInboundAt=0}
 snapshot(){const now=this.clock();return {engaged:this.lastInboundAt>0&&now-this.lastInboundAt<this.activeMs,hotUntil:this.lastInboundAt?this.lastInboundAt+this.activeMs:0,lastInboundAt:this.lastInboundAt,lastReplyAt:this.lastReplyAt,waitUntil:this.waitUntil,waitingBriefly:now<this.waitUntil}}
}
module.exports={Activity};
