'use strict';
const fs=require('node:fs'),path=require('node:path');
function mode({purpose='auto',pending=false,config}){
 const cadastro=purpose==='cadastro'||(purpose==='auto'&&pending);
 return {cadastro,proxy:cadastro?config.cadastro?.proxyEnabled===true:config.virtus?.proxyEnabled===true};
}
function pending(nome){const desired=JSON.parse(fs.readFileSync(path.join(__dirname,'../dados/desired.json'),'utf8'));return desired.perfis?.[nome]?.provisioningPending===true}
async function create({nome,onState=()=>{},dependencies={}}){
 const cp2=dependencies.cp2||require('./carrierV2/accountOperation'),rails=dependencies.rails||require('./robeRail');
 await cp2.ensureConfig();
 const Client=dependencies.Client||require('./carrierV2/client').OperationClient;
 const cap=await new Client(cp2.readConfig()).capabilities();
 if(cap.accountProvision!==true)throw Error('cadastro_proxy_executor_upgrade_required');
 const rail=rails.createDirectSwitch({requireProxy:true}),abort=new AbortController();
 let operation=null,browser=null,closed=false,closing=null,timer=null,state='waiting',failure=null;
 const now=dependencies.now||Date.now,startedAt=now();let acquiredAt=null,closedAt=null,stage='waiting',stageAt=startedAt;const stages=[];
 const noteStage=name=>{const at=now();stages.push({stage,durationMs:at-stageAt});if(stages.length>24)stages.shift();stage=String(name).slice(0,64);stageAt=at;publish()};
 const snapshot=()=>({state,failure,operationId:operation?.operationId||null,healthy:!closed&&operation?.snapshot().healthy===true,traffic:rail.trafficSnapshot(),timing:{startedAt,acquiredAt,closedAt,waitingMs:(acquiredAt||now())-startedAt,chairMs:acquiredAt?((closedAt||now())-acquiredAt):0,absoluteDeadline:operation?.snapshot().absoluteDeadline||null,stage,stageMs:now()-stageAt,completedStages:stages.slice()}});
 const publish=()=>onState(snapshot());
 const assertHealthy=()=>{if(closed||!operation||operation.snapshot().healthy!==true||(operation.snapshot().absoluteDeadline&&now()>=operation.snapshot().absoluteDeadline*1000))throw Error('cadastro_proxy_transport_unhealthy')};
 const close=()=>{
  if(closing)return closing;
  closing=(async()=>{closed=true;(dependencies.clearInterval||clearInterval)(timer);rail.flip(null);state='closing';publish();
   if(browser?.isConnected?.())await browser.close();
   if(browser?.isConnected?.())throw Error('cadastro_proxy_browser_close_unconfirmed');
   await rail.close();if(operation)await operation.close();closedAt=now();state='closed';noteStage('closed');
  })().catch(error=>{state='blocked';failure=String(error.message||error);publish();throw error});return closing;
 };
 try{
  const port=await rail.listen();
  operation=await cp2.begin({nome,purpose:'provision',authenticationRecovery:true,signal:abort.signal,isReady:async()=>!closed,onWait:publish});
  acquiredAt=now();noteStage('proxy_proof');rail.flip(operation.hop);assertHealthy();
  const raw=await rails.proveThroughRail(port),proof=rails.readExit(JSON.parse(raw));
  if(!proof.ip)throw Error('cadastro_proxy_proof_missing');
  assertHealthy();state='online';publish();
  noteStage('browser_start');
  const api={noteStage,proxyServer:'127.0.0.1:'+port,snapshot,assertHealthy,
   attach(value){browser=value;noteStage('browser_ready');browser.__ctCadastroProxy=api;browser.once('disconnected',()=>{close().catch(error=>onState({...snapshot(),error:String(error.message||error)}))});
    timer=(dependencies.setInterval||setInterval)(()=>{if(operation.snapshot().healthy!==true||(operation.snapshot().absoluteDeadline&&now()>=operation.snapshot().absoluteDeadline*1000)){failure='cadastro_proxy_transport_lost';rail.flip(null);close().catch(error=>onState({...snapshot(),error:String(error.message||error)}))}},500);timer.unref?.();
   },
   async possibleSideEffect(){assertHealthy();await operation.possibleSideEffect();assertHealthy()},
   confirm(){assertHealthy();operation.confirm();noteStage('verified')},close,
   cancel(){abort.abort(Error('cadastro_proxy_canceled'));return close()}
  };return api;
 }catch(error){failure=String(error.message||error);try{await close()}catch{}throw error}
}
module.exports={mode,pending,create};
