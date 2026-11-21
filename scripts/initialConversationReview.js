'use strict';
function shouldReview({fromWaitingRead,firstBootSeed,outsideLookback,messageAt,now,lookbackMs=12*60*60*1000}){
 const timestamp=Number(messageAt);
 return !fromWaitingRead&&firstBootSeed===true&&outsideLookback===false&&Number.isFinite(timestamp)&&timestamp>0&&timestamp>=now-lookbackMs&&timestamp<=now+60000;
}
module.exports={shouldReview};
