'use strict';
async function restore({browser,health,prepare}){
 const pages=await browser.pages(),page=pages.find(p=>/facebook\.com\/messages|messenger\.com/.test(p.url()))||pages.find(p=>/facebook\.com/.test(p.url()))||pages[0];
 if(!page)return {ok:false,error:'human_resume_page_missing'};
 require('./interactionLease').assert(page);
 const checked=await health(page);if(!checked?.ok)return {ok:false,error:'human_resume_blocked:'+String(checked?.reason||checked?.state||'unconfirmed')};
 if(!/facebook\.com\/messages(?:\/|\?|$)|messenger\.com\//.test(page.url())){require('./interactionLease').assert(page);await page.goto('https://www.facebook.com/messages/',{waitUntil:'domcontentloaded',timeout:120000});}
 require('./interactionLease').assert(page);const result=await prepare(page,()=>health(page));require('./interactionLease').assert(page);
 if(result?.ok!==true||!['marketplace_ready','marketplace_absent'].includes(result.state))return {ok:false,error:'human_resume_inbox_unconfirmed',details:result||null};
 return {ok:true,state:result.state,verifiedAt:Date.now()};
}
module.exports={restore};
