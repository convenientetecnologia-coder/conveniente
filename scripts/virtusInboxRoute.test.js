'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{restore,outsideInbox}=require('./virtusInboxRoute');
test('confirmed healthy account outside inbox navigates to messages instead of reloading index',async()=>{
 const calls=[],page={url:()=> 'https://web.facebook.com/index.php',goto:async(url,opts)=>calls.push({url,opts})};
 const result=await restore({page,healthCheck:async()=>({ok:true}),onRecovery:r=>calls.push(r)});
 assert.equal(result.navigated,true);assert.equal(calls[0].reason,'messages_route_lost');assert.equal(calls[1].url,'https://www.facebook.com/messages/');
});
test('login wall or missing health proof never navigates',async()=>{
 const page={url:()=> 'https://www.facebook.com/index.php',goto:async()=>{throw Error('must_not_navigate')}};
 assert.equal((await restore({page,healthCheck:async()=>({ok:false,state:'login'})})).blocked.state,'login');
 await assert.rejects(restore({page}),/health_required/);
});
test('messages, posting, checkpoints and external pages are not rerouted',async()=>{
 for(const url of ['https://www.facebook.com/messages/','https://www.facebook.com/messages/t/123','https://www.facebook.com/marketplace/create/item','https://www.facebook.com/checkpoint/123','https://example.com/index.php']){
  assert.equal(outsideInbox(url),false);assert.equal((await restore({page:{url:()=>url}})).navigated,false);
 }
});
