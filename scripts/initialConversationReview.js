'use strict';
function shouldReview({fromWaitingRead,firstBootSeed,outsideLookback,messageAt,now,alreadyTracked=false,lookbackMs=12*60*60*1000}){
 const timestamp=Number(messageAt);
 return !alreadyTracked&&!fromWaitingRead&&firstBootSeed===true&&outsideLookback===false&&Number.isFinite(timestamp)&&timestamp>0&&timestamp>=now-lookbackMs&&timestamp<=now+60000;
}
function verifiedTimestamp({original,read,now=Date.now(),lookbackMs=12*60*60*1000}){
 const normalize=t=>String(t||'').replace(/\s+/g,' ').trim();
 const same=original&&normalize(original.text)&&normalize(original.text)===normalize(read?.text);
 const at=Number(same?original.messageAt:read?.message_at);
 return !read?.mine&&!read?.empty&&Number.isFinite(at)&&at>0&&at>=now-lookbackMs&&at<=now?at:null;
}
module.exports={shouldReview,verifiedTimestamp};
