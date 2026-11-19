'use strict';
// One bounded visit; absence is a result, never an invitation to click forever.
async function visit({ready,active,visible,click,settled,sleep=ms=>new Promise(r=>setTimeout(r,ms)),clock=Date.now,presenceMs=10000,activationMs=45000,pollMs=250}){
 await ready();if(await active()){await settled();return {ok:true,state:'marketplace_ready',clicked:false};}
 const presenceUntil=clock()+presenceMs;let found=await visible();
 while(!found&&clock()<presenceUntil){await sleep(pollMs);found=await visible()}
 if(!found)return {ok:true,state:'marketplace_absent',clicked:false};
 await click();const until=clock()+activationMs;let stable=0;
 while(clock()<until){if(await active()){if(++stable>=2){await settled();return {ok:true,state:'marketplace_ready',clicked:true}}}else stable=0;await sleep(pollMs)}
 throw Error('virtus_marketplace_activation_unconfirmed');
}
module.exports={visit};
