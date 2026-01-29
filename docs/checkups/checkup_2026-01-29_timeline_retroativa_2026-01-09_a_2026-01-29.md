### Timeline retroativa (como se fosse “em tempo real”) — 2026-01-09 → 2026-01-29

Objetivo: reconstruir do dia **09/01 até hoje** as mudanças/incident-response como se tivéssemos registrado em tempo real, com **organização enterprise** e **evidência rastreável**.

Escopo: **somente documentação** (não altera runtime).

---

## Guardrail crítico (para não “empurrar imperfeição” pra frente)

Esta timeline é **retroativa**. Ela será “o mais completa possível com evidências”, mas **não vai ter o mesmo nível de detalhe** que teremos daqui pra frente.

Regra a partir de hoje:
- O retroativo é **histórico** (base para RCA), não “padrão de qualidade aceitável”.
- O padrão “de verdade” daqui pra frente é:
  - `TIMELINE.md` (entrada curta com evidência + reinícios + rollback)
  - e, quando for complexo, um checkup novo em `docs/checkups/` com logs/links/IDs.

---

## Regras desta timeline retroativa

- Toda entrada tem: **tags**, **THREAD**, **O que**, **Por quê**, **Evidência**, **Reinícios**, **Rollback**.
- Quando for cross-system, usar **`[CROSS]` + tags específicas** (`[CONV]`, `[CT]`, `[NOTIF]`).
- “Evidência” sempre aponta para **um artefato real**:
  - commit/hash do Git (no `conveniente`)
  - arquivo `*.patch`, `_manifest.json`, `restore_plan`, `restore_summary`
  - arquivo do Cursor (`agent-tools`, `agent-transcripts`, `terminals`)

---

## Legenda rápida de evidências (fontes usadas)

- **Git (`conveniente`)**: commits com timestamp/hashes (fonte de verdade do que entrou no repo)
  - Base: `git log --since="2026-01-09" --date=iso --pretty=format:"%ad|%h|%s"`

- **Cursor/Terminals (CT rodando na prática)**:
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-Users-NOTIFICADOR-AppData-Roaming-Cursor-Workspaces-1767798316519-workspace-json\terminals\28.txt`
  - `...\terminals\29.txt`
  - `...\terminals\30.txt`
  - `...\terminals\31.txt`
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\terminals\*.txt`

- **Backups/recovery (`sitechatbot`)**:
  - Auto-backup CT: `C:\sitechatbot\_backup_auto_root\_snapshots.log`
  - Recovery/restore: `C:\sitechatbot\_recovery\restore_plan_*.json`, `restore_summary_*.txt`
  - “Histórico por arquivo”: `C:\sitechatbot\_recovery\*.HISTORY_*`
  - Backups recebidos do conveniente via CT: `C:\sitechatbot\_incoming_backups\...\backup_*\_manifest.json`
  - Patches/diffs: `C:\sitechatbot\_incoming_backups\_diff_*.patch`

- **Backups (`notificador`)**:
  - Auto-backup: `C:\notificador\_backup_auto\_snapshots.log`

- **Cursor/agent-tools (ouro de operações reais)**:
  - `list_backups` do conveniente: `...\agent-tools\e5548d03-4350-439a-a0f5-1531adc4ddfe.txt`
  - bulk gitpull/self_update: `...\agent-tools\6824a330-2923-4c90-bc02-c2f92d32cd68.txt`

- **Auditoria de cobertura (tabelas)**:
  - `C:\conveniente\docs\checkups\audit_2026-01-29_cobertura_evidencias_2026-01-09_a_2026-01-29.md`

---

## THREADS principais (para correlacionar decisões)

- `TH-2026-01-09-ct-runtime-ops`: runtime CT/WhatsApp (SQLITE_BUSY, taskkill, start)
- `TH-2026-01-15-ct-puppeteer-start`: CT start via puppeteer script
- `TH-2026-01-16-bootstrap-service`: bootstrap/service + logs sob demanda/self_update
- `TH-2026-01-17-closeall-ack`: close_all/open_all ACK e UI/ops
- `TH-2026-01-19-stock-ui-e-deploy`: UI/estoque + política de deploy/self_update
- `TH-2026-01-22-provision-lock-backups`: provision_lock + auto-backup + provision_unlock
- `TH-2026-01-23-login-remediate-enterprise`: login_remediate (timeouts/evidência/robustez)
- `TH-2026-01-25-ban-2fa-enterprise`: pipeline ban/2FA + evidências + auto-delete + CT archive
- `TH-2026-01-27-uafp-telemetry`: UA+FP telemetry (conveniente → CT)
- `TH-2026-01-27-rollback-rm4`: snapshots RM4 + rollback/auditoria
- `TH-2026-01-28-perfis-recovery-openall-governance`: perfis.json recovery + open-all governance
- `TH-2026-01-29-docs-bootstrap`: docs/runbook/timeline/checkups
- `TH-2026-01-29-backfill-*`: reconstruções retroativas (nível 1/2/3)

---

## 2026-01-09 — [CT][NOTIF][CROSS] Runtime CT e erros operacionais observados (THREAD=TH-2026-01-09-ct-runtime-ops)

- **O que**:
  - restart manual do CT via `taskkill` + `node index.js`.
  - erros `SQLITE_BUSY` (“database is locked”) no WhatsApp inbox/outbox.
  - erros de envio WhatsApp API (falha de envio + retries/backoff no outbox).
  - erro de migração: `no such column: driver_id`.
  - alto volume de “fechamentos por timeout parcial (10min)” no dia (conversas).
- **Por quê**: incident-response/operacional (restaurar serviço; lidar com travas de DB e falhas externas).
- **Evidência (Cursor terminals)**:
  - `...\terminals\30.txt`: `2026-01-09T20:03:02Z` + `migração callbacks falhou: no such column: driver_id`
  - `...\terminals\31.txt` (janela 09→13):
    - `2026-01-09`: `SQLITE_BUSY`/`database is locked` (2 ocorrências) + falha OpenAI `/v1/responses` (timeout 10s)
    - `2026-01-09`: `fechada por timeout parcial (10min)` (10 ocorrências)
    - `2026-01-09`: `Erro ao enviar mensagem WhatsApp` (7) + `Outbox ... falhou` (7)
  - `...\terminals\26.txt`: `2026-01-09` `Erro ao enviar mensagem WhatsApp` (5) + `Outbox ... falhou` (5)
  - `...\terminals\29.txt`: `2026-01-09T20:01:26Z` `Reenfileirados 2 outbox presos em sending`
- **Reinícios**: CT (processo Node) foi reiniciado via taskkill.
- **Rollback**: n/a (evento operacional).

---

## 2026-01-10 — [CT] Continuação do runtime (timeouts/fechamentos) (THREAD=TH-2026-01-09-ct-runtime-ops)

- **O que**: alto volume de “fechamentos por timeout parcial (10min)” registrados em log.
- **Por quê**: política de encerramento automático de conversas por inatividade/timeout.
- **Evidência (Cursor terminals)**:
  - `...\terminals\31.txt`: `2026-01-10` `fechada por timeout parcial (10min)` (135 ocorrências)
- **Reinícios**: nenhum evidenciado.
- **Rollback**: n/a (evento operacional).

---

## 2026-01-11 — [CT] Continuação do runtime (timeouts) (THREAD=TH-2026-01-09-ct-runtime-ops)

- **O que**: continuidade do tráfego (timeouts de conversa).
- **Por quê**: operação normal do CT/Notificador com política de timeout parcial.
- **Evidência (Cursor terminals)**:
  - `...\terminals\31.txt`: `2026-01-11` `fechada por timeout parcial (10min)` (86 ocorrências)
- **Reinícios**: desconhecido (não evidenciado nesses logs).
- **Rollback**: n/a (evento operacional).

---

## 2026-01-12 — [CT] Continuação do runtime (timeouts + falha OpenAI pontual) (THREAD=TH-2026-01-09-ct-runtime-ops)

- **O que**:
  - timeouts de conversa em volume alto.
  - falha pontual no `/v1/responses` (timeout 10s) com fallback.
  - falhas de envio WhatsApp (com retries) registradas no dia.
- **Por quê**: operação normal + instabilidades externas (OpenAI/WhatsApp) mitigadas por fallback/retry.
- **Evidência (Cursor terminals)**:
  - `...\terminals\31.txt`:
    - `2026-01-12` `fechada por timeout parcial (10min)` (116 ocorrências)
    - `2026-01-12` falha OpenAI `/v1/responses` (1 ocorrência)
    - `2026-01-12` `Erro ao enviar mensagem WhatsApp` (4) + `Outbox ... falhou` (4)
- **Reinícios**: desconhecido (não evidenciado nesses logs).
- **Rollback**: n/a (evento operacional).

---

## 2026-01-13 — [CT] Continuação do runtime (THREAD=TH-2026-01-09-ct-runtime-ops)

- **O que**: timeouts de conversa continuam (volume menor).
- **Por quê**: operação normal com encerramento automático por timeout.
- **Evidência (Cursor terminals)**:
  - `...\terminals\31.txt`: `2026-01-13` `fechada por timeout parcial (10min)` (26 ocorrências)
- **Reinícios**: desconhecido (não evidenciado nesses logs).
- **Rollback**: n/a (evento operacional).

---

## 2026-01-14 — [CT] Continuação do runtime (THREAD=TH-2026-01-09-ct-runtime-ops)

- **O que**:
  - continuidade do tráfego (timeouts).
  - falhas de envio WhatsApp (com retries) registradas no dia.
- **Por quê**: operação normal + instabilidade externa (WhatsApp API) mitigada por retry.
- **Evidência (Cursor terminals)**:
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\terminals\6.txt`:
    - `2026-01-14` `fechada por timeout parcial (10min)` (15 ocorrências)
    - `2026-01-14` `Erro ao enviar mensagem WhatsApp` (4) + `Outbox ... falhou` (4)
- **Reinícios**: desconhecido (não evidenciado nesses logs).
- **Rollback**: n/a (evento operacional).

---

## 2026-01-15 — [CT][CROSS] Start do CT via Puppeteer script (THREAD=TH-2026-01-15-ct-puppeteer-start)

- **O que**: CT iniciado com executor=puppeteer headless=false.
- **Por quê**: operação do CT em modo controlado com browser executor visível.
- **Evidência (Cursor terminals)**:
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\terminals\6.txt` (pré-start):
    - `2026-01-15` `fechada por timeout parcial (10min)` (25 ocorrências)
    - `2026-01-15` `Erro ao enviar mensagem WhatsApp` (3) + `Outbox ... falhou` (3)
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\terminals\13.txt` (e similares 10/11/12) com:
    - `[2026-01-15T16:03:07.200Z]` + “Schema SQLite aplicado” + “Notificador pronto em http://0.0.0.0:3000”.
- **Reinícios**: CT iniciado/reiniciado via script.
- **Rollback**: n/a (evento operacional).

---

## 2026-01-16 — [CONV] Bootstrap/service + logs sob demanda + self_update (THREAD=TH-2026-01-16-bootstrap-service)

- **O que**: conjunto de commits preparando bootstrap/service e logging/commands.
- **Por quê**: padronizar instalação/execução e observabilidade/commands (enterprise).
- **Evidência (CONV/Git)**:
  - `2026-01-16 11:46:30 -0300 | afc9b59 | telemetria: enviar host.totalMemGB no /report`
  - `2026-01-16 13:50:37 -0300 | 7db161b | logs sob demanda + self_update + migrate_profiles + bootstrap service`
  - commits de bootstrap/NSSM idempotente e melhorias (ex.: `6f16bba`, `4ed0b2f`, `5fa6984`, `385c963`, `437a9a2`, `117ba6e`, `e32b86a`)
- **Reinícios**: aplicável após update.
- **Rollback**: via snapshot/backup.

---

## 2026-01-17 — [CONV] close_all/open_all ACK e UI/ops (THREAD=TH-2026-01-17-closeall-ack)

- **O que**: commits de estabilização de close_all/open_all e refletir no painel.
- **Por quê**: impedir ACK “mentiroso”/silencioso e reduzir travamentos operacionais.
- **Evidência (CONV/Git)**:
  - `2026-01-17 15:23:48 -0300 | 3f9edf7 | ops: close_all canônico (close-all) + dashboard close_all robusto`
  - `2026-01-17 15:34:10 -0300 | ce317e8 | ui: refletir close_all remoto no painel (ops em /api/status)`
  - `2026-01-17 15:50:17 -0300 | 522b431 | ops: não engolir erro em close_all/open_all (ACK confiável)`
  - `2026-01-17 17:33:04 -0300 | f7f77ee | ui: estado final único por conta (sem duplicidade login/limite/captcha)`
- **Reinícios**: aplicável após update.
- **Rollback**: via snapshot/backup.

---

## 2026-01-18 — [CONV][CT][NOTIF] Lacuna de evidência retroativa (THREAD=TH-2026-01-09-ct-runtime-ops)

- **O que**: não foi encontrado um “marco único” (commit/manifest/restore/terminal) claramente atribuível ao dia 18/01.
- **Por quê**: limitação natural do retroativo (eventos podem ter ocorrido sem registro preservado).
- **Evidência**: ausência de artefato explícito do dia 18/01 entre os conjuntos já minerados (Git + Cursor + recovery/backups listados nos anexos).
- **Reinícios**: desconhecido (sem evidência).
- **Rollback**: n/a.

---

## 2026-01-19 — [CONV][CT][CROSS] Estoque/UI e base de deploy (THREAD=TH-2026-01-19-stock-ui-e-deploy)

- **O que**:
  - Entraram melhorias no “Nova Conta/Estoque” e ajustes de deploy (self_update).
  - CORS local foi endurecido para cenário Electron.
- **Por quê**: estabilidade do painel/estoque e previsibilidade de updates (sem travar acesso local).
- **Evidência (CONV/Git)**:
  - `2026-01-19 19:45:11 -0300 | dd09e0b | Stock: nova conta via estoque + comandos stock_export_profiles/push`
  - `2026-01-19 19:47:11 -0300 | 0730428 | self_update: opcao restart para aplicar codigo novo`
  - `2026-01-19 21:06:03 -0300 | efbfa6d | stock: robustecer nova conta (estoque CT) + debug`
  - `2026-01-19 21:09:23 -0300 | 49fe747 | ui: no-cache no painel para updates imediatos`
  - `2026-01-19 21:19:13 -0300 | cda3f1b | deploy: bloquear restart automatico no self_update (seguranca)`
  - `2026-01-19 21:31:48 -0300 | 26526dc | stock: permitir configurar CT/secret via arquivo (set_ct_config)`
  - `2026-01-19 21:50:41 -0300 | 26ca165 | fix: permitir Origin null (Electron) no CORS do painel`
  - `2026-01-19 21:56:07 -0300 | 36d9651 | fix: CORS local aceitar ::ffff:127.0.0.1 (Electron fetch)`
  - `2026-01-19 21:59:18 -0300 | e394917 | fix: painel sem Electron (fallback listPerfis/getStatus)`
  - `2026-01-19 22:07:12 -0300 | 51085d5 | ui: diagnostico enterprise no modal Nova Conta (estoque)`
  - `2026-01-19 22:10:35 -0300 | 638b763 | fix: escapeHtml no modal Nova Conta + logar excecao real`
  - `2026-01-19 22:24:58 -0300 | 452f0a3 | ui: remover toast de sucesso no Nova Conta`
- **Evidência (CT/Recovery)**:
  - `C:\sitechatbot\_recovery\estoque.HISTORY_2026-01-19_211134.html`
  - `C:\sitechatbot\_recovery\index.HISTORY_2026-01-19_211204.js`
- **Reinícios**: (na época) aplicável conforme estratégia de self_update/restart.
- **Rollback**: usar snapshots/backup (ver threads RM4 mais adiante) + scripts do CT em `C:\sitechatbot\ops\`.

---

## 2026-01-20 — [CT][CROSS] Recovery/restore do CT (THREAD=TH-2026-01-20-ct-recovery)

- **O que**: houve um fluxo de restore/recovery no CT com substituição de arquivos críticos.
- **Por quê**: restaurar estado consistente (e.g., após mudanças rápidas/incident).
- **Evidência**:
  - Plans:
    - `C:\sitechatbot\_recovery\restore_plan_20260120_214606.json`
    - `C:\sitechatbot\_recovery\restore_plan_20260120_214721.json`
    - `C:\sitechatbot\_recovery\restore_plan_20260120_220220.json`
  - Summaries (TOP_CHANGES):
    - `restore_summary_20260120_214606.txt` (replace=3): `index.js`, `convenientetecnologia\lib\ctDb.js`, `convenientetecnologia\lib\ctFbStock.js`
    - `restore_summary_20260120_220220.txt` (replace=2): `convenientetecnologia\public\estoque.html`, `convenientetecnologia\tools\ct_fix_duplicate_phones.js`
  - “histórico por arquivo”: `C:\sitechatbot\_recovery\index.HISTORY_2026-01-20_103603.js`
- **Reinícios**: normalmente envolve restart do CT após restore (confirmar no terminal/history).
- **Rollback**: re-aplicar restore inverso via planos/histórico.

---

## 2026-01-21 — [CONV] Comandos remotos + PIN + melhorias de fluxo (THREAD=TH-2026-01-21-ops-commands-pin)

- **O que**:
  - comando remoto `delete_perfis`.
  - ct_config/LOG_INGEST_SECRET via arquivo quando missing.
  - automações e correções em PIN.
- **Por quê**: reduzir intervenção manual e estabilizar onboarding/controle.
- **Evidência (CONV/Git)**:
  - `2026-01-21 10:22:48 -0300 | 14f9d1b | feat: auto-request ct_config when missing + use ct_config.json for LOG_INGEST_SECRET`
  - `2026-01-21 10:36:10 -0300 | 643f30c | feat: add delete_perfis remote command`
  - `2026-01-21 15:17:30 -0300 | 781e2c8 | fix(messenger): dismiss PIN restore modal + continue-without-restore`
  - `2026-01-21 15:37:19 -0300 | bf4cafc | fix(messenger): auto-dismiss PIN modal in work-mode + telemetry`
  - `2026-01-21 15:53:07 -0300 | 3af95ba | fix(messenger): scan all tabs for PIN modal + audit logs`
  - `2026-01-21 15:57:31 -0300 | 0588e91 | feat(messenger): nurse GPT fallback + richer pin telemetry`
  - `2026-01-21 16:41:42 -0300 | b894426 | feat: automação de PIN do Messenger...`
  - `2026-01-21 16:43:11 -0300 | 40aa6b8 | Revert ...`
  - `2026-01-21 16:50:17 -0300 | 08a286a | feat: automação completa de PIN ...`
  - `2026-01-21 20:37:29 -0300 | 75c8aa0 | feat(ui): nova conta manual - seletor de categoria`
  - `2026-01-21 20:46:44 -0300 | b41fb62 | feat(stock): nova conta pausa Robe 24h (new_account) + check marketplace`
- **Reinícios**: aplicável por update (self_update/gitpull).
- **Rollback**: via snapshot/backup.

---

## 2026-01-21 — [CT][NOTIF][OPS][CROSS] Início dos auto-backups (THREAD=TH-2026-01-21-autobackup-start)

- **O que**: início da trilha contínua de auto-backups (CT e Notificador).
- **Por quê**: criar base real para rollback e auditoria “sempre-on”.
- **Evidência**:
  - CT: `C:\sitechatbot\_backup_auto_root\_snapshots.log` (minTag `20260121_110746`, contagem do dia = 44)
  - Notificador: `C:\notificador\_backup_auto\_snapshots.log` (minTag `20260121_110755`, contagem do dia = 26)
  - Auditoria de cobertura: `C:\conveniente\docs\checkups\audit_2026-01-29_cobertura_evidencias_2026-01-09_a_2026-01-29.md`
- **Reinícios**: n/a.
- **Rollback**: restaurar por tag conforme snapshots.

---

## 2026-01-22 — [CONV][CROSS] ProvisionLock + auto-backup + provision_unlock (THREAD=TH-2026-01-22-provision-lock-backups)

- **O que**:
  - provision_lock reforçado (owner/operator).
  - auto-backup do conveniente com retenção.
  - comando `provision_unlock` + exposição do lock via logs.
  - close_all adquiriu lock para evitar reabertura e retornar ok/fail corretamente.
- **Por quê**: reduzir deadlocks/“travados” e permitir recuperação segura.
- **Evidência (CONV/Git)**:
  - `2026-01-22 21:56:38 -0300 | 6ab1622 | Hardening stock_provision: backpressure, provision lock, retries`
  - `2026-01-22 22:19:20 -0300 | cd474ba | Fix logs secret precedence: ct_config overrides env`
  - `2026-01-22 22:27:26 -0300 | 46186dd | Fix provision lock: allow owner operator + use stock_provision:<batchId>`
  - `2026-01-22 22:41:10 -0300 | b6bc7a7 | Add convenient auto-backup snapshots with retention`
  - `2026-01-22 23:15:11 -0300 | 4ab834c | feat: add provision_unlock command and expose provision_lock in fetch_logs`
  - `2026-01-22 23:45:36 -0300 | 30723c3 | fix: close_all acquires lock...`
- **Reinícios**: aplicável após update (self_update/gitpull).
- **Rollback**: via snapshot/backup e scripts do CT quando necessário.

---

## 2026-01-23 — [CONV] Login_remediate enterprise + auditoria/detecção (THREAD=TH-2026-01-23-login-remediate-enterprise)

- **O que**: grande sequência de commits endurecendo `login_remediate` (timeouts, evidência, detecção de captcha/PIN/consent, pós-sucesso determinístico).
- **Por quê**: evitar loops/ACK pendente e tornar recuperação automática confiável em produção.
- **Evidência (CONV/Git)**: ver commits do dia `2026-01-23` no Git log (ex.: `3a26eab`, `61ebe1f`, `747695f`, `43c4d7f`, `80872d6`, `bf43d6c`, `2f82c24`, `6d771c7`).
- **Reinícios**: aplicável após update.
- **Rollback**: via snapshot/backup.

---

## 2026-01-24 — [CONV] Quiesce obrigatório + status flags (THREAD=TH-2026-01-24-quiesce)

- **O que**: quiesce antes de cookie inject e expansão de flags no status.
- **Por quê**: reduzir concorrência durante etapas sensíveis (configure/login_remediate).
- **Evidência (CONV/Git)**:
  - `2026-01-24 17:11:07 -0300 | cb9b8de | quiesce: require global pause before cookie inject`
  - `2026-01-24 16:46:18 -0300 | c578a81 | status: expose virtusOnline/sendLock/robeExec in get-status`
- **Reinícios**: aplicável após update.
- **Rollback**: via snapshot/backup.

---

## 2026-01-25 — [CONV][CT][CROSS] Ban/2FA enterprise (THREAD=TH-2026-01-25-ban-2fa-enterprise)

- **O que**: pipeline completo para ban/2FA (evidência, CT archive, não deletar com Chrome vivo, overlay humano persistente).
- **Por quê**: impedir perda de contas/estado e dar rastreabilidade (evidence-first).
- **Evidência (CONV/Git)**: vários commits do dia (ex.: `886ddfc`, `739d936`, `3271a49`, `1b319fe`, `00fc5f6`, `b8cfecd`, `3b5da22`).
- **Reinícios**: aplicável após update.
- **Rollback**: via snapshot/backup.

---

## 2026-01-26 — [CONV] Políticas de humano/identity/captcha + hardening (THREAD=TH-2026-01-26-human-policies)

- **O que**: política “humano só via invoke_human” (e ajustes), plus hardening de ban/2FA e kill robusto por userDataDir/rootPid.
- **Por quê**: evitar “humano invocado sem querer” e evitar Chrome órfão.
- **Evidência (CONV/Git)**: commits do dia (ex.: `05f7ea8`, `83e1f94`, `d75f985`, `00ceb17`).
- **Reinícios**: aplicável após update.
- **Rollback**: via snapshot/backup.

---

## 2026-01-27 — [CONV][CT][CROSS] UA+FP telemetry + snapshots RM4 (THREAD=TH-2026-01-27-uafp-telemetry, TH-2026-01-27-rollback-rm4)

- **O que**:
  - UA+FP telemetry para CT (captcha/identity/banned/2FA) — cria contrato CT⇄Conveniente.
  - export de snapshots do conveniente para o CT (RM4), com `_manifest.json` por tag.
- **Por quê**:
  - telemetria: reduzir falso positivo e dar observabilidade central no CT.
  - snapshots: ter rollback/auditoria baseada em artefato real.
- **Evidência (patch/diff)**:
  - `C:\sitechatbot\_incoming_backups\_diff_worker_1624_vs_1654.patch` (mostra endpoint `POST /api/stock/uafp_event_secret`)
- **Evidência (backups recebidos no CT)**:
  - `C:\sitechatbot\_incoming_backups\825a4485-1465-4c11-aa18-52f0597b23a3\backup_20260127_162416\_manifest.json`
  - `...\backup_20260127_165414\_manifest.json`
  - `...\backup_20260127_172414\_manifest.json`
- **Evidência (doc CT)**:
  - `C:\sitechatbot\docs\AUDITORIA_ROLLBACK_CONVENIENTE_20260127_165414.md`
- **Reinícios**: aplicável quando rollback/restores são executados.
- **Rollback**: escolher tag base (ex.: `20260127_165414`) e aplicar script de rollback de código.

---

## 2026-01-28 — [CONV] perfis.json recovery + open-all governance + backup ops (THREAD=TH-2026-01-28-perfis-recovery-openall-governance)

- **O que**:
  - recuperação/lock do `perfis.json`, master-only writes e comando repair.
  - governança/open-all (sequenciador/backoff/menos flicker) e melhorias de dashboard.
  - comandos de backup ops (list_backups/restore_backup + export snapshot via comando).
- **Por quê**: reduzir corrupção/IO race e tornar operações em massa controláveis.
- **Evidência (CONV/Git)**: commits `229f109`, `5c62c07`, `7301889`, `554748f`, `2ad6f9e`, `14f9391`, `1814d9b` e vários de open-all.
- **Evidência (Cursor/agent-tools)**:
  - `list_backups` mostrou `C:\conveniente\_backup_auto\_snapshots.log` e `tagsCount=326`:
    - `cmdId=326a188c-f925-44d3-a130-6e7e99a554b0`, `hostId=825a...`
    - arquivo: `C:\Users\NOTIFICADOR\.cursor\projects\...\agent-tools\e5548d03-4350-439a-a0f5-1531adc4ddfe.txt`
- **Reinícios**: aplicável após update.
- **Rollback**: via snapshot/backup e scripts de rollback.

---

## 2026-01-29 — [CROSS][DOCS] Bootstrap de documentação + backfills (THREAD=TH-2026-01-29-docs-bootstrap, TH-2026-01-29-backfill-*)

- **O que**:
  - estruturamos `LIVRO_DE_BORDO.md`, `RUNBOOK_TECNICO.md`, `TIMELINE.md` e checkups.
  - backfill nível 1/2/3 para reconstruir os dias com evidência (Git/backups/recovery/Cursor).
- **Por quê**: garantir que qualquer GPT/humano consiga entender “o que foi feito e por quê” e debugar com evidências reais.
- **Evidência**:
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
  - `C:\conveniente\docs\TIMELINE.md`
  - `C:\conveniente\docs\checkups\checkup_2026-01-29_reconstrucao_ultimos_10_dias.md` (nível 1)
  - `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_planos_patches.md` (nível 2)
  - `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_agenttools.md` (nível 3)
  - `C:\conveniente\docs\checkups\audit_2026-01-29_cobertura_evidencias_2026-01-09_a_2026-01-29.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter `.md`.

---

## Anexos (backfills e fontes de prova)

- Backfill nível 1 (10 dias, Git/backups): `C:\conveniente\docs\checkups\checkup_2026-01-29_reconstrucao_ultimos_10_dias.md`
- Backfill nível 2 (Cursor + planos/patches/backups recebidos): `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_planos_patches.md`
- Backfill nível 3 (Cursor agent-tools): `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_agenttools.md`
- Auditoria de cobertura (tabelas/contagens): `C:\conveniente\docs\checkups\audit_2026-01-29_cobertura_evidencias_2026-01-09_a_2026-01-29.md`
- Ledger de commits do `conveniente` (hora+hash+título): `C:\conveniente\docs\checkups\audit_2026-01-29_conveniente_git_ledger_2026-01-16_a_2026-01-29.md`
- Changesets do Git do `conveniente` (por commit: A/M/D/R): `C:\conveniente\docs\checkups\audit_2026-01-29_conveniente_git_changesets_2026-01-16_a_2026-01-29.md`
- Hotspots do Git do `conveniente` (arquivos/diretórios/extensões mais tocados): `C:\conveniente\docs\checkups\audit_2026-01-29_conveniente_git_hotspots_2026-01-16_a_2026-01-29.md`

