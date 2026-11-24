'use strict';
const {VirtusTurn}=require('./virtusTurn');
const {Activity}=require('./virtusActivity');
async function create({nome,onState=()=>{},dependencies={}}){
 const config=dependencies.config||require('./serverConfig').readServerConfigEffective();
 const pilot=dependencies.pilot===undefined?readPilot():dependencies.pilot;
 const accountPilot=pilot?.enabled===true&&pilot.accountId===nome;
 if(config.virtus?.proxyEnabled!==true&&!accountPilot)return null;
 if(config.virtus?.proxyEnabled!==true&&!dependencies.allowPilot&&!accountPilot&&process.env.VIRTUS_PROXY_PILOT_ACCOUNT!==nome)throw Error('virtus_proxy_pilot_not_enabled_for_account');
 if(!dependencies.allowPilot){const fs=require('node:fs'),path=require('node:path');let desired={};try{desired=JSON.parse(fs.readFileSync(path.join(__dirname,'../dados/desired.json'),'utf8'))}catch{}const engine=String(desired._autoMode?.engine||desired.autoMode?.engine||desired.engine||'delta').toLowerCase();if(engine==='legacy')throw Error('virtus_proxy_requires_delta_engine');}
 const cp2=dependencies.cp2||require('./carrierV2/accountOperation');
 await cp2.ensureConfig();
 const Client=dependencies.Client||require('./carrierV2/client').OperationClient;
 const available=await new Client(cp2.readConfig()).capabilities();let rotationPolicy=available.rotation||null;
 if(available.virtusTurns!==true)throw Error('virtus_proxy_transport_not_ready');
 const rails=dependencies.rails||require('./robeRail');
 const rail=rails.createDirectSwitch({requireProxy:true});let port;
 try{
  port=await rail.listen();
  const turn=new VirtusTurn({rail,onState,onTrace:async trace=>{
   if(!bootstrapOutcome&&startupFinished&&trace.intent==='warm'&&trace.endedAt){bootstrapOutcome={at:trace.endedAt,ok:trace.checkConfirmed===true,reason:trace.reason||trace.outcome};onState(api.snapshot())}
   await (dependencies.onTrace||(value=>require('./virtusTurnEvidence').record(nome,value)))(trace);
  },beforeDisconnect:async()=>{if(browser)for(const page of await browser.pages())try{await page.setOfflineMode(true)}catch{}},acquire:({intent,signal})=>cp2.begin({nome,purpose:'virtus',intent,messageIsolation:true,observationRecovery:['warm','observe','engaged'].includes(intent)&&!!deliveryLedger.accountBlocked?.(nome),hotUntil:Math.floor(activity.snapshot().hotUntil/1000),signal,isReady:dependencies.isReady||(()=>accountStillWanted(nome))}),prove:async()=>{
   const raw=await rails.proveThroughRail(port);let payload;try{payload=JSON.parse(raw)}catch{throw Error('virtus_proxy_invalid_proof')}
   const proof=rails.readExit(payload);if(!proof.ip)throw Error('virtus_proxy_missing_ip');return proof;
  }});
  let bootResolve,bootReady,bootReject;
  const bootGate=new Promise(resolve=>bootResolve=resolve);
  const ready=new Promise((resolve,reject)=>{bootReady=resolve;bootReject=reject});
  const boot=()=>{const task=turn.run('warm',async()=>{bootReady();await bootGate;return lastInbox||{ok:false,state:'incomplete',reason:'startup_inbox_unconfirmed'}});task.catch(bootReject);return ready};
  let bootstrapOutcome=null;
  let browser=null,timer=null,stopped=false,lastNetworkAt=0,lastSyncNetworkAt=0,connectedAt=Date.now(),observerBusy=false,observerOptions=null,observerLastTickAt=0,lastObserveAttemptAt=0,observerSkipReason=null,observerVersion=0,startupFinished=false,healthCheck=null,lastInbox=null,activeLease=null,expectedSend=null,outgoingEvidence=null,humanHeld=false,humanTimer=null,humanResolve=null,humanTask=null;
  const deliveryLedger=dependencies.deliveryLedger||require("./virtusDeliveryLedger");
  let closedBrowserTimer=null,recoveringClosedBrowser=false,nextTransportRecoveryAt=0,transportRecoveryDelay=2000;
  let lastDocumentNavigation=null,documentNavigations=0,plannedNavigationReason=null,lastBootGate=null;
  const activity=new Activity();const inboundByThread=new Map();let lastReplyTiming=null;const burst=[];let visitIntent=null,visitReplied=false;
 const api={turn,proxyServer:'127.0.0.1:'+port,boot,
   attach(value){
    browser=value;browser.__ctVirtusProxy=api;
    closedBrowserTimer=(dependencies.setClosedBrowserInterval||setInterval)(async()=>{
      if(!turn.closed||stopped||humanHeld||recoveringClosedBrowser||Date.now()<nextTransportRecoveryAt||!browser?.isConnected?.())return;
      recoveringClosedBrowser=true;
      try{
       const recovered=await turn.reconcileTransport();
       if(recovered)lastInbox={ok:false,state:'incomplete',reason:'transport_reconciled_requires_inbox_check'};
       transportRecoveryDelay=recovered?2000:Math.min(30000,transportRecoveryDelay*2);
       nextTransportRecoveryAt=Date.now()+transportRecoveryDelay;
       onState({...api.snapshot(),transportRecovery:recovered?'reconciled':'waiting_authoritative_closure'});
      }catch(error){transportRecoveryDelay=Math.min(30000,transportRecoveryDelay*2);nextTransportRecoveryAt=Date.now()+transportRecoveryDelay;onState({...api.snapshot(),error:'virtus_transport_reconciliation:'+String(error.message||error)})}
      finally{recoveringClosedBrowser=false}
    },2000);closedBrowserTimer.unref?.();
    const watch=page=>{
     if(page.__ctVirtusProxyObserved)return;page.__ctVirtusProxyObserved=true;
     const pending=new Set();page.__ctVirtusPendingInbox=pending;
     const relevant=request=>{try{const u=new URL(request.url());return /(^|\.)facebook\.com$|(^|\.)messenger\.com$/.test(u.hostname)&&/\/api\/graphql|\/ajax\/mercury|\/messaging|\/graphql/.test(u.pathname)}catch{return false}};
     page.on('request',request=>{
      if(relevant(request))pending.add(request);
      try{if(request.isNavigationRequest()&&request.frame()===page.mainFrame()){
        lastDocumentNavigation={at:Date.now(),path:new URL(request.url()).pathname,reason:plannedNavigationReason||'browser_document_navigation'};
        documentNavigations++;onState(api.snapshot());
      }}catch{}
     });
     page.on('requestfinished',request=>pending.delete(request));page.on('requestfailed',request=>pending.delete(request));
     page.on('response',res=>{try{const u=new URL(res.url());if(/(^|\.)facebook\.com$|(^|\.)messenger\.com$/.test(u.hostname)&&res.status()>=200&&res.status()<400&&!res.fromCache()&&!res.fromServiceWorker()){api.noteNetwork();if(relevant(res.request()))api.noteSyncNetwork()}}catch{}});
    };
    browser.pages().then(pages=>pages.forEach(watch)).catch(()=>{});
    browser.on('targetcreated',target=>target.page().then(page=>{if(page)watch(page)}).catch(()=>{}));
    browser.once('disconnected',()=>{api.close().catch(()=>{})});
   },
   finishBoot(){startupFinished=true;bootResolve()},
   async withRuntimeStartup(action){
    // First startup is already covered by boot(). A restarted runtime must
    // obtain a fresh turn before any navigation or inbox preparation.
    if(!startupFinished&&turn.state==='online')return action();
    let runner;
    await api.run('warm',async()=>{lastInbox=null;runner=await action();return lastInbox||{ok:false,state:'incomplete',reason:'startup_inbox_unconfirmed'}},{startup:true});
    return runner;
   },
   noteIncoming(at,threadKey){
    at=Number(at);activity.incoming(at);
    if(threadKey&&Number.isFinite(at)&&at<=Date.now()+5000&&Date.now()-at<=3600000){const key=String(threadKey);const old=inboundByThread.get(key)||0;if(at>old){inboundByThread.delete(key);inboundByThread.set(key,at)}while(inboundByThread.size>256)inboundByThread.delete(inboundByThread.keys().next().value)}
   },
   noteConversationComplete(){activity.complete()},
   noteNetwork(){lastNetworkAt=Date.now()},
   noteSyncNetwork(){lastSyncNetworkAt=Date.now()},
   noteBootGate(result){lastBootGate={...result};onState(api.snapshot())},
   visitNetwork(page){return {connectedAt,lastNetworkAt:lastSyncNetworkAt,pending:page?.__ctVirtusPendingInbox?.size||0}},
   setHealthCheck(fn){healthCheck=fn},
   noteInbox(result){lastInbox={...result,at:Date.now()};onState(api.snapshot())},
   snapshot(){return {...turn.snapshot(),bootstrapOutcome,lastNetworkAt,humanHeld,pilot:accountPilot,lastInbox,startupFinished,documentNavigations,lastDocumentNavigation,lastBootGate,rotation:rotationPolicy,lastReplyTiming,activity:activity.snapshot(),pendingBurst:burst.length,observer:{registered:!!observerOptions,lastTickAt:observerLastTickAt,skipReason:observerSkipReason,guard:observerOptions?.describeGuard?.()||null}}},
   async enterHuman(){
    if(humanTask)return humanTask.ready;
    humanHeld=true;api.finishBoot();let readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j});
    const gate=new Promise(r=>humanResolve=r),cancel=new AbortController();turn.cancelWaitingObservation();
    const task=api.run('human',async()=>{humanTimer=setTimeout(()=>{humanResolve?.();},dependencies.humanLeaseMs||5*60*1000);humanTimer.unref?.();readyResolve();await gate},{signal:cancel.signal});
    humanTask={ready,task,cancel};
    task.then(()=>{},readyReject).finally(()=>{clearTimeout(humanTimer);humanTask=null;humanHeld=false}).catch(()=>{});return ready;
   },
   async leaveHuman(){if(!humanTask){humanHeld=false;return}const {task,cancel}=humanTask;clearTimeout(humanTimer);cancel.abort(Error('virtus_human_canceled'));humanResolve?.();try{await task}catch(error){if(error.message!=='virtus_human_canceled')throw error}finally{humanHeld=false}},
   async run(intent,action,turnOptions){
    if(intent==='reply'&&activeLease&&!activeLease.snapshot().reconciliationOnly&&['warm','observe','engaged'].includes(visitIntent)&&!humanHeld&&!visitReplied&&burst.length<1){return new Promise((resolve,reject)=>burst.push({action,resolve,reject}))}
    return turn.run(intent,async lease=>{
      activeLease=lease;rotationPolicy=lease.snapshot().rotation||rotationPolicy;visitIntent=intent;visitReplied=false;
      try{
        const reconnectAt=Date.now();connectedAt=reconnectAt;
        const pages=await browser.pages();
        for(const page of pages)try{await page.setOfflineMode(false)}catch{}
        if(intent==='human'||turnOptions?.startup===true)return await action(lease);
        // Reconnection must have a ready document before any account action.
        const page=pages.find(p=>/facebook\.com\/messages|messenger\.com/.test(p.url()))||pages[0];
        if(!page)throw Error('virtus_proxy_page_missing');
        await require('./virtusMessagesDocument').recoverBrowserError({page,onRecovery:e=>{api.noteInbox({ok:false,state:'recovering_browser_document',reason:e.reason});}});
        if(healthCheck&&intent!=='human'){
          const health=await healthCheck();
          if(!health.ok){const result={ok:false,state:'blocked',health:health.state,reason:health.reason};api.noteInbox(result);return result}
          const route=await require('./virtusInboxRoute').restore({page,healthCheck:()=>healthCheck(),onRecovery:e=>api.noteInbox({ok:false,state:'recovering_browser_document',reason:e.reason})});
          if(route.blocked){const result={ok:false,state:'blocked',health:route.blocked.state,reason:route.blocked.reason};api.noteInbox(result);return result}
        }
        try{await page.waitForFunction(()=>document.readyState!=='loading'&&!!document.body,{timeout:120000});}
        catch(error){
          if(error.name!=='TimeoutError')throw error;
          await require('./virtusMessagesDocument').ensure({page,onRecovery:e=>api.noteInbox({ok:false,state:'recovering_browser_document',reason:e.reason})});
        }
        const until=Date.now()+(dependencies.reconnectWaitMs??60000);
        while(lastNetworkAt<reconnectAt&&Date.now()<until&&!stopped)await new Promise(r=>setTimeout(r,250));
        if(lastNetworkAt<reconnectAt){
          // A broken document may have no surviving socket to produce a reconnect event.
          // A complete, quiet inbox must never be reloaded merely for being quiet.
          const documents=require('./virtusMessagesDocument');
          const state=await page.evaluate(documents.inspectDocument);
          if(!state.ready)await documents.ensure({page,onRecovery:e=>api.noteInbox({ok:false,state:'recovering_browser_document',reason:e.reason})});
          if(lastNetworkAt<reconnectAt)throw Error('virtus_reconnect_not_confirmed');
        }
        if(intent==='reply'&&healthCheck){const health=await healthCheck();if(!health.ok)throw Error('virtus_account_blocked:'+health.state)}
        return await action(lease);
      }finally{if(expectedSend?.delivery){deliveryLedger.markUncertain?.(expectedSend.delivery);expectedSend=null}visitIntent=null;activeLease=null;while(burst.length)burst.shift().reject(Error('virtus_visit_ended_before_reply'))}
      },turnOptions);
   },
   async beforeSend({threadKey,text,clientMessageId}={}){
    if(!activeLease)throw Error('virtus_send_without_turn');
    if(activeLease.snapshot().reconciliationOnly)throw Error('virtus_delivery_reconciliation_required');
    if(!threadKey||!String(text||'').trim())throw Error('virtus_send_identity_missing');
    const delivery=clientMessageId?deliveryLedger.begin({account:nome,id:String(clientMessageId),thread:threadKey,text}):null;
    expectedSend={threadKey:String(threadKey),text:String(text).replace(/\s+/g,' ').trim(),since:Date.now(),inboundAt:inboundByThread.get(String(threadKey))||null,delivery};outgoingEvidence=null;
    await activeLease.possibleSideEffect();
    const accepted=delivery&&deliveryLedger.read?.(nome,String(clientMessageId));
    if(accepted?.state==='confirmed'){outgoingEvidence=accepted.evidence;return {skipSubmit:true};}
    return {skipSubmit:false};
   },
   async reconcileSend({page,threadKey}) {
    if(!activeLease||activeLease.snapshot().healthy===false||humanHeld)throw Error('virtus_recovery_without_healthy_turn');
    if(!/^\d{12,20}$/.test(String(threadKey)))throw Error('virtus_recovery_thread_invalid');
    const started=Date.now();
    plannedNavigationReason='recover_previously_attempted_delivery';
    try{await page.goto('https://www.facebook.com/messages/t/'+threadKey+'/',{waitUntil:'domcontentloaded',timeout:60000})}
    finally{plannedNavigationReason=null}
    const until=Date.now()+(dependencies.recoverySyncTimeoutMs??30000);
    while(Date.now()<until&&!stopped) {
      if(activeLease.snapshot().healthy===false)throw Error('virtus_recovery_transport_lost');
      if(lastSyncNetworkAt>=started&&!(page.__ctVirtusPendingInbox?.size)&&Date.now()-lastSyncNetworkAt>=(dependencies.recoveryQuietMs??2500))return;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    throw Error('virtus_recovery_sync_incomplete');
   },
   recordOutgoing({threadKey,text,messageId,messageAt}={}){
    const hasReconciler=typeof deliveryLedger.recordServerEcho==='function';
    const receipt=messageId&&threadKey?deliveryLedger.recordServerEcho?.({account:nome,thread:String(threadKey),text:String(text||''),messageId:String(messageId),messageAt:Number(messageAt),onAmbiguous:details=>onState({...api.snapshot(),deliveryAmbiguous:details})}):null;
    if(!expectedSend||!messageId||String(threadKey)!==expectedSend.threadKey)return;
    if(expectedSend.delivery&&hasReconciler){
      if(receipt?.state!=='confirmed'||receipt.id!==expectedSend.delivery.id)return;
      outgoingEvidence=receipt.evidence;return;
    }
    if(String(text||'').replace(/\s+/g,' ').trim()!==expectedSend.text)return;
    if(!Number.isFinite(Number(messageAt))||Number(messageAt)<expectedSend.since-2000)return;
    const evidence={messageId:String(messageId),messageAt:Number(messageAt),...(expectedSend.delivery?{source:"facebook_server_event",account:nome,thread:expectedSend.delivery.thread,clientMessageId:expectedSend.delivery.id,attemptId:expectedSend.delivery.attemptId,contentHash:expectedSend.delivery.contentHash}:{})};
    if(expectedSend.delivery)deliveryLedger.confirm(expectedSend.delivery,evidence);
    outgoingEvidence=evidence;
   },
   async confirmSend(){
    if(!activeLease||!expectedSend)throw Error('virtus_send_without_turn');
    const until=Date.now()+(dependencies.confirmationTimeoutMs||45000);
    while(!outgoingEvidence&&Date.now()<until&&!stopped)await new Promise(r=>setTimeout(r,250));
    if(!outgoingEvidence)throw Error('virtus_send_server_ack_unconfirmed');
    if(expectedSend.delivery)deliveryLedger.confirm(expectedSend.delivery,outgoingEvidence);
    await activeLease.confirm();visitReplied=true;activity.replied();
    const now=Date.now();lastReplyTiming={confirmedAt:now,sendToConfirmationMs:now-expectedSend.since,customerToConfirmationMs:expectedSend.inboundAt&&now>=expectedSend.inboundAt?now-expectedSend.inboundAt:null};onState(api.snapshot());expectedSend=null;return outgoingEvidence;
   },
   async performVisit(options){
    const prepared=await options.prepareInbox();api.noteInbox(prepared);
    if(prepared?.ok===false)return prepared;
    const start=Date.now();let sawNetwork=lastNetworkAt>0;
    while(Date.now()-start<30000&&!stopped){
      if(lastNetworkAt>=start)sawNetwork=true;
      while(burst.length){const job=burst.shift();visitReplied=true;try{if(healthCheck){const health=await healthCheck();if(!health.ok)throw Error('virtus_account_blocked:'+health.state)}job.resolve(await job.action(activeLease))}catch(error){job.reject(error)}}
      if(sawNetwork&&Date.now()-lastNetworkAt>=2500&&!activity.snapshot().waitingBriefly)break;
      await new Promise(r=>setTimeout(r,500));
    }
    if(!sawNetwork)throw Error('virtus_reconnect_not_confirmed');return prepared;
   },
   async visitOnLease(lease){
    if(lease.accountId!==nome||lease.snapshot().healthy!==true)throw Error('virtus_shared_lease_identity_invalid');
    if(stopped||humanHeld||!observerOptions)return {ok:true,skipped:true,reason:'virtus_not_available'};
    if(['online','releasing'].includes(turn.state)||turn.currentIntent==='reply'&&turn.state==='waiting')return {ok:true,skipped:true,reason:'virtus_already_has_turn'};
    const options=observerOptions;if(!await options.canObserve())return {ok:true,skipped:true,reason:'virtus_observer_guard'};turn.cancelWaitingObservation();lastObserveAttemptAt=Date.now();
    return api.run('warm',()=>api.performVisit(options),{lease});
   },
   stopObserver(version){if(version!==undefined&&version!==observerVersion)return;observerOptions=null;(dependencies.clearObserverInterval||clearInterval)(timer);timer=null},
   startObserver({canObserve=()=>true,prepareInbox=async()=>{},describeGuard=()=>null}={}){
    observerOptions={canObserve,prepareInbox,describeGuard};const version=++observerVersion;
    if(timer)return version;
    const tick=async()=>{
      const options=observerOptions;observerLastTickAt=Date.now();
      observerSkipReason=stopped||turn.closed?'closed':humanHeld?'human':observerBusy?'busy':!browser?.isConnected()?'browser_disconnected':!options?'unregistered':!options.canObserve()?'runtime_guard':null;
      if(observerSkipReason==='closed'){if(stopped)api.stopObserver();return}
      if(observerSkipReason)return;
      const needsStartupRepair=!lastInbox||['incomplete','recovering_browser_document'].includes(lastInbox.state);
      const target=activity.snapshot().engaged?rotationPolicy?.hotIntervalMs:rotationPolicy?.coldIntervalMs;
      const revisitMs=dependencies.revisitMs??(needsStartupRepair?60000:Math.max(15000,Math.min(1800000,Number(target)||(activity.snapshot().engaged?15000:60000))));
      if(lastObserveAttemptAt&&Date.now()-lastObserveAttemptAt<revisitMs){observerSkipReason='revisit_interval';return}
      lastObserveAttemptAt=Date.now();observerBusy=true;
      try{await api.run(needsStartupRepair?'warm':activity.snapshot().engaged?'engaged':'observe',()=>api.performVisit(options))}catch(error){api.noteInbox({ok:false,state:'incomplete',reason:String(error.message||error),details:error.details||null});onState({...api.snapshot(),error:String(error.message||error)})}
      finally{observerBusy=false}
    };
    timer=(dependencies.setObserverInterval||setInterval)(()=>tick().catch(error=>onState({...api.snapshot(),error:String(error.message||error)})),5000);timer.unref?.();return version;
   },
   async close(){if(stopped)return;stopped=true;(dependencies.clearClosedBrowserInterval||clearInterval)(closedBrowserTimer);closedBrowserTimer=null;api.stopObserver();humanResolve?.();bootResolve();await turn.close()}
  };
  return api;
 }catch(error){await rail.close();throw error}
}
function accountStillWanted(nome){
 try{const fs=require('node:fs'),path=require('node:path');const desired=JSON.parse(fs.readFileSync(path.join(__dirname,'../dados/desired.json'),'utf8'));return desired.perfis?.[nome]?.active===true}catch{return false}
}
function readPilot(){
 const fs=require('node:fs'),path=require('node:path');
 const file=path.join(__dirname,'../dados/carrier_v2_private/virtus_pilot.json');
 try{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.enabled!==true)return null;if(value.version!==1||typeof value.accountId!=='string'||!value.accountId.trim()||value.accountId.length>128)throw Error('virtus_pilot_config_invalid');return value}catch(error){if(error.code==='ENOENT')return null;throw error}
}
module.exports={create};
