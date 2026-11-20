'use strict';
const crypto=require('node:crypto'),net=require('node:net'),{once}=require('node:events'),WebSocket=require('ws');
const {CarrierSession}=require('./session');
class OperationClient {
  constructor({baseUrl,serverId,token,edgeGeneration=crypto.randomUUID(),allowLoopbackTest=false,fetchImpl=fetch,requestTimeoutMs=90000,protocolTimeoutMs=60000}){
    const url=new URL(baseUrl);if(url.protocol!=='https:'&&!(allowLoopbackTest&&url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw Error('cp2_tls_required');
    if(!serverId&&!token)throw Error('cp2_server_id_required');
    if(serverId&&!/^[a-f0-9-]{36}$/i.test(serverId))throw Error('cp2_server_id_invalid');
    this.url=url;this.serverId=serverId;this.token=token;this.edgeGeneration=edgeGeneration;this.fetch=fetchImpl;this.operations=new Map();
    if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1||!Number.isSafeInteger(protocolTimeoutMs)||protocolTimeoutMs<1)throw Error('invalid_client_timeout');
    this.requestTimeoutMs=requestTimeoutMs;this.protocolTimeoutMs=protocolTimeoutMs;
  }
  headers(){return {'content-type':'application/json','x-edge-generation':this.edgeGeneration,...(this.serverId?{'x-server-id':this.serverId}:{authorization:'Bearer '+this.token})}}
  async request(path,body,signal){
    const url=new URL(this.url);url.pathname=this.url.pathname.replace(/\/$/,'')+'/v2/operations'+path;
    const response=await this.fetch(url,{method:body===undefined?'GET':'POST',headers:this.headers(),body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.requestTimeoutMs)]):AbortSignal.timeout(this.requestTimeoutMs)});
    const data=await response.json();if(!response.ok||data.ok!==true){const e=Error(data.error||'cp2_http_failure');e.retryable=!!data.retryable;e.nextPollAfterMs=data.nextPollAfterMs;throw e}return data;
  }
  async capabilities(){
    const url=new URL(this.url);url.pathname=this.url.pathname.replace(/\/$/,'')+'/capabilities';
    const response=await this.fetch(url,{headers:this.headers(),signal:AbortSignal.timeout(this.requestTimeoutMs)});const data=await response.json();
    if(!response.ok||data.ok!==true)throw Error(data.error||'cp2_capabilities_unavailable');return data;
  }
  lease(row){return {leaseId:row.leaseId,leaseGeneration:row.leaseGeneration,carrierGeneration:row.carrierGeneration}}
  async acquire({operationId=crypto.randomUUID(),accountId,type,intent,operationSequence,eligiblePhoneIds,signal,onWait=()=>{},isReady=async()=>true}){
    const request={operationId,accountId,type,eligiblePhoneIds,...(type==='virtus'?{intent:intent||'observe',...(operationSequence===undefined?{}:{operationSequence})}:{})};let status;
    // O chamador conserva operationId antes deste método. O cancelamento não
    // presume que um timeout de enqueue significa que o pedido não foi salvo.
    try{
      let attempts=0;
      for(;;){
        if(signal?.aborted)throw signal.reason||Error('operation_canceled');
        try{status=status?await this.request('/'+operationId,undefined,signal):await this.request('',request,signal);attempts=0}catch(e){
          if(!e.retryable&&e.name!=='TimeoutError'&&e.name!=='TypeError')throw e;
          onWait({operationId,state:'waiting_authority',reason:e.message});
          await this.wait(Math.min(30000,Math.max(1000,e.nextPollAfterMs||1000)*2**Math.min(attempts++,4)),signal);continue;
        }
        if(status.state==='granted')break;
        if(['released','canceled','expired','failed','unknown'].includes(status.state)){const e=Error('cp2_terminal:'+status.state);e.result=status;throw e}
        if(status.state==='active')break;
        onWait(status);await this.wait(Math.max(1000,Math.min(30000,status.nextPollAfterMs||3000)),signal);
      }
      if(!await isReady()){await this.request('/'+operationId+'/cancel',{...this.lease(status),businessResult:'not_started'});throw Error('operation_context_lost')}
      let ready;
      for(let n=0;n<3;n++){
        try{ready=await this.controlRequest('/'+operationId+'/ready',this.lease(status));break}catch(e){if(!e.retryable||n===2)throw e;await this.wait(Math.max(1000,e.nextPollAfterMs||1000),signal)}
      }
      if(ready.state!=='active'||!ready.binding)throw Error('cp2_activation_unconfirmed');
      const op={operationId,status:ready,binding:ready.binding,result:'not_started',route:null,heartbeatError:null};this.operations.set(operationId,op);return op;
    }catch(error){
      // Cancel é idempotente. Se a resposta se perder, autoridade mantém capacidade
      // contada até fechar; nunca repetir uma ação de negócio para "recuperar".
      if(status&&status.state!=='queued')try{await this.request('/'+operationId+'/cancel',{...this.lease(status),businessResult:status.state==='granted'?'not_started':'unknown'})}catch{}
      else try{await this.request('/'+operationId+'/cancel-queued',{expectedState:'queued'})}catch{}
      throw error;
    }
  }
  wait(ms,signal){return new Promise((resolve,reject)=>{
    const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve()};
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason||Error('operation_canceled'))};
    const timer=setTimeout(done,ms*(0.9+Math.random()*0.2));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  })}
  control(op,action){
    const prior=op.controlTail||Promise.resolve();
    const task=prior.catch(()=>{}).then(action);
    const tail=task.catch(()=>{});op.controlTail=tail;
    tail.finally(()=>{if(op.controlTail===tail)delete op.controlTail});return task;
  }
  async controlRequest(path,body){
    const deadline=Date.now()+90000;
    for(let attempt=0;;attempt++){
      try{return await this.request(path,body)}catch(error){
        // Busy means this control was not executed. Never replay a browser action.
        if(error.message!=='operation_control_in_flight'||Date.now()>=deadline)throw error;
        await this.wait(Math.min(2000,500*(attempt+1)));
      }
    }
  }
  heartbeat(op){return this.control(op,async()=>{
    if(op.releasing)return op.status;
    const response=await this.controlRequest('/'+op.operationId+'/heartbeat',this.lease(op.status));const ack=response.acknowledgment;
    if(response.state!=='active'||ack?.source!=='carrier'||ack?.kind!=='heartbeat_ack'||!require('./protocol').sameIdentity(op.binding,ack)||require('./protocol').contextKeys.some(k=>op.binding[k]!==ack[k]))throw Error('cp2_lease_not_active');op.status=response;return response;
  })}
  phase(op,phase){return this.control(op,()=>{
    if(op.releasing)throw Error('cp2_operation_closing');
    return this.controlRequest('/'+op.operationId+'/phase',{...this.lease(op.status),phase});
  })}
  possibleSideEffect(op){return this.control(op,async()=>{
    if(op.releasing)throw Error('cp2_operation_closing');
    await this.controlRequest('/'+op.operationId+'/possible-side-effect',this.lease(op.status));op.result='unknown';
  })}
  async openRoute(op,{heartbeatMs=10000}={}){
    const url=new URL(this.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname=this.url.pathname.replace(/\/$/,'')+'/edge';url.searchParams.set('operationId',op.operationId);
    const ws=new WebSocket(url,'conveniente.carrier.v2.r2',{headers:{...this.headers(),'x-cp2-browser-budget':'1'},maxPayload:65536,perMessageDeflate:false,handshakeTimeout:10000});
    const session=new CarrierSession(ws,{authenticated:true,requestTimeoutMs:this.protocolTimeoutMs,peerRole:'CT',replyRole:'authority'});await session.ready;
    const sockets=new Set(),flows=new Set();let closing=false,inflightHeartbeat=false;
    const close=async()=>{if(closing)return;closing=true;clearInterval(timer);for(const s of sockets)s.destroy();for(const f of flows)f.destroy();session.close();await new Promise(resolve=>server.close(resolve))};
    const server=net.createServer({pauseOnConnect:true},socket=>{
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
      if(closing||op.heartbeatError){socket.destroy();return}
      let flow;try{flow=session.open(op.binding)}catch{socket.destroy();return}flows.add(flow);flow.on('close',()=>flows.delete(flow));
      flow.on('error',error=>{op.transportError=error.code||error.message;socket.destroy()});socket.on('close',()=>flow.destroy());
      flow.ready.then(()=>{if(socket.destroyed){flow.destroy();return}socket.pipe(flow).pipe(socket);socket.resume()}).catch(()=>socket.destroy());
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const timer=setInterval(async()=>{
      if(inflightHeartbeat||closing)return;inflightHeartbeat=true;
      try{await this.heartbeat(op)}catch(error){op.heartbeatError=error;await close()}finally{inflightHeartbeat=false}
    },heartbeatMs);timer.unref();
    op.route={port:server.address().port,host:'127.0.0.1',close,session};return op.route;
  }
  async release(op,result=op.result){
    op.releasing=true;
    if(op.route)await op.route.close();
    return this.control(op,async()=>{
    let status;
    for(let attempt=0;attempt<3;attempt++){
      try{status=await this.controlRequest('/'+op.operationId+'/release',{...this.lease(op.status),businessResult:result});break}catch(error){
        if(!error.retryable&&error.name!=='TimeoutError'&&error.name!=='TypeError')throw error;
        // Retrying closure is safe; never replay the business action. A GET
        // may show the terminal ACK already consumed after HTTP response loss.
        try{const observed=await this.request('/'+op.operationId);if(['released','canceled','expired'].includes(observed.state)){status=observed;break}}catch{}
        if(attempt===2)throw error;await this.wait(1000);
      }
    }
    if(!['released','canceled','expired'].includes(status.state))throw Error('cp2_release_unconfirmed');
    this.operations.delete(op.operationId);return status;
    });
  }
}
module.exports={OperationClient};
