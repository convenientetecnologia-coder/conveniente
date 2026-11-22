'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{retryPlan,isTransient}=require('./stockProvisionRetry');
test('falhas técnicas observadas em produção não encerram cadastro como falha definitiva',()=>{
 for(const error of ['maintenance','carrier_maintenance','operation_control_in_flight','carrier_ack_timeout'])assert.equal(isTransient(error),true,error);
 for(const error of ['HTTP/1.1 502 Bad Gateway','HTTP/1.1 503 Service Unavailable','HTTP/1.1 504 Gateway Timeout','cp2_uncertain_transport_not_closed','cp2_previous_operation_not_closed'])assert.equal(isTransient(error),true,error);
 for(const error of ['HTTP/1.1 401 Unauthorized','HTTP/1.1 403 Forbidden','identity_required','still_login_required:login_form','captcha timeout'])assert.equal(isTransient(error),false,error);
});
test('temporary transport failure retains only failed actions, reusing account and command',()=>{
 const record={id:'same-command',payload:{actions:[{stockAccountId:1},{stockAccountId:2},{stockAccountId:3}]}};
 const output={results:[{type:'stock_provision',details:{results:[{stockAccountId:1,ok:true},{stockAccountId:2,ok:false,error:'carrier_unavailable'},{stockAccountId:3,ok:false,error:'identity_required'}]}}]};
 const next=retryPlan(record,output,1000);assert.equal(next.id,record.id);assert.deepEqual(next.stockAccountIds,[2]);assert.equal(next.nextAttemptAt,31000);assert.equal(record.payload.actions.length,3);
});
test('retry survives restart with bounded delay and never retries identity or authentication errors',()=>{
 assert.equal(isTransient('timeout'),true);
 const record={id:'same',retryCount:999999,payload:{actions:[{stockAccountId:1}]}};
 const output={results:[{type:'stock_provision',error:'provision_lock_busy'}]};const next=retryPlan(JSON.parse(JSON.stringify(record)),output,1000);assert.equal(next.retryCount,1000000);assert.equal(next.nextAttemptAt,301000);
 for(const error of ['identity_required','configure_blocked_url_checkpoint','still_login_required:login_wall','unauthorized','captcha timeout'])assert.equal(isTransient(error),false);
 assert.equal(retryPlan(record,{results:[{type:'stock_provision',error:'identity_required'}]}),null);
 const queued={id:'same',payload:{actions:[{stockAccountId:2}]}};
 assert.equal(retryPlan(queued,{results:[{type:'stock_provision',details:{results:[{stockAccountId:2,profileName:'cidade-1',ok:false,error:'carrier_unavailable'}]}}]},1000),null);
});
