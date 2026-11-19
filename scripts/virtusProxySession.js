'use strict';
const {VirtusTurn}=require('./virtusTurn');
async function create({nome,onState=()=>{},dependencies={}}){
 const config=dependencies.config||require('./serverConfig').readServerConfigEffective();
 if(config.virtus?.proxyEnabled!==true)return null;
 if(!dependencies.allowPilot&&process.env.VIRTUS_PROXY_PILOT_ACCOUNT!==nome)throw Error('virtus_proxy_pilot_not_enabled_for_account');
 if(!dependencies.allowPilot){const fs=require('node:fs'),path=require('node:path');let desired={};try{desired=JSON.parse(fs.readFileSync(path.join(__dirname,'../dados/desired.json'),'utf8'))}catch{}const engine=String(desired._autoMode?.engine||desired.autoMode?.engine||desired.engine||'delta').toLowerCase();if(engine==='legacy')throw Error('virtus_proxy_requires_delta_engine');}
 const cp2=dependencies.cp2||require('./carrierV2/accountOperation');
 await cp2.ensureConfig();
 const Client=dependencies.Client||require('./carrierV2/client').OperationClient;
 const available=await new Client(cp2.readConfig()).capabilities();
 if(available.virtusTurns!==true)throw Error('virtus_proxy_transport_not_ready');
 const rails=dependencies.rails||require('./robeRail');
 const rail=rails.createDirectSwitch({requireProxy:true});let port;
 try{
  port=await rail.listen();
  const turn=new VirtusTurn({rail,onState,beforeDisconnect:async()=>{if(browser)for(const page of await browser.pages())try{await page.setOfflineMode(true)}catch{}},acquire:({intent,signal})=>cp2.begin({nome,purpose:'virtus',intent,signal,isReady:async()=>true}),prove:async()=>{
   const raw=await rails.proveThroughRail(port);let payload;try{payload=JSON.parse(raw)}catch{throw Error('virtus_proxy_invalid_proof')}
   const proof=rails.readExit(payload);if(!proof.ip)throw Error('virtus_proxy_missing_ip');return proof;
  }});
  let bootResolve,bootReady,bootReject;
  const bootGate=new Promise(resolve=>bootResolve=resolve);
  const ready=new Promise((resolve,reject)=>{bootReady=resolve;bootReject=reject});
  const boot=()=>{const task=turn.run('warm',async()=>{bootReady();await bootGate});task.catch(bootReject);return ready};
  let browser=null,timer=null,stopped=false,lastNetworkAt=0,observerBusy=false,activeLease=null,expectedSend=null,outgoingEvidence=null,humanHeld=false,humanResolve=null,humanTask=null;
  const api={turn,proxyServer:'127.0.0.1:'+port,boot,
   attach(value){
    browser=value;browser.__ctVirtusProxy=api;
    const watch=page=>{if(page.__ctVirtusProxyObserved)return;page.__ctVirtusProxyObserved=true;page.on('response',res=>{try{const u=new URL(res.url());if(/(^|\.)facebook\.com$|(^|\.)messenger\.com$/.test(u.hostname)&&res.status()>=200&&res.status()<400&&!res.fromCache()&&!res.fromServiceWorker())api.noteNetwork()}catch{}})};
    browser.pages().then(pages=>pages.forEach(watch)).catch(()=>{});
    browser.on('targetcreated',target=>target.page().then(page=>{if(page)watch(page)}).catch(()=>{}));
    browser.once('disconnected',()=>{api.close().catch(()=>{})});
   },
   finishBoot(){bootResolve()},
   noteNetwork(){lastNetworkAt=Date.now()},
   snapshot(){return {...turn.snapshot(),lastNetworkAt,humanHeld}},
   async enterHuman(){
    if(humanTask)return humanTask.ready;
    humanHeld=true;api.finishBoot();let readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j});
    const gate=new Promise(r=>humanResolve=r);
    const task=api.run('human',async()=>{readyResolve();await gate});
    humanTask={ready,task};task.catch(readyReject).finally(()=>{humanTask=null;humanHeld=false});return ready;
   },
   async leaveHuman(){if(!humanTask){humanHeld=false;return}const task=humanTask.task;humanResolve?.();await task;humanHeld=false},
   async run(intent,action){
    return turn.run(intent,async lease=>{
      activeLease=lease;
      try{
        const reconnectAt=Date.now();
        const pages=await browser.pages();
        for(const page of pages)try{await page.setOfflineMode(false)}catch{}
        // Reconnection must have a ready document before any account action.
        const page=pages.find(p=>/facebook\.com\/messages|messenger\.com/.test(p.url()))||pages[0];
        if(!page)throw Error('virtus_proxy_page_missing');
        await page.waitForFunction(()=>document.readyState!=='loading'&&!!document.body,{timeout:120000});
        const until=Date.now()+60000;
        while(lastNetworkAt<reconnectAt&&Date.now()<until&&!stopped)await new Promise(r=>setTimeout(r,250));
        if(lastNetworkAt<reconnectAt)throw Error('virtus_reconnect_not_confirmed');
        return await action(lease);
      }finally{activeLease=null}
    });
   },
   async beforeSend({threadKey,text}={}){
    if(!activeLease)throw Error('virtus_send_without_turn');
    if(!threadKey||!String(text||'').trim())throw Error('virtus_send_identity_missing');
    expectedSend={threadKey:String(threadKey),text:String(text).replace(/\s+/g,' ').trim(),since:Date.now()};outgoingEvidence=null;
    await activeLease.possibleSideEffect();
   },
   recordOutgoing({threadKey,text,messageId,messageAt}={}){
    if(!expectedSend||!messageId||String(threadKey)!==expectedSend.threadKey)return;
    if(String(text||'').replace(/\s+/g,' ').trim()!==expectedSend.text)return;
    if(!Number.isFinite(Number(messageAt))||Number(messageAt)<expectedSend.since-2000)return;
    outgoingEvidence={messageId:String(messageId),messageAt:Number(messageAt)};
   },
   async confirmSend(){
    if(!activeLease||!expectedSend)throw Error('virtus_send_without_turn');
    const until=Date.now()+(dependencies.confirmationTimeoutMs||45000);
    while(!outgoingEvidence&&Date.now()<until&&!stopped)await new Promise(r=>setTimeout(r,250));
    if(!outgoingEvidence)throw Error('virtus_send_server_ack_unconfirmed');
    activeLease.confirm();expectedSend=null;return outgoingEvidence;
   },
   startObserver({canObserve=()=>true}={}){
    if(timer)return;
    const tick=async()=>{
      if(stopped||humanHeld||observerBusy||!browser?.isConnected()||!canObserve())return;
      observerBusy=true;
      try{await api.run('observe',async()=>{
        const start=Date.now();let sawNetwork=lastNetworkAt>0;
        while(Date.now()-start<30000&&!stopped){
          if(lastNetworkAt>=start)sawNetwork=true;
          if(sawNetwork&&Date.now()-lastNetworkAt>=2500)break;
          await new Promise(r=>setTimeout(r,500));
        }
        if(!sawNetwork)throw Error('virtus_reconnect_not_confirmed');
      })}catch(error){onState({...api.snapshot(),error:String(error.message||error)})}
      finally{observerBusy=false}
    };
    timer=setInterval(()=>tick().catch(()=>{}),30000);timer.unref?.();
   },
   async close(){if(stopped)return;stopped=true;clearInterval(timer);humanResolve?.();bootResolve();await turn.close()}
  };
  return api;
 }catch(error){await rail.close();throw error}
}
module.exports={create};
