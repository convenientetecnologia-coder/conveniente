### Timeline — mudanças (mais novo em cima)

Regra: toda mudança relevante entra aqui com:
- tags (projeto/área),
- o que mudou,
- por que mudou,
- evidência (arquivo/endpoint/log),
- impacto operacional (reinícios),
- rollback.

Tags (modelo A = timeline única):
- `[CONV]`: conveniente
- `[CT]`: sitechatbot / CT
- `[NOTIF]`: notificador
- `[CROSS]`: envolve 2+ sistemas (sempre use junto com as tags de cada sistema)
- `[DOCS]`: documentação/organização (sem runtime)
- `[OPS]`: operação (procedimentos/rollback/restart)

Quando for “a mesma iniciativa” em mais de um sistema, usar um identificador:
- `THREAD=TH-YYYY-MM-DD-slug-curto`

Formato canônico (copiar/colar):

- `#### YYYY-MM-DD — [TAGS...] Título curto`
- **O que**: 1–5 bullets (sem detalhe excessivo)
- **Por quê**: 1 frase
- **Evidência**: caminho de arquivo / endpoint / log (ou “ver checkup X”)
- **Reinícios**: quais serviços/nodes precisam reiniciar (ou “nenhum”)
- **Rollback**: como desfazer (1–2 linhas)
- **THREAD**: `TH-...` (somente quando `[CROSS]`)

---

#### 2026-03-07 — [CONV][OPS][DOCS] P2 safe-mode: recovery serial por perfil + fila 15–30min + robe 20–35min

- **O que**:
  - aplicada governança de recovery com estado único por perfil (evita concorrência simultânea de LR/captcha/identity/appeal no mesmo perfil);
  - adicionada transição de follow-up por perfil para preservar fluxo natural de recuperação em sequência;
  - adicionado guardrail anti-conta saudável parada (`virtus_off_auto_heal_guardrail`);
  - acelerada fila global de recovery para `15–30 min` (defaults);
  - recalibrado cooldown padrão do `Robe` para `20–35 min`;
  - desativado `dbg_agent_runtime` legado por padrão (`LEGACY_RUNTIME_DEBUG=1` para habilitar).
- **Por quê**: reduzir comportamento de pânico/competição em recovery sem sacrificar continuidade de Virtus/Robe.
- **Evidência**:
  - código: `C:\conveniente\scripts\worker.js`, `C:\conveniente\scripts\virtus.js`, `C:\conveniente\scripts\robe.js`
  - INC: `C:\conveniente\docs\inbox\need_evidence\INC-20260305-1815-01.md`
- **Reinícios**: `conveniente` no host alvo (RM7) após `self_update` (`node index.js`).
- **Rollback**: reverter este commit, disparar `self_update` e reiniciar o runtime.

#### 2026-03-07 — [CONV][OPS][DOCS] P1 anti-pânico: LR scan desacelerado (5min saudável / 20min risco)

- **O que**:
  - aplicado gate de cadência por perfil no `lr_scan_tabs` do nurse;
  - perfil saudável passou para janela de ~5min (com jitter);
  - perfil em risco (LR/captcha/identity/appeal/twoFactor/messengerPin) passou para janela de ~20min (com jitter);
  - adicionada telemetria de pacing (`lr_scan_deferred`, `lr_scan_cadence_applied`).
- **Por quê**: reduzir comportamento robótico de varredura em segundos, mantendo detecção com ritmo humano.
- **Evidência**:
  - código: `C:\conveniente\scripts\worker.js`
  - INC: `C:\conveniente\docs\inbox\need_evidence\INC-20260305-1815-01.md`
- **Reinícios**: `conveniente` no host alvo (RM7) após `self_update` (`node index.js`).
- **Rollback**: reverter este commit no `worker.js`, disparar `self_update` e reiniciar o runtime.

#### 2026-03-07 — [CONV][OPS][DOCS] F0 anti-rajada no nurse/open (backoff progressivo + gate por perfil)

- **O que**:
  - removido comportamento de retry curto fixo (`3s`) em `nurse_open` sob `ram_low/supervisor_denied`;
  - aplicado backoff progressivo por perfil com teto e jitter;
  - adicionado gate de skip durante `activationHeldUntil` e telemetria nova de contenção (`nurse_open_backoff_skip`, `nurse_open_backoff_applied`);
  - reset de estado de backoff/streak após abertura bem-sucedida.
- **Por quê**: conter rajadas cíclicas de reabertura (~10s) que elevam pressão operacional e risco anti-abuso.
- **Evidência**:
  - código: `C:\conveniente\scripts\worker.js`
  - INC: `C:\conveniente\docs\inbox\need_evidence\INC-20260305-1815-01.md`
- **Reinícios**: `conveniente` no host alvo (RM7) após `self_update` (`node index.js`).
- **Rollback**: reverter este commit no `worker.js`, disparar `self_update` e reiniciar o runtime.

#### 2026-03-05 — [DOCS][CONV][OPS] Auditoria pré-código da migração Chrome -> Chromium (com baseline de backup)

- **O que**:
  - executada auditoria ponta a ponta do fluxo de browser/session no `conveniente` antes de codar a migração;
  - identificado que o runtime já aceita `CHROMIUM_PATH`, mas a descoberta default no Windows ainda privilegia paths do Google Chrome;
  - identificado risco de drift em service mode (bootstrap não propaga env de engine/executable por padrão);
  - registrado checkup técnico e atualização do INC de migração; backup baseline concluído e anexado como dependência atendida.
- **Por quê**: reduzir risco de regressão em produção e evitar mudança parcial/ambígua na troca de engine.
- **Evidência**:
  - checkup: `C:\conveniente\docs\checkups\checkup_2026-03-05_migracao_chromium_pre_codigo.md`
  - INC migração: `C:\conveniente\docs\inbox\in_progress\INC-20260305-0900-01.md`
  - INC backup (done): `C:\conveniente\docs\inbox\done\INC-20260305-0900-02.md`
  - backup: `C:\sitechatbot\backups\conveniente_full_20260305_140355\_backup_manifest.json`
- **Reinícios**: nenhum (somente auditoria/documentação).
- **Rollback**: reverter os arquivos de docs/checkup/INC/timeline desta rodada.

#### 2026-03-05 — [DOCS][CONV][OPS] Auditoria E2E “olhos de deus” (Chromium + sessões + persistência)

- **O que**:
  - consolidado dossiê E2E com resposta objetiva por requisito:
    - Chromium sem fallback para Chrome,
    - reaproveitamento das sessões já salvas,
    - persistência de sessão quente em operação,
    - UX nome/email no perfil do navegador;
  - evidenciado que reuso de sessão e atualização de cookies já são automáticos hoje, enquanto “Chromium estrito sem fallback” e UX nome/email ainda são pendências de implementação.
- **Por quê**: travar critérios de aceite reais antes de codar, evitando rollout parcial ou interpretação ambígua.
- **Evidência**:
  - checkup E2E: `C:\conveniente\docs\checkups\checkup_2026-03-05_auditoria_e2e_chromium_sessoes.md`
  - INC: `C:\conveniente\docs\inbox\in_progress\INC-20260305-0900-01.md`
- **Reinícios**: nenhum (somente auditoria/documentação).
- **Rollback**: reverter docs desta entrada se necessário.

#### 2026-03-05 — [CONV][OPS][DOCS] Fase 1 aplicada: Chromium estrito sem fallback para Chrome (código)

- **O que**:
  - implementada seleção explícita de engine no launcher (`BROWSER_ENGINE`, default `chromium`);
  - em modo `chromium`, removido fallback para Chrome e adicionado erro explícito quando Chromium não é encontrado;
  - bootstrap de serviço atualizado para propagar envs de engine/path (`BROWSER_ENGINE`, `CHROMIUM_PATH`, `CHROME_PATH`);
  - instalador atualizado para tratar Chromium como obrigatório e validar presença pós-instalação.
- **Por quê**: garantir migração determinística para Chromium em todos os hosts, sem “falso positivo” por fallback silencioso para Chrome.
- **Evidência**:
  - checkup: `C:\conveniente\docs\checkups\checkup_2026-03-05_fase1_chromium_estrito_impl.md`
  - código: `C:\conveniente\scripts\browser.js`, `C:\conveniente\scripts\bootstrapService.js`, `C:\conveniente\instalar_conveniente.ps1`
- **Reinícios**: após deploy no host alvo, reiniciar `conveniente` (`node index.js`).
- **Rollback**: revert dos arquivos acima + deploy + restart.

#### 2026-03-03 — [CT][OPS][DOCS] Janela de cobrança: bloqueio/vencimento alterado de 15h para 10h

- **O que**:
  - atualizado o motor de cobrança para manter emissão em **segunda/quinta 22:00** e aplicar bloqueio/vencimento em **10:00** no próximo ciclo;
  - atualizado texto técnico da fatura automática para refletir `bloqueio 10h`;
  - atualizado teste canônico de janela de cobrança para validar bloqueio em 10:00 (segunda->quinta e quinta->segunda).
- **Por quê**: ajuste operacional solicitado para antecipar horário de vencimento/bloqueio sem alterar os dias de emissão.
- **Evidência**:
  - `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`
  - `C:\sitechatbot\tools\validate_billing_window_rule.js`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **Reinícios**: `sitechatbot` (`node index.js`) para aplicar a nova regra no runtime.
- **Rollback**: restaurar `BILLING_BLOCK_HOUR=15` e string de nota em `ctLeadLedgerStore.js`; reiniciar `sitechatbot`.

#### 2026-03-03 — [DOCS][CT][OPS] Auditoria forense RM1..RM7 (exclusões de contas em 24h/48h/72h/96h)

- **O que**:
  - executada auditoria de exclusões para os hosts ROBE MÃE 1..7 usando `deleted_on_server_at` como evento canônico de queda/exclusão no servidor;
  - cruzadas, por evento, as três datas pedidas: cadastro no estoque (`ct_fb_stock_accounts.created_at`), cadastro no servidor (`ct_fb_stock_server_profiles.created_at`) e exclusão (`deleted_on_server_at`);
  - gerados artefatos em Markdown (leitura humana) e JSON (evidência estruturada) com resumo por janela, por host, por tipo (`source_kind`) e detalhe linha a linha (96h).
- **Por quê**: dar visibilidade objetiva de “quais contas estão caindo”, com trilha temporal completa e sem achismo.
- **Evidência**:
  - checkup: `C:\conveniente\docs\checkups\checkup_2026-03-03_auditoria_exclusoes_rm1_rm7_24h_48h_72h_96h.md`
  - JSON: `C:\conveniente\docs\checkups\checkup_2026-03-03_auditoria_exclusoes_rm1_rm7_24h_48h_72h_96h.json`
  - INC: `C:\conveniente\docs\inbox\done\INC-20260303-1755-01.md`
- **Reinícios**: nenhum (somente leitura de banco + documentação).
- **Rollback**: reverter apenas os arquivos de docs/checkup se necessário.

#### 2026-03-03 — [DOCS][CT][OPS] Refino forense: causa real da exclusão (ban/2FA/manual) separada do evento operacional

- **O que**:
  - ajustado o dossiê humano para distinguir claramente:
    - evento operacional (`missing_in_snapshot` / `ct_delete`) e
    - causa real da conta (extraída de `stock_evidence/<stock_account_id>/meta.json`, campo `reason`);
  - gerada lista 96h por servidor com causa real em português claro e coluna técnica bruta para auditoria.
- **Por quê**: evitar interpretação errada de que `missing_in_snapshot` seria “ban/2FA”; isso é apenas marcador de reconciliação de inventário.
- **Evidência**:
  - novo relatório: `C:\conveniente\docs\checkups\checkup_2026-03-03_lista_humana_exclusoes_96h_com_causa_real.md`
  - fonte de causa real: `C:\sitechatbot\dados\stock_evidence\<stock_account_id>\meta.json`
- **Reinícios**: nenhum (somente auditoria/documentação).
- **Rollback**: reverter arquivo de checkup desta rodada.

#### 2026-03-03 — [DOCS][CT][OPS][FORENSE] Dossiê UAFP das exclusões (10 dias) com concentração e percentuais

- **O que**:
  - criado relatório forense dedicado para padrão UAFP (UA + fingerprint resumido) nas contas excluídas dos ROBE MÃE 1..7;
  - calculados percentuais por causa real, por servidor, por UA, por FP e por combinação UAFP, incluindo concentração dos Top 5;
  - incluída seção de “sinais de padrão ruim” para destacar UAFP com alta recorrência de banida/desativada.
- **Por quê**: responder objetivamente se há padrão repetitivo de UAFP nas exclusões ou se está distribuído.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-03-03_auditoria_forense_uafp_exclusoes_10dias.md`
  - fontes: `C:\sitechatbot\dados\convenientetecnologia.sqlite` + `C:\sitechatbot\dados\stock_evidence\<stock_account_id>\meta.json`
- **Reinícios**: nenhum (somente leitura/relatório).
- **Rollback**: reverter arquivo de checkup desta rodada.

#### 2026-03-02 — [CT][DOCS][CROSS][OPS] Fechamento INC-20260302-1500-01 (sorteio justo por “carga” + contestação não zera prioridade)

- **O que**:
  - ranking de sorteio passou a usar **carga** (ledger + faturas) com `LEAD_LOTTERY_RANK_MODE=load` (mantém `legacy` disponível por flag);
  - contestação estorna valor, mas **mantém carga** para justiça até pagamento/baixa da competência;
  - mensagem de cobrança WhatsApp ajustada para explicar que **boletos em aberto reduzem prioridade** e que pagar baixa a competência (melhorando prioridade nas próximas rodadas).
- **Por quê**: remover incentivo involuntário de “contestar para voltar a 0 e ganhar de novo” e reforçar pagamento como mecanismo justo de zeragem por competência.
- **Evidência**:
  - INC fechado: `C:\conveniente\docs\inbox\done\INC-20260302-1500-01.md`
  - auditoria runtime (snapshot): `C:\sitechatbot\dados\audit_tiebreak_postrun.json`
  - testes isolados R1..R7: `C:\sitechatbot\tools\validate_lottery_load_r1_r7.js`
  - mensagem cobrança: `C:\sitechatbot\whatsapp\lib\timeouts.js`
- **Reinícios**: `sitechatbot` (`node index.js`) para aplicar texto de mensagem em runtime (mudança de WhatsApp).
- **Rollback**: setar `LEAD_LOTTERY_RANK_MODE=legacy` (comportamento de ranking anterior) e reverter `whatsapp/lib/timeouts.js` para o texto anterior.
- **THREAD**: `TH-2026-03-02-sorteio-carga-contestacao`

#### 2026-03-02 — [CT][OPS][FINANCEIRO] Migração tokenized: correção do sinal de “crédito em dobro” (ledger)

- **O que**:
  - identificado que o lote `tokenized_credito_dobro_lote1_2026-02-27` lançou `manual_adjustment.amount_cents` **positivo** (que no ledger significa **dívida**);
  - aplicada correção idempotente por `correction_key=tokenized_credito_dobro_lote1_2026-02-27__sign_fix_v1` (compensação de \(-2x\) do lançamento original por motorista);
  - hardening do playbook: scripts de migração/correção agora exigem `--apply --confirm` e validam direção `negative_is_credit`.
- **Por quê**: crédito no ledger é representado por valor **negativo**; um lançamento positivo transforma crédito em dívida e gera reclamação imediata.
- **Evidência**:
  - script da migração (guard rails de crédito): `C:\sitechatbot\tools\apply_tokenized_credit_migration_lote1.js`
  - script de correção (idempotente): `C:\sitechatbot\tools\fix_tokenized_credit_migration_lote1_sign.js`
  - auditoria (pré e pós): `C:\sitechatbot\tools\audit_tokenized_migration_lote1.js`
  - relatórios forenses (contêm PII; não commitar): `C:\sitechatbot\dados\forensics\tokenized_credit_migration_lote1_sign_fix_*.json` e `C:\sitechatbot\dados\forensics\tokenized_credit_migration_lote1_audit_postfix_2026-03-02.json`
- **Reinícios**: nenhum (mudança é em SQLite; refletida imediatamente nas leituras do CT).
- **Rollback**: aplicar ajuste compensatório inverso (novo `manual_adjustment`) referenciando o mesmo `correction_key` (não apagar histórico).

#### 2026-02-26 — [DOCS][INBOX] Fechamento e alinhamento dos INCs (sem divergência)

- **O que**:
  - alinhado “arquivo real” vs `docs/inbox/INDEX.md` e movidos INCs concluídos para `docs/inbox/done/`;
  - corrigidos paths/citações no `docs/LIVRO_DE_BORDO.md` para refletir estado real.
- **Por quê**: evitar operação “no escuro” com INCs marcados errado (fonte única do status é arquivo+índice coerentes).
- **Evidência**:
  - `docs/inbox/INDEX.md`
  - `docs/inbox/done/INC-20260222-2310-01.md`
  - `docs/inbox/done/INC-20260224-0005-01.md`
  - `docs/inbox/done/INC-20260224-1600-01.md`
  - `docs/inbox/done/INC-20260225-1400-01.md`
  - `docs/LIVRO_DE_BORDO.md`
- **Reinícios**: nenhum (somente docs/organização).
- **Rollback**: reverter commit de docs desta rodada.

#### 2026-02-26 — [DOCS][CT][NOTIF][CROSS][OPS] Dossie pre-codigo Contestacao: auditoria ponta a ponta + matriz de metricas e queries congeladas

- **O que**:
  - consolidado dossie mestre de auditoria pre-codigo para menu "Contestacao", com anexos por modulo (CT contestacao, ledger/Asaas, WhatsApp, tokenized ciclos, notificador/ACK);
  - congelada matriz de metricas com definicao humana + tecnica e queries de referencia para Hoje/Ontem/MTD/Custom;
  - registrado risco P0/P1/P2 com evidencias por funcao/arquivo para gate Go/No-Go antes de qualquer endpoint/UI.
- **Por quê**: eliminar ambiguidade antes de codar, garantir fonte de verdade unica e reduzir risco de regressao operacional/financeira.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_dossie_auditoria_contestacao_pre_codigo.md`
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_anexo_contestacao_ct.md`
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_anexo_ledger_financeiro_asaas.md`
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_anexo_whatsapp_contestacao.md`
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_anexo_tokenized_ciclos.md`
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_anexo_notificador_ack.md`
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_matriz_metricas_queries_contestacao.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260226-1500-01.md`
- **Reinícios**: nenhum (somente documentação e auditoria).
- **Rollback**: reverter commit de docs desta rodada.
- **THREAD**: `TH-2026-02-26-contestacao-dossie-pre-codigo`

#### 2026-02-26 — [DOCS][CT][OPS] Contestacao: contrato de endpoints backend fechado (overview/city/reason/drivers/leads/meta)

- **O que**:
  - definida especificacao tecnica dos endpoints da aba Contestacao com request/response, filtros, ordenacao, validacoes e SLO alvo;
  - congelada whitelist de `sort_by` por endpoint e padrao de erro JSON;
  - vinculada regra de aceite 1:1 com a matriz de metricas/queries ja congelada.
- **Por quê**: iniciar implementacao backend sem ambiguidade de contrato e sem risco de cada endpoint "contar diferente".
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_especificacao_endpoints_menu_contestacao.md`
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_matriz_metricas_queries_contestacao.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260226-1500-01.md`
- **Reinícios**: nenhum (somente documentação/planejamento técnico).
- **Rollback**: reverter commit de docs desta rodada.

#### 2026-02-26 — [DOCS][CT][OPS] Contestacao: plano de implementacao backend em slices fechado (S0..S6)

- **O que**:
  - definido plano executavel em slices curtas para backend da aba Contestacao, com ordem de entrega, arquivos-alvo, critérios de teste por slice e gates de no-go;
  - congelado pipeline de rollout com feature flag e etapa obrigatoria de comparacao 1:1 contra queries canônicas;
  - atualizado INC com referencia direta ao plano de slices.
- **Por quê**: reduzir risco de regressao e permitir entrega incremental com validacao objetiva em cada etapa.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_plano_implementacao_backend_contestacao_slices.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260226-1500-01.md`
- **Reinícios**: nenhum (somente documentação/plano técnico).
- **Rollback**: reverter commit de docs desta rodada.

#### 2026-02-26 — [DOCS][CT][OPS] Contestacao: auditoria forense final pre-codigo (veredito NO-GO temporario)

- **O que**:
  - executada auditoria forense final ponta a ponta antes de codar, com foco em risco estrutural de schema/estado e rastreabilidade operacional;
  - identificados 2 bloqueios P0: duplicidade de familias de tabela de contestacao e divergencia de dicionario de status/validacao;
  - registrado checklist objetivo para virar GO.
- **Por quê**: evitar iniciar codificacao com ambiguidade estrutural que comprometa KPI, trilha forense e comparacao 1:1.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_auditoria_forense_final_pre_codigo_contestacao.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260226-1500-01.md`
- **Reinícios**: nenhum (somente auditoria/documentação).
- **Rollback**: reverter commit de docs desta rodada.

#### 2026-02-26 — [CT][DOCS][OPS] Contestacao: saneamento P0 pre-codigo concluido (canonizacao + customer_confirm)

- **O que**:
  - aplicada canonizacao estrutural sem quebra em 3 arquivos: store, flow e schema de contestacao;
  - unificado dicionario de client validation no store usando contrato central (`CLIENT_VALIDATION_STATUS`);
  - adicionada persistencia explicita para acao `contest:customerconfirm` no fluxo WhatsApp;
  - normalizados aliases antigos de status/validacao no schema V21 e documentada familia canônica `ct_lead_contestation_*`.
- **Por quê**: remover bloqueios P0 detectados na auditoria final e liberar inicio dos endpoints com base forense consistente.
- **Evidência**:
  - `C:\sitechatbot\convenientetecnologia\lib\ctLeadContestationStore.js`
  - `C:\sitechatbot\whatsapp\lib\flow.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctDb.js`
  - `C:\conveniente\docs\checkups\checkup_2026-02-26_execucao_p0_pre_codigo_canonizacao_contestacao.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260226-1500-01.md`
- **Reinícios**: `sitechatbot` (`node index.js`) para aplicar mudanças no runtime.
- **Rollback**: restaurar os 3 arquivos alterados e reiniciar `sitechatbot`.

#### 2026-02-26 — [DOCS][CT] Abrir INC: Menu "Contestacao" (olhos de Deus) com metricas avancadas (ciclo, valor, valor-zero, reabertura)

- **O que**:
  - criado novo INC para congelar definicoes e desenho enterprise do menu de contestacao no CT (sem codar ainda);
  - escopo cobre: taxa por cidade/grupo, ranking de motivos, ranking de motoristas, recontestacoes/ciclos e deteccao de "valor zero".
- **Por quê**: migracao tokenized esta virando diaria; precisamos observabilidade objetiva para decisao sem achismo.
- **Evidência**:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260226-1500-01.md`
  - relacionado: `C:\conveniente\docs\inbox\in_progress\INC-20260224-1300-01.md`
  - base tecnica (CT): `C:\sitechatbot\convenientetecnologia\lib\ctLeadContestationStore.js`, `C:\sitechatbot\convenientetecnologia\lib\ctDb.js`, `C:\sitechatbot\lib\pedidosStore.js`
- **Reinícios**: nenhum (somente docs)
- **Rollback**: reverter commit de docs (git) se necessario.

#### 2026-02-23 — [CT][DOCS][CROSS][OPS] Contestação V2.1: início de runtime com persistência T+15 e retomada pós-restart

- **O que**:
  - criada implementação inicial do store canônico de contestação (`ct_lead_contestation_*`) com bootstrap idempotente por `case_key`;
  - `timeouts` passou a: bootstrapar caso após vencedor notificado e enviar followup T+15 persistente com `interactive_id` técnico;
  - `flow` passou a capturar resposta T+15 do motorista no número operacional e transicionar estado do caso (`closed`/`provisional`/`manual_queue`).
- **Por quê**: iniciar execução real do pós-vencedor sem perder estado em restart e sem quebrar legado/fluxo tokenized atual.
- **Evidência**:
  - `C:\sitechatbot\convenientetecnologia\lib\ctLeadContestationStore.js`
  - `C:\sitechatbot\whatsapp\lib\timeouts.js`
  - `C:\sitechatbot\whatsapp\lib\flow.js`
  - `C:\conveniente\docs\checkups\checkup_2026-02-23_auditoria_pre_codigo_pos_vencedor_contestacao_v2_1.md`
- **Reinícios**: `sitechatbot` (`node index.js`) para ativar a slice no runtime.
- **Rollback**: restaurar os 3 arquivos acima para a versão anterior e reiniciar `sitechatbot`.
- **THREAD**: `TH-2026-02-20-leads-porte-contestacao-ct`

---

#### 2026-02-23 — [DOCS][CT][CROSS][OPS] Auditoria pré‑código pós‑vencedor (Contestação V2.1) — baseline real + gaps + simulação P2

- **O que**:
  - auditado “o que existe hoje” no pós‑vencedor: winner recebe 1 mensagem + lead é debitado no ledger (idempotente por `lead_token`);
  - registrado dossiê pré‑código com mapeamento função‑a‑função, gaps P0/P1/P2 e desenho da simulação pesada (500–600/dia) com deadline (anti‑trava);
  - linkado no INC canônico de contestação V2.1.
- **Por quê**: iniciar codificação sem achismo e sem regressão no core tokenized já validado.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-23_auditoria_pre_codigo_pos_vencedor_contestacao_v2_1.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2310-01.md`
- **Reinícios**: nenhum (apenas documentação/auditoria).
- **Rollback**: reverter commits de docs (git) se necessário.

---

#### 2026-02-23 — [DOCS][CROSS][OPS] Handoff blindado (INC reorganizado + contestação V2.1 canonizada + bloco copiar/colar)

- **O que**:
  - reorganizados INCs por pasta conforme `state` (done/need_evidence/in_progress) e alinhado `docs/inbox/INDEX.md`;
  - reforçada governança: `INC-20260222-2310-01` agora traz **V2.1 como canônico no topo** (V1 fica como histórico) + copy V2.1 canônica;
  - atualizado `docs/INFORMACOES_CONTINUIDADE_GPT.md` com bloco pronto para copiar/colar no novo chat, mantendo continuidade sem perda.
- **Por quê**: evitar perda de decisões “na memória” e impedir que um GPT futuro implemente V1 por engano.
- **Evidência**:
  - `C:\conveniente\docs\INFORMACOES_CONTINUIDADE_GPT.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2310-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2230-01.md`
- **Reinícios**: nenhum (apenas documentação/organização).
- **Rollback**: reverter os commits de docs (git) se for necessário voltar a estrutura anterior.
- **THREAD**: `TH-2026-02-20-leads-porte-contestacao-ct`

---

#### 2026-02-20 — [DOCS][CT][CROSS][OPS] Auditoria ponta a ponta pre-codigo (porte + sorteio + contestacao + CT)

- **O que**:
  - consolidada auditoria tecnica completa, funcao por funcao, cobrindo fluxo WhatsApp, sorteio tokenized, financeiro por `lead_token` e operacao CT;
  - validadas evidencias reais de consistencia e stress isolado de sorteio (`failures=0`);
  - fechado gate `READY_TO_IMPLEMENT_PHASED` com invariantes atomicos (estorno total somente do lead contestado, idempotencia e all-or-nothing por lead).
- **Por quê**: iniciar codificacao sem achismo, com regras e evidencias fechadas, reduzindo risco de regressao operacional e financeira.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-20_auditoria_ponta_a_ponta_pre_codigo.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2230-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2310-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0950-01.md`
- **Reinícios**: nenhum (rodada documental/auditoria pre-codigo).
- **Rollback**: remover/ajustar os registros documentais acima caso o escopo seja redefinido.
- **THREAD**: `TH-2026-02-20-leads-porte-contestacao-ct`

---

#### 2026-02-21 — [CT][NOTIF][CROSS][OPS] Fechamento DR: full_mirror sem falha residual por lock (exclusões absolutas)

- **O que**:
  - ajustado `driveBackup` para enviar exclusões do `robocopy` com caminhos absolutos nas rotinas de `full_mirror`;
  - removidos do mirror pesado os diretórios de lock recorrente (`node_modules`, `dados/fb_gpt`, logs voláteis e áreas de runtime já cobertas por `live_overlay`/`snapshot`);
  - validação manual executada com retorno saudável:
    - `sitechatbot` `SITE_RC=3`;
    - `notificador` `NOTIFIER_RC=2`.
- **Por quê**: eliminar ruído residual de `robocopy` por arquivo em uso sem reduzir continuidade de recuperação.
- **Evidência**:
  - `C:\sitechatbot\lib\driveBackup.js`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260220-2230-01.md`
- **Reinícios**: `sitechatbot` (`node index.js`) para aplicar este ajuste em runtime automático.
- **Rollback**: restaurar `driveBackup.js` anterior e reiniciar `sitechatbot`.
- **THREAD**: `TH-2026-02-20-dr-drive-orquestracao`

---

#### 2026-02-21 — [CT][NOTIF][CROSS][OPS] Hardening de backup DR (integridade SQLite + manifesto + anti-trava)

- **O que**:
  - Backup DR passou a rodar sem bloquear o boot do `sitechatbot` (execução assíncrona com disparo pós-start).
  - Incluído timeout para `robocopy` e log de skip por concorrência para evitar sobreposição silenciosa.
  - Snapshot agora gera `snapshot_manifest.json` com:
    - `sha256` dos bancos copiados;
    - validação `PRAGMA quick_check` em cada SQLite copiado.
  - Criados metadados de DR (`runtime_write_inventory.json`, `last_success.json`) e validação de arquivos críticos no script de restore.
- **Por quê**: reduzir risco de inconsistência silenciosa e aumentar auditabilidade em cenários adversos (interrupções/falhas em cópia).
- **Evidência**:
  - `C:\sitechatbot\lib\driveBackup.js`
  - `C:\sitechatbot\tools\restore_from_drive.ps1`
- **Reinícios**: `sitechatbot` (`node index.js`) para ativar o hardening em runtime.
- **Rollback**: restaurar versões anteriores dos dois arquivos e reiniciar `sitechatbot`.
- **THREAD**: `TH-2026-02-20-dr-drive-orquestracao`

---

#### 2026-02-21 — [CT][CROSS][OPS] Durabilidade SQLite elevada para FULL nos bancos críticos

- **O que**:
  - Alterado `synchronous` dos bancos SQLite críticos para `FULL` por padrão (mantendo `WAL` + `busy_timeout`):
    - `pedidosStore` (`PEDIDOS_SQLITE_SYNC_MODE`);
    - `ctDb` (`CT_SQLITE_SYNC_MODE`);
    - `whatsapp/db` (`WHATSAPP_SQLITE_SYNC_MODE`).
- **Por quê**: maximizar durabilidade de escrita em cenário adverso (queda de energia/interrupção abrupta), reduzindo risco de perda recente de páginas.
- **Evidência**:
  - `C:\sitechatbot\lib\pedidosStore.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctDb.js`
  - `C:\sitechatbot\whatsapp\lib\db.js`
- **Reinícios**: `sitechatbot` (`node index.js`) para aplicar nas novas conexões SQLite.
- **Rollback**: voltar `synchronous` para `NORMAL` nos três arquivos e reiniciar `sitechatbot`.
- **THREAD**: `TH-2026-02-20-dr-drive-orquestracao`

---

#### 2026-02-21 — [CT][CROSS][OPS] Backup DR com concorrência isolada por tipo de job (mirror/overlay/snapshot)

- **O que**:
  - removido lock global único do backup e aplicado lock por grupo (`mirror`, `overlay`, `snapshot`);
  - `live_overlay` deixa de ser pulado quando `full_mirror` está em execução longa.
- **Por quê**: melhorar RPO real e evitar janelas maiores de defasagem durante espelhamento pesado.
- **Evidência**:
  - `C:\sitechatbot\lib\driveBackup.js`
- **Reinícios**: `sitechatbot` (`node index.js`) para ativar o novo modelo de concorrência.
- **Rollback**: restaurar `driveBackup.js` anterior e reiniciar `sitechatbot`.
- **THREAD**: `TH-2026-02-20-dr-drive-orquestracao`

---

#### 2026-02-21 — [CT][CROSS][OPS] Auditoria runtime DR + ajuste final de schema WhatsApp para FULL

- **O que**:
  - executada auditoria runtime pós-restart com evidências de `ngrok`, `:3000`, metadados DR no Drive e lock do `notificador`;
  - ajustado `whatsapp/db/schema.sql` de `PRAGMA synchronous = NORMAL` para `FULL` para eliminar override de durabilidade.
- **Por quê**: fechar o último gap de escrita durável e consolidar trilha de evidência operacional para DR restore-first.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-21_validacao_runtime_dr_hardening.md`
  - `C:\sitechatbot\whatsapp\db\schema.sql`
  - `G:\Meu Drive\_dr_meta\runtime_write_inventory.json`
  - `G:\Meu Drive\sitechatbot\_dr_meta\last_success.json`
  - `G:\Meu Drive\notificador\_dr_meta\last_success.json`
- **Reinícios**: `sitechatbot` (`node index.js`) para carregar integralmente ajustes finais desta rodada.
- **Rollback**: reverter `schema.sql` WhatsApp para `NORMAL` (não recomendado) e reiniciar.
- **THREAD**: `TH-2026-02-20-dr-drive-orquestracao`

---

#### 2026-02-20 — [CT][NOTIF][CROSS][OPS] Boot unificado (1 comando) + backup contínuo no Drive privado

- **O que**:
  - `sitechatbot` passou a iniciar e supervisionar `ngrok` + `notificador` no mesmo `node index.js`, com restart automático e encerramento coordenado.
  - Implementado backup contínuo para `G:\Meu Drive\sitechatbot` e `G:\Meu Drive\notificador` com camadas:
    - `live` (incremental frequente de dados vivos, incluindo SQLite+WAL/SHM e `.baileys_auth`);
    - `snapshot` periódico com retenção.
  - Adicionada trava de instância única no `notificador` para evitar duplicidade de worker em paralelo.
- **Por quê**: reduzir risco operacional (3 terminais manuais), consolidar DR privado e evitar regressão por dupla execução do notificador.
- **Evidência**:
  - `C:\sitechatbot\lib\unifiedRuntime.js`
  - `C:\sitechatbot\lib\driveBackup.js`
  - `C:\sitechatbot\index.js`
  - `C:\notificador\index.js`
  - `C:\sitechatbot\dados\logs\drive_backup.jsonl` (após reinício e runtime)
- **Reinícios**: `sitechatbot` (`node index.js`) — sobe `ngrok` e `notificador` junto
- **Rollback**: remover chamadas no `sitechatbot/index.js` e restaurar arquivos `lib/unifiedRuntime.js`, `lib/driveBackup.js`, `notificador/index.js` para versão anterior.
- **THREAD**: `TH-2026-02-20-dr-drive-orquestracao`

---

#### 2026-02-21 — [CT][NOTIF][CROSS][OPS] DR restore-first 1:1 (espelho completo Drive + script de restauração)

- **O que**:
  - Backup no Drive evoluiu de cobertura parcial para espelho completo 1:1 dos projetos:
    - `C:\sitechatbot` -> `G:\Meu Drive\sitechatbot`
    - `C:\notificador` -> `G:\Meu Drive\notificador`
  - Mantidos snapshots/metadata de DR no destino sem conflito com o espelho (`_snapshots`, `_dr_meta`).
  - Criado script canônico de restauração para host novo:
    - `C:\sitechatbot\tools\restore_from_drive.ps1`
    - restaura arquivos 1:1 e instala dependências (`npm ci`/`npm install`) quando necessário.
- **Por quê**: garantir continuidade real após desastre (host novo do zero) com procedimento simples e reprodutível.
- **Evidência**:
  - `C:\sitechatbot\lib\driveBackup.js`
  - `C:\sitechatbot\tools\restore_from_drive.ps1`
  - restore probe OK em:
    - `C:\sitechatbot_restore_probe`
    - `C:\notificador_restore_probe`
- **Reinícios**: `sitechatbot` (`node index.js`) para carregar o novo modo de backup 1:1
- **Rollback**: restaurar `C:\sitechatbot\lib\driveBackup.js` para versão anterior e reiniciar `sitechatbot`.
- **THREAD**: `TH-2026-02-20-dr-drive-orquestracao`

---

#### 2026-02-19 — [CT][CROSS][OPS] Protótipo do ledger/scheduler alinhado com cobrança seg-sex (08:00/15:00) + competência

- **O que**:
  - Alinhado o protótipo de cobrança/ledger no CT para:
    - cobrança em dias úteis (seg-sex);
    - bloqueio default às 15:00 (`LEAD_BILLING_BLOCK_HOUR=15`);
    - competência: `lead_award` do dia não entra na fatura do próprio dia (cobrança do dia seguinte; fim de semana cai na segunda);
    - lançamentos (lead/ajuste) passam a “grudar” na fatura aberta e atualizar `amount_cents` para não existir saldo fora da fatura.
  - Atualizado o validador offline para provar a janela (bloqueio 15:01) e removido ruído de migração em DB forense.
- **Por quê**: eliminar divergência entre regra canônica e protótipo, e impedir inconsistência “paguei a fatura mas ainda devo” por lançamentos fora da fatura.
- **Evidência**:
  - `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`
  - `C:\sitechatbot\tools\validate_billing_window_rule.js` (resultado `ok:true`)
  - `C:\sitechatbot\convenientetecnologia\lib\ctDb.js` (migração dedupe sem warning em DB novo)
- **Reinícios**: (quando levar para runtime real) `sitechatbot`: reiniciar `node index.js`
- **Rollback**: reverter alterações nos arquivos acima e reiniciar `sitechatbot`
- **THREAD**: `TH-2026-02-19-new-lead-flow-triage`

---

#### 2026-02-19 — [CROSS][DOCS][OPS] Alinhamento final de handoff + nova regra de cobrança diária (08:00/15:00)

- **O que**:
  - Atualizada a regra do programa de cobrança Asaas para janela diária útil (seg-sex 08:00) com bloqueio às 15:00 e competência sexta/sábado/domingo na segunda.
  - Sincronizados INC financeiro, índice de INCs, intake canônico, checkup técnico e runbook com a nova regra operacional.
  - Criado arquivo de continuidade dedicado para abrir novo chat sem perda de contexto (`INFORMACOES_CONTINUIDADE_GPT.md`).
- **Por quê**: preparar transição de chat e garantir que a próxima sessão parta da regra mais recente definida pelo humano, sem ambiguidade.
- **Evidência**:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0940-01.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
  - `C:\conveniente\docs\checkups\checkup_2026-02-19_novo_fluxo_leads_sorteio_cobranca.md`
  - `C:\conveniente\docs\INFORMACOES_CONTINUIDADE_GPT.md`
  - `C:\sitechatbot\docs\INTEGRACAO_ASAAS.md`
- **Reinícios**: nenhum (somente documentação e handoff)
- **Rollback**: `git revert` das alterações nos arquivos `docs/` e em `sitechatbot/docs/INTEGRACAO_ASAAS.md`
- **THREAD**: `TH-2026-02-19-new-lead-flow-triage`

---

#### 2026-02-19 — [CROSS][DOCS][OPS] Revalidação ultra do dossiê (rodada 5) com checklist de completude 110%

- **O que**:
  - Executada checagem final de cobertura requisito-a-requisito, com matriz explícita de status (`OK`/`PENDENTE`) para o novo fluxo.
  - Registrado gate hard-stop com 7 bloqueadores obrigatórios antes da auditoria de plano de execução.
  - Sincronizado INC mestre com checklist objetivo de prontidão (sem espaço para achismo).
- **Por quê**: garantir que nenhum ponto crítico fique implícito antes de entrar na fase de plano de execução.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-19_novo_fluxo_leads_sorteio_cobranca.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0900-01.md`
- **Reinícios**: nenhum (somente auditoria/documentação)
- **Rollback**: `git revert` das alterações em `docs/` (sem impacto de runtime)
- **THREAD**: `TH-2026-02-19-new-lead-flow-triage`

---

#### 2026-02-19 — [CROSS][DOCS][OPS] Revalidação ultra do dossiê (rodada 4) com destrinche do código atual

- **O que**:
  - Executada nova auditoria completa, focada em separar explicitamente: o que já existe em produção vs o que falta para o novo modelo.
  - Confirmado no código que o legado segue ativo com publicação de contato do cliente (builder atual), exigindo builder tokenizado sob flag para piloto.
  - Confirmado que CT já possui base madura de memberships/chat, porém o domínio financeiro atual é de mensalidade por participação e não ledger por lead ganho.
  - Registrado plano técnico anti-regressão por etapas (isolamento dual-number -> sorteio/token -> ledger -> cobrança -> chat -> E2E -> piloto).
- **Por quê**: evitar qualquer regressão no fluxo atual e eliminar ambiguidade de escopo antes do primeiro commit de implementação.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-19_novo_fluxo_leads_sorteio_cobranca.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0900-01.md`
  - `C:\sitechatbot\lib\pedidosStore.js`
  - `C:\sitechatbot\index.js`
  - `C:\sitechatbot\whatsapp\lib\metaParser.js`
  - `C:\sitechatbot\convenientetecnologia\index.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctDb.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctMembershipStore.js`
  - `C:\notificador\index.js`
- **Reinícios**: nenhum (somente auditoria/documentação)
- **Rollback**: `git revert` das alterações em `docs/` (sem impacto de runtime)
- **THREAD**: `TH-2026-02-19-new-lead-flow-triage`

---

#### 2026-02-19 — [CROSS][DOCS][OPS] Revalidação ultra do dossiê (rodada 3) com blindagem anti-mistura

- **O que**:
  - Executada terceira auditoria técnica, focada em não-regressão do legado e isolamento entre os dois números WhatsApp (atendimento x operacional).
  - Confirmado bloqueador P0 de isolamento: pipeline atual do WhatsApp opera por `phone` sem `phone_number_id` no parser/banco/conversa.
  - Confirmado bloqueador P0 de rollout: fila/notificador ainda sem segregação explícita de `delivery_mode` por `groupId` (risco de afetar grupos fora do piloto).
  - Registradas invariantes obrigatórias e matriz de validação pré-código no checkup canônico.
- **Por quê**: impedir mistura de contexto entre APIs e garantir que o fluxo atual continue intacto durante a implantação gradual.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-19_novo_fluxo_leads_sorteio_cobranca.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0900-01.md`
  - `C:\sitechatbot\whatsapp\lib\metaParser.js`
  - `C:\sitechatbot\whatsapp\index.js`
  - `C:\sitechatbot\whatsapp\lib\db.js`
  - `C:\sitechatbot\whatsapp\db\schema.sql`
  - `C:\sitechatbot\lib\pedidosStore.js`
  - `C:\notificador\index.js`
- **Reinícios**: nenhum (somente auditoria/documentação)
- **Rollback**: `git revert` das alterações em `docs/` (sem impacto de runtime)
- **THREAD**: `TH-2026-02-19-new-lead-flow-triage`

---

#### 2026-02-19 — [CROSS][DOCS][OPS] Revalidação ultra do dossiê (rodada 2) com bloqueadores pré-código

- **O que**:
  - Executada segunda auditoria técnica "sem piedade" cruzando dossiê + INCs + código real (`sitechatbot`/`notificador`).
  - Registrados bloqueadores P0/P1 adicionais: roteamento dual-number por `phone_number_id`, lock transacional do sorteio, conflito domínio legado x pay-per-lead, scheduler idempotente com catch-up, elegibilidade em dois pontos, e flag de piloto por `groupId`.
  - Atualizados o checkup canônico e o INC mestre com faltantes objetivos antes do primeiro commit de código.
- **Por quê**: eliminar lacunas ocultas de concorrência e governança financeira antes de iniciar implementação.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-19_novo_fluxo_leads_sorteio_cobranca.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0900-01.md`
  - `C:\sitechatbot\whatsapp\lib\metaParser.js`
  - `C:\sitechatbot\lib\pedidosStore.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctMembershipStore.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctDb.js`
  - `C:\notificador\index.js`
- **Reinícios**: nenhum (somente auditoria/documentação)
- **Rollback**: `git revert` das alterações em `docs/` (sem impacto de runtime)
- **THREAD**: `TH-2026-02-19-new-lead-flow-triage`

---

#### 2026-02-19 — [CROSS][DOCS][OPS] Dossiê técnico completo pré-código (novo fluxo de leads por sorteio/cobrança)

- **O que**:
  - Criado checkup canônico com auditoria do estado atual do código e arquitetura-alvo para o novo modelo de leads.
  - Consolidada ordem de implementação por INC (segurança -> tokenização -> sorteio -> ledger -> cobrança -> atendimento -> E2E -> piloto).
  - Vinculado o dossiê no INC mestre `INC-20260219-0900-01`.
- **Por quê**: iniciar codificação com escopo fechado, sem achismo e com critério objetivo de Go/No-Go.
- **Evidência**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-19_novo_fluxo_leads_sorteio_cobranca.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0900-01.md`
  - `C:\sitechatbot\docs\INTEGRACAO_ASAAS.md`
- **Reinícios**: nenhum (somente documentação/planejamento)
- **Rollback**: `git revert` das alterações em `docs/` (sem impacto de runtime)
- **THREAD**: `TH-2026-02-19-new-lead-flow-triage`

---

#### 2026-02-19 — [CROSS][DOCS][OPS] Abertura de triagem macro para novo fluxo de leads (sorteio + cobrança)

- **O que**:
  - Aberto programa-mãe `INC-20260219-0900-01` e desdobrados 8 sub-INCs canônicos para separar domínios técnicos sem misturar escopo.
  - Registrada triagem no intake (`INBOX_RELATOS_DO_HUMANO.md`) com prioridade P0/P1 e status inicial `need_alignment/need_evidence`.
  - Atualizado índice `docs/inbox/INDEX.md` com os novos tickets:
    - arquitetura webhook/link token,
    - sorteio 2 minutos,
    - ledger/banco por motorista,
    - cobrança Asaas + baixa + bloqueio,
    - atendimento financeiro/administrativo,
    - rollout piloto em 3 grupos,
    - plano E2E/Go-NoGo,
    - segurança de credencial exposta.
- **Por quê**: iniciar a reconstrução do método operacional com rastreabilidade total antes de qualquer implementação em runtime.
- **Evidência**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0900-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0910-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0920-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0930-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0940-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-0950-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-1000-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-1010-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260219-1020-01.md`
- **Reinícios**: nenhum (somente documentação/triagem)
- **Rollback**: `git revert` das alterações em `docs/` (sem impacto de runtime)
- **THREAD**: `TH-2026-02-19-new-lead-flow-triage`

---

#### 2026-02-16 — [CONV][RM3][P0] Ajuste fino de consistência Virtus/LR + rollout controlado

- **O que**:
  - Aplicados hotfixes em `scripts/worker.js` para reduzir estados invertidos observados em produção:
    - `9229adf`: auto-clear de `probe_failed` menos rígido (exige Messenger limpo + ausência de razão forte).
    - `619e088`: `start_work` passa a bloquear explicitamente quando `loginRequired=true`, forçando `virtus=off` e snapshot imediato.
  - Rollout executado com `self_update` no RM3 e reinício operacional confirmado pelo host.
- **Por quê**: eliminar casos residuais de `loginRequired + Virtus Online` e manter coerência de estado sem regredir o avanço obtido no `Virtus Offline` sem motivo.
- **Evidência**:
  - `C:\conveniente\scripts\worker.js`
  - Commits: `9229adf`, `619e088`
  - RM3 status build: `buildId=1.0.0|worker_mtime=1771266647123`
- **Reinícios**: RM3 (`conveniente`) reiniciado na rodada
- **Rollback**: revert dos commits `619e088` e `9229adf` (ordem inversa)
- **THREAD**: `TH-2026-02-15-rm3-lr-probe-false-positive`

---

#### 2026-02-16 — [CONV][DOCS][OPS][P0] Reabertura do INC de tela preta (RM1) para monitoramento residual

- **O que**:
  - `INC-20260215-1100-01` reclassificado de `done` para `need_evidence` por relato de tela preta residual e confiabilidade parcial de retentativa.
  - INC movido para `docs/inbox/need_evidence/INC-20260215-1100-01.md`.
- **Por quê**: preservar histórico de correções já aplicadas e fechar o gap residual com nova rodada de evidência.
- **Evidência**:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260215-1100-01.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
- **Reinícios**: nenhum (documentação/monitoramento)
- **Rollback**: retornar estado/path no `INDEX.md` para `done`
- **THREAD**: `TH-2026-02-15-rm1-robe-marketplace-black`

---

#### 2026-02-16 — [CONV][RM4][P0] Abertura de INC novo: loop Robe login_required x Messenger saudável

- **O que**:
  - Aberto `INC-20260216-1930-01` para investigar o fluxo observado na conta `recife-1769723410217`:
    - Robe detecta login_required no contexto `create/item`;
    - reconciliação com Messenger saudável parece limpar/oscilar flags;
    - Robe não converge para resolver sessão de postagem.
- **Por quê**: separar domínio Virtus x Robe sem apagar bloqueio legítimo do Robe.
- **Evidência**:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260216-1930-01.md`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260203-1800-01.md` (regras de domínio relacionadas)
- **Reinícios**: nenhum (fase forense)
- **Rollback**: n/a (somente abertura de incidente/documentação)
- **THREAD**: `TH-2026-02-16-rm4-robe-loginrequired-loop`

---

#### 2026-02-16 — [CONV][CT][RM3][P0][FORENSICS] Rodada 2 RAM: série em tempo real + probe automatizado 6h

- **O que**:
  - Executada série curta em tempo real no RM3 com `controllers=120` estáveis e captura de delta de `freeMB` em minutos.
  - Criado probe automatizado: `C:\sitechatbot\tools\rm3_ram_forensics_probe.js` para coleta contínua (`status_node_1..4`, `governor_snapshots`, `issues_fallback`) e geração de dossiê JSON.
  - INC `INC-20260216-1600-01` atualizado com plano operacional completo de resolução por fases (A evidência, B A/B, C correção, D garantia contínua).
- **Por quê**: transformar investigação em pipeline repetível para fechar causalidade e validar correção sem achismo.
- **Evidência**:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260216-1600-01.md`
  - `C:\sitechatbot\tools\rm3_ram_forensics_probe.js`
  - `C:\sitechatbot\dados\forensics\rm3_ram_probe_5d7c3309-8581-4a50-a421-e6cbb52d8070_1771260441764.json`
- **Reinícios**: nenhum nesta rodada (forense + tooling)
- **Rollback**: remover script `rm3_ram_forensics_probe.js` e descartar artefatos de `dados/forensics/`
- **THREAD**: `TH-2026-02-16-rm3-ram-degradation-forensics`

---

#### 2026-02-16 — [CONV][RM3][P0][FORENSICS] Rodada 1 de RAM: baseline por nó + histórico de degradação confirmado

- **O que**:
  - Coletada evidência objetiva do RM3 (`governor_snapshots`, `status_node_1..4`, `issues_fallback`) com requestIds rastreáveis.
  - Confirmado baseline atual pós-restart: ~`37GB` em `ramMB` somado dos 120 perfis e ~`10-11GB` livres no host.
  - Confirmada degradação histórica com controladores estáveis (`>=28`): janela com queda de `~12.5GB -> ~2.0GB`, incluindo `~408` min abaixo de `2GB` em ~48h.
  - Confirmado acionamento real de `light/mem_low` por logs de issues e transições no governor.
  - Registrado achado técnico: monitor RAM por PID usa CDP tracing periódico por worker (candidato forte para experimento A/B controlado).
- **Por quê**: transformar dor antiga de RAM em causalidade mensurável antes de patch definitivo.
- **Evidência**:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260216-1600-01.md`
  - `dados/logs/5d7c3309-8581-4a50-a421-e6cbb52d8070/fetch_logs_..._1771259169637_d537.json`
  - `dados/logs/5d7c3309-8581-4a50-a421-e6cbb52d8070/fetch_logs_..._1771259379394_285d.json`
  - `dados/logs/5d7c3309-8581-4a50-a421-e6cbb52d8070/fetch_logs_..._1771259434287_5997.json`
- **Reinícios**: nenhum (rodada apenas forense/documental)
- **Rollback**: n/a (sem alteração de runtime)
- **THREAD**: `TH-2026-02-16-rm3-ram-degradation-forensics`

---

#### 2026-02-16 — [CONV][DOCS][OPS] Reclassificação de INCs (RM3 em monitoramento, RAM cancelado, latência CT chat encerrado)

- **O que**:
  - `INC-20260203-1800-01` movido de `in_progress` para `need_evidence` (soak/monitoramento em produção após patch no RM3).
  - `INC-20260201-0200-01` movido de `need_evidence` para `cancelled` por decisão operacional.
  - `INC-20260204-0140-01` movido de `need_evidence` para `done` (estável na rodada atual).
  - Índices sincronizados: `docs/inbox/INDEX.md`, `docs/INBOX_RELATOS_DO_HUMANO.md`, `docs/LIVRO_DE_BORDO.md`.
- **Por quê**: refletir estado real da operação e manter backlog limpo para próxima evidência.
- **Evidência**:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260203-1800-01.md`
  - `C:\conveniente\docs\inbox\cancelled\INC-20260201-0200-01.md`
  - `C:\conveniente\docs\inbox\done\INC-20260204-0140-01.md`
- **Reinícios**: nenhum (somente organização/documentação de status)
- **Rollback**: mover os INCs de volta para pastas/estados anteriores no `docs/inbox/`

---

#### 2026-02-16 — [CONV][RM3][P0] Abertura de INC forense de memória (queda progressiva pós-boot)

- **O que**:
  - Aberto INC `INC-20260216-1600-01` para investigar degradação de RAM no RM3 após restart/open_all:
    - cenário inicial saudável (~11GB livre, 120/120 ativos, 118 trabalhando);
    - degradação em 3-6h para ~2GB livre;
    - entrada em ações defensivas (close/stop/degrade).
  - Definido plano forense em 3 blocos: série temporal de memória, topologia de execução, causalidade operacional.
- **Por quê**: eliminar modo destrutivo recorrente e estabelecer controle estável de headroom sem achismo.
- **Evidência**:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260216-1600-01.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
- **Reinícios**: nenhum (fase de coleta/forense)
- **Rollback**: n/a (somente documentação)
- **THREAD**: `TH-2026-02-16-rm3-ram-degradation-forensics`

---

#### 2026-02-15 — [CONV][DOCS][OPS] Abrir INC: RM1 Robe Marketplace “tela preta” (aba 1 criar item)

- **O que**:
  - Aberto INC `INC-20260215-1100-01` para investigar “tela preta” na aba 1 durante o fluxo de postar item do Robe no Marketplace, com Virtus rodando na aba 0.
  - Registrado dossiê inicial: sintoma, hipóteses, plano de evidências (rodada 1 sem mudar código) e proposta de instrumentação opt-in (rodada 2).
  - Índices sincronizados para o ticket aparecer como ativo.
- **Por quê**: problema recorrente bloqueia postagem; precisamos prova objetiva antes de correção cirúrgica.
- **Evidência**:
  - `C:\conveniente\docs\inbox\in_progress\INC-20260215-1100-01.md`
- **Reinícios**: nenhum (fase 1: investigação/documentação)
- **Rollback**: n/a (somente docs)
- **THREAD**: `TH-2026-02-15-rm1-robe-marketplace-black`

---

#### 2026-02-15 — [CONV][ROBE][P0] Encerramento INC-20260215-1100-01 (tela preta + aba extra de bootstrap)

- **O que**:
  - Encerrado o INC `INC-20260215-1100-01` com status `done/deployed/passed`.
  - Confirmado em runtime que o Robe voltou a postar com estabilidade e sem regressao do fluxo.
  - Removido comportamento obsoleto de abrir aba extra de create no bootstrap (`open_manual`) por default.
- **Por quê**: finalizar o P0 com correcoes comprovadas por evidencia operacional e validacao humana.
- **Evidência**:
  - `C:\conveniente\docs\inbox\done\INC-20260215-1100-01.md`
  - Commits: `40a6ae1`, `08d2410`, `5f17b31`, `0062a42`, `91dd50e`
- **Reinícios**: sim (self_update + restart no RM1 durante rollout/validacao)
- **Rollback**: reverter em ordem inversa os commits listados acima
- **THREAD**: `TH-2026-02-15-rm1-robe-marketplace-black`

---

#### 2026-02-15 — [CONV][RM3][P0] Reabertura operacional INC-20260203-1800-01 (Virtus offline por falso `probe_failed`)

- **O que**:
  - Reclassificado `INC-20260203-1800-01` para `in_progress` com plano de ação cirúrgico.
  - Consolidada evidência RM3 nas contas `ipatinga-1768508775083` e `juiz_de_fora-1769026433175`:
    - `lr_flag_snapshot` com `storedReason=probe_failed`;
    - `lr_scan_tabs` com Messenger `lr=false` e aba `create/item` com `lr=true` em parte dos ciclos.
  - Registrada regra arquitetural: saúde do Virtus deve priorizar contexto Messenger; create/item pertence ao Robe.
- **Por quê**: eliminar falso positivo que desliga Virtus em contas aparentemente saudáveis no Messenger.
- **Evidência**:
  - `C:\conveniente\docs\inbox\in_progress\INC-20260203-1800-01.md`
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\agent-tools\99733b5e-1749-4a66-b642-a3ba4f555b9e.txt`
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\agent-tools\40e9d861-a5a8-41a2-ae66-c19e060095dd.txt`
- **Reinícios**: nenhum (forense em estado vivo)
- **Rollback**: n/a (somente documentação nesta etapa)
- **THREAD**: `TH-2026-02-15-rm3-lr-probe-false-positive`

---

#### 2026-02-15 — [CONV][RM3][P0] Dossiê ultra-forense consolidado (matriz Virtus x Robe + invariantes)

- **O que**:
  - Consolidado no INC `INC-20260203-1800-01`:
    - catálogo de problemas confirmados;
    - matriz de decisão por domínio (Virtus=Messenger, Robe=create/item);
    - critérios de evidência 110% e checklist operacional pré-implementação.
  - Atualizada triagem de relatos do humano com o incidente RM3 em andamento.
- **Por quê**: prevenir regressão e remover ambiguidade de decisão de saúde em produção.
- **Evidência**:
  - `C:\conveniente\docs\inbox\in_progress\INC-20260203-1800-01.md`
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
- **Reinícios**: nenhum
- **Rollback**: n/a (somente documentação)
- **THREAD**: `TH-2026-02-15-rm3-lr-probe-false-positive`

---

#### 2026-02-15 — [CONV][RM3][P0] Patch cirúrgico aplicado + soak test 72h (INC permanece aberto)

- **O que**:
  - Aplicado patch em `scripts/worker.js` para:
    - priorizar domínio Messenger na decisão de `loginRequired` do Virtus;
    - tratar `probe_failed` em `create/item` como sinal fraco quando Messenger está OK;
    - fechar aba extra ociosa (incluindo `create/item`) fora de Robe/humano/config.
  - INC `INC-20260203-1800-01` atualizado para fase de execução controlada + observação 72h.
- **Por quê**: eliminar falso positivo sistêmico que derrubava Virtus com Messenger saudável.
- **Evidência**:
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\docs\inbox\in_progress\INC-20260203-1800-01.md`
- **Reinícios**: pendente conforme operação do RM3
- **Rollback**: revert único do patch em `scripts/worker.js`
- **THREAD**: `TH-2026-02-15-rm3-lr-probe-false-positive`

---

#### 2026-02-13 — [CROSS][DOCS][OPS] Encerramento formal dos 2 INCs P0 da etapa (0900 e 1020) + limpeza de `in_progress`

- **O que**:
  - INC `INC-20260214-0900-01` movido para `docs/inbox/done/` com status final concluído.
  - INC `INC-20260214-1020-01` movido para `docs/inbox/done/` com status final concluído.
  - Pasta `docs/inbox/in_progress/` ficou sem esses dois INCs, removendo pendência visual/operacional.
  - Índices sincronizados: `docs/inbox/INDEX.md`, `docs/INBOX_RELATOS_DO_HUMANO.md`, `docs/LIVRO_DE_BORDO.md`.
- **Por quê**: encerrar a etapa de segurança com organização canônica, sem tickets P0 ativos indevidamente em `in_progress`.
- **Evidência**:
  - `C:\conveniente\docs\inbox\done\INC-20260214-0900-01.md`
  - `C:\conveniente\docs\inbox\done\INC-20260214-1020-01.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
- **Reinícios**: nenhum (somente organização/documentação)
- **Rollback**: `git revert` das alterações em `docs/` (sem impacto de runtime)
- **THREAD**: `TH-2026-02-13-inc0900-inc1020-closeout`

---

#### 2026-02-13 — [CROSS][CT][CONV][OPS] INC-20260214-1020-01: implementação rodada 1 (H1/H2/H3) com rollout seguro

- **O que**:
  - H1 (CT): `releaseReservedAccount` ficou restrito a `reserved`; criada rota explícita para liberar `assigned` apenas com confirmação.
  - H2 (host): adicionado gate `production/maintenance` para bypass de guardrails de `perfis.json`; tombstone funcional integrado ao `fileStore` e usado para bloquear rebuild de perfil tombstonado.
  - H3 (CT): criado `computeH3HealthGate()` e integrado ao scheduler em modo observação por padrão (enforcement só com `CT_H3_ENFORCE_BLOCK=1`).
- **Por quê**: fechar risco residual crítico de regressão sem introduzir ruptura operacional abrupta.
- **Evidência**:
  - `C:\sitechatbot\convenientetecnologia\lib\ctFbStock.js`
  - `C:\sitechatbot\index.js`
  - `C:\conveniente\scripts\fileStore.js`
  - `C:\conveniente\docs\inbox\done\INC-20260214-1020-01.md`
- **Reinícios**:
  - `sitechatbot` (CT): necessário para aplicar H1/H3 em runtime (`node index.js`)
  - `conveniente` (hosts): necessário para aplicar H2 em runtime (`node index.js`)
- **Rollback**: `git revert` dos commits dos blocos H1/H2/H3 e reinício dos serviços afetados
- **THREAD**: `TH-2026-02-13-inc1020-impl-round1`

---

#### 2026-02-13 — [CROSS][DOCS][OPS] INC-20260214-1020-01: meta-auditoria rodada 2 (confirmação final pré-código)

- **O que**:
  - Executada uma segunda rodada completa de auditoria (“meta-auditoria”) para confirmar que nenhum ponto crítico ficou fora do dossiê antes de codar.
  - Achados foram reconciliados em três classes: risco confirmado, risco contextual/intencional, hipótese não confirmada.
  - Resultado consolidado manteve o plano H1 -> H2 -> H3 sem adicionar novos bloqueadores.
- **Por quê**: garantir 0 achismo antes da fase de implementação, com validação cruzada de ponta a ponta.
- **Evidência**:
  - `C:\conveniente\docs\inbox\done\INC-20260214-1020-01.md` (seção “Bateria de auditoria ultra - rodada 2”)
  - revisão direta de `C:\sitechatbot\index.js`, `C:\sitechatbot\convenientetecnologia\lib\ctFbStock.js`, `C:\conveniente\scripts\fileStore.js`, `C:\conveniente\scripts\api_perfis.js`
- **Reinícios**: nenhum (somente auditoria/documentação)
- **Rollback**: `git revert` nas alterações de `docs/` (sem impacto de runtime)
- **THREAD**: `TH-2026-02-13-inc1020-meta-audit-round2`

---

#### 2026-02-13 — [CROSS][DOCS][OPS] INC-20260214-1020-01: bateria de auditoria ultra (H1/H2/H3) concluída com dossiê técnico

- **O que**:
  - Executada auditoria forense de ponta a ponta no novo INC de blindagem final (`INC-20260214-1020-01`), cobrindo:
    - H1: risco de release indevido de contas `assigned` no CT,
    - H2: risco de bypass dos guardrails de `perfis.json` por flags de ambiente,
    - H3: ausência de gate periódico único para detectar regressão cedo.
  - Dossiê consolidado registrado no próprio INC com:
    - findings por severidade,
    - evidência de código,
    - snapshot operacional de runtime,
    - plano de execução seguro em ordem H1 -> H2 -> H3.
- **Por quê**: transformar risco residual em plano executável com evidência objetiva, sem achismo, antes de qualquer alteração de runtime.
- **Evidência**:
  - `C:\conveniente\docs\inbox\done\INC-20260214-1020-01.md`
  - `C:\sitechatbot\tools\list_running_provisions.js` (snapshot: running provision = 0)
  - `C:\sitechatbot\tools\check_stock_state.js` (snapshot de status/jobs)
  - `C:\sitechatbot\tools\check_stock_unique_index.js` (índice de proteção de provision por host)
  - `C:\conveniente\dados\perfis_ledger.jsonl` (eventos guardrail)
- **Reinícios**: nenhum (fase de auditoria/documentação)
- **Rollback**: `git revert` das alterações em `docs/` (sem impacto de runtime)
- **THREAD**: `TH-2026-02-13-inc1020-ultra-audit-round1`

---

#### 2026-02-13 — [CROSS][DOCS][OPS] Encerramento do INC P0 de cadastro + abertura de INC novo de blindagem final

- **O que**:
  - INC `INC-20260214-0900-01` atualizado para `done` com fechamento formal após validação final R10-R12 no RM1.
  - Aberto novo INC canônico `INC-20260214-1020-01` para hardening final anti-regressão (H1/H2/H3):
    - H1: restringir release de reserva para não atingir `assigned` por engano.
    - H2: travar bypass de guardrails de `perfis.json` em produção.
    - H3: gate contínuo de saúde para detectar regressão cedo.
  - Índices e livros sincronizados para manter organização única de operação/auditoria.
- **Por quê**: separar claramente “problema P0 principal resolvido” da “fase de blindagem final”, mantendo governança documental limpa e rastreável.
- **Evidência**:
  - `C:\conveniente\docs\inbox\done\INC-20260214-0900-01.md`
  - `C:\conveniente\docs\inbox\done\INC-20260214-1020-01.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
- **Reinícios**: nenhum (somente documentação/organização nesta etapa)
- **Rollback**: `git revert` das alterações em `docs/` (sem impacto de runtime)
- **THREAD**: `TH-2026-02-13-p0-close-and-final-hardening-open`

---

#### 2026-02-13 — [CONV] P0: blindagem anti-wipe de `perfis.json`/`desired.json` (anti-fallback + atomic write Windows-safe + registro redundante + ledger)

- **O que**:
  - `writeJsonAtomic()` agora faz swap Windows-safe **sem** janela `unlink → missing` (usa `file.old` + `file.bak_last` + rollback best-effort).
  - `withPerfisFileLockUpdate()` bloqueia escrita se `perfis.json` estiver ilegível (nunca cai para `[]`) e adiciona guardrails contra “virar 1/2 perfis” quando antes era grande.
  - Registro redundante por perfil: grava `C:\conveniente\dados\perfis\<nome>\perfil.json` (sem secrets) e `manifestStore` passou a conseguir resolver `manifest.json` via esse registro mesmo se `perfis.json` estiver ruim.
  - Ledger append-only: `C:\conveniente\dados\perfis_ledger.jsonl` com eventos de escrita/guard/restore (forense).
- **Por quê**: evidência forte de que os “wipes” (RM2/RM6) ocorreram ao redor de `stock_provision` e havia vetor destrutivo por fallback/IO; o sistema não pode mais “apagar silenciosamente”.
- **Evidência**:
  - Código: `C:\conveniente\scripts\fileStore.js`, `C:\conveniente\scripts\api_perfis.js`, `C:\conveniente\scripts\manifestStore.js`
  - INCs: `C:\conveniente\docs\inbox\in_progress\INC-20260212-0315-01.md` e `C:\conveniente\docs\inbox\need_evidence\INC-20260213-1200-01.md`
- **Reinícios**: `conveniente` (hosts) — humano: `node index.js` após `self_update`.
- **Rollback**: `git revert` do commit desta blindagem e reiniciar `conveniente`.

#### 2026-02-13 — [CROSS][CONV][CT][OPS] RM1: alinhamento no disco (órfãos) + recovery controlado + exclusão final (playbook replicável RM2–RM7)

- **O que**:
  - Auditoria FS (`perfis.json` vs `desired.json` vs `dados/perfis` vs Chrome User Data) para detectar órfãos sem “ressuscitar legado”.
  - Probing sanitizado (`manifest.json`/cookies/login) para separar “potencialmente quente” vs lixo.
  - Relink controlado de órfãos com `humanHold=true` para teste visual humano.
  - Exclusão final (delete_perfis) dos reprovados e purge de diretórios órfãos remanescentes.
- **Por quê**: RM1 tinha histórico de pastas sobrando; com o cenário de wipes (RM2/RM6), precisávamos um método enterprise para recuperar o que for útil e limpar o que for lixo, sem risco de “169 perfis voltarem do nada”.
- **Evidência**:
  - Checkup canônico: `C:\conveniente\docs\checkups\checkup_2026-02-13_rm1_profiles_orphans_alignment.md`
  - ACKs (CT):
    - `profiles_fs_audit`: `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_57ecd300-62a6-458c-bada-36eac4b9f54c.json`
    - `profiles_manifest_probe`: `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_47603d26-2696-4832-a878-832877e263ac.json`
    - `profiles_relink_orphans`: `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_8b9d16a8-07b6-4dd6-bb5c-940ac2738b30.json`
    - `delete_perfis`: `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_bd31e092-5ac8-4a92-9e93-a8a06e9df38c.json`
    - `profiles_purge_dirs`: `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_8fc23b09-abaf-41a1-a723-824af9493012.json`
- **Reinícios**: nenhum (operações via CT no host RM1; sem deploy de runtime nesta etapa)
- **Rollback**: n/a (operação; rollback seria reprovisionar sob decisão humana)

#### 2026-02-12 — [CONV] P0: Disaster recovery RM2 — restore de perfis via backup (dry-run + apply atômico + rollback)

- **O que**:
  - Adicionados comandos CT no `conveniente` para **restaurar perfis** a partir de backup local do host:
    - `backup_restore_probe` (valida backup + contagens + sha256)
    - `backup_restore_merge` (`dry_run` + `apply` atômico)
  - `apply` é protegido por `provision_lock` e salva rollback automático em `C:\conveniente\dados\_ops_audit\restore_<ts>_*.before.json`.
- **Por quê**: RM2 teve `perfis.json` sobrescrito (caiu para 7 perfis); precisava recuperação urgente sem cópia manual e sem duplicar as 7 contas novas.
- **Evidência**:
  - Código: `C:\conveniente\scripts\dashboard.js` (handlers `execBackupRestoreProbe/execBackupRestoreMerge`)
  - INC restore: `C:\conveniente\docs\inbox\done\INC-20260212-0240-01.md`
  - INC investigação wipe: `C:\conveniente\docs\inbox\in_progress\INC-20260212-0315-01.md`
- **Reinícios**: RM2 (`conveniente`) — humano: `node index.js`.
- **Rollback**:
  - restaurar os arquivos “before” em `C:\conveniente\dados\_ops_audit\restore_<ts>_*.before.json` e reiniciar, **ou**
  - `git revert` do commit do restore e reiniciar.

#### 2026-02-12 — [CROSS][OPS][DOCS] RM1: auditoria CT vs servidor + teste real de exclusão manual (CT ⇄ servidor alinhados)

- **O que**:
  - Executada auditoria “CT em uso vs perfis reais do servidor” no **ROBE MÃE 1** e saneamento operacional.
  - Remoção de perfis inválidos no servidor e arquivamento correspondente no CT (Excluídas), com evidência por ACK.
  - Teste real: humano excluiu manualmente 2 perfis no servidor e o CT refletiu corretamente (saiu de Em uso, foi pra Excluídas).
- **Por quê**: estabelecer um playbook canônico e provar que o pipeline de exclusão/alinhamento está correto antes de repetir em RM2–RM7.
- **Evidência**:
  - INC fechado: `C:\conveniente\docs\inbox\done\INC-20260212-0605-01.md`
  - ACKs (CT): `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_*.json`
- **Reinícios**: nenhum
- **Rollback**: n/a (ação operacional; rollback seria reprovisionar sob decisão humana)

#### 2026-02-11 — [CONV] P0/P1: “Virtus Offline/trabalhando=false em massa” e “reserved mas não cadastra” (fix raiz, sem remendos)

- **O que**:
  - Fix P0: `login_remediate` pausava Virtus global (quiesce) e podia **não retomar**, derrubando `working` em massa com browsers ativos. Agora o `finally` do `login_remediate` **sempre tenta retomar** Virtus para os perfis pausados (`wasWorking=true`), respeitando `desired.virtus`.
  - Fix P0: `stock_provision` **não depende de quiesce** (busy/pause) por padrão; o provisionamento passa a usar apenas **headroom (RAM) + supervisor slots**, evitando “não cadastrou” por `busy_timeout` e evitando pausar Virtus/Robe do servidor.
  - Fix P1: durante `provision_lock` de `stock_provision`, a automação (Robe/Virtus) **não é bloqueada** (política do lead).
- **Por quê**: garantir operação 24/7 sem “flap” e sem perdas por provisão; provisão não pode travar por `robeEmExecucao` nem derrubar trabalho em massa.
- **Evidência**:
  - `C:\conveniente\scripts\worker.js` (`login_remediate_quiesce_resumed`, `anomaly_*` em `provision_audit`)
  - `C:\conveniente\scripts\dashboard.js` (`stock_provision_quiesce_skipped` em `provision_audit`)
  - RM2: `C:\sitechatbot\dados\logs\<rm2_hostId>\rm2_tail_audit_postrestart_*.json` (quiesce pause + anomalias antes; estabilização depois)
- **Reinícios**: `conveniente` (hosts afetados) — humano roda `node index.js` após `self_update`.
- **Rollback**: `git revert` dos commits deste item e reiniciar `conveniente`.

#### 2026-02-07 - [CONV] P0: pós `stock_provision`, auto-resume enterprise por shard (evitar “volta parcial”)

- **O que**:
  - Adicionado mecanismo de **resume pós-provision**: ao detectar `provision_lock` (kind `stock_provision`) terminando, o sistema grava um marcador global (`stock_provision_last_end.json`).
  - Cada worker/shard executa um **resume sweep** para seus perfis (`desired.active=true` e `desired.virtus!=off`) chamando `start_work` (e, se necessário, `activateOnce`), com limite por tick e guardrails.
  - Telemetria irrefutável em `provision_audit`: `stock_provision_lock_end_detected` + `stock_provision_post_resume_tick`.
- **Por quê**: evitar o P0 “cadastra e não volta tudo a trabalhar” quando há pausa/quiesce e parte dos shards não retoma automaticamente.
- **Evidência**:
  - INC: `C:\conveniente\docs\inbox\done\INC-20260207-1403-01.md`
  - Código: `C:\conveniente\scripts\worker.js` (post stock_provision resume + marker)
  - Telemetria esperada: `C:\conveniente\dados\provision_audit.jsonl` eventos `stock_provision_*resume*`.
- **Reinícios**: `conveniente` (hosts afetados) — humano roda `node index.js`.
- **Rollback**: `git revert` do commit deste INC; reiniciar `conveniente`.

#### 2026-02-04 - [CT] Removidos/Reprovados: histórico central no cadastro + remove coluna “Motivo”

- **O que**:
  - Remove a coluna “Motivo” da aba **Removidos**.
  - Cria bloco **Histórico (Removidos/Reprovados)** no **cadastro (driver-level)** com scroll interno.
  - Backend passa a registrar eventos `membership_removed`/`membership_rejected` com `payload.note` (motivo) e cidade.
- **Por que**: “Motivo” não é dado de lista; é histórico operacional do cadastro (multi-cidade) e precisa ficar centralizado.
- **Evidência**:
  - `c:\sitechatbot\.cursor\debug.log` runId `ct_driver_motives_central_v1` (append events + fetch/render no cadastro)
  - INC fechado: `C:\conveniente\docs\inbox\done\INC-20260204-0144-01.md`
- **Reinícios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `C:\sitechatbot\convenientetecnologia\public\ct.js`, `C:\sitechatbot\convenientetecnologia\index.js`, `C:\sitechatbot\convenientetecnologia\lib\ctMembershipStore.js` e reiniciar CT.

#### 2026-02-04 - [CT] Chat: abrir sala no 1º nao lido + marcar como lido ao chegar no fim

- **O que**:
  - Ao abrir sala com nao lidas, ancora no 1º nao lido (em vez de abrir no fim).
  - Ao chegar no fim do chat, marca como lido mesmo sem "Novas mensagens (x)".
  - Evita corridas: abertura concorrente de salas agora auto-cancela para nao baguncar estado.
- **Por que**: leitura operacional em ordem + parar de "voltar pro nao lido" apos ja ter lido.
- **Evidencia**: `c:\sitechatbot\.cursor\debug.log` runIds `chat_open_unread_v1` (strategy before/after) e `chat_open_unread_perf_v1` (`mark_read_bottom`).
- **Reinicios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `C:\sitechatbot\convenientetecnologia\public\ct.js` e reiniciar CT.

#### 2026-02-04 - [CT] Aprovados: notificação por usuário + som dedicado (vitória/dinheiro)

- **O que**:
  - Badge de “novos em Aprovados” ficou monótono (não depende de contagem que sobe/desce).
  - Estado de “visto” passa a ser **por usuário** (não vaza entre logins no mesmo browser).
  - Som dedicado de Aprovados (diferente do chat), com timbre “bell/coin”.
- **Por que**: operacional (financeiro) precisa de alerta confiável e motivador.
- **Evidência**: `debug.log` (runId `ct_approved_notify_v1`) + confirmação humana.
- **Reinicios**: CT (sitechatbot) - `node index.js` (migração/rotas/ct.js).

#### 2026-02-04 - [CT] Aprovados: latência realtime aceitável (~1–2s) após enviar para o financeiro

- **O que**: medição ponta-a-ponta de latência (ação → SSE `ct_changed` → refreshCore → badge/som).
- **Evidência**: `debug.log` runId `ct_approved_rt_v1` (ex.: ack ~141ms, SSE recv ~138ms, badge ~1946ms).
- **Decisão**: manter (sem ajuste adicional) — “tá ótimo desde que funcione”.

#### 2026-02-04 - [CT] Encerrar INC-20260204-0130-01 (Zoom/Layout) por decisao do humano

- **O que**: INC `INC-20260204-0130-01` movido para `cancelled` e encerrado por decisao do humano (tempo/custo/estresse).
- **Por que**: nao atingiu baseline desejado em 100% (comparacao com 75%) dentro do tempo aceitavel.
- **Evidencia**: `c:\sitechatbot\.cursor\debug.log` runIds `ct_zoom_layout_v1`, `ct_zoom_density_v2`, `ct_layout_cols_v1`, `ct_topbar_sync_v1`, `ct_approved_clip_v1/v2`.
- **Reinicios**: nenhum (encerramento documental).
- **Rollback**: n/a (INC encerrado; mudancas operacionais permanecem como estao no repo local do CT).

#### 2026-02-04 - [CT] Chat: "Ver mais" sem indent na 1Âª linha

- **O que**: Ajuste no HTML gerado pelo clamp do "Ver mais" para nÃ£o inserir whitespace de template literal que virava recuo visual na 1Âª linha.
- **Por que**: padronizar layout; evitar 1Âª linha deslocada quando o clamp estÃ¡ ativo.
- **EvidÃªncia**: `c:\sitechatbot\.cursor\debug.log` runId `chat_vermais_v2` (leadingWsLen=0) + validaÃ§Ã£o humana (CÃ¡ssio): â€œperfeito, foiâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/ct.js` e reiniciar CT.


#### 2026-02-04 - [CT] Chat: "Mais usados" no picker do composer (ðŸ˜€)

- **O que**: O picker do ðŸ˜€ agora mostra "Mais usados" no topo (mesmo ranking do menu de reaÃ§Ã£o) + "Todos" abaixo; clicar no emoji no composer tambÃ©m alimenta o ranking.
- **Por que**: acelerar operaÃ§Ã£o (os emojis mais usados ficam sempre a 1 clique).
- **EvidÃªncia**: `c:\sitechatbot\.cursor\debug.log` runId `chat_mostused_composer_v1` + validaÃ§Ã£o humana (CÃ¡ssio): â€œficou perfeitoâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/ct.js` e reiniciar CT.


#### 2026-02-04 - [CT] Chat: corrigir mistura de mensagens entre salas (P0)

- **O que**: Corrigido bug onde Equipe/Canais/Privados mostravam histÃ³rico misturado (cache global).
- **Por que**: P0 â€” inviabilizava uso de canais/privados e causava risco de enviar no lugar errado.
- **Como**: cache por `roomId` + outbox local filtrado por sala.
- **EvidÃªncia**: `c:\sitechatbot\.cursor\debug.log` runId `chat_roommix_v1` (antes: sala vazia count=0 mas mergedCount alto; depois: mergedCount=0).
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/ct.js` e reiniciar CT.


#### 2026-02-04 - [CT] Chat: composer (8 linhas) sem sobrepor + foco sem borda

- **O que**:
  - Composer ajustado para nÃ£o sobrepor o texto aos botÃµes quando bate o teto de ~8 linhas (scroll interno).
  - Ajuste de espaÃ§amento do textarea (padding/line-height) para nÃ£o colar na borda.
  - Removido halo/borda azul ao focar o textarea do chat (sÃ³ no chat).
- **Por que**: melhorar leitura/digitaÃ§Ã£o e evitar texto â€œpor baixoâ€ de emoji/enviar.
- **EvidÃªncia**: validaÃ§Ã£o humana (CÃ¡ssio): â€œficou excelenteâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/ct.css`/`public/app.html`/`public/ct.js` e reiniciar CT.


#### 2026-02-03 - [CT] Chat: emoji pack (padrÃ£o apps) + picker UX

- **O que**:
  - Atualizado pack de emojis para lista padrÃ£o (apps) com filtro de compatibilidade no Windows.
  - Picker do composer: abre acima do campo, nÃ£o fecha ao selecionar, sem scroll horizontal fantasma.
  - Menu de reaÃ§Ã£o: nÃ£o fica mais cortado embaixo (altura/posiÃ§Ã£o calculadas pelo espaÃ§o disponÃ­vel).
  - â€œMais usadosâ€ agora reseta/pruna quando o pack muda.
- **Por que**: emoji Ã© ferramenta operacional; padronizar melhora consistÃªncia e velocidade.
- **EvidÃªncia**: `c:\sitechatbot\.cursor\debug.log` (runId `chat_emoji_pack_v3/v4` e `chat_react_menu_v1`) + validaÃ§Ã£o humana (CÃ¡ssio): â€œficou muito bomâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/ct.js` e `public/ct.css` e reiniciar CT.


#### 2026-02-03 - [CT] Chat: composer layout (input full + botoes dentro)

- **O que**: textarea do chat agora ocupa largura total; botÃµes ðŸ˜€/ï¼‹/Enviar ficam dentro do campo embaixo.
- **Por que**: melhora digitaÃ§Ã£o (campo maior) e UX mais parecido com apps modernos.
- **EvidÃªncia**: validaÃ§Ã£o humana (CÃ¡ssio): â€œfuncionou e ficou muito bomâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/app.html` + `public/ct.css` e reiniciar CT.


#### 2026-02-03 - [CT] Chat: cores por usuÃ¡rio (pill no autor)

- **O que**: cada usuÃ¡rio recebe uma cor consistente no pill do nome (CÃ¡ssio/Matheo/Larissa/Abiline com cores fixas; demais automÃ¡tico).
- **Por que**: leitura mais rÃ¡pida e menos confusÃ£o operacional em conversas com mÃºltiplos autores.
- **EvidÃªncia**: validaÃ§Ã£o humana (CÃ¡ssio): â€œficou excelenteâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `ct.js`/`ct.css` e reiniciar CT.


#### 2026-02-03 - [CT] Chat: histÃ³rico infinito (paginaÃ§Ã£o pra trÃ¡s)

- **O que**:
  - Chat agora carrega mensagens antigas ao subir (infinite scroll), com banner â€œCarregando mais mensagensâ€¦â€ / â€œInÃ­cio do histÃ³ricoâ€.
  - API passou a aceitar cursor `beforeId` alÃ©m de `sinceId`.
- **Por que**: permitir auditoria/consulta do histÃ³rico completo e suportar testes como â€œreenviar falha antigaâ€.
- **EvidÃªncia**: `c:\sitechatbot\.cursor\debug.log` (runId `chat_history_v1`) com requests usando `beforeId` e `hasMoreOlder=false` no final.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `ct.js`/`ctStore.js`/`index.js` e reiniciar CT.

#### 2026-02-03 - [CT] Chat: Reenviar mensagem falhada

- **O que**: Mensagem com falha fica com âš  e mostra botÃµes **Reenviar**/**Remover**; reenvio reutiliza texto/anexo do outbox.
- **Por que**: reduzir atrito operacional quando rede/servidor falha no envio.
- **EvidÃªncia**: validaÃ§Ã£o humana (CÃ¡ssio): â€œreenviar funcionouâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `ct.js` e reiniciar CT.


#### 2026-02-03 - [CT] Chat: links clicaveis

- **O que**:
  - Mensagens agora transformam URLs em links clicaveis (https/http, www, wa.me).
- **Por que**: melhorar produtividade (abrir links direto do chat).
- **Evidencia**: `docs/inbox/done/INC-20260203-2510-01.md` + `sitechatbot/convenientetecnologia/public/ct.js`.
- **Reinicios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter ct.js/ct.css e reiniciar CT.


#### 2026-02-03 - [CT] Chat: editar mensagem (menu ... + modal)

- **O que**:
  - Adicionado item Editar no menu (3 pontinhos) das mensagens do proprio usuario.
  - Modal de edicao com preview + textarea + confirmar/cancelar.
  - Backend: endpoint para editar mensagem e auditar edited_at/edited_by (com recalc de mencoes).
- **Por que**: corrigir rapidamente mensagens erradas e deixar o chat mais profissional.
- **Evidencia**: `docs/inbox/done/INC-20260203-2500-01.md` + `sitechatbot/convenientetecnologia/public/ct.js` + `sitechatbot/convenientetecnologia/lib/ctStore.js`.
- **Reinicios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter ct.js/ctStore/ctDb/index.js e reiniciar CT.


#### 2026-02-03 â€” [CT] Chat: composer auto-grow + Ver mais

- **O que**:
  - Composer do chat agora cresce automaticamente ate ~8 linhas.
  - Mensagens grandes agora exibem Ver mais/Ver menos.
- **Por que**: melhorar UX/operacao do chat (nao perder texto e ler mensagens longas).
- **Evidencia**: `docs/inbox/done/INC-20260203-2400-01.md` + UI em `sitechatbot/convenientetecnologia/public/ct.js`/`ct.css`.
- **Reinicios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter ct.js/ct.css e reiniciar CT.


#### 2026-02-03 â€” [CT][OPS] CT Sistema Interno: WhatsApp verde + menu + auditoria â€œChamou no zapâ€

- **O que**:
  - Adicionado botÃ£o WhatsApp (verde) com menu (abrir / copiar link / copiar nÃºmero) em: Testes â€” Encerrados, Chamar depois, Cadastro e ParticipaÃ§Ã£o.
  - Persistido â€œChamou no zapâ€ (Ãºltima aÃ§Ã£o + data/hora + usuÃ¡rio) para outros usuÃ¡rios verem nas listas operacionais (Testes Encerrados e Chamar depois).
- **Por quÃª**: padronizar o acesso rÃ¡pido ao WhatsApp e deixar rastreÃ¡vel quando o cliente foi cobrado.
- **EvidÃªncia**: `docs/inbox/done/INC-20260203-2230-01.md` + cÃ³digo em `sitechatbot/convenientetecnologia/public/ct.js`.
- **ReinÃ­cios**: `sitechatbot` (CT) â€” `node index.js`.
- **Rollback**: reverter alteraÃ§Ãµes no `ct.js`/endpoints/migraÃ§Ãµes e reiniciar CT.


#### 2026-02-03 â€” [DOCS][OPS] INBOX: remover duplicata que mantinha INC de migraÃ§Ãµes/cadastro como â€œin_progressâ€

- **O que**:
  - Removida a cÃ³pia duplicada do `INC-20260202-1600-01` que havia ficado em `docs/inbox/in_progress/` (o INC jÃ¡ estava corretamente em `docs/inbox/done/`).
  - Criada pasta `docs/inbox/need_evidence/` e movido `INC-20260201-0200-01` para lÃ¡ (ticket de RAM fica â€œpausadoâ€, sem parecer WIP ativo).
- **Por quÃª**: evitar confusÃ£o operacional (o humano via â€œem progressoâ€ um INC jÃ¡ encerrado).
- **EvidÃªncia**:
  - `C:\conveniente\docs\inbox\done\INC-20260202-1600-01.md`
  - removido: `C:\conveniente\docs\inbox\in_progress\INC-20260202-1600-01.md`
  - movido: `C:\conveniente\docs\inbox\need_evidence\INC-20260201-0200-01.md`
  - Ã­ndice: `C:\conveniente\docs\inbox\INDEX.md`
- **ReinÃ­cios**: nenhum
- **Rollback**: `git revert <commit>` (recria o arquivo removido; sem impacto em runtime)

#### 2026-02-02 â€” [CT][CROSS][FIX][OPS] Fonte Ãšnica (runtime): Virtus/Grupos + Contas Facebook passam a usar classificador canÃ´nico e UI explicita janela/supply

- **O que**:
  - `sitechatbot`: `/api/dashboard/virtus` e `/api/contas-facebook` passam a usar `computeAccountsByGroupFromSnapshots` (canÃ´nico) com `fbAccountState` para A/LR/LE/B.
  - `sitechatbot`: payload do Virtus inclui `groups.accountsMeta` (accountsMode/supplyMode/serversMeta) e UI Virtus mostra isso no topo (janela + supply + modo).
  - `sitechatbot`: UI Virtus corrige rÃ³tulo para `Contas (A/LR/LE/B)` (antes faltava LE no header).
- **Por quÃª**: garantir que CT â€œmostraâ€ exatamente a mesma verdade que CT â€œdecideâ€ (evita divergÃªncia P0).
- **EvidÃªncia**: `C:\sitechatbot\index.js` (`/api/dashboard/virtus`, `/api/contas-facebook`, `computeAccountsByGroupFromSnapshots`) + `C:\sitechatbot\public\virtus.js`.
- **ReinÃ­cios**: `sitechatbot` (CT) â€” humano reinicia com `node index.js`.
- **Rollback**: reverter alteraÃ§Ãµes no CT e reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-02-truth-single-source`

---

#### 2026-02-02 â€” [CROSS][DOCS][OPS] DossiÃª cidades/grupos: plano de implementaÃ§Ã£o auditÃ¡vel (warmup/LE/anti-pÃ¢nico)

- **O que**:
  - Consolidado plano executÃ¡vel (CT-only) para score Ãºnico por `cidade_uf` com guardrails: warmup 24h e LE por idade (12d).
  - Registrada evidÃªncia do contrato do `nome` do perfil (timestamp no sufixo) e knobs do anti-pÃ¢nico do CT (env vars).
- **Por quÃª**: garantir 110% de rastreabilidade antes de tocar em runtime.
- **EvidÃªncia**: `C:\conveniente\docs\inbox\done\INC-20260202-1600-01.md` + `C:\conveniente\scripts\api_perfis.js` + `C:\sitechatbot\index.js`.
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o/planejamento).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-02-02-city-score-plan`

---

#### 2026-02-03 â€” [CT][CROSS][FEAT][OPS] Cadastro (provisÃ£o) CT: rank por recent3d + remainingNeed (insight baixo amortecido por LE+pipeline)

- **O que**:
  - `sitechatbot`: `rankUrgentCityUFs()` passa a usar janela **recent3d** e prioriza **insight baixo** com amortecedor por `LE + pipelineW` (`remainingNeed`), evitando pÃ¢nico/overfit em uma cidade.
  - `sitechatbot`: `pickUrgentCityUF()` passa a reutilizar `rankUrgentCityUFs` (fallback consistente).
  - `sitechatbot`: mantÃ©m antiâ€‘pÃ¢nico existente (TOPâ€‘N + inflight cap + refresh) e continua â€œnunca pararâ€ quando houver estoque + vaga (scheduler).
- **Por quÃª**: cidades â€œfriasâ€ precisam de contas novas, mas o insight demora a reagir; o CT precisa descontar supply futuro (LE/provisÃµes recentes) para distribuir com lucidez.
- **EvidÃªncia**: `C:\sitechatbot\index.js` (`rankUrgentCityUFs`, `pickUrgentCityUF`, `pickNextCityUFForProvision`) + `C:\conveniente\docs\inbox\done\INC-20260202-1600-01.md`.
- **ReinÃ­cios**: `sitechatbot` (CT) â€” humano reinicia com `node index.js`.
- **Rollback**: restaurar lÃ³gica anterior em `rankUrgentCityUFs/pickUrgentCityUF` e reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-03-ct-provision-city-remaining-need`

---

#### 2026-02-03 â€” [CT][CROSS][FEAT][FIX][OPS] MigraÃ§Ãµes CT (V3): doador insight alto â†’ receptor insight baixo + pareamento corajoso (insight = recent3d)

- **O que**:
  - `sitechatbot`: `/api/contas-facebook-v2` passa a sugerir migraÃ§Ãµes com regra mestre V3: **doador = insight alto**, **receptor = insight baixo**, com `canDrainToZero` quando `donorInsight >= 2x avgInsight`.
  - `sitechatbot`: corrige a divergÃªncia de janela do **insight_percent**: agora usa **recent3d** (igual Virtus/Grupos) ao calcular `totalEngajamento` e `ratio` (antes estava em `sent_24h`).
  - `sitechatbot`: **corrige elegibilidade do doador no `/api/contas-facebook-v2/migrations/preview`** para nunca â€œmigrar LE por enganoâ€: a seleÃ§Ã£o passa a usar `fbAccountState.classify({ perfil, robeRec }).kind === 'ok'` (antes podia pegar `paused_limit` porque o `estado` nÃ£o estava espelhado em `p.robeEstado`).
  - Pareamento â€œcorajosoâ€ prioriza doadores mais quentes (config via `CT_MIG_DONOR_BONUS`, `CT_MIG_ALPHA`) e inclui `why` auditÃ¡vel em cada sugestÃ£o.
  - Continua **manual**: CT apenas sugere; execuÃ§Ã£o ainda Ã© via `/api/contas-facebook-v2/migrations/execute`.
- **Por quÃª**: evitar sugestÃµes erradas (ex.: tirar de cidade fria) e alinhar decisÃ£o com o que o humano aprovou na simulaÃ§Ã£o V3.
- **EvidÃªncia**: `C:\sitechatbot\index.js` (`/api/contas-facebook-v2` bloco migrations) + `INC-20260202-1600-01` (motor 1 migraÃ§Ã£o).
- **ReinÃ­cios**: `sitechatbot` (CT) â€” humano reinicia com `node index.js`.
- **Rollback**: reverter o bloco de migraÃ§Ãµes no endpoint e reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-03-ct-migrations-v3`

#### 2026-02-02 â€” [CROSS][DOCS][OPS] P0: Fonte Ãšnica da Verdade (CT Virtusâ†’Grupos vs Contas FB v2)

- **O que**:
  - Aberto INC P0 para unificar fonte da verdade entre dashboards e algoritmos (motoristas, engajamento e A/LR/LE/B).
  - Documentadas divergÃªncias atuais: janelas (recent3d vs rolling) e classificador simples (`p.estado`) vs canÃ´nico (`fbAccountState`).
- **Por quÃª**: evitar que humano veja uma coisa e o sistema decida outra (risco P0 de decisÃ£o errada).
- **EvidÃªncia**: `C:\conveniente\docs\inbox\done\INC-20260202-2000-01.md` + `C:\sitechatbot\index.js` (`/api/dashboard/virtus`, `/api/contas-facebook-v2`, `computeAccountsByGroupFromSnapshots`).
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o/planejamento).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-02-02-truth-single-source`

---

#### 2026-02-01 â€” [CONV][FEAT][OPS] Autopilot â€œTudo abertoâ€: toggle no painel + boot OFF + controle via desired

- **O que**:
  - `desired._autoOpen.enabled` controla o modo â€œTudo abertoâ€ (autopilot).
  - Boot do worker forÃ§a OFF para evitar reabertura automÃ¡tica apÃ³s restart.
  - `open-all-24h` liga o autopilot; `close-all` desliga; novo endpoint `POST /api/perfis/auto-open`.
  - `/api/status` passa a expor `autoOpen` e o painel mostra botÃ£o ON/OFF.
- **Por quÃª**: permitir abrir manualmente sem reabertura automÃ¡tica e manter controle explÃ­cito de â€œTudo abertoâ€.
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js`, `C:\conveniente\scripts\api_perfis.js`, `C:\conveniente\scripts\api_status.js`, `C:\conveniente\public\index.html`.
- **ReinÃ­cios**: `conveniente` (hosts).
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-auto-open-toggle`

---

#### 2026-02-01 â€” [CONV][FIX][OPS] Dashboard â€œTudo abertoâ€ nÃ£o atualizava estado

- **O que**:
  - `/api/status` agora inclui `autoOpen` no payload principal e no fallback de erro.
  - UI atualiza o botÃ£o â€œTudo abertoâ€ imediatamente apÃ³s o clique.
- **Por quÃª**: o botÃ£o ficava travado em OFF mesmo com autopilot ligado.
- **EvidÃªncia**: `C:\conveniente\scripts\api_status.js`, `C:\conveniente\public\index.html`.
- **ReinÃ­cios**: `conveniente` (hosts).
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-auto-open-toggle`

---

#### 2026-02-01 â€” [CONV][CT][CROSS][FEAT] CT/Servidores: contadores â€œLogin/Cookies falhouâ€ + â€œRecurso em anÃ¡liseâ€ + ordenaÃ§Ã£o OFFLINE primeiro

- **O que**:
  - `conveniente`: snapshot `status.json` passa a expor `loginRemediateFailed` em `status.perfis`.
  - `sitechatbot`: `GET /servers` agrega `flagsAgg.login_cookies_failed` e `flagsAgg.appeal_submitted`.
  - `sitechatbot`: UI do menu Servidores renderiza novos pills e o sort prioriza OFFLINE antes da capacidade.
- **Por quÃª**: dar visibilidade operacional exata no CT e manter lista estÃ¡vel (sem â€œdanÃ§arâ€).
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js` (snapshotStatusAndWrite), `C:\sitechatbot\index.js` (flagsAgg + sort), `C:\sitechatbot\public\index.html` (pills).
- **ReinÃ­cios**: `conveniente` (hosts) e `sitechatbot` (CT) apÃ³s deploy.
- **Rollback**: `git revert <hash>` em cada repo + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-ct-server-flags`

#### 2026-02-01 â€” [CONV][FIX][OPS] P0 total>ativos: impedir desativaÃ§Ã£o automÃ¡tica e manter perfis sempre ativos

- **O que**:
  - `open_all_finalize_partial` nÃ£o desativa mais `desired.active`; aplica backoff curto para reabrir quando houver RAM.
  - `nurseTick` reforÃ§a `desired.active=true` para perfis existentes (1x/min).
  - adiciona `OPEN_ALL_PARTIAL_BACKOFF_MS` (default 60s) para evitar loop agressivo.
- **Por quÃª**: evitar â€œbrowsers fechados sem motivoâ€ e garantir abertura contÃ­nua quando hÃ¡ RAM.
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js` (open_all_finalize_partial + nurseTick) + INC `INC-20260201-0300-01`.
- **ReinÃ­cios**: hosts `conveniente` apÃ³s deploy.
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-open-gaps`

#### 2026-02-01 â€” [CONV][FIX][OPS] Abrir Todos: nÃ£o bloquear abertura quando `loginRequired=captcha_*` ou `identityRequired` e browser fechado

- **O que**:
  - `nurseTick` deixa de dar `continue` em captcha/identidade quando `ctrl` estÃ¡ ausente; o perfil cai no fluxo normal `want.active && !ctrl` e o navegador abre.
  - Logs operacionais (sem segredos) no `provision_audit`: `nurse_captcha_required_no_ctrl_allow_open`, `nurse_identity_required_no_ctrl_allow_open`.
  - Removidas instrumentaÃ§Ãµes temporÃ¡rias desta rodada (POST local `127.0.0.1:7242`).
- **Por quÃª**: regra do negÃ³cio: â€œse estÃ¡ no servidor e tem `desired.active=true`, deve abrir â€” mesmo se estiver em captcha/identidade/appealâ€.
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js` + INC `INC-20260201-0300-01` + RM1 CT snapshot `C:\sitechatbot\dados\084c8fff-c508-47bd-a33e-3ab34aeb1e3d-*.json`.
- **ReinÃ­cios**: hosts `conveniente` apÃ³s deploy.
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-open-gaps`

#### 2026-01-31 â€” [CONV][FEAT][OPS] Captcha: implementa OCR Groq para resolver captchas automaticamente (ultra enterprise melhor do mundo)

- **O que**:
  - Adicionada funÃ§Ã£o `solveCaptchaWithGroq` em `scripts/browser.js` que extrai imagem do captcha via canvas, chama Groq API e processa resposta para retornar texto limpo.
  - Integrado OCR no fluxo de 3 tentativas em `runIdentityFlow`: extrai imagem, chama Groq, digita texto, verifica se botÃ£o "Continuar" ficou azul.
  - Se botÃ£o nÃ£o ficar azul apÃ³s digitar: reload para pegar nova imagem e tenta novamente (atÃ© 3 vezes).
  - Processamento robusto da resposta Groq: remove comentÃ¡rios/explicaÃ§Ãµes e extrai apenas o texto do captcha.
- **Por quÃª**: automatizar resoluÃ§Ã£o de captchas usando Groq OCR para reduzir necessidade de intervenÃ§Ã£o humana.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\browser.js` (`solveCaptchaWithGroq`, logs `captcha_flow_ocr_attempt`, `captcha_flow_fill_attempt`)
  - `C:\conveniente\scripts\worker.js` (integraÃ§Ã£o OCR no loop de 3 tentativas)
  - Commit: `2c9abe9` (feat: implementa OCR Groq para resolver captchas)
- **ReinÃ­cios**: `conveniente` (hosts) â€” humano reinicia com `node index.js`.
- **Rollback**: `git revert 2c9abe9` e reiniciar `node index.js`.

#### 2026-01-31 â€” [CONV][FIX][OPS] Identidade: remover cooldown do gate global (evita engessamento apÃ³s captcha)

- **O que**:
  - `IDENTITY_GATE.cooldownMinMs` e `cooldownMaxMs` zerados para permitir sequÃªncia imediata de fluxos de identidade (ainda 1 por vez no host).
- **Por quÃª**: evidÃªncia mostrou `identity_flow_gate_denied` por cooldown, travando contas na tela de identidade apÃ³s captcha.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\worker.js` (IDENTITY_GATE)
  - RM7 `provision_audit`: eventos `identity_gate_denied why=cooldown` + `identity_flow_gate_denied` (fetch `rm7_fetch_identity_stuck_1769899549740.json`)
- **ReinÃ­cios**: `conveniente` (hosts) â€” humano reinicia com `node index.js`.
- **Rollback**: reverter commit desta mudanÃ§a e reiniciar `node index.js`.

#### 2026-01-31 â€” [CONV][FIX][OPS] Pre-screen â€œConfirme que vocÃª Ã© humanoâ€: esperar â€œContinuarâ€ habilitar e nÃ£o invocar humano cedo

- **O que**:
  - Adicionado `waitForContinueEnabled` e usado no pre-screen.
  - Pre-screen nÃ£o entra em humano quando â€œContinuarâ€ estÃ¡ desabilitado; retorna e o nurse re-tenta com debounce.
- **Por quÃª**: evidÃªncia mostrou `continue_disabled` levando a humano cedo, mesmo sendo um estado transitÃ³rio do Facebook.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\browser.js` (`waitForContinueEnabled`)
  - `C:\conveniente\scripts\worker.js` (`captcha_flow_pre_screen_wait` / retorno `pre_screen_disabled`)
  - RM7 `provision_audit` (bundle CT: `rm7_fetch_sp_regression_1769899065677.json`)
- **ReinÃ­cios**: `conveniente` (hosts) â€” humano reinicia com `node index.js`.
- **Rollback**: reverter commit desta mudanÃ§a e reiniciar `node index.js`.

#### 2026-01-31 â€” [CONV][FIX][OPS] Captcha: tratar pre-screen "Confirme que vocÃª Ã© humano" + 3 tentativas antes de invocar humano (sem OCR implementado)

- **O que**:
  - `detectLoginRequired` passou a detectar `captcha_persona_pre_screen` (tela â€œconfirme que vocÃª Ã© humano para usar sua contaâ€) com sinais anti-falso-positivo.
  - Adicionados helpers em `scripts/browser.js` para clicar â€œContinuarâ€, detectar captcha (imagem+input) e preparar foco do input (sem OCR).
  - `login_remediate` e `runIdentityFlow` agora fazem **3 tentativas** (pre-screen click + captcha revalidar/click-se-habilitado/reload) antes de invocar humano.
- **Por quÃª**: evitar falso positivo e evitar â€œinvocar humano imediatoâ€ quando dÃ¡ para avanÃ§ar pelo menos o â€œContinuarâ€ e revalidar o estado.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\browser.js` (`captcha_persona_pre_screen`, `clickContinueByLabel`, `detectCaptchaChallenge`)
  - `C:\conveniente\scripts\worker.js` (eventos `captcha_flow_*`, `captcha_requires_human_after_3_tries`)
- **ReinÃ­cios**: `conveniente` (hosts) â€” humano reinicia com `node index.js`.
- **Rollback**: `git revert` do commit desta mudanÃ§a e reiniciar `node index.js`.

#### 2026-01-31 â€” [CROSS][CONV][CT][FEAT][OPS] Groq config: host auto-solicita e CT envia `set_groq_config` (persistente em `dados/groq_config.json`)

- **O que**:
  - Host (`conveniente`) passou a sinalizar `needsGroqConfig=true` quando faltar config e a aceitar comando `set_groq_config` para persistir em `C:\conveniente\dados\groq_config.json` (ignorado no git).
  - CT (`sitechatbot`) passou a enfileirar `set_groq_config` quando receber `/report` com `needsGroqConfig=true`, lendo `GROQ_API_KEY` e `GROQ_MODEL` do ambiente (modelo tem default).
- **Por quÃª**: permitir que cada host faÃ§a requisiÃ§Ã£o prÃ³pria ao Groq sem depender de `.env` no host e sem operaÃ§Ã£o manual por host.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\groqConfig.js`
  - `C:\conveniente\scripts\dashboard.js`
  - `C:\conveniente\.gitignore`
  - `C:\sitechatbot\index.js` (bloco AUTO-CONFIG GROQ no handler `/report`)
  - `C:\sitechatbot\convenientetecnologia\ct.env` (GROQ_MODEL)
- **ReinÃ­cios**:
  - `sitechatbot` (CT) â€” humano reinicia com `node index.js`
  - `conveniente` (hosts) â€” humano reinicia com `node index.js`
- **Rollback**: `git revert` do(s) commit(s) deste item e reiniciar `node index.js`.
- **THREAD**: `TH-2026-01-31-groq-config`

#### 2026-01-31 â€” [CONV][FIX][OPS] RM3: fila atÃ´mica para retry (governor_busy) nÃ£o travar em `configurando=true`

- **O que**:
  - `queueAutoLoginRemediate(...force=true)` agora persiste `autoLoginRemediate.force` (para retries).
  - `autoLoginRemediateTick` pode avanÃ§ar a fila mesmo com `ctrl.configurando=true` **somente** quando o item estÃ¡ `queued && force && nextAt<=now` e nÃ£o hÃ¡ `provisionLock` ativo (mantendo `humanControl` como hard-stop).
  - Removidas instrumentaÃ§Ãµes temporÃ¡rias de debug (`127.0.0.1:7242/ingest/...`) apÃ³s validaÃ§Ã£o.
- **Por quÃª**: o retry existia, mas era pulado por `configurando=true`, causando â€œsÃ³ 1 conta vaiâ€ / engessamento.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\worker.js` (`autoLoginRemediateTick`, `queueAutoLoginRemediate`)
  - RM3 `provision_audit` no CT: `C:\sitechatbot\dados\logs\5d7c3309-8581-4a50-a421-e6cbb52d8070\rm3_pa_tail_verify_20260131_01.json`
- **ReinÃ­cios**: `conveniente` (hosts afetados) â€” humano reinicia com `node index.js` quando for testar/validar runtime novo.
- **Rollback**: `git revert d1d84f8` e reiniciar `node index.js`.

#### 2026-01-30 â€” [CONV][FIX][OPS] Retomar trabalho: retry imediato quando governor ocupado

- **O que**:
  - Adicionado retry imediato (forÃ§ado) do `login_remediate` quando o governor estÃ¡ ocupado em `human-resume`.
  - Log de evidÃªncia `login_remediate_governor_retry_queued` para rastrear a re-fila.
- **Por quÃª**: evitar â€œengessamentoâ€ apÃ³s Retomar trabalho quando outro login_remediate estÃ¡ em andamento.
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js` (human-resume + auto_login_remediate queue)
- **ReinÃ­cios**: `conveniente` no RM3 (node index.js).
- **Rollback**: reverter commit `fix: honor human mode + login form` + retry governor (ou `git revert` do Ãºltimo commit).

#### 2026-01-30 â€” [CONV][FIX][OPS] Open-all/manual limpa flags de login antes do re-probe

- **O que**:
  - Na abertura (open_all/manual), limpa flags de login (`loginRequired`, `loginRemediateFailed`, `messengerPin`) e registra evento.
  - RevalidaÃ§Ã£o real continua via `probeHumanStateOnOpen`.
- **Por quÃª**: evitar UI â€œpresaâ€ com flags antigas e garantir reavaliaÃ§Ã£o do estado atual.
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js` (eventos `open_clear_login_flags*`).
- **ReinÃ­cios**: `conveniente` no RM3 (node index.js).
- **Rollback**: reverter commit do ajuste de open flags.

#### 2026-01-30 â€” [CROSS][DOCS][OPS] INBOX: novo INC para â€œCT mostra OFFLINE falsoâ€ (RM3) + clarificaÃ§Ãµes hostId/telemetria

- **O que**:
  - Criado `INC-20260130-0905-01` (RM3 marcado OFFLINE no CT embora host esteja acessÃ­vel) para investigaÃ§Ã£o com evidÃªncia.
  - Registrado no `INBOX_RELATOS_DO_HUMANO.md` e no `docs/inbox/INDEX.md`.
  - Clarificado no `LIVRO_DE_BORDO.md` que `hostId` nÃ£o muda com restart; e que a telemetria `/report` Ã© enviada em loop (default 30s).
- **Por quÃª**: eliminar achismo (â€œmÃ¡quina onlineâ€ vs â€œCT recebendo `/report`â€) e tornar o estado auditÃ¡vel antes de qualquer refactor.
- **EvidÃªncia**:
  - `C:\conveniente\docs\inbox\cancelled\INC-20260130-0905-01.md` (movido para cancelled)
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
- **ReinÃ­cios**: nenhum (somente docs/triagem).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-30-ct-offline-triage`

#### 2026-01-30 â€” [CONV][CT][DOCS][OPS] Auditoria estrutural: conveniente + integraÃ§Ã£o CT

- **O que**:
  - Criado checkup de auditoria estrutural do `conveniente` + integraÃ§Ã£o com CT, com mapa de mÃ³dulos e riscos P1/P2.
  - Registrado plano de desengessamento (sem mudanÃ§a de runtime nesta rodada).
- **Por quÃª**: pedido explÃ­cito de auditoria â€œultra detalhadaâ€ para orientar correÃ§Ãµes sem achismo.
- **EvidÃªncia**: `C:\conveniente\docs\checkups\checkup_2026-01-30_auditoria_conveniente_ct.md`
- **ReinÃ­cios**: nenhum (documentaÃ§Ã£o).
- **Rollback**: reverter o arquivo `.md` (nÃ£o afeta runtime).

#### 2026-01-30 â€” [CT][CROSS][FIX][OPS] Servidores (CT): remover â€œDesconhecidoâ€ e expor flags acionÃ¡veis (Humano invocado + Outros (login))

- **O que**:
  - Estado `unknown` virou **`login_other`** (label humano: **Outros (login)**), mantendo `loginReason` para auditoria.
  - CT `/servers` passou a expor `flagsAgg` (ex.: `human_invoked`, `login_reasons_top`) para o dashboard ser fonte de verdade operacional.
  - UI â€œServidoresâ€ removeu pill â€œDesconhecidoâ€ e passou a mostrar **Humano invocado** + **Outros (login)** (com tooltip de `loginReason` top).
  - UI â€œcontas-facebook-contasâ€ alinhada para `login_other` (sem â€œDesconhecidoâ€).
- **Por quÃª**: o operador usa â€œServidoresâ€ para decidir qual host ir; â€œDesconhecidoâ€ nÃ£o Ã© acionÃ¡vel e quebra a confiabilidade do painel.
- **EvidÃªncia**:
  - `C:\sitechatbot\convenientetecnologia\lib\fbAccountState.js`
  - `C:\sitechatbot\index.js` (`GET /servers` â†’ `accountsAgg` + `flagsAgg`)
  - `C:\sitechatbot\public\index.html`
  - `C:\sitechatbot\convenientetecnologia\public\contas-facebook-contas.html`
  - Snapshot exemplo (motivo real): `C:\sitechatbot\dados\5d7c3309-...-30b3fe928b.json` contÃ©m `loginReason:"probe_failed"`
- **ReinÃ­cios**:
  - **CT (`sitechatbot`)**: **sim** â€” humano reinicia no host do CT com `node index.js`
  - **conveniente (hosts)**: **nÃ£o** (mudanÃ§a Ã© no CT/UI; docs do conveniente foram atualizadas via git)
- **Rollback**:
  - CT: restaurar arquivos via `C:\sitechatbot\_backup_auto_root\...` + reiniciar `node index.js`
  - conveniente: `git revert 976c6ef` (somente docs)
- **THREAD**: `TH-2026-01-30-ct-servers-states-flags`

#### 2026-01-30 â€” [CROSS][DOCS][OPS] INBOX: cancelar INC-20260130-0905-01 (RM3 OFFLINE falso) a pedido do humano

- **O que**:
  - Marcado `INC-20260130-0905-01` como `cancelled` e movido para `docs/inbox/cancelled/`.
  - Atualizados Ã­ndices (`docs/inbox/INDEX.md` e `INBOX_RELATOS_DO_HUMANO.md`) para nÃ£o deixar link quebrado.
- **Por quÃª**: cancelado a pedido do humano (decisÃ£o consciente).
- **EvidÃªncia**:
  - `C:\conveniente\docs\inbox\cancelled\INC-20260130-0905-01.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
- **ReinÃ­cios**: nenhum (somente docs).
- **Rollback**: `git revert <commit>` (nÃ£o afeta runtime).

#### 2026-01-29 â€” [CROSS][DOCS] OrganizaÃ§Ã£o inicial do conhecimento (bootstrap)

- **O que**:
  - Criado `docs/LIVRO_DE_BORDO.md` como Ã­ndice/porta de entrada.
  - Criado `docs/RUNBOOK_TECNICO.md` (procedimentos operacionais).
  - Criado `docs/TIMELINE.md` (este arquivo).
  - Criado `docs/checkup_geral_2026-01-29.md` com achados tÃ©cnicos.
- **Por quÃª**: evitar perda de contexto entre chats/GPTs e reduzir criaÃ§Ã£o de â€œcaminhos paralelosâ€.
- **EvidÃªncia**: arquivos em `C:\conveniente\docs\`.
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: remover os arquivos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-docs-bootstrap`

---

#### 2026-01-29 â€” [CONV][FIX][OPS] P1: `close_all` com timeout/retry e erro explÃ­cito (sem â€œfetch failedâ€ opaco)

- **O que**:
  - endurecido `httpJson()` no `dashboard.js` com timeout (AbortController) + retry leve + mensagem com URL/timeout.
  - `close_all` via comando agora usa timeout maior (atÃ© 15min) e seta `x-operator` com `cmdId` para rastreio.
- **Por quÃª**: logs do CT mostraram `close_all` falhando com `ackError: fetch failed` (erro opaco, sem contexto).
- **EvidÃªncia**:
  - CT: `C:\sitechatbot\dados\logs\bcf01e8d-82da-4d5d-aed0-d60305d4696d\ack_f941b889-b8d2-4823-a64e-4c507bc9df37.json`
  - cÃ³digo: `C:\conveniente\scripts\dashboard.js` (`httpJson`, `execCloseAll`)
- **Precisa reiniciar agora?** nÃ£o (dÃ¡ para continuar atualizando).
- **Precisa reiniciar para validar/testar?** sim (para o host aplicar a mudanÃ§a).
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert <commit>` e reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX][OPS] P1: `stock_provision` com evidÃªncia de â€œbusy_timeoutâ€ (busyDetails/pauseableDetails)

- **O que**:
  - ampliado snapshot de quiescÃªncia do `stock_provision` para incluir `busyDetails` e `pauseableVirtusDetails` (flags reais por perfil).
  - erro de timeout agora inclui `sample=` com nomes para diagnÃ³stico rÃ¡pido no CT.
- **Por quÃª**: logs do CT mostraram `stock_provision` falhando com `busy_timeout count=21` sem contexto do â€œpor quÃªâ€ cada perfil estava ocupado.
- **EvidÃªncia**:
  - CT: `C:\sitechatbot\dados\logs\bcf01e8d-82da-4d5d-aed0-d60305d4696d\ack_2f0461f7-db74-478d-a43a-0c83485abfbe.json`
  - cÃ³digo: `C:\conveniente\scripts\dashboard.js` (`execStockProvision` â†’ `computeQuiesceSnapshot`)
- **Precisa reiniciar agora?** nÃ£o
- **Precisa reiniciar para validar/testar?** sim
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert <commit>` e reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX][OPS] P1: evitar â€œsendLockActive presoâ€ (Virtus libera via Browser, nÃ£o via Page)

- **O que**:
  - `virtus.js`: `send-lock` agora Ã© adquirido/liberado usando o objeto `browser` diretamente (nÃ£o depende de `page.browser()`).
  - isso evita leak do lock quando a pÃ¡gina fecha/desconecta durante o fluxo do chat.
- **Por quÃª**: evidÃªncia no CT mostra muitos perfis com `sendLockActive=true`, o que dispara `busy_timeout` e bloqueia operaÃ§Ãµes crÃ­ticas (provisÃ£o/locks).
- **EvidÃªncia**:
  - CT snapshot: `C:\sitechatbot\dados\bcf01e8d-82da-4d5d-aed0-d60305d4696d-de8717d9f1.json` (vÃ¡rios `sendLockActive=true`)
  - CT ack: `C:\sitechatbot\dados\logs\bcf01e8d-82da-4d5d-aed0-d60305d4696d\ack_2f0461f7-db74-478d-a43a-0c83485abfbe.json` (`busy_timeout`)
  - cÃ³digo: `C:\conveniente\scripts\virtus.js` (`acquireSendGuardBrowser`, `releaseSendGuardBrowser`)
- **Precisa reiniciar agora?** nÃ£o
- **Precisa reiniciar para validar/testar?** sim
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert <commit>` e reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][DOCS] Achado P0 (ainda nÃ£o corrigido): lock nÃ£o owner-safe

- **O que**: identificado P0 de concorrÃªncia em lock de arquivo no `conveniente`.
- **Por quÃª**: `unlink` do lock pode acontecer mesmo sem adquirir o lock â‡’ risco de corrida/corrupÃ§Ã£o.
- **EvidÃªncia**: `docs/checkup_geral_2026-01-29.md` e `conveniente/scripts/fileStore.js`.
- **ReinÃ­cios**: nenhum (ainda nÃ£o alterado).
- **Rollback**: n/a (nÃ£o houve mudanÃ§a).

---

#### 2026-01-29 â€” [CONV][FIX] CorreÃ§Ã£o P0: lock owner-safe em `fileStore.js` + remove busy-wait (CPU)

- **O que**:
  - corrigido release de lock para **nÃ£o** remover `.lock` quando o lock nÃ£o foi adquirido.
  - adicionados metadados no lock (pid/ts/token) e recuperaÃ§Ã£o best-effort de lock â€œstaleâ€ por idade.
  - trocado busy-wait do lock de `perfis.json` por `Atomics.wait` (nÃ£o gasta CPU).
- **Por quÃª**: eliminar risco de corrida/corrupÃ§Ã£o em `desired.json`/`perfis.json` e reduzir congelos por contenÃ§Ã£o.
- **EvidÃªncia**: `C:\conveniente\scripts\fileStore.js` (seÃ§Ã£o de locks `desired.json`/`perfis.json`).
- **ReinÃ­cios**: **conveniente** (somente) â€” **humano** reinicia no host do `conveniente` (parar e rodar `node index.js`).
- **Rollback**: o GPT prepara rollback via Git (ex.: `git revert` / voltar tag). O humano aplica reiniciando `node index.js` no host do `conveniente`.

---

#### 2026-01-29 â€” [CONV][FIX] P1: deadline/logs no `ensureFreeMB` (sem espera infinita)

- **O que**: `ensureFreeMB()` no `conveniente/scripts/dashboard.js` deixou de esperar infinito; agora tem `timeoutMs`, logs de progresso e erro explÃ­cito no timeout.
- **Por quÃª**: regra canÃ´nica P1: nenhuma espera pode ser infinita.
- **EvidÃªncia**: `C:\conveniente\scripts\dashboard.js` (funÃ§Ã£o `ensureFreeMB`).
- **Precisa reiniciar agora?** nÃ£o (mudanÃ§a preventiva; sÃ³ â€œvaleâ€ no runtime apÃ³s restart).
- **Precisa reiniciar para validar/testar?** sim, se vocÃª quiser testar `ensureFreeMB` em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX] P1: auto-backup do `index.js` em subprocess (reduz freeze)

- **O que**: o snapshot automÃ¡tico (`CONVENIENTE_AUTO_BACKUP_*`) deixou de rodar com IO sÃ­ncrono pesado no processo principal; agora dispara um subprocesso (`scripts/autoBackupWorker.js`) para fazer o trabalho.
- **Por quÃª**: P1 â€” reduzir latÃªncia/congelos do `conveniente` sob stress.
- **EvidÃªncia**:
  - `C:\conveniente\index.js` (funÃ§Ã£o `startAutoBackupConveniente`)
  - `C:\conveniente\scripts\autoBackupWorker.js`
- **Precisa reiniciar agora?** nÃ£o (sÃ³ Ã© necessÃ¡rio quando vocÃª quiser o benefÃ­cio em runtime).
- **Precisa reiniciar para validar/testar?** sim, se vocÃª quiser observar â€œmenos freezeâ€ e confirmar que `_backup_auto/_snapshots.log` continua sendo gerado.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX] P1: auto-backup evita snapshots concorrentes (lock)

- **O que**: adicionado lock no worker de backup para impedir snapshots concorrentes quando um snapshot demora mais que o intervalo (e stale recovery).
- **Por quÃª**: reduzir IO/carga e evitar â€œpile-upâ€ de backups.
- **EvidÃªncia**: `C:\conveniente\scripts\autoBackupWorker.js` (lock `_snapshot_running.lock`).
- **Precisa reiniciar agora?** nÃ£o
- **Precisa reiniciar para validar/testar?** sim, se quiser observar o comportamento em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX] P1: logs/guardrails em waits de UI (browser/virtus)

- **O que**:
  - `browser.js`: `waitAny()` agora loga timeout quando `BROWSER_DEBUG=1`.
  - `browser.js`: loop de `identityAssistStep` ficou explicitamente bounded por budget/minTries (sem `while(true)`).
  - `virtus.js`: `assertOnChat` loga timeout quando `VIRTUS_DEBUG=1` (sÃ³ em timeout).
- **Por quÃª**: P1 â€” reduzir â€œtravou e nÃ£o sei ondeâ€ e garantir que waits sejam sempre bounded.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\browser.js`
  - `C:\conveniente\scripts\virtus.js`
- **Precisa reiniciar agora?** nÃ£o
- **Precisa reiniciar para validar/testar?** sim, se quiser observar logs em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX] P1: handlers globais de erro (master/worker) + opÃ§Ã£o de exit

- **O que**: padronizado `uncaughtException`/`unhandledRejection` no master (`index.js`) e no worker (`scripts/worker.js`), com logs consistentes e opÃ§Ã£o `CONVENIENTE_FATAL_EXIT=1` para sair (evitar â€œseguir vivoâ€ corrompido).
- **Por quÃª**: P1 â€” polÃ­tica de erro consistente e auditÃ¡vel.
- **EvidÃªncia**:
  - `C:\conveniente\index.js`
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (baseline env)
- **Precisa reiniciar agora?** nÃ£o (sÃ³ Ã© necessÃ¡rio quando vocÃª quiser que isso passe a valer no runtime).
- **Precisa reiniciar para validar/testar?** sim, se quiser simular erro e ver o comportamento/log.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Inbox canÃ´nica para â€œtexto bombaâ€ do humano (triage P0/P1/P2)

- **O que**: criado canal canÃ´nico para intake/triage de relatos desorganizados do humano (colagem do texto bruto + decomposiÃ§Ã£o em itens + P0/P1/P2 + evidÃªncia).
- **EvidÃªncia**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seÃ§Ã£o â€œIntake de texto bomba do humanoâ€)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (link no Ã­ndice)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] INBOX: anÃ¡lise de impacto obrigatÃ³ria (callers/callees/efeitos colaterais)

- **O que**: reforÃ§ado que â€œtriagem inboxâ€ inclui **investigaÃ§Ã£o real** antes de mexer: mapear fluxo ponta a ponta e impactos (callers/callees/estados/efeitos colaterais).
- **EvidÃªncia**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (Mapa de impacto obrigatÃ³rio)
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (intake: anÃ¡lise de impacto)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] INBOX: â€œolhar o histÃ³rico primeiroâ€ (timeline + file_timeline)

- **O que**: padronizado que triagem inbox inclui checar histÃ³rico (TIMELINE + file_timeline/hotspots) para detectar regressÃ£o e evitar repetir erro.
- **EvidÃªncia**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (HistÃ³rico relacionado obrigatÃ³rio)
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (intake: olhar histÃ³rico)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] INBOX: perguntas obrigatÃ³rias (como deveria ser / sucesso)

- **O que**: triagem inbox agora exige perguntas item-a-item (â€œcomo deveria serâ€, â€œcritÃ©rio de sucessoâ€, prioridade) antes de qualquer correÃ§Ã£o.
- **EvidÃªncia**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Host registry (apelidos â†” hostId)

- **O que**: criado registro canÃ´nico para mapear apelidos humanos (â€œrobe mae 2â€) para `hostId` e facilitar coleta de logs via CT.
- **EvidÃªncia**: `C:\conveniente\docs\HOST_REGISTRY.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Host registry preenchido (CT aliases + snapshots)

- **O que**: preenchido `HOST_REGISTRY.md` automaticamente a partir de `C:\sitechatbot\dados\server_names.json` + snapshots do CT.
- **EvidÃªncia**:
  - `C:\sitechatbot\dados\server_names.json`
  - `C:\conveniente\docs\HOST_REGISTRY.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] INBOX: bloco de â€œregras nÃ£o negociÃ¡veisâ€ (humano/GPT)

- **O que**: adicionado bloco de regras nÃ£o negociÃ¡veis e lista de arquivos canÃ´nicos dentro do `INBOX_RELATOS_DO_HUMANO.md` para guiar triage em chats com relato confuso.
- **EvidÃªncia**: `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS] Checkup 3 (loops/timeouts/polling)

- **O que**:
  - Documentado contrato CTâ‡„Notificador (poll/ack).
  - Documentado canal de logs `*_secret` (requestId/response) no CT.
  - Registrada regra canÃ´nica anti â€œespera infinitaâ€ (deadlines/ACK/GC).
  - Registrado achado P1: risco de `while(true)` sem deadline (ex.: `ensureFreeMB` legado no `conveniente`).
- **EvidÃªncia**:
  - `docs/LIVRO_DE_BORDO.md`
  - `docs/RUNBOOK_TECNICO.md`
  - `docs/checkup_geral_2026-01-29.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o/auditoria).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-ops-contracts`

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Checklist canÃ´nico de release (P0/P1) no RUNBOOK

- **O que**: promovido checklist de â€œproduÃ§Ã£o real de atualizaÃ§Ãµesâ€ para o `RUNBOOK_TECNICO.md`, com gate explÃ­cito P0/P1 e links para evidÃªncias/auditorias.
- **Por quÃª**: garantir que qualquer GPT consiga atualizar sem achismo e sem â€œcaminhos paralelosâ€.
- **EvidÃªncia**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seÃ§Ã£o â€œChecklist de release / atualizaÃ§Ã£o (produÃ§Ã£o real) â€” CANÃ”NICOâ€)
  - `C:\conveniente\docs\checkup_geral_2026-01-29.md` (P0/P1)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-release-checklist-p0p1`

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Contrato humano/GPT (node manual) + `self_update` sem espera

- **O que**: reforÃ§ado contrato operacional: humano sÃ³ reinicia manualmente com `node index.js`; GPT nÃ£o â€œreinicia servidorâ€. Documentado comportamento real de `self_update` e regra de nÃ£o ficar esperando resposta.
- **EvidÃªncia**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seÃ§Ãµes â€œRegra humana (restart)â€ e â€œself_update (comando) â€” como funcionaâ€)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (regra humana)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] PowerShell gotchas (sem `&&`/heredoc) para commits/comandos

- **O que**: registrado â€œjeito certoâ€ de rodar comandos no Windows/PowerShell (ex.: nÃ£o usar `&&` e nÃ£o usar heredoc `<<EOF`) para evitar GPTs repetirem tentativa/erro.
- **EvidÃªncia**: `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seÃ§Ã£o â€œWindows/PowerShell â€” pegadinhas operacionaisâ€)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] VocabulÃ¡rio: â€œpullâ€ = `self_update` (CT)

- **O que**: padronizado vocabulÃ¡rio humano: quando o humano disser â€œpullâ€, significa disparar `self_update` via CT (equivalente a `git pull` no host).
- **EvidÃªncia**:
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Regra: â€œprecisa reiniciar agora?â€ vs â€œprecisa reiniciar para validarâ€

- **O que**: registrado que nem toda atualizaÃ§Ã£o exige restart imediato para continuar trabalhando; restart Ã© obrigatÃ³rio quando a mudanÃ§a precisa estar valendo no runtime (teste/validaÃ§Ã£o).
- **EvidÃªncia**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (checklist: â€œPrecisa reiniciar agora?â€ + regra de restart)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (regra de restart)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS] ReconstruÃ§Ã£o retroativa (~10 dias) a partir de evidÃªncias (Git/backups/recovery)

- **O que**: reconstruÃ­do histÃ³rico dos Ãºltimos ~10 dias (conveniente/sitechatbot/notificador) usando Git, logs de backups e arquivos de recovery.
- **EvidÃªncia**: `C:\conveniente\docs\checkups\checkup_2026-01-29_reconstrucao_ultimos_10_dias.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-timeline`

---

#### 2026-01-29 â€” [CROSS][DOCS] Backfill nÃ­vel 2: Cursor timeline + planos/patches + backups recebidos

- **O que**: consolidado â€œrastro do Cursorâ€ (transcripts/terminals) + patches/diffs + manifests de backups recebidos pelo CT + scripts de rollback/prune.
- **Por quÃª**: transformar evidÃªncia espalhada (plans/backups/patches) em material pesquisÃ¡vel para debug e RCA.
- **EvidÃªncia**: `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_planos_patches.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-cursor-plans`

---

#### 2026-01-29 â€” [CROSS][DOCS] Backfill nÃ­vel 3: Cursor `agent-tools` (marcos reais: cmdId/requestId/git pull/push)

- **O que**: minerado `agent-tools/*.txt` do Cursor para recuperar marcos reais (ex.: `list_backups`, `bulk_gitpull_*`, `push_update`, scripts de start).
- **Por quÃª**: aumentar precisÃ£o de RCA/debug quando nÃ£o hÃ¡ Git em todos os projetos e o passado estÃ¡ â€œespalhadoâ€.
- **EvidÃªncia**: `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_agenttools.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-cursor-agenttools`

---

#### 2026-01-29 â€” [CROSS][DOCS] Timeline retroativa (09/01 â†’ hoje) (formato â€œem tempo realâ€)

- **O que**: criada timeline retroativa 2026-01-09 â†’ 2026-01-29 no formato â€œcomo se fosse em tempo realâ€, com THREADs e evidÃªncias (Git/backups/recovery/Cursor).
- **Por quÃª**: deixar o â€œpassadoâ€ rastreÃ¡vel para RCA/debug, sem confundir retroativo com o padrÃ£o de qualidade do â€œao vivoâ€.
- **EvidÃªncia**: `C:\conveniente\docs\checkups\checkup_2026-01-29_timeline_retroativa_2026-01-09_a_2026-01-29.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-retro-timeline-2026-01-09`

---

#### 2026-01-29 â€” [CONVENIENTE][P1] Status/CT: send-lock com metadados (owner/since/chatId) para diagnÃ³stico â€œbusyâ€

- **O que**: ampliado o snapshot de `perfis` no `worker.js` para incluir `sendLockOwner`, `sendLockChatId`, `sendLockSince`, `sendLockAgeMs` (alÃ©m de `sendLockActive`).
- **Por quÃª**: quando existe `busy_timeout`, agora dÃ¡ para provar *quem* segurou o send-lock e hÃ¡ quanto tempo, sem achismo e sem depender de logs ad-hoc.
- **Arquivos**: `C:\conveniente\scripts\worker.js`
- **ReinÃ­cios**: `conveniente` (para o runtime novo expor os campos no `/api/status` e no CT).
- **Rollback**: `git revert <commit>` (remove apenas campos extras do status; nÃ£o altera fluxo Robe/Virtus).
- **THREAD**: `TH-2026-01-29-sendlock-status-meta`

---

#### 2026-01-29 â€” [CONVENIENTE][P1] Varredura final: loops/waits de UI sem deadline (robe/virtus/browser)

- **O que**: verificado que `scripts/browser.js`, `scripts/robe.js`, `scripts/robeVeiculos.js` nÃ£o possuem `while(true)`/`for(;;)`; os loops crÃ­ticos de UI existentes estÃ£o bounded por budget/timeout e (quando debug habilitado) jÃ¡ emitem logs em timeout nos helpers relevantes.
- **Por quÃª**: reduzir risco de â€œtravou para sempreâ€ por UI/espera infinita (sem mexer em comportamento quando estÃ¡ saudÃ¡vel).
- **Arquivos**: `C:\conveniente\scripts\browser.js`, `C:\conveniente\scripts\robe.js`, `C:\conveniente\scripts\robeVeiculos.js`
- **ReinÃ­cios**: nenhum (apenas validaÃ§Ã£o/auditoria).
- **THREAD**: `TH-2026-01-29-ui-loop-audit`

---

#### 2026-01-29 â€” [CONVENIENTE][P2][DOCS] Baseline de logging de produÃ§Ã£o (clarificaÃ§Ãµes)

- **O que**: clarificado no runbook que `LOG_TO_FILE=1` escreve em `C:\conveniente\dados\logger.log` e que o `logger.js` assume debug ligado por default (recomendaÃ§Ã£o: `LOG_DEBUG=0`/`DEBUG=0`), com nota de rotaÃ§Ã£o manual do arquivo.
- **Por quÃª**: reduzir ruÃ­do em produÃ§Ã£o e deixar o caminho de evidÃªncia/arquivos explÃ­cito.
- **Arquivos**: `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **ReinÃ­cios**: nenhum (doc).
- **THREAD**: `TH-2026-01-29-prod-logging-baseline`

---

#### 2026-01-29 â€” [CONVENIENTE][P2] CT: `health_bundle` + `rotate_logs` (coleta rÃ¡pida + rotaÃ§Ã£o de `logger.log`)

- **O que**:
  - adicionado comando `health_bundle` (1 requestId â†’ resumo de status + manifest do allowlist; tails opt-in).
  - adicionado comando `rotate_logs` (rotaciona `logger.log` para `dados/logs/` e mantÃ©m N arquivos).
- **Por quÃª**: acelerar investigaÃ§Ã£o (menos â€œida e voltaâ€) e evitar crescimento infinito do `dados/logger.log`.
- **Arquivos**:
  - `C:\conveniente\scripts\dashboard.js`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **ReinÃ­cios**: `conveniente` (para o host aceitar os novos tipos de comando).
- **Rollback**: `git revert <commit>` (remove comandos; nÃ£o afeta Robe/Virtus).
- **THREAD**: `TH-2026-01-29-health-bundle-rotate-logs`

---

#### 2026-01-29 â€” [CONVENIENTE][OPS] RM4: humano precisou `git pull` (self_update nÃ£o foi enviado) + validaÃ§Ã£o com evidÃªncia CT

- **Relato humano**: apÃ³s restart no **ROBE MÃƒE 4**, foi necessÃ¡rio `git pull` manual no host (o `self_update` nÃ£o foi disparado pelo GPT).
- **EvidÃªncia (CT)**:
  - `C:\sitechatbot\dados\commands.log`: nÃ£o hÃ¡ `enqueue` recente de `self_update` para `825a4485-1465-4c11-aa18-52f0597b23a3` no recorte do incidente.
  - ValidaÃ§Ã£o pÃ³s-restart:
    - `health_bundle` ACK ok: `C:\sitechatbot\dados\logs\825a4485-1465-4c11-aa18-52f0597b23a3\ack_c9475bed-3a3f-4cfd-89d9-fa244e7dcb81.json`
    - resposta do bundle: `C:\sitechatbot\dados\logs\825a4485-1465-4c11-aa18-52f0597b23a3\hb_1769726532463.json`
    - `git_main_ref` confirma commit no disco: `00cb4b38cc1c16535a82574d697d17833f25e11e` (arquivo `git_1769726532463.json`).
  - Fluxo `self_update` verificado (prova de que funciona via CT):
    - comando: `self_update` cmdId `de8dd0e9-9b0d-41d2-b519-dc41bc111361` (ACK ok em `ack_de8dd0e9-...json`)
    - `updates.jsonl` contÃ©m `requestId:"verify_self_update_1769726589134"` (via `updates_1769726606544.json`).
- **AÃ§Ã£o**: runbook/livro atualizados para exigir **evidÃªncia mÃ­nima** do `self_update` (enqueue/deliver/ack + ack file) e registrar exceÃ§Ã£o quando humano precisar fazer `git pull`.
- **THREAD**: `TH-2026-01-29-rm4-manual-gitpull`

---

#### 2026-01-29 â€” [CONVENIENTE][P1] `stock_provision`: alinhar timeout HTTP local com `login_remediate` (evita abort 8s)

- **O que**: `execStockProvision` agora passa `timeoutMs` explÃ­cito (maior) nos steps longos (`activate` e principalmente `login_remediate`).
- **Por quÃª**: evidÃªncia real mostrou `login_remediate` abortando por timeout HTTP local de ~8s, apesar do worker usar `totalTimeoutMs=8min`, gerando falhas em massa do provision.
- **EvidÃªncia (CT)**:
  - RM2: `busy_timeout` (host ocupado) em `ack_20580076-ce15-4ff6-a54f-580afd80aeed.json` (step `quiesce_busy_done` com `busyCount=23`).
  - RM4: `login_remediate_fail` repetido com `timeoutMs=8000` em `ack_b69aa71e-714f-43eb-a48c-421dc4ca60df.json`.
- **Arquivos**: `C:\conveniente\scripts\dashboard.js`
- **ReinÃ­cios**: `conveniente` (para o runtime novo aplicar os timeouts).
- **Rollback**: `git revert <commit>` (retorna para timeout padrÃ£o).
- **THREAD**: `TH-2026-01-29-stock-provision-local-timeout`

---

#### 2026-01-29 â€” [CONVENIENTE][P1] `stock_provision`: modo â€œesperar busy mais tempoâ€ (budget/waitBusy defaults)

- **O que**: aumentados os defaults de:
  - `STOCK_PROVISION_BUDGET_MS` (para 20min)
  - `STOCK_PROVISION_WAIT_BUSY_MS` (para 10min)
  - `STOCK_PROVISION_WAIT_PAUSE_MS` (para 2min)
- **Por quÃª**: alinhamento com o operador (humano): Ã© mais seguro esperar ocupaÃ§Ã£o terminar do que falhar rÃ¡pido; no timeout, o histÃ³rico registra erro e o loop de guard re-tenta depois.
- **Arquivos**: `C:\conveniente\scripts\dashboard.js`
- **ReinÃ­cios**: `conveniente` (para runtime novo aplicar defaults).
- **Rollback**: `git revert <commit>` (volta para defaults anteriores).
- **THREAD**: `TH-2026-01-29-stock-provision-wait-busy-policy`

---

#### 2026-01-29 â€” [CONVENIENTE][DOCS] INBOX: banco de relatos por arquivo (1 INC por relato) + Ã­ndice

- **O que**: `INBOX_RELATOS_DO_HUMANO.md` permanece como â€œentradaâ€, e cada incidente triado ganha arquivo em `docs/inbox/` com Ã­ndice.
- **Por quÃª**: manter histÃ³rico pesquisÃ¡vel (â€œbanco de relatosâ€) sem inflar o arquivo de entrada.
- **Arquivos**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\inbox\INC-20260129-2100-01.md`
- **ReinÃ­cios**: nenhum (docs).
- **THREAD**: `TH-2026-01-29-inbox-archive-per-inc`

---

#### 2026-01-29 â€” [CONVENIENTE][P1] Abrir/Fechar (painel): â€œFechar Todosâ€ nÃ£o pode reabrir; â€œAbrir Todos 24hâ€ modo seguro + lock renovÃ¡vel

- **Sintoma (humano)**: clicar â€œFechar Todosâ€ era lento e â€œbrigavaâ€ com o sistema (reabria durante o fechamento); â€œAbrir Todosâ€ gerava concorrÃªncia/travamentos e Ã s vezes parecia abrir sozinho apÃ³s restart.
- **Causa raiz**:
  - Painel fazia `deactivate` perfil-a-perfil sem o passo atÃ´mico `desired.active=false` para todos â†’ `nurseTick` via `desired.active=true` e podia reabrir.
- **CorreÃ§Ãµes**:
  - Painel passou a chamar endpoints canÃ´nicos:
    - `POST /api/perfis/close-all` (modo seguro; corta reabertura via desired)
    - `POST /api/perfis/open-all-24h` (modo seguro)
  - `open-all-24h`: TTL do `provision_lock` virou **curto e renovÃ¡vel** (`OPEN_ALL_LOCK_TTL_MS`, default 2min) com keepalive por shard no `nurseTick`, e finalizaÃ§Ã£o automÃ¡tica ao expirar.
  - `provision_lock.meta.kind`: `stock_provision` nÃ£o pausa Virtus globalmente; pausa sÃ³ em `open_all_map`/`close_all`.
- **EvidÃªncia (CT)**:
  - RM4 `provision_audit`: eventos `close_all_api_called` + `worker_hard_close_*` confirmam endpoint canÃ´nico.
- **Arquivos**:
  - `C:\conveniente\public\index.html`
  - `C:\conveniente\scripts\api_perfis.js`
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\scripts\dashboard.js`
- **ReinÃ­cios**: `conveniente` (para runtime novo aplicar).
- **THREAD**: `TH-2026-01-29-open-close-all-governance`

---

#### 2026-02-19 — [SORTEIO][FASE-D][PASS] Validação formal consolidada (stress + legado + isolamento)

- **O que**: concluída validação formal com três provas objetivas: stress pesado de sorteio, não regressão fora do piloto e isolamento por `wa_phone_number_id`.
- **Evidência**: `C:\conveniente\docs\checkups\checkup_2026-02-19_fase_d_validacao_formal_sorteio.md`
- **Resultado**: `PASS` (sem falhas nas três frentes); nenhum reinício necessário nesta fase (somente validação/documentação).

---

#### 2026-02-20 — [SITECHATBOT][P0][PASS] Drill de incidentes + simulação pesada de fechamento (forense isolado)

- **O que**: rodada final de fechamento com validação objetiva em ambiente isolado (SQLite forense), cobrindo incidentes críticos e stress de ponta a ponta.
- **Blocos executados (P0)**:
  - webhook Asaas + idempotência de baixa local (`PAYMENT_RECEIVED`/`PAYMENT_CONFIRMED`)
  - webhook atrasado com recuperação automática por `reconcileOpenAsaasPayments` (poll)
  - reemissão com ajuste mantendo atomicidade de fatura/saldo
  - alertas de observabilidade (`asaas_paid_without_local_settlement`, `debt_without_open_invoice`, `overdue_open_windows`)
- **Evidências (arquivos/saídas)**:
  - `C:\sitechatbot\tools\validate_asaas_webhook_auto_settlement.js`
  - `C:\sitechatbot\tools\simulate_asaas_invoice_lifecycle.js`
  - `C:\sitechatbot\tools\validate_ops_health_alerts.js`
  - `C:\sitechatbot\dados\forensics\ct_poll_reconcile_1771623887927.sqlite`
  - `C:\sitechatbot\dados\forensics\ct_ops_health_1771623930026.sqlite`
  - `C:\sitechatbot\dados\forensics\pedidos_ops_health_1771623930026.sqlite`
- **Stress pesado adicional (PASS)**:
  - suíte enterprise: `C:\sitechatbot\tools\stress_phase4_enterprise.js`
    - saída: `C:\sitechatbot\dados\forensics\stress_phase4_enterprise_1771624051549.json`
    - `ok=true`, `rounds=8`, `elapsedMs=188210`
  - sorteio atômico extra:
    - saída: `C:\sitechatbot\dados\forensics\stress_lottery_report_1771624251610.json`
    - `totalLeads=1200`, `totalParticipantsPersisted=62674`, `failures=0`
  - billing atômico extra:
    - DB: `C:\sitechatbot\dados\forensics\ct_stress_billing_atomic_1771624251435.sqlite`
    - `drivers=180`, `openInvoicesAfterWebhook=0`, `paidInvoices=180`
- **Ajuste de qualidade**: script `validate_ops_health_alerts.js` atualizado para regra diária idempotente de emissão (evita falso negativo no mesmo dia útil).
- **Resultado**: `PASS` em todos os critérios da rodada; sem alteração de runtime de produção.

#### 2026-02-20 — [PROGRAMA][GO/NO-GO] Piloto 5 grupos: GO condicional aprovado

- Checkup formal final criado com decisão e plano de rollout: `C:\conveniente\docs\checkups\checkup_2026-02-20_go_no_go_piloto_4_grupos.md` (título atualizado para 5 grupos)
- Status: critérios P0 da fase fechados com evidência; pendência única para iniciar piloto é confirmar `groupId` dos 5 grupos/cidades (Ipatinga, Montes Claros, Foz do Iguaçu, Fortaleza, Petrolina).

#### 2026-02-20 — [SITECHATBOT][HOTFIX CONFIG] Fortaleza ainda legado no piloto: causa raiz e correção

- **Sintoma**: pedido de Fortaleza saiu no molde legado (com telefone/link), apesar da cidade estar no piloto.
- **Causa raiz**: o `delivery_mode` default é decidido no enqueue do `sitechatbot` por `C:\sitechatbot\dados\tokenized_pilot_cities.json`; esse arquivo ainda estava apenas com Ipatinga.
- **Correção**:
  - atualizado `C:\sitechatbot\dados\tokenized_pilot_cities.json` com as 5 cidades piloto;
  - validação em DB forense isolado confirmou `delivery_mode='tokenized'` para `Fortaleza (CE)`.
- **Impacto esperado**: somente as cidades piloto entram no novo fluxo; demais grupos/cidades permanecem no legado sem regressão.

#### 2026-02-20 — [SITECHATBOT/NOTIFICADOR][HOTFIX ROLLOUT] Migração corrigida para cobertura real por grupo piloto

- **Sintoma**: após reinício, novo pedido em `Horizonte (CE)` (mesmo `groupId` de Fortaleza) ainda saiu no molde legado.
- **Causa raiz**: rollout estava parametrizado por **5 cidades âncora**, não por **cobertura completa das cidades pertencentes aos 5 grupos piloto**.
- **Evidência objetiva**:
  - `Horizonte (CE)` e `Fortaleza (CE)` compartilham `groupId=120363418394810828@g.us` (consulta em `C:\notificador\gruposids.json`);
  - em runtime local, pedido `wa_31312` foi persistido como `delivery_mode='legacy'` para `Horizonte (CE)` antes da correção;
  - após correção, diagnóstico `diag_horiz_*` em `C:\sitechatbot\dados\pedidos.sqlite` confirmou `delivery_mode='tokenized'`.
- **Correção aplicada**:
  - expandida a lista piloto para **todas as cidades** dos 5 grupos (78 cidades) em:
    - `C:\sitechatbot\dados\tokenized_pilot_cities.json`
    - `C:\notificador\tokenized_pilot_cities.json`
  - arquivos sincronizados (`same=true`) para evitar divergência entre enqueue (`sitechatbot`) e entrega (`notificador`).
- **Impacto esperado**: qualquer pedido de cidade pertencente aos 5 grupos piloto entra no fluxo novo; demais grupos seguem legado.

#### 2026-02-20 — [SITECHATBOT/NOTIFICADOR][ARQUITETURA] Rollout tokenized por groupId (fonte única)

- **Decisão enterprise**: remover dependência operacional de lista gigante por cidade para piloto.
- **Fonte única do rollout**: `C:\notificador\tokenized_pilot_groups.json` (somente `groupId` piloto).
- **Resolução automática**:
  - `sitechatbot` resolve cidade -> `groupId` via `C:\notificador\gruposids.json` e aplica piloto por grupo;
  - `notificador` aplica modo efetivo por grupo usando o mesmo arquivo de `groupId` piloto.
- **Benefício**: ao liberar novo grupo, altera-se apenas 1 arquivo; cidades secundárias novas herdam automaticamente via `gruposids.json`.

#### 2026-02-20 — [SITECHATBOT/NOTIFICADOR][HARDENING] Remoção total de fallback por cidade no rollout tokenized

- **O que foi removido**:
  - arquivos de lista por cidade:
    - `C:\sitechatbot\dados\tokenized_pilot_cities.json`
    - `C:\notificador\tokenized_pilot_cities.json`
  - lógica de fallback por cidade em:
    - `C:\sitechatbot\lib\pedidosStore.js`
    - `C:\notificador\index.js`
- **Regra final (canônica)**: somente `groupId` piloto definido em `C:\notificador\tokenized_pilot_groups.json`.
- **Evidência objetiva**:
  - `cityFileExists=false` no `notificador`;
  - diagnóstico em `sitechatbot` para `Horizonte (CE)` resultou `delivery_mode='tokenized'` apenas por mapeamento cidade->grupo em `gruposids`.

#### 2026-02-20 — [SITECHATBOT][SIMULAÇÃO PESADA][PASS] Resolução cidade->grupo sem fallback por cidade

- **Objetivo**: validar em ambiente isolado que o rollout tokenized funciona somente por `groupId` piloto + `gruposids`, sem envio real para grupos.
- **Método**:
  - execução forense com `PEDIDOS_DB_PATH` isolado (sem tocar fila de produção);
  - varredura determinística de **todas as 856 cidades** do `gruposids`;
  - stress aleatório adicional de **12.000 iterações**;
  - checks críticos para `Fortaleza`, `Horizonte`, `Ipatinga`, `Montes Claros`, `Petrolina`, `Foz do Iguaçu`, `São Paulo`, `Santos`.
- **Resultado**:
  - `ok=true`, `mismatches=0`, `randomMismatch=0`;
  - cidades dos 5 grupos piloto => `tokenized`;
  - cidades fora dos grupos piloto => `legacy`.
- **Evidência**:
  - relatório: `C:\sitechatbot\dados\forensics\pilot_group_resolution_stress_1771635481802.json`
  - probe unicode (acento íntegro): `Foz do Iguaçu (PR)` => `tokenized`, `São Paulo (SP)` => `legacy`.

#### 2026-02-20 — [PROGRAMA][GOVERNANÇA] Abertura de INC para publicação segura no GitHub (`sitechatbot` + `notificador`)

- **Decisão**: não publicar imediatamente; primeiro formalizar dossiê de segurança/continuidade.
- **INC aberto**: `C:\conveniente\docs\inbox\need_evidence\INC-20260220-2230-01.md`
- **Escopo do INC**:
  - inventário de risco de segredos e artefatos locais;
  - plano de `.gitignore`/allowlist/denylist;
  - checklist de preflight e validação de bootstrap em clone limpo;
  - estratégia de publicação em etapas com rollback definido.

#### 2026-02-20 — [PROGRAMA][GOVERNANÇA] Pivot do INC: continuidade por backup no Drive privado (DR)

- **Decisão do owner**: priorizar backup completo no drive privado em vez de publicação imediata no GitHub para `sitechatbot`/`notificador`.
- **Evidência de acesso**: drive disponível em `G:\Meu Drive`.
- **Atualização canônica**:
  - `INC-20260220-2230-01` redefinido para dossiê de backup contínuo + restore/disaster recovery.
  - `INDEX` e `INBOX_RELATOS_DO_HUMANO` alinhados com a nova estratégia.

#### 2026-02-20 — [PROGRAMA][CHECKUP][PASS] Auditoria pré-codificação (orquestração 1 comando + backup DR no Drive)

- Checkup formal criado: `C:\conveniente\docs\checkups\checkup_2026-02-20_pre_codificacao_orquestracao_backup_drive.md`
- Escopo auditado ponta a ponta:
  - estado atual de startup (`sitechatbot`/`notificador`/`ngrok`);
  - inventário objetivo de dados críticos (SQLite + WAL/SHM + sessão WhatsApp + envs);
  - evidência de destino de backup (`G:\Meu Drive`) e lacunas de DR.
- Decisão desta rodada: documentação e evidência concluídas; implementação técnica ficará para próxima etapa, sem achismo.

#### 2026-02-20 — [PROGRAMA][CHECKUP][PASS COM ACHADOS] Auditoria "olhos de deus" pré-código (2a rodada)

- Checkup formal criado: `C:\conveniente\docs\checkups\checkup_2026-02-20_auditoria_olhos_de_deus_pre_codificacao.md`
- Achados críticos registrados antes de codar:
  - `whatsapp.sqlite` fora do snapshot local atual do `sitechatbot`;
  - `.baileys_auth` fora do snapshot local atual do `notificador`;
  - `spool` do notificador em backup parcial/opt-in;
  - necessidade de snapshot atômico para SQLite.
- Decisão: manter `INC-20260220-2230-01` em execução e só iniciar codificação com esses guardrails incorporados no desenho.

#### 2026-02-20 — [PROGRAMA][CHECKUP][PASS COM BLOQUEIOS] Auditoria "olhos de deus" (3a rodada) pré-código

- Checkup formal criado: `C:\conveniente\docs\checkups\checkup_2026-02-20_auditoria_olhos_de_deus_rodada3_pre_codificacao.md`
- Confirmações operacionais:
  - API ativa em `:3000`;
  - ngrok ativo em `:4040` com túnel público no subdomínio canônico;
  - contrato `sitechatbot`/`notificador` validado (`/api/notifier/next` e `/api/notifier/ack`).
- Bloqueios de continuidade mantidos:
  - incluir `whatsapp.sqlite` e `.baileys_auth` no DR;
  - retenção por camadas para preservar espaço no `G:`;
  - orquestração única com rastreabilidade de subprocessos.

#### 2026-02-20 — [LEADS][CONTESTACAO][CHECKUP V2] Dossie ponta-a-ponta pre-codigo (funcao-a-funcao)

- **Contexto**: rodada de alinhamento antes de qualquer runtime, para congelar regras de contestacao com foco em operacao real (cliente e motorista).
- **Documento canonico criado**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-20_contestacao_v2_dossie_ponta_a_ponta_pre_codigo.md`
- **Decisoes V2 congeladas**:
  - janela de contestacao: ate 23h;
  - motivos: 4 (nao respondeu, ja contratou outro, desistiu apos contato, divergencia de info);
  - validacao com cliente via Virtus para motivos ambiguos;
  - reenvio automatico maximo: 1 ciclo, depois manual;
  - telefone do cliente como referencia humana no CT (lead_token tecnico interno).
- **Governanca**:
  - INC principal atualizado com apontamento V2:
    - `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2310-01.md`
  - status: desenho pre-codigo locked_v2, aguardando implementacao por fases + simulacoes pesadas.

#### 2026-02-20 — [LEADS][CONTESTACAO][CHECKUP V2.1] Refinamento M1 "cliente nao respondeu" (cadencia 23h)

- **Motivacao**: ajustar o fluxo ao comportamento real observado (resposta distribuida em 15min / 2h / ate 23h), evitando estorno precoce.
- **Refinamento congelado**:
  - M1 nao encerra antes de 23h;
  - checkpoints operacionais:
    - T+15min motorista,
    - T+3h cliente,
    - ate 1 lembrete cliente entre T+3h e T+23h;
  - fechamento 23h com confirmacao final de motorista (cliente opcional recomendado);
  - decisao financeira M1:
    - cliente disse "nao quero" -> estorno;
    - sem resposta ate 23h sem avancos -> estorno;
    - cliente disse "sim quero" -> atendimento segue, sem estorno automatico final.
- **Documento canonico atualizado**:
  - `C:\conveniente\docs\checkups\checkup_2026-02-20_contestacao_v2_dossie_ponta_a_ponta_pre_codigo.md`
- **INC sincronizado**:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260222-2310-01.md`

#### 2026-02-20 — [LEADS][CONTESTACAO][PLANO TECNICO FORMAL V1] Ordem executavel P0->P1->P2

- **Objetivo**: transformar o dossie funcional em plano tecnico com checklist executavel e gates de aceite.
- **Documento canonico criado**:
  - `C:\conveniente\docs\checkups\plano_tecnico_formal_v1_contestacao_p0_p1_p2.md`
- **Conteudo principal**:
  - P0: contencao e fundacao (contrato, estados, schema, neutralizacao de risco);
  - P1: integridade financeira/operacional (idempotencia envio+ack, ownership lock, normalizacao telefone, reconciliacao winner vs ledger);
  - P2: escala (cadencia T+15/T+3h/T+23h, reenvio maximo 1, observabilidade).
- **Governanca**:
  - artefato rascunho removido para evitar falsa percepcao de pronto:
    - `C:\sitechatbot\convenientetecnologia\lib\ctLeadContestationStore.js`
  - INC atualizado com referencia do plano formal.

#### 2026-03-02 — [OPERACAO][GOVERNANCA] Contrato operacional formalizado + regra persistente do Cursor

- **Objetivo**: operar produção real com evidência, sem “achismo”, e com divisão clara: humano reinicia, GPT coleta/organiza/implementa.
- **Mudança**:
  - regra persistente criada: `C:\conveniente\.cursor\rules\operacao-enterprise.mdc`
  - correção de legibilidade (acentos/aspas) no intake canônico: `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (seções iniciais)
- **Restart**: nenhum.

#### 2026-03-02 — [FORENSE][LEADS] Dossie "olhos de Deus" (sorteio x contestacao x boleto)

- **Objetivo**: auditoria ponta a ponta sem codar, para provar o estado real do runtime antes de qualquer alteração.
- **Documento canônico criado**:
  - `C:\conveniente\docs\checkups\checkup_2026-03-02_dossie_forense_sorteio_contestacao_boleto.md`
- **Achado central**:
  - sorteio atual prioriza `wins_count` histórico (`lead_lottery_winners`) + `first_joined_at`;
  - contestação/boletos hoje afetam elegibilidade e financeiro, mas não entram como chave primária do ranking.
- **Governança**:
  - INC atualizado com alinhamento e referência forense:
    - `C:\conveniente\docs\inbox\need_evidence\INC-20260302-1500-01.md`

Adendo (rodada aprofundada):
- dossiê expandido com:
  - trilha ponta a ponta (sorteio -> award -> contestacao -> reabertura -> emissao -> pagamento),
  - invariantes anti-quebra,
  - matriz de regressão obrigatória (R1..R6),
  - gate Go/No-Go pré-código.

#### 2026-03-02 — [FORENSE][LEADS] Plano técnico faseado pré-código (feature flag + rollback)

- **Documento canônico criado**:
  - `C:\conveniente\docs\checkups\checkup_2026-03-02_plano_tecnico_faseado_sorteio_carga_competencia.md`
- **Conteúdo**:
  - arquitetura de mudança mínima e reversível;
  - `rank_mode=legacy|load` com política explícita sem fallback automático em `load` (fail-closed auditável);
  - competência temporal de baixa por boleto;
  - matriz de regressão ampliada (R1..R7);
  - rollout/rollback operacional.
- **Status**:
  - codificação ainda não iniciada; aguardando aprovação explícita do owner.

Adendo (blindagem de contingência):
- anexo canônico criado para erro de cálculo em `rank_mode=load`:
  - `C:\conveniente\docs\checkups\checkup_2026-03-02_anexo_canonico_contingencia_sorteio_load.md`
- decisão final desta rodada:
  - sem fallback silencioso;
  - sem travamento global;
  - fail-closed por janela + reprocesso explícito com trilha auditável.

#### 2026-03-02 — [IMPLEMENTACAO][LEADS] Ranking por carga (legacy|load) + fail-closed por janela + bateria R1..R7

- **Código**:
  - `C:\sitechatbot\lib\pedidosStore.js`:
    - flag `LEAD_LOTTERY_RANK_MODE=legacy|load`;
    - seleção por carga no modo `load`;
    - erro de carga em `load` marca janela `error_load` (fail-closed por janela, sem travamento global);
    - utilitários de operação para listar/reprocessar janelas em erro.
  - `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`:
    - função canônica `getDriverLotteryLoadByPhone(...)` para ranking por carga.
  - `C:\sitechatbot\tools\validate_lottery_load_r1_r7.js`:
    - suíte isolada cobrindo R1..R7.
- **Validação**:
  - R1..R7 isolado verde:
    - `C:\sitechatbot\dados\forensics\lottery_load_r1_r7_report_1772478624630.json`
  - stress atômico em `rank_mode=load` verde:
    - `C:\sitechatbot\dados\forensics\stress_lottery_report_1772478624814.json`
- **Restart**: nenhum nesta fase (ainda não houve deploy em runtime de produção).

Adendo (ajuste operacional aprovado pelo owner):
- prioridade para não perder sorteio:
  - retries automáticos em `load`;
  - se retries esgotarem, override explícito/auditado para `legacy` (sem fallback silencioso);
  - `fail_closed` fica opcional via flag para operação extraordinária.

#### 2026-03-05 — [CONVENIENTE][CHROMIUM] Hardening de launch CDP após flapping abre/fecha

- **Sintoma em runtime (evidência)**:
  - Chromium resolvido via `puppeteer-managed`, porém várias tentativas falhando com:
    - `Target.setDiscoverTargets: Target closed`
    - `Target.setAutoAttach: Target closed`
  - erro secundário intermitente:
    - `Requesting main frame too early!` em `patchPage`.
- **Correção aplicada** (`C:\conveniente\scripts\browser.js`):
  - `tryLaunch(args, tag)` passa a usar os args da tentativa (corrigido);
  - retries 2/3 com perfil de flags mais conservador para Chromium gerenciado;
  - `pipe: true` no `puppeteer.launch` para reduzir flake de conexão CDP;
  - guardas em `evaluateOnNewDocument` para não abortar ativação por frame transitório.
- **Operação**:
  - sem `self_update` nesta rodada (owner fará `git pull` no host);
  - requer restart manual do `conveniente` para carregar o patch.

#### 2026-03-07 — [CONVENIENTE][RM1] Restore code baseline Chrome + patch anti-rajada mínimo

- **Escopo aprovado (sem achismo / sem tocar dados)**:
  - restore **code-only** a partir de `C:\sitechatbot\backups\conveniente_full_20260305_140355`;
  - sem overwrite de `C:\conveniente\dados\`.
- **Backup de segurança do estado Chromium antes do restore**:
  - `C:\sitechatbot\backups\conveniente_code_chromium_pre_restore_20260307_112310\_code_snapshot_manifest.json`;
  - `robocopy_exit_code=1` (cópia bem-sucedida).
- **Arquivos restaurados para baseline**:
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\scripts\browser.js`
  - `C:\conveniente\scripts\api_status.js`
  - `C:\conveniente\scripts\bootstrapService.js`
  - `C:\conveniente\instalar_conveniente.ps1`
- **Patch anti-rajada aplicado em `worker.js` (mínimo)**:
  - cadência única de LR scan: `~10min + jitter` (`LR_SCAN_BASE_MS`/`LR_SCAN_JITTER_MS`);
  - `AUTO_LOGIN_REMEDIATE_MIN_INTERVAL_MS` default de `20min` -> `10min`;
  - backoff progressivo para `nurse/open` em `ram_denied` (`2min` -> teto `45min`);
  - `REOPEN_DELAY_SHORT_MS` default de `5s` -> `60s`.
- **Dossiê pré-código canônico**:
  - `C:\conveniente\docs\checkups\checkup_2026-03-07_dossie_pre_codigo_restore_chrome_antirajada_rm1.md`

#### 2026-03-07 — [CONVENIENTE][RM7] Auditoria de rajadas pós-restart + correção de cadência LR

- **Coleta forense via CT (RM7)**:
  - `logs_manifest` cmdId `15b72497-bfd4-4912-aa82-9db4421859d6`
  - `fetch_logs` cmdId `5fca2ab4-2a7d-4ba3-b227-009a1cc6927b`
  - `fetch_logs_query` cmdId `94da4e23-68b1-4a08-a935-d33ce544cd53`
- **Achado**:
  - persistência de rajada de marcação (`auto_login_remediate_queued` em faixa ~5s por perfil) e `lr_scan_tabs` acima do esperado.
- **Causa raiz**:
  - bloco `finally` de cadência LR fora do ponto correto no `worker.js`, impedindo consolidar `nextAt` de forma consistente no ciclo de scan.
- **Correção**:
  - reposicionado `finally` para o bloco correto da varredura LR; removido bloco indevido em fluxo de delete banido.
- **Dossiê canônico**:
  - `C:\conveniente\docs\checkups\checkup_2026-03-07_auditoria_rajadas_pos_restart_rm7.md`

#### 2026-03-07 — [CONVENIENTE][RM7] Forense de "chat feed recarregando" (Florianopolis) + humanização Virtus

- **Perfil foco**:
  - `florianopolis-1764625643701` (operação observou "recarregando chats" visual).
- **Evidência CT**:
  - `fetch_logs_query` cmdId `3f8dcb74-a366-46ea-8aef-074ce6b094f4` (requestId `rm7_floripa_forense_20260307_123545`).
- **Achado técnico**:
  - sem burst de `page.reload` puro no recorte curto;
  - padrão visual veio de scroll/keepalive agressivo no loop do Virtus (efeito de "refresh perceptível").
- **Correção aplicada** (`scripts/virtus.js`):
  - polling mais humano (`30s -> 60s`, slow `45s -> 90s`);
  - scroll de topo desacelerado (`30s -> 5min`, slow `60s -> 8min`);
  - remoção de reforço `scroll +800ms`;
  - throttle de keepalive (`KEEPALIVE_MIN_GAP_MS=5min`);
  - gate de scroll por fila/ociosidade (`SCROLL_TOP_IDLE_MIN_GAP_MS=10min`).
- **Dossiê canônico**:
  - `C:\conveniente\docs\checkups\checkup_2026-03-07_forense_floripa_reload_chatfeed.md`

#### 2026-03-07 — [CONVENIENTE][RM7] Forense fase 2 pós-restart: guardrail anti-loop no Nurse

- **Coleta CT fase 2**:
  - `fetch_logs` cmdId `0c12f7c4-dd42-4a75-8edc-392c767975b3`
  - `fetch_logs_query` cmdId `cdeb8c5b-d1ec-4be6-90ef-c202cf8b13d9`
- **Achado técnico**:
  - sem burst de reload no recorte pós-restart curto;
  - identificado risco estrutural de retry curto de `nurse_open_attempt` em perfis sem controller (histórico).
- **Mitigação aplicada** (`scripts/worker.js`):
  - `NURSE_INTERVAL_MS` configurável (default `10s`);
  - `NURSE_OPEN_MIN_RETRY_MS` default `60s` por perfil;
  - `activationHeldUntil` mínimo em `nurse_open_denied` para evitar martelar reabertura.
- **Dossiê canônico**:
  - `C:\conveniente\docs\checkups\checkup_2026-03-07_forense_floripa_reload_chatfeed.md`

#### 2026-03-07 — [CONVENIENTE][RM7] Forense fase 3: humanização de micro-ações Virtus

- **Achado de risco**:
  - `virtus` ainda tinha assinatura robótica em micro-ações (`typing delay 0`, click sintético por `dispatchEvent`, polling curto de URL).
- **Mitigação aplicada** (`scripts/virtus.js`):
  - typing por caractere com delay humano configurável;
  - pausa humana antes de Enter;
  - troca de click sintético por click nativo com delay;
  - pós-click com janela humana;
  - polling de confirmação de chat desacelerado.
- **Objetivo**:
  - reduzir sensibilidade anti-automação do Facebook sem quebrar fluxo de atendimento.
- **Dossiê canônico**:
  - `C:\conveniente\docs\checkups\checkup_2026-03-07_forense_floripa_reload_chatfeed.md`

#### 2026-03-07 — [CONVENIENTE][RM7] Forense fase 4: humanização global de pausas no Robe

- **Achado de risco**:
  - `robe`/`robeVeiculos` com múltiplos `sleep` curtos e cadência sistemática no fluxo de publicação.
- **Mitigação aplicada**:
  - guardrail central nos dois scripts para elevar pauses curtas à faixa humana com jitter:
    - `ROBE_HUMAN_PAUSE_MIN_MS=220`
    - `ROBE_HUMAN_PAUSE_JITTER_MS=180`
- **Objetivo**:
  - diminuir assinatura robótica de microtempos no fluxo Robe mantendo comportamento funcional.
- **Dossiê canônico**:
  - `C:\conveniente\docs\checkups\checkup_2026-03-07_forense_floripa_reload_chatfeed.md`

#### 2026-03-07 — [CONVENIENTE][RM7] Forense fase 5: humanização de base no Browser Helper

- **Achado de risco**:
  - delays curtos e fixos em `browser.js` (click/type/mouse click) ainda podiam gerar assinatura sistemática.
- **Mitigação aplicada**:
  - guardrail global de pausa humana + jitter de click/type no helper base.
- **Objetivo**:
  - diminuir previsibilidade temporal nos fluxos de login/recuperação sem regressão funcional.
- **Dossiê canônico**:
  - `C:\conveniente\docs\checkups\checkup_2026-03-07_forense_floripa_reload_chatfeed.md`
