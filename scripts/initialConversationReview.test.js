'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{shouldReview}=require('./initialConversationReview');
test('recent customer message on first account boot requests conversation verification rather than historical dismissal',()=>{const now=1800000000000;assert.equal(shouldReview({fromWaitingRead:false,firstBootSeed:true,outsideLookback:false,messageAt:now-4*3600000,now}),true)});
test('old, future, invalid, already reviewed or non-bootstrap events do not create replay loops',()=>{const now=1800000000000,base={fromWaitingRead:false,firstBootSeed:true,outsideLookback:false,messageAt:now-1000,now};for(const patch of [{fromWaitingRead:true},{firstBootSeed:false},{outsideLookback:true},{messageAt:now-13*3600000},{messageAt:now+120000},{messageAt:null},{messageAt:'invalid'}])assert.equal(shouldReview({...base,...patch}),false)});
test('persisted conversation state prevents first-boot review after restart',()=>{assert.equal(shouldReview({firstBootSeed:true,outsideLookback:false,messageAt:1799999999000,now:1800000000000,alreadyTracked:true}),false)});
test('Neto production timestamps qualify once, expire normally and remain blocked by persisted state',()=>{
 const now=1795274590927,messageAt=1795258929975,base={firstBootSeed:true,outsideLookback:false,messageAt,now};
 assert.equal(shouldReview(base),true);
 assert.equal(shouldReview({...base,alreadyTracked:true}),false);
 assert.equal(shouldReview({...base,now:messageAt+12*3600000+1}),false);
});
test('re-reading never rejuvenates an old message or invents a missing timestamp',()=>{
 const {verifiedTimestamp}=require('./initialConversationReview'),now=1800000000000,original={text:'oi',messageAt:now-4*3600000},read={text:'oi',mine:false,empty:false,message_at:null};
 assert.equal(verifiedTimestamp({original,read,now}),original.messageAt);
 assert.equal(verifiedTimestamp({original,read,now:now+9*3600000}),null);
 assert.equal(verifiedTimestamp({original,read:{...read,text:'outra'},now}),null);
 assert.equal(verifiedTimestamp({original,read:{...read,mine:true},now}),null);
 assert.equal(verifiedTimestamp({read,now}),null);
});
