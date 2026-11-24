'use strict';
function outsideInbox(url){
 try{const u=new URL(url);return /(^|\.)facebook\.com$/.test(u.hostname)&&/^\/(?:index\.php|home\.php)?\/?$/.test(u.pathname)}catch{return false}
}
async function restore({page,healthCheck,onRecovery=()=>{}}){
 if(!outsideInbox(page.url()))return {navigated:false};
 // Never bypass an account restriction or navigate an unrelated work tab.
 if(typeof healthCheck!=='function')throw Error('virtus_inbox_route_health_required');
 const health=await healthCheck(page);
 if(!health?.ok)return {navigated:false,blocked:health};
 onRecovery({reason:'messages_route_lost',fromPath:new URL(page.url()).pathname});
 require('./interactionLease').assert(page);await page.goto('https://www.facebook.com/messages/',{waitUntil:'domcontentloaded',timeout:120000});
 return {navigated:true};
}
module.exports={outsideInbox,restore};
