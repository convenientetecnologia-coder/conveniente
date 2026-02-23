# INFORMACOES_CONTINUIDADE_GPT — handoff completo para novo chat

Data de geração: 2026-02-23
Escopo: continuidade do programa "novo fluxo de leads por sorteio + cobrança" + qualificação (porte) + contestação (V2.1) + DR/Backup

---

## COPIAR/COLAR NO NOVO CHAT (handoff ultra enterprise)

Cole este bloco como 1ª mensagem no novo chat:

---

Você é o novo GPT operador. Objetivo: continuar o programa **cliente -> grupo -> sorteio -> vencedor -> cobrança -> (porte) -> (contestação V2.1)** sem perder nenhuma decisão já congelada e sem regressão.

### Leitura obrigatória (ordem)
1) `C:\conveniente\docs\INFORMACOES_CONTINUIDADE_GPT.md` (este arquivo)  
2) `C:\conveniente\docs\inbox\INDEX.md` (status de verdade)  
3) `C:\conveniente\docs\inbox\in_progress\INC-20260219-0900-01.md` (mestre do programa)  
4) Porte (qualificação): `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2230-01.md`  
5) Contestação (CANÔNICO V2.1): `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2310-01.md`  
6) Dossiê/Playbook/Plano técnico (contestação V2.1):
   - `C:\conveniente\docs\checkups\checkup_2026-02-20_contestacao_v2_dossie_ponta_a_ponta_pre_codigo.md`
   - `C:\conveniente\docs\checkups\playbook_operacional_contestacao_v2_1.md`
   - `C:\conveniente\docs\checkups\plano_tecnico_formal_v1_contestacao_p0_p1_p2.md`
7) Evidência objetiva (simulação offline):
   - `C:\conveniente\docs\checkups\checkup_2026-02-20_simulacao_pesada_p0_p1_validacao.md`

### Decisões congeladas (não inventar regra nova)
- **Contestação V2.1 é a única base de implementação.** V1 (6h/6 motivos) existe só como histórico.
- **Janela de contestação:** até **23h**.
- **Motivos (menu fechado):** M1/M2/M3/M4 (4 motivos).
- **M1/M2/M3:** sempre validação com cliente via Virtus antes de fechar (estorno / reabertura / manter ativo).
- **M4:** sempre fila manual CT.
- **Cadência M1 (sem spam):** T+15 (motorista), T+3h (cliente), T+23h (fechamento). Entre T+3h e T+23h: no máx 1 lembrete cliente.
- **Regra de ouro:** M1 **nunca encerra antes de 23h**.
- **Reabertura no grupo:** no máx **1** reenvio automático por atendimento; depois disso é manual.
- **Financeiro:** estorno **total**, **atômico**, **idempotente** e **somente** do `lead_token` contestado (nunca “estornar outros leads” por efeito colateral).
- **Referência humana:** após sorteio, o atendimento deve ser “sobre o telefone do cliente” no CT/ops; `lead_token` é chave técnica/auditável.
- **Auditoria obrigatória:** `driver_id`, `phone_digits`, `lead_token`, `motivo`, `decisao`, `actor_user_id`, `requestId`, `timestamp`.
- **Porte:** nesta fase é **informativo**, mas o texto exibido para motorista deve bater 1:1 com a opção escolhida pelo cliente (item curto + descrição completa, sem truncar).

### O que já existe (evidência + base técnica)
- Suítes offline/forense rodadas e registradas (PASS em atomicidade/lock/idempotência): ver `checkup_2026-02-20_simulacao_pesada_p0_p1_validacao.md`.
- Contestação V2.1: dossiê, playbook e plano técnico formal já existem (paths acima).
- Inbox/INC foi reorganizado por `state` (done/need_evidence/in_progress) e `docs/inbox/INDEX.md` foi alinhado.

Base técnica já codificada (local, sem pressupor rollout):
- Normalização única de telefone (fonte única): `C:\sitechatbot\lib\phoneCanon.js`
- Porte (novo passo no WhatsApp + persistência + payload): `C:\sitechatbot\whatsapp\lib\flow.js` + `C:\sitechatbot\whatsapp\lib\db.js`
- Porte e copy do tokenized (mensagem de janela “3 minutos após o primeiro entrar”): `C:\sitechatbot\lib\pedidosStore.js`
- ACK endurecido (ownership `workerId` + idempotência): `C:\sitechatbot\lib\pedidosStore.js` (validado por simulação offline)
- Ledger CT usando normalização canônica: `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`
- Schema base de contestação (tabelas `ct_lead_contestation_*` + vínculos no ledger): `C:\sitechatbot\convenientetecnologia\lib\ctDb.js`

### Próximos passos (ordem “sem desvio”)
1) Confirmar no código (sem enviar mensagem para grupos) que as bases P0/P1 continuam ok: idempotência/ACK/lock ownership/normalização de telefone.
2) Implementar/rodar a simulação P2 de volume (500–600/dia) para cadência M1 + validação com cliente + reabertura max 1.
3) Só depois iniciar rollout controlado (piloto), sempre com rollback fácil.

### Proibidos (para evitar regressão/custo)
- Não usar política V1 como base.
- Não rodar comandos “stress suite” sem deadline/timeouts (evitar “travou e ficou infinito”).
- Não enviar nada para grupos produtivos durante simulação.

---

## Leitura obrigatória (ordem)

1. `C:\conveniente\docs\LIVRO_DE_BORDO.md`
2. `C:\conveniente\docs\RUNBOOK_TECNICO.md`
3. `C:\conveniente\docs\TIMELINE.md`
4. `C:\conveniente\docs\checkups\checkup_2026-02-19_novo_fluxo_leads_sorteio_cobranca.md`
5. `C:\conveniente\docs\inbox\INDEX.md`
6. INCs canônicos (ordem recomendada):
   - Mestre do programa:
     - `C:\conveniente\docs\inbox\in_progress\INC-20260219-0900-01.md`
   - Já encerrados (bloco 20260219):
     - `C:\conveniente\docs\inbox\done\INC-20260219-0910-01.md`
     - `C:\conveniente\docs\inbox\done\INC-20260219-0920-01.md`
     - `C:\conveniente\docs\inbox\done\INC-20260219-0930-01.md`
     - `C:\conveniente\docs\inbox\done\INC-20260219-0940-01.md`
     - `C:\conveniente\docs\inbox\done\INC-20260219-1000-01.md`
     - `C:\conveniente\docs\inbox\done\INC-20260219-1010-01.md`
     - `C:\conveniente\docs\inbox\done\INC-20260219-1020-01.md`
   - Ainda em desenho/alinhamento:
     - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0950-01.md` (Motoristas WhatsApp no CT)
     - `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2230-01.md` (Porte)
     - `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2310-01.md` (Contestação V2.1)
   - DR/Backup (encerrado):
     - `C:\conveniente\docs\inbox\done\INC-20260220-2230-01.md`
7. Checkups canônicos desta rodada (evidência objetiva):
   - `C:\conveniente\docs\checkups\checkup_2026-02-20_auditoria_ponta_a_ponta_pre_codigo.md`
   - `C:\conveniente\docs\checkups\checkup_2026-02-20_contestacao_v2_dossie_ponta_a_ponta_pre_codigo.md`
   - `C:\conveniente\docs\checkups\playbook_operacional_contestacao_v2_1.md`
   - `C:\conveniente\docs\checkups\plano_tecnico_formal_v1_contestacao_p0_p1_p2.md`
   - `C:\conveniente\docs\checkups\checkup_2026-02-20_simulacao_pesada_p0_p1_validacao.md`
8. Contrato Asaas local:
   - `C:\sitechatbot\docs\INTEGRACAO_ASAAS.md`

---

## Estado real atual (sem maquiagem)

- A triagem e os INCs foram **reorganizados por pasta conforme o `state`** (ver `docs/inbox/INDEX.md`).
- Já existe base técnica validada por simulações forenses/offline (idempotência/lock/atomicidade) e evidência documentada no checkup de simulação pesada.
- Contestação (V2.1) está **com regras e dossiê canônico fechados**, e já existe schema base no CT (tabelas `ct_lead_contestation_*`), mas o runtime/fluxo ainda é faseado.

---

## Atualização humana mais recente (regra de cobrança) — canônica

- Cobrança automática em dias úteis (segunda a sexta) às 08:00.
- Bloqueio por inadimplência às 15:00 do mesmo dia.
- Competência:
  - segunda cobra leads de sexta/sábado/domingo e também de segunda;
  - terça cobra leads de segunda;
  - quarta cobra leads de terça;
  - quinta cobra leads de quarta;
  - sexta cobra leads de quinta.
- Janela operacional humana: segunda a sexta, 10:00-17:00.

Observação: esta regra foi propagada nos docs do programa e no contrato Asaas; o protótipo no CT já foi alinhado (ver checklist abaixo).

---

## Checklist anti-confusão (canônico vs protótipo)

Canônico (regra de negócio atual):
- seg-sex 08:00 emite cobrança; 15:00 bloqueia se pendente; competência conforme seção acima;
- funcionamento interno: seg-sex 10:00–17:00 (impacta mensagens/SLA ao motorista).

Protótipo (código já existe e já está alinhado à regra canônica):
- `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`:
  - `isBillingDay(...)` é **segunda a sexta**;
  - `LEAD_BILLING_BLOCK_HOUR` default é **15**;
  - scheduler não inclui `lead_award` do dia no invoice do próprio dia (competência).
- `C:\sitechatbot\tools\validate_billing_window_rule.js` valida bloqueio em **15:01** (passando).

Regra: o E2E (`INC-20260219-1010-01`) deve provar que essa base fica estável junto do restante do fluxo.

---

## O que já foi feito nesta rodada de handoff

- Atualizada regra de cobrança no INC financeiro:
  - `C:\conveniente\docs\inbox\done\INC-20260219-0940-01.md`
- Atualizado índice dos INCs:
  - `C:\conveniente\docs\inbox\INDEX.md`
- Atualizado intake canônico com adendo de regra:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
- Atualizado runbook (seção experimental Asaas):
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- Atualizado checkup canônico do programa:
  - `C:\conveniente\docs\checkups\checkup_2026-02-19_novo_fluxo_leads_sorteio_cobranca.md`
- Atualizado contrato Asaas do CT:
  - `C:\sitechatbot\docs\INTEGRACAO_ASAAS.md`
- Alinhado protótipo de ledger/scheduler no CT com a regra canônica (seg-sex 08:00 / bloqueio 15:00 / competência):
  - `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`
  - prova: `C:\sitechatbot\tools\validate_billing_window_rule.js` (passando)
- Simulação pesada offline (PASS) com evidência objetiva:
  - `C:\conveniente\docs\checkups\checkup_2026-02-20_simulacao_pesada_p0_p1_validacao.md`

---

## Pendências objetivas antes de codar forte

1. Fechar decisões do gate do INC mestre `0900` (especialmente elegibilidade e política de reemissão Asaas).
2. Registrar evidência mínima de rotação/revogação do segredo do `INC-20260219-1020-01` (sem segredos).
3. Definir rollout por `groupId` (pilotos exatos) com fallback imediato.
4. P2: simulação em volume da cadência M1 (T+15, T+3h, T+23h) conforme dossiê V2.1.
5. Evoluir CT UI: menu “Motoristas WhatsApp” + fila de contestação (Fase 5 do plano).

---

## Instruções operacionais para o próximo GPT

- Não tratar documentação como prova de runtime; validar sempre no código e logs.
- Manter regra de não regressão: legado intocado com flags OFF.
- Toda mudança relevante deve atualizar `TIMELINE.md` no mesmo ciclo.
- Se mexer em runtime, declarar claramente necessidade de restart por projeto (`conveniente`, `sitechatbot`, `notificador`).
- Nunca registrar segredo em texto puro (apenas nomes de variáveis e evidência de rotação).

