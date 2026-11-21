'use strict';
// Leave room for initial navigation, bounded document repair and inbox settlement.
// This remains below the ten-minute Virtus lease; failure still closes and releases.
function install({browser,session,timeoutMs=360000,setTimer=setTimeout,clearTimer=clearTimeout,onError=()=>{}}){
 let fired=false;
 const timer=setTimer(()=>{
  if(fired||session.snapshot().startupFinished)return;fired=true;
  try{session.noteInbox({ok:false,state:'startup_timeout'});}catch(error){onError(error)}
  // Close the browser even when session cleanup fails: a closed proxy session must not leave a blank Chrome alive.
  const sessionClosing=Promise.resolve().then(()=>session.close()).catch(onError);
  const browserClosing=Promise.resolve().then(async()=>{if(browser.isConnected?.()!==false)await browser.close();}).catch(onError);
  Promise.allSettled([sessionClosing,browserClosing]).catch(onError);
 },timeoutMs);
 timer.unref?.();browser.once('disconnected',()=>clearTimer(timer));return timer;
}
module.exports={install};
