'use strict';
const { EventEmitter }=require('node:events');
const { Duplex }=require('node:stream');
const p=require('./protocol'),{F}=p;
const {acceptedLimits}=require('./limits');
const features=['window-credit','signed-grant','fencing','bounded-flows','operation-metrics','closure-proof-r2'];
const ackKinds=new Set([F.ACTIVATE_ACK,F.HEARTBEAT_ACK,F.RELEASE_ACK,F.STATUS_ACK]);
class CarrierSession extends EventEmitter {
  // ws deve vir de upgrade já autenticado; não aceita identidade de JSON como auth.
  constructor(ws,{authenticated=false,helloTimeoutMs=5000,requestTimeoutMs=10000,takeoverTimeoutMs=10000,peerRole='carrier',replyRole='CT',takeover=null}={}){
    super();if(!authenticated)throw Error('authenticated_carrier_required');
    this.ws=ws;this.takeover=takeover;this.peerRole=peerRole;this.replyRole=replyRole;this.hello=null;this.flows=new Map();this.pending=new Map();this.controlBusy=new Set();this.nextId=0;this.closed=false;this.requestTimeoutMs=requestTimeoutMs;this.admitted=false;
    this.uncertainControls=new Map();
    this.takeoverTimeoutMs=takeoverTimeoutMs;
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject});
    this.ready.catch(()=>{});
    this.helloTimer=setTimeout(()=>this.fail(Error('carrier_hello_timeout')),helloTimeoutMs);
    ws.on('message',(raw,isBinary)=>{try{if(!isBinary)throw Error('binary_required');this.receive(p.decode(raw));}catch(e){this.fail(e)}});
    ws.on('close',()=>this.fail(Error('carrier_disconnected')));ws.on('error',e=>this.fail(e));
  }
  send(kind,id,body){
    if(this.closed||this.ws.readyState!==1)return Promise.reject(Error('carrier_disconnected'));
    const raw=p.encode(kind,id,body);
    // A soma dos limites de cada fluxo limita dados; limite adicional no socket.
    const maxBuffered=this.hello?this.hello.limits.maxFlows*this.hello.limits.queueChunks*32768+65536*128:65536*2;
    if(this.ws.bufferedAmount>maxBuffered){const error=Error('carrier_channel_backpressure');this.fail(error);return Promise.reject(error)}
    return new Promise((resolve,reject)=>this.ws.send(raw,{binary:true},error=>error?reject(error):resolve()));
  }
  receive({kind,id,body}){
    if(!this.hello){
      if(kind!==F.HELLO||id!==0||body.role!==this.peerRole||body.contractRevision!==2||!features.every(f=>body.features.includes(f))||!acceptedLimits(body.limits))throw Error('carrier_negotiation_failed');
      this.hello=body;clearTimeout(this.helloTimer);
      this.send(F.HELLO,0,{...body,role:this.replyRole}).then(async()=>{
        if(this.peerRole==='carrier'){
          if(!this.takeover)throw Error('takeover_adapter_required');
          this.takeoverState=await this.takeover.begin(body);this.takeoverTimer=setTimeout(()=>this.fail(Error('takeover_ack_timeout')),this.takeoverTimeoutMs);
          await this.send(F.TAKEOVER,0,this.takeoverState.frame);
        }else{this.admitted=true;this.resolveReady(body);this.emit('ready',body)}
      }).catch(e=>this.fail(e));return;
    }
    if(kind!==F.DATA&&body.carrierGeneration!==this.hello.carrierGeneration)throw Error('stale_generation');
    if(kind===F.TAKEOVER_ACK){
      if(id||this.admitted||!this.takeoverState)throw Error('unexpected_takeover_ack');
      const state=this.takeoverState;this.takeoverState=null;clearTimeout(this.takeoverTimer);
      Promise.resolve().then(()=>this.takeover.consume(state.command,body)).then(async result=>{
        this.fencedContext=p.context(result.commit);
        if(result.commit.retirementToken){
          this.retirementCommit=result.commit;
          this.retirementTimer=setTimeout(()=>this.fail(Error('retirement_ack_timeout')),this.takeoverTimeoutMs);
          await this.send(F.TAKEOVER_COMMIT,0,result.commit);
        }else{await this.send(F.TAKEOVER_COMMIT,0,result.commit);this.admitted=true;this.resolveReady(this.hello);this.emit('ready',this.hello)};
      }).catch(error=>this.fail(error));return;
    }
    if(kind===F.RETIREMENT_ACK){
      if(id||this.admitted||!this.retirementCommit||!this.takeover.acceptRetirement)throw Error('unexpected_retirement_ack');
      const commit=this.retirementCommit;this.retirementCommit=null;clearTimeout(this.retirementTimer);
      Promise.resolve().then(()=>this.takeover.acceptRetirement(commit,body)).then(()=>{if(this.closed)return;this.admitted=true;this.resolveReady(this.hello);this.emit('ready',this.hello)}).catch(error=>this.fail(error));return;
    }
    if(!this.admitted)throw Error('takeover_commit_required');
    if(kind===F.PING){this.send(F.PONG,0,{protocolVersion:2,carrierGeneration:this.hello.carrierGeneration}).catch(e=>this.fail(e));return}
    if(kind===F.PONG)return;
    if(ackKinds.has(kind)||kind===F.ERROR){
      if(id!==0)throw Error('control_id_required');
      const pending=this.pending.get(body.operationId);
      const uncertain=this.uncertainControls.get(body.operationId);
      if(uncertain&&kind===uncertain.expected&&p.sameIdentity(uncertain.body,body))this.uncertainControls.delete(body.operationId);
      if(pending){
        if(!p.sameIdentity(pending.body,body))throw Error('control_identity_mismatch');
        // Um ACK tardio de outro kind não responde ao controle atual e não
        // derruba a geração inteira. Continua observável para reconciliação.
        if(kind!==pending.expected&&kind!==F.ERROR){this.emit('control',{kind,body});return;}
        this.pending.delete(body.operationId);clearTimeout(pending.timer);
        if(kind===F.ERROR){const e=Error(body.code);e.code=body.code;e.retryable=body.retryable;pending.reject(e)}else pending.resolve(body);
      }
      this.emit('control',{kind,body});return;
    }
    const flow=this.flows.get(id);
    if(!flow){
      // IDs não são reutilizados: créditos/END em trânsito após o fechamento
      // pertencem ao fluxo antigo e não invalidam o canal dos vizinhos.
      if(id>0&&id<=this.nextId&&[F.END,F.WINDOW,F.OPEN_ERR,F.DATA].includes(kind))return;
      throw Error('unbound_flow');
    }
    if(kind!==F.DATA&&!p.sameIdentity(flow.binding,body))throw Error('flow_identity_mismatch');
    flow.receive(kind,body);
  }
  async command(kind,body,expected,timeoutMs=this.requestTimeoutMs){
    await this.ready;const operationId=body.operationId;
    if(this.controlBusy.has(operationId))throw Error('operation_control_in_flight');
    if(this.uncertainControls.get(operationId)?.expected===expected)throw Error('control_requires_reconciliation');
    this.controlBusy.add(operationId);
    try{return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(operationId);this.uncertainControls.set(operationId,{body,expected});reject(Error('carrier_ack_timeout'))},timeoutMs);
      this.pending.set(operationId,{body,expected,resolve,reject,timer});
      this.send(kind,0,body).catch(e=>{const row=this.pending.get(operationId);if(row){this.pending.delete(operationId);clearTimeout(timer);reject(e)}});
    })}finally{this.controlBusy.delete(operationId)}
  }
  open(binding){
    if(!this.hello||this.closed||!this.admitted)throw Error('carrier_not_ready');
    if(this.nextId>=Math.min(0xffffffff,this.hello.limits.historyLimit))throw Error('carrier_generation_drain_required');
    if(this.flows.size>=this.hello.limits.maxFlows)throw Error('capacity');
    let operationFlows=0;
    for(const flow of this.flows.values())if(flow.binding.operationId===binding.operationId)operationFlows++;
    if(operationFlows>=this.hello.limits.operationFlows)throw Error('capacity');
    const id=++this.nextId,flow=new CarrierFlow(this,id,binding);this.flows.set(id,flow);
    this.send(F.OPEN,id,binding).catch(e=>flow.destroy(e));return flow;
  }
  fail(error){
    if(this.closed)return;this.closed=true;this.failure=error;clearTimeout(this.helloTimer);clearTimeout(this.takeoverTimer);clearTimeout(this.retirementTimer);this.rejectReady(error);
    for(const row of this.pending.values()){clearTimeout(row.timer);row.reject(error)}this.pending.clear();
    for(const flow of this.flows.values())flow.destroy(error);this.flows.clear();
    try{this.ws.terminate()}catch{}this.emit('disconnected',{error,generation:this.hello?.carrierGeneration});
  }
  close(){this.fail(Error('session_closed'))}
}
class CarrierFlow extends Duplex {
  constructor(session,id,binding){
    super({readableHighWaterMark:32768,writableHighWaterMark:32768,allowHalfOpen:false});
    this.session=session;this.id=id;this.binding=binding;this.opened=false;this.remoteEnded=false;this.heldCredits=[];
    this.maxBytes=32768*session.hello.limits.queueChunks;this.maxFrames=session.hello.limits.queueChunks;
    this.sendBytes=this.receiveBytes=this.maxBytes;this.sendFrames=this.receiveFrames=this.maxFrames;this.writePending=null;this.pumping=false;
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject});this.ready.catch(()=>{});
    this.openTimer=setTimeout(()=>this.destroy(Error('open_ack_timeout')),session.requestTimeoutMs);
    // Erros são refletidos em ready/write; nenhum fluxo órfão derruba o processo.
    this.on('error',()=>{});
  }
  receive(kind,body){
    if(kind===F.OPEN_OK){if(this.opened)throw Error('duplicate_open_ack');if(p.contextKeys.some(k=>body[k]!==this.binding[k]))throw Error('open_executor_context_mismatch');clearTimeout(this.openTimer);this.openAck=body;this.opened=true;this.resolveReady();this.pump();return}
    if(kind===F.OPEN_ERR){const e=Error(body.code);e.code=body.code;e.retryable=body.retryable;this.remoteEnded=true;this.destroy(e);return}
    if(kind===F.WINDOW){
      if(!this.opened||this.sendBytes+body.creditBytes>this.maxBytes||this.sendFrames+body.creditFrames>this.maxFrames)throw Error('credit_overflow');
      this.sendBytes+=body.creditBytes;this.sendFrames+=body.creditFrames;this.pump();return;
    }
    if(kind===F.DATA){
      if(!this.opened||!body.length||body.length>this.receiveBytes||this.receiveFrames<1)throw Error('backpressure');
      this.receiveBytes-=body.length;this.receiveFrames--;this.heldCredits.push(body.length);
      if(this.push(body))this.returnCredits();return;
    }
    if(kind===F.END){
      this.remoteEnded=true;this.session.flows.delete(this.id);clearTimeout(this.openTimer);
      if(!this.opened){this.destroy(Error(body.reason||'connection_closed'));return}
      if(this.writePending){this.destroy(Error('upstream_closed_during_write'));return}
      if(body.reason&&body.reason!=='eof'&&body.reason!=='peer_end')this.emit('transportEndReason',body.reason);
      this.push(null);return;
    }
    throw Error('unexpected_flow_frame');
  }
  returnCredits(){
    while(this.heldCredits.length&&!this.remoteEnded&&!this.destroyed){
      const bytes=this.heldCredits.shift();this.receiveBytes+=bytes;this.receiveFrames++;
      this.session.send(F.WINDOW,this.id,{...p.identity(this.binding),creditBytes:bytes,creditFrames:1}).catch(e=>this.destroy(e));
    }
  }
  _read(){this.returnCredits()}
  _write(chunk,encoding,callback){this.writePending={chunk:Buffer.from(chunk),offset:0,callback};this.pump()}
  async pump(){
    if(this.pumping||!this.opened||this.destroyed)return;this.pumping=true;
    try{while(this.writePending&&!this.destroyed){
      const w=this.writePending,remaining=w.chunk.length-w.offset;
      if(!remaining){this.writePending=null;w.callback();continue}
      if(!this.sendFrames||!this.sendBytes)break;
      const size=Math.min(32768,this.sendBytes,remaining),data=w.chunk.subarray(w.offset,w.offset+size);
      this.sendBytes-=size;this.sendFrames--;w.offset+=size;
      await this.session.send(F.DATA,this.id,data);
    }}catch(e){this.destroy(e)}finally{this.pumping=false;if(this.writePending&&this.opened&&!this.destroyed&&this.sendFrames&&this.sendBytes)queueMicrotask(()=>this.pump())}
  }
  _final(callback){
    // O caller fecha somente após receber a resposta de aplicação; não usa
    // half-close para sinalizar término de upload dentro de CONNECT/TLS.
    if(this.remoteEnded||this.session.closed){callback();return}
    this.session.send(F.END,this.id,{...p.identity(this.binding),reason:'peer_end'}).then(()=>callback(),callback);
  }
  _destroy(error,callback){
    clearTimeout(this.openTimer);this.rejectReady(error||Error('connection_closed'));
    if(this.writePending){const w=this.writePending;this.writePending=null;w.callback(error||Error('connection_closed'))}
    this.session.flows.delete(this.id);
    if(!this.remoteEnded&&!this.session.closed)this.session.send(F.END,this.id,{...p.identity(this.binding),reason:'peer_end'}).catch(()=>{});
    callback(error);
  }
}
module.exports={CarrierSession,CarrierFlow,features};
