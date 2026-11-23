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
test('explosão sem marca fica pendente, vai para o fim e para na quinta',async()=>{
 const d={perfis:{account:{provisioningPending:true},other:{provisioningPending:true}}};
 await settle([{profileName:'account',ok:false,error:'unexpected_worker_error'}],{update:async fn=>fn(d),now:()=>1000});
 assert.equal(d.perfis.account.provisioningPending,true);assert.equal(d.perfis.account.provisioningAttempts,1);assert.equal(d.perfis.account.provisioningNextAt,31000);assert.equal(d.perfis.account.provisioningResult,undefined);
 const {nextCadastro}=require('./accountProvisioningState');
 assert.equal(nextCadastro(d.perfis,1000).nome,'other');
 d.perfis.account.provisioningAttempts=4;d.perfis.account.provisioningNextAt=0;
 await settle([{profileName:'account',ok:false,error:'cadastro_account_identity_mismatch'}],{update:async fn=>fn(d),now:()=>2000});
 assert.equal(d.perfis.account.provisioningPending,false);assert.equal(d.perfis.account.provisioningResult.reason,'cadastro_attempts_exhausted');assert.equal(unready(d.perfis.account),true);
});
test('recurso e mercado fecham o pendente; espera de cadeado não conta tentativa',async()=>{
 const appeal={perfis:{account:{provisioningPending:true}}};await settle([{profileName:'account',ok:false,error:'appeal_submitted'}],{update:async fn=>fn(appeal),now:()=>100});
 assert.equal(appeal.perfis.account.provisioningPending,false);assert.equal(appeal.perfis.account.provisioningResult.reason,'appeal_submitted');
 const pin={perfis:{account:{provisioningPending:true}}};await settle([{profileName:'account',ok:false,error:'messenger_pin'}],{update:async fn=>fn(pin),now:()=>100});
 assert.equal(pin.perfis.account.provisioningPending,false);assert.equal(pin.perfis.account.provisioningResult.reason,'messenger_pin');
 const wait={perfis:{account:{provisioningPending:true,provisioningAttempts:2}}};await settle([{profileName:'account',ok:false,error:'provision_lock_busy owner=stock'}],{update:async fn=>fn(wait),now:()=>1000});
 assert.equal(wait.perfis.account.provisioningPending,true);assert.equal(wait.perfis.account.provisioningAttempts,2);assert.equal(wait.perfis.account.provisioningNextAt,31000);
});
test('fila pega uma conta vencida e a que explodiu espera a vez',()=>{
 const {nextCadastro,mayWriteCadastroMark,runAsCadastro,cadastroIsWriting}=require('./accountProvisioningState');
 const perfis={a:{provisioningPending:true,provisioningNextAt:9000},b:{provisioningPending:true,provisioningNextAt:0},c:{provisioningPending:false}};
 assert.equal(nextCadastro(perfis,1000).nome,'b');
 assert.equal(nextCadastro({a:perfis.a},1000).nome,null);assert.equal(nextCadastro({a:perfis.a},1000).waitMs,8000);
 assert.equal(mayWriteCadastroMark(false,true),false);assert.equal(mayWriteCadastroMark(true,true),true);assert.equal(mayWriteCadastroMark(false,false),true);
 assert.equal(cadastroIsWriting(),false);runAsCadastro(()=>assert.equal(cadastroIsWriting(),true));
});
test('capacity and transport deferrals do not exhaust cadastro or claim that credentials failed',async()=>{
 for(const error of ['supervisor_denied:slots','supervisor_denied:ram_low','governor_busy','fetch failed','cadastro_proxy_transport_unhealthy']){
  const d={perfis:{a:{provisioningPending:true,provisioningAttempts:4}}};
  for(let i=0;i<8;i++)await settle([{profileName:'a',ok:false,error}],{update:async f=>f(d),now:()=>1000});
  assert.equal(d.perfis.a.provisioningAttempts,4);assert.equal(d.perfis.a.provisioningPending,true);assert.equal(d.perfis.a.provisioningResult,undefined);assert.equal(d.perfis.a.provisioningDeferrals,8);assert.equal(d.perfis.a.provisioningWaitReason,error);
 }
});
