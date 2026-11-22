'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{unready,settle}=require('./accountProvisioningState');
test('resultado real encerra pendência com motivo sem liberar conta restrita para trabalhar',async()=>{
 const desired={perfis:{account:{provisioningPending:true,active:true,virtus:'on'}}};
 await settle([{profileName:'account',ok:false,error:'configure_blocked_two_factor'}],{update:async fn=>fn(desired),now:()=>100});
 const p=desired.perfis.account;assert.equal(p.provisioningPending,false);assert.equal(p.provisioningResult.reason,'two_factor');assert.equal(p.provisioningResult.at,100);assert.equal(p.active,false);assert.equal(unready(p),true);
});
test('falha técnica permanece recuperável e sucesso antigo não é rebaixado por retorno atrasado',async()=>{
 for(const error of ['HTTP/1.1 502 Bad Gateway','cp2_uncertain_transport_not_closed','timeout']){const d={perfis:{account:{provisioningPending:true}}};await settle([{profileName:'account',ok:false,error}],{update:async fn=>fn(d)});assert.equal(d.perfis.account.provisioningPending,true);assert.equal(d.perfis.account.provisioningResult,undefined)}
 const d={perfis:{account:{active:true}}};await settle([{profileName:'account',ok:false,error:'identity_required'}],{update:async fn=>fn(d)});assert.equal(d.perfis.account.provisioningResult,undefined);assert.equal(d.perfis.account.active,true);
});
test('erro sem retry termina com falha técnica explícita, sem inventar restrição de identidade',async()=>{
 for(const error of ['cadastro_account_identity_mismatch','cadastro_expected_identity_missing','unexpected_worker_error']){
  const d={perfis:{account:{provisioningPending:true}}};await settle([{profileName:'account',ok:false,error}],{update:async fn=>fn(d)});
  assert.equal(d.perfis.account.provisioningPending,false);assert.equal(d.perfis.account.provisioningResult.state,'failed');assert.equal(d.perfis.account.provisioningResult.reason,'technical_failure');assert.equal(unready(d.perfis.account),true);
 }
});
