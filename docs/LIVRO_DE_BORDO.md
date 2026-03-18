### Livro de bordo — Conveniente / Sitechatbot / Notificador (handoff para GPT)

Objetivo: ser a **porta de entrada** (índice) do sistema, apontando para:

- **Runbook técnico (como operar)**: `docs/RUNBOOK_TECNICO.md`
- **Linha do tempo (o que mudou e por quê)**: `docs/TIMELINE.md`

Motivo: isso evita engessar futuros GPTs e, ao mesmo tempo, evita “cada GPT inventar um caminho novo” sem deixar rastros.

---

### Regras (110% enterprise)

- **Cabeçalho obrigatório (sempre no início da resposta)**:
  - Precisa reiniciar? sim/não
  - Qual projeto? conveniente / sitechatbot / notificador / site *(ou outro projeto, ex.: `afiliadozap`)*
  - Como reiniciar (humano)? `node index.js`
  - Por quê? (1 frase)
- **Evidência obrigatória**: sempre citar arquivo/endpoints/log keys/comando (o que torna auditável).
- **Impacto operacional obrigatório**: sempre dizer **quais processos/nodes reiniciar** (ou “nenhum”).
- **Rollback obrigatório**: como desfazer/voltar.
- **Regra de melhoria contínua (obrigatória)**:
  - Se um GPT **tentou um caminho e deu errado** e depois encontrou o **caminho certo**, ele deve:
    - atualizar o **procedimento canônico** no `docs/RUNBOOK_TECNICO.md`, e/ou
    - atualizar este índice (`docs/LIVRO_DE_BORDO.md`) se for regra estrutural, e/ou
    - registrar na `docs/TIMELINE.md` se mudou comportamento/procedimento,
    - e **subir commit** para o GitHub (para “propagar” para os próximos GPTs).
- **Regra humana (importante)**: o humano é falho — **o GPT é o operador**.
  - O humano **não executa comandos** e **não troca arquivo manualmente**.
  - **Limite real**: o GPT **não reinicia** seus servidores remotamente.
  - O GPT executa (no que dá): `git commit/push` (repositório), e quando aplicável envia comando CT `self_update`.
  - O humano executa (quando necessário): reiniciar manualmente no host com `node index.js` (parar e subir de novo).
  - Rollback (Git) continua sendo “feito pelo GPT” **no repositório** (`git revert` / voltar tag) — e o humano aplica reiniciando `node index.js` no(s) host(s).
  - Regra de comunicação: sempre falar “reiniciar = rodar `node index.js` de novo”, e dizer claramente **qual projeto** (conveniente/CT/notificador).
  - **Padrão sem repetição (conveniente)**: se houve mudança no `conveniente`, o GPT **já** faz `commit/push` + dispara `self_update` via CT e só avisa: **“reinicia `node index.js` no host X”**.
  - Vocabulário: quando o humano disser **“pull”**, significa **disparar `self_update` via CT** (equivalente a `git pull` no host).
- **Stock provision (regra do lead)**: por padrão, o `stock_provision` **não deve pausar** Virtus/Robe do servidor; ele deve garantir headroom (RAM) fechando browsers se necessário. O quiesce legado (busy/pause) só deve ser reativado explicitamente via env `STOCK_PROVISION_QUIESCE_ENABLED=1`.
- **Disaster recovery (RM2 wipe de perfis)**: restore de perfis deve ser feito via comandos CT no executor (sem cópia manual):
  - `backup_restore_probe` + `backup_restore_merge(mode=dry_run/apply)` no `C:\conveniente\scripts\dashboard.js`
  - `apply` salva rollback em `C:\conveniente\dados\_ops_audit\restore_<ts>_*.before.json`
  - Referência: `docs/inbox/done/INC-20260212-0240-01.md`
  - Se o humano reportar que precisou fazer `git pull` manual no host: isso é **sinal de falha no fluxo de update** (self_update não foi enviado/entregue/ack). O GPT deve coletar evidência no CT e registrar na `docs/TIMELINE.md` + ajustar o runbook para não repetir.
  - Regra de restart (importante): **nem toda atualização precisa de restart “agora”** para continuar trabalhando em outras mudanças.
    - Restart é necessário quando a atualização precisa **valer no runtime** (para testar/validar o comportamento novo).
    - Se a próxima mudança não depende disso, pode reiniciar depois.
  - O que o humano cobra do GPT: “o que mudou?”, “qual serviço reiniciar?”, “qual validação foi feita?”, “qual rollback você vai aplicar se falhar?”.
- **Sem segredos em texto puro aqui**: este arquivo documenta **NOMES** e **ONDE CONFIGURAR** (env / `ct_config.json`), mas **não cola valores**.

> Motivo: mesmo “só nós temos acesso”, texto puro pode vazar por backup, print, upload, ou histórico. A forma enterprise é registrar *referência* e *procedimento*, não o valor.

---

### Índice rápido

- **Começar por aqui**
  - Visão geral (o que é cada projeto) — **este arquivo**
  - Continuidade entre chats (handoff pronto para colar no novo chat) — `docs/INFORMACOES_CONTINUIDADE_GPT.md`
  - Runbook (operar/restart/diagnóstico) — `docs/RUNBOOK_TECNICO.md`
  - Timeline (mudanças) — `docs/TIMELINE.md`
  - Dossiê pré-código (novo fluxo de leads por sorteio/cobrança) — `docs/checkups/checkup_2026-02-19_novo_fluxo_leads_sorteio_cobranca.md`
  - Auditoria pré‑código (pós‑vencedor / Contestação V2.1: baseline real + gaps + simulação pesada P2) — `docs/checkups/checkup_2026-02-23_auditoria_pre_codigo_pos_vencedor_contestacao_v2_1.md`
  - Incidentes P0 concluídos desta etapa — `docs/inbox/done/INC-20260214-0900-01.md` e `docs/inbox/done/INC-20260214-1020-01.md`
  - Incidente P0 reaberto em monitoramento (aguardando evidência) — `docs/inbox/need_evidence/INC-20260215-1100-01.md`
  - Incidente P0 em monitoramento (aguardando evidência) — `docs/inbox/need_evidence/INC-20260203-1800-01.md`
  - Incidente P0 em monitoramento (aguardando evidência) — `docs/inbox/need_evidence/INC-20260216-1600-01.md`
  - Incidente P0 em monitoramento (aguardando evidência) — `docs/inbox/need_evidence/INC-20260216-1930-01.md`
  - Reativação tokenized + reset baseline financeiro (runbook canônico) — `docs/RUNBOOK_TECNICO.md` (seção “Reativação tokenized por praça + reset de baseline financeiro”)
  - **Migração de crédito (mensalidade → tokenized) + correção de sinal (ledger)** — `docs/RUNBOOK_TECNICO.md` (seção “Migração de crédito (mensalidade → tokenized) — CANÔNICO”)
  - **Inbox de relatos do humano (intake/triage)** — `docs/INBOX_RELATOS_DO_HUMANO.md`
  - **Serviço de Lead (2026-03-18)**: menu 10 serviços pós-frete + CT — `docs/inbox/need_evidence/INC-20260318-1000-01.md`; dossiê pré-código — `docs/checkups/checkup_2026-03-18_dossie_pre_codigo_servico_lead.md`
  - **Host registry (apelidos ↔ hostId)** — `docs/HOST_REGISTRY.md`
  - Checkups (relatórios) — `docs/checkups/`
  - **RM3 CDP/recovery/UAFP (2026-03-16)**: dossiê forense + correção aplicada — `docs/checkups/checkup_2026-03-16_dossie_forense_rm3_browser_morto_12h.md`; investigação RM3 vs outros — `docs/checkups/checkup_2026-03-16_investigacao_rm3_vs_outros.md`; procedimento canônico — `docs/RUNBOOK_TECNICO.md` (seção "RM3: recovery CDP fatal")
- **Sorteio justo por carga (contestação não zera prioridade até pagamento)** — `docs/inbox/done/INC-20260302-1500-01.md` (inclui evidências/tokens e auditoria)
  - **P0 (CT) Fonte Única da Verdade — validação**: ver `docs/inbox/done/INC-20260202-2000-01.md` (inclui verificador offline `C:\sitechatbot\tools\verify_virtus_groups_truth.js`)
  - **Playbook (FS) perfis órfãos/recovery/purge (RM1 validado)**: `docs/RUNBOOK_TECNICO.md` (seção “Alinhamento no disco…”) + checkup `docs/checkups/checkup_2026-02-13_rm1_profiles_orphans_alignment.md`

---

### Como trabalhamos (regra para todos os GPTs)

Objetivo: não criar “caminhos paralelos” e não perder contexto entre chats.

- **Se descobriu algo estrutural/contrato/ID/comando**:
  - atualizar **`docs/LIVRO_DE_BORDO.md`** (este arquivo).
- **Se virou procedimento repetível (playbook)**:
  - atualizar **`docs/RUNBOOK_TECNICO.md`** (CANÔNICO vs EXPERIMENTAL).
- **Se foi uma mudança (docs ou código)**:
  - registrar na **`docs/TIMELINE.md`** com: o que, por quê, evidência, reinícios, rollback.
- **Se foi uma investigação/checkup detalhado**:
  - criar um **arquivo de checkup** em `docs/checkups/` (use o template `docs/checkups/TEMPLATE_CHECKUP.md`).
  - e colocar **um resumo de 1–3 linhas** na `docs/TIMELINE.md` apontando para o checkup.

---

### Visão geral (o que é o quê)

- **`conveniente`** (`C:\conveniente`):
  - Serviço local que controla perfis, browsers e automações (cluster de workers).
  - Expõe painel/API local (bind local) e envia telemetria para o CT.
  - Entry: `C:\conveniente\index.js`

- **`sitechatbot`** (`C:\sitechatbot`):
  - CT (central) + UI/estoque + fila de comandos remotos.
  - Mantém `commands.json` (fila), grava `commands.log`, recebe ACK e persiste evidências.
  - Entry: `C:\sitechatbot\index.js`

- **`notificador`** (`C:\notificador`):
  - Worker de WhatsApp (Baileys) que consome/pulsa dados do CT e envia mensagens.
  - Não parece expor servidor HTTP; opera via polling/API.
  - Entry: `C:\notificador\index.js`

---

### Portas e bindings (canônico)

- **conveniente**
  - **PORT**: `process.env.PORT` (default **8088**)
  - Bind: **`127.0.0.1`** (local apenas)
  - Health: `GET /health`
  - Status agregado: `GET /api/status`

- **sitechatbot**
  - **PORT**: `process.env.PORT` (default **3000**)
  - Bind: `0.0.0.0`

- **notificador**
  - Sem porta HTTP detectada no `index.js` (opera por API/polling)

---

### Contrato CT ⇄ servidores (fluxo de dados)

#### 1) Servidor (`conveniente`) → CT (`sitechatbot`) — telemetria

- O `conveniente` envia status para o CT em:
  - Endpoint report: `POST {CT_BASE_URL}/report`
  - Resolução do endpoint: `C:\conveniente\scripts\notifierEndpoints.js`
    - Prioridade: `CT_BASE_URL` / `CT_URL`
    - Fallback: `dados/ct_config.json` (`ctBaseUrl`)

#### 2) CT → servidor — comandos (fila)

- CT expõe enqueue:
  - `POST /api/commands/enqueue` (autenticado)
  - `POST /api/commands/enqueue_secret` (por segredo ou local)
  - Arquivo CT: `C:\sitechatbot\index.js`

O comando é persistido em:
- `sitechatbot/dados/commands.json`
- Lock: `sitechatbot/dados/commands.lock`
- Log: `sitechatbot/dados/commands.log`

O servidor (`conveniente`) recebe comandos dentro da resposta do `report` (campo `commands`) e executa via `C:\conveniente\scripts\dashboard.js` (função `applyCommands`).

#### 3) Servidor → CT — ACK (anti “comando zumbi”)

- Endpoint CT: `POST /api/commands/ack` (`C:\sitechatbot\index.js`)
- O CT:
  - marca o comando como concluído (inflight/broadcast)
  - grava evidência por cmdId: `sitechatbot/dados/logs/<hostId>/ack_<cmdId>.json`

---

### Contrato CT ⇄ Notificador (fila de “pedidos”)

#### CT (`sitechatbot`) → Notificador (`notificador`) — pull (claim)

- Endpoint CT: `GET /api/notifier/next`
- Auth (opcional, recomendado em prod): header `x-api-key` deve bater com `NOTIFIER_API_KEY` no CT.
  - Se `NOTIFIER_API_KEY` no CT estiver vazio, o endpoint fica aberto (não recomendado).
- Identidade do worker: header `x-worker-id` (ou query `?worker=`).

#### Notificador → CT — ACK

- Endpoint CT: `POST /api/notifier/ack`
- Body: `{ jobId, ok, error?, nonRetryable?, meta? }`
- Headers:
  - `x-api-key` (se configurado)
  - `x-worker-id` (opcional, para rastreio)

#### Notificador (config)

- Base do CT: `SITECHATBOT_API_BASE` (default `http://127.0.0.1:3000`)
- API key: `NOTIFIER_API_KEY`
- Polling default: 30–60s (randomizado) via `NOTIFIER_POLL_MIN_MS` / `NOTIFIER_POLL_MAX_MS`

---

### Glossário de IDs (para debugar sem confusão)

- **`hostId`**
  - **O que é**: identificador único de um servidor/nó.
  - **Onde nasce**: `conveniente` grava/usa `dados/.telemetry_hostid`.
  - **Quando muda**: não muda com restart do processo; só muda se `C:\conveniente\dados\.telemetry_hostid` for apagado/ausente e o `conveniente` recriar.
  - **Cadência de telemetria**: o `conveniente` envia `POST /report` por padrão a cada `DASHBOARD_INTERVAL_MS` (default 30s) via `scripts/dashboard.js`.
  - **Mapa humano ↔ hostId**: `C:\conveniente\docs\HOST_REGISTRY.md` (apelidos tipo “ROBE MÃE 2”).
  - **Onde aparece**:
    - CT/telemetria: payload do `report`
    - comandos/ACK: `sitechatbot/dados/commands.json`, `sitechatbot/dados/commands.log`
    - evidência: `sitechatbot/dados/logs/<hostId>/ack_<cmdId>.json`

- **`cmdId`** (ou `id` do comando)
  - **O que é**: id do comando enfileirado no CT.
  - **Onde nasce**: CT ao criar `enqueueCommand(...)` (persistido em `commands.json`).
  - **Onde aparece**:
    - CT: `sitechatbot/dados/commands.json` + `sitechatbot/dados/commands.log`
    - servidor: recebido dentro do `report` como `commands[]`
    - evidência do CT: `sitechatbot/dados/logs/<hostId>/ack_<cmdId>.json`

- **`requestId`**
  - **O que é**: id de uma solicitação “de dados/logs” (não é comando de ação direta).
  - **Uso típico**: `fetch_logs`, `fetch_logs_query`, `logs_manifest` (para correlacionar resposta/entrega).

- **`profileName`** / **`nome`** (perfil)
  - **O que é**: slug do perfil (ex.: conta/instância).
  - **Onde aparece**: payload de comandos por perfil (`login_remediate`, `delete_perfis`, etc.) e no status.

---

### Comandos canônicos (evitar “cada GPT inventar um”)

#### Comandos suportados pelo servidor (`conveniente`) via dashboard

Fonte: `C:\conveniente\scripts\dashboard.js`

- `close_all`
- `open_all_24h`
- `robes_pause_24h_all`
- `robes_release_all`
- `delete_perfis`
- `migrate_profiles`
- `stock_provision`
- `login_remediate`
- `profiles_cleanup`
- `provision_unlock`
- `stock_export_profiles`
- `stock_push_account_update`
- `fetch_logs`
- `fetch_logs_query`
- `logs_manifest`
- `set_ct_config`
- `self_update`

Notas operacionais (P0):

- `open_all_24h` **deve abrir** perfis mesmo quando `loginRequired=captcha_*` / `checkpoint_*` / `identityRequired` (esses estados são “correção”, não motivo para manter browser fechado).
- O contador “trabalhando” pode ter **warm-up** logo após Abrir Todos (abrindo browsers + `bootstrap_messenger_ready` + start do Virtus); se cair muito, esperar alguns minutos antes de concluir regressão.

#### Anti “comandos zumbis” (fila/loops)

O CT já tem GC/limpeza por TTL para comandos que ficaram sem ACK:
- `close_all` (inflight e broadcast)
- `login_remediate` (inflight)

Além do GC, existe proteção de **idempotência pós-restart**:
- O CT verifica se já existe `ack_<cmdId>.json` para um `hostId` e **não reentrega** o comando para aquele host (evita executar 2x após reinício).
- Eventos úteis em `commands.log`: `deliver_skip_acked`, `gc_*`, `ack`.

Config (env vars no CT / `sitechatbot`):
- `CT_COMMANDS_PRUNE_INTERVAL_MS` (default 30s)
- `CT_COMMANDS_LOCK_STALE_MS` (default 30s)
- `CT_COMMANDS_EXPIRE_CLOSE_ALL_INFLIGHT_NO_ACK_MS`
- `CT_COMMANDS_EXPIRE_CLOSE_ALL_BROADCAST_NO_ACK_MS`
- `CT_COMMANDS_EXPIRE_CLOSE_ALL_BROADCAST_GLOBAL_MS`
- `CT_COMMANDS_EXPIRE_LOGIN_REMEDIATE_INFLIGHT_NO_ACK_MS`
- limites:
  - `CT_COMMANDS_MAX_INFLIGHT_PER_HOST`
  - `CT_COMMANDS_MAX_BROADCAST`
  - `CT_COMMANDS_KEEP_COMPLETED_MS`

**Procedimento de diagnóstico de zumbi** (ordem):
- olhar `sitechatbot/dados/commands.log` (eventos `enqueued`, `delivered`, `ack`, `gc_*`)
- confirmar evidência: `sitechatbot/dados/logs/<hostId>/ack_<cmdId>.json`
- se o servidor “não responde”, pedir logs pelo comando `fetch_logs` (abaixo)

---

### Coleta de logs (canônico, via comando remoto)

Fonte allowlist: `C:\conveniente\scripts\dashboard.js` (`logsAllowlist()`).

Keys permitidas (servidor):
- `logger`
- `issues_fallback`
- `desired`
- `perfis`
- `status`
- `status_node_1..6`
- `provision_audit`
- `login_required_events`
- `login_remediate_evidence`
- `messenger_pin`
- `migrations`
- `updates`
- `git_head`
- `git_main_ref`
- `provision_lock`
- `commands`
- `service_stdout`
- `service_stderr`

Formas:
- **`fetch_logs`**: tail do arquivo (por keys)
- **`fetch_logs_query`**: tail + filtro por padrões (substring)
- **`logs_manifest`**: lista existência/tamanho/mtime das keys (inventário rápido)

---

### Logs “sob demanda” (CT) — requestId/response (sem UI)

O CT mantém um canal de logs por `requestId`:

- Metadados da requisição: `sitechatbot/dados/logs/requests/<requestId>.json`
- Resposta do host: `sitechatbot/dados/logs/<hostId>/<requestId>.json`
- Stream de eventos: `sitechatbot/dados/logs/requests.jsonl`

Endpoints “secret” (CT):
- `POST /api/logs/request_secret` (enfileira `fetch_logs`)
- `GET /api/logs/request_secret/:id` (consulta status/resposta)
- `POST /api/logs/manifest_secret` (enfileira `logs_manifest`)

Autorização:
- por header `x-log-secret` (valor = `LOG_INGEST_SECRET`) **ou** request local (localhost) no próprio host do CT.

---

### Onde ficam configs e segredos (sem valores)

#### `conveniente`

- Config persistida:
  - `C:\conveniente\dados\ct_config.json` (ignorado pelo git)
    - `ctBaseUrl` (base do CT)
    - `logIngestSecret` (segredo para logs/secret endpoints)
- Env vars importantes:
  - `PORT`
  - `CT_BASE_URL` / `CT_URL`
  - `LOG_INGEST_SECRET` (fallback; `ct_config.json` tem prioridade)
  - `OPEN_CHROMIUM_ON_START`

#### `sitechatbot` (CT)

- Env vars importantes:
  - `PORT`
  - `LOG_INGEST_SECRET`
  - `CT_BASE_URL` / `CT_URL` (se existir; ver config interna)
  - comandos/GC: todas `CT_COMMANDS_*`
  - `NOTIFIER_API_KEY` (auth do notificador)
  - `WHATSAPP_VERIFY_TOKEN` (se integra com webhook)

#### `notificador`

- Env vars importantes:
  - `SITECHATBOT_API_BASE` (base do CT)
  - `NOTIFIER_API_KEY` (auth do notificador no CT)
  - `BAILEYS_AUTH_DIR` (diretório de auth local)
  - `GROUPS_FILE`

> Observação: o `notificador` tem arquivo sensível citado no backup (`credenciais-google-sheets.json`). **Não colar o conteúdo aqui**; registrar apenas existência/local e procedimento de rotação.

---

### Baseline de operação (resumo)

Para detalhes (restart/checklists/diagnóstico), usar o runbook: `docs/RUNBOOK_TECNICO.md`.

Para histórico de mudanças, usar a timeline: `docs/TIMELINE.md`.

---

## 2026-02-20 — Fechamento P0 com simulação pesada (PASS)

- Rodada final executada com foco em "fechar com chave de ouro", sempre em base forense isolada (sem tocar runtime de produção).
- Incidentes P0 validados:
  - webhook Asaas com baixa automática idempotente
  - webhook atrasado recuperado por reconciliação `poll` (`reconcileOpenAsaasPayments`)
  - reemissão com ajuste sem perda de atomicidade financeira
  - alertas operacionais críticos com métricas esperadas
- Stress pesado aprovado:
  - suíte enterprise completa (`stress_phase4_enterprise`) com `8` rodadas e `ok=true`
  - sorteio atômico em alta carga (`1200` leads, `62674` participações persistidas, `0` falhas)
  - billing atômico em carga alta (`180` motoristas, `0` boletos abertos após webhook, `180` pagos)
- Status operacional após rodada: sem pendência P0 aberta nos blocos testados nesta fase.

---

## 2026-02-23 — Consolidacao pre-nova-fase (transicao com menor atrito)

- Contestacao/reabertura estabilizadas em runtime:
  - reenvio ao grupo apos contestacao valida;
  - bloqueio apenas do motorista contestante no mesmo `lead_token`;
  - reabertura automatica quando janela fechou sem participantes (`no_participants`).
- Governanca de grupos:
  - todos os grupos voltaram ao legado, mantendo apenas Ipatinga tokenized (`C:\notificador\tokenized_pilot_groups.json`).
- Financeiro zerado para recomeco limpo:
  - limpeza seletiva de leads em aberto executada com trilha auditavel;
  - em seguida, wipe total de carteira/ledger/faturas de lead (`reset_all_wallets_full_wipe.js --apply`);
  - estado final confirmado: sem saldo/sem boletos/sem leads ativos no ledger.
- INC de continuidade aberta para nova etapa:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260223-1200-01.md`
  - foco: reduzir atrito entre metodo antigo e metodo novo antes de migracao ampla.

---

## 2026-02-23 — Hardening final pre-Go/No-Go (copy + seguranca + simulacao)

- Canônico da contestacao alinhado ao runtime real:
  - arquivo: `C:\conveniente\docs\inbox\done\INC-20260222-2310-01.md`
  - consolidado: menu 10 opcoes (`r1..r10`), regra de reabertura por motivo e desativacao do legado `CONTEST_LEGACY_T15_ENABLED=0`.
- Copy financeira unificada no WhatsApp:
  - vencedor: `💰 Saldo da sua carteira (em aberto): R$ ...`
  - contestacao aprovada: mesma assinatura de saldo.
  - bloqueio financeiro: texto padronizado com "saldo em aberto" (removendo copy hibrida "boleto vencido" como frase primaria).
- Scripts destrutivos com dupla confirmacao:
  - `reset_all_wallets_full_wipe.js`, `cleanup_open_leads_tokenized_rollout.js`, `reset_wallets_tokenized_rollout.js`
  - aplicar agora exige: `--apply --confirm`.
- Script de reteste alinhado com producao:
  - `release_lead_for_retest.js` voltou para janela de `180000ms` (3 minutos) no output.
- Evidencia objetiva de validacao:
  - `node tools/simulate_contestation_matrix_live.js --driver 48991985634 --customer 48991985634` => `ok=true`, `total_scenarios=11`, `pass=true`.
  - `node tools/simulate_contestation_concurrency_live.js --driver 48991985634 --customer 48991985634 --count 36` => `ok=true`, `pass=36`, `fail=0`.
  - higiene pos-simulacao: `node tools/cleanup_simulation_artifacts.js` e validacao `--dry-run` com `lead_tokens_found=0`.

---

## 2026-02-23 — Rodada pesada complementar (forense) concluida

- Contestacao T+15 (slice legado) validada em base forense:
  - `node tools/simulate_contestation_t15_slice.js` => `ok=true`.
- Ledger financeiro validado sob carga em base forense:
  - `node tools/simulate_lead_ledger.js` => `ok=true`, `220` motoristas, `90` operacoes por motorista, `mismatches=0`.
- Status operacional:
  - pronto para iniciar **teste controlado com equipe + usuarios monitorados**;
  - manter gate de migracao ampla apenas apos Go/No-Go desse piloto.

---

## 2026-02-23 — Checklist final antes da bateria real com 3 usuários

- Auditoria de ponta a ponta atualizada no INC de transição:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260223-1200-01.md`
- Confirmado no runtime:
  - contestação `r1..r10` com regras de retorno/não-retorno;
  - saldo único em mensagens + CT;
  - crédito manual no CT;
  - bloqueio operacional manual com botão dinâmico.
- Plano de bateria real fechado:
  - 8 cenários, 2 execuções por cenário, com critério PASS/FAIL objetivo.
- Gate:
  - Go para bateria controlada;
  - No-Go para expansão ampla sem evidência da bateria real completa.

---## 2026-02-23 — [BATERIA REAL][VALIDADO] Saldo único + crédito manual + contestação (runtime vivo)

- **Saldo único no WhatsApp (pós-contestação)** validado com crédito manual:
  - evidência canônica: `C:\conveniente\docs\inbox\done\INC-20260222-2310-01.md` (seção “Evidência (bateria real controlada) — 2026-02-23”).
  - caso: `pedidoId=TSTBAL2_1771883706901`, `lead_token=LDTSTBAL21771883706901`, saldo exibido `+R$ 80,00`.
- **Correção aplicada no runtime**:
  - remover truncamento indevido do saldo pós-contestação (`Math.max(0, ...)`) no WhatsApp.
  - arquivo: `C:\sitechatbot\whatsapp\lib\flow.js`
  - requer restart do `sitechatbot` para valer.
- **Operação: pedido não chega no grupo** (observado e resolvido):
  - causa raiz 1: `notificador` parado com lock stale (`C:\notificador\.notificador.lock` com PID morto).
  - causa raiz 2: cidade fora do mapa de roteamento tokenized (`no_group_for_city:IPATINGA-MG`).
  - correção operacional: subir `C:\notificador` → `node index.js` e usar cidade canônica `Ipatinga (MG)`.

---## 2026-02-24 — [ORGANIZACAO CANONICA] Fechamento da rodada e abertura de monitoracao dedicada

- INC principal de contestacao/financeiro consolidado para operação:
  - `C:\conveniente\docs\inbox\done\INC-20260222-2310-01.md`
  - estado no índice atualizado para `done / deployed_monitoring / pass_for_core`.
- INC dedicado de monitoracao runtime criado para o próximo turno:
  - `C:\conveniente\docs\inbox\done\INC-20260224-0005-01.md`
  - foco: observar em produção controlada latência, filas, outbox WhatsApp e auditabilidade.
- Operação recomendada mantida:
  - 3 processos separados (`sitechatbot`, `notificador`, `ngrok`) sem mistura com runtime unificado.

---## 2026-02-24 — [PRODUCAO CONTROLADA][12H] Verificacao de estabilidade operacional

- Janela de observacao: sistema em execucao continua por ~12h, sem erro terminal critico reportado na rodada.
- Evidencias coletadas:
  - `GET /health` retornando `200`;
  - `GET /api/whatsapp/stats` retornando `200` com `runtime.counters` e `runtime.latencies`;
  - `GET /api/pedidos/stats` retornando `200`;
  - fila `pedidos` sem stuck em `pending/sending/error`.
- Recorte objetivo de 12h (`wa_outbox`):
  - `sent=1472`;
  - sem novos registros com `error` no recorte.
- Governanca de producao confirmada:
  - sorteio consolidado novamente em `3 minutos` para operacao real.
- Decisao:
  - fluxo principal tokenized/contestacao segue aprovado para operacao;
  - manter monitoracao assistida no `INC-20260224-0005-01` ate fechamento formal do turno seguinte.

---## 2026-02-24 — [BILLING HARDENING][PASS] Bateria prática completa + reset financeiro total

- Bateria de cobrança executada com validação forense (Asaas + CT + ledger), cobrindo:
  - criação sem duplicação;
  - pagamento e baixa automática;
  - cancelamento com retorno para aberto;
  - exclusão com compensação de leads;
  - edição de leads com reemissão.
- Correção crítica aplicada durante a bateria:
  - baixa automática de Asaas no reconcile voltou a liquidar invoice (`paid`) sem bloquear fluxo legítimo de webhook/reconcile.
- Hardening de confiabilidade confirmado:
  - cliente Asaas com retry + idempotência por `externalReference`;
  - confirmação forte pós-cancelamento (`deleted=true`);
  - reconciliação anti-zumbi/órfão ativa.
- Reset final solicitado pelo owner executado com proteção Asaas:
  - `C:\sitechatbot\tools\reset_all_wallets_full_wipe.js --apply --confirm`
  - resultado final: `ledger=0`, `invoices=0`, `open_invoices=0`, `controls=0`.---

## 2026-02-24 — [ORGANIZACAO][INC] Limpeza de backlog + abertura da frente de dashboard de contestacao

- Triagem dos INCs em `need_evidence` executada:
  - confirmados como fechados: `INC-20260222-2310-01`, `INC-20260224-0005-01`;
  - itens restantes mantidos em aberto por dependerem de evidência/definição funcional.
- Correção canônica no índice:
  - `INC-20260223-1200-01` alinhado para `in_progress / pilot_ready / passed_internal_simulation` (estava desatualizado no `INDEX`).
- Nova frente aberta para execução imediata:
  - `INC-20260224-1300-01` em `in_progress`;
  - escopo: menu novo `Contestacao Tokenized` com métricas por grupo, taxas, ranking de motoristas e ranking de motivos.

---## 2026-02-24 — [AUDITORIA][PRECIFICACAO] Base forense dos ultimos 200 pedidos (incompleto + porte)

- INC de auditoria de preço por faixa concluído:
  - `INC-20260224-1600-01` (`done`, `audited_data_ready`).
- Fonte canônica auditada:
  - `C:\sitechatbot\dados\pedidos.sqlite`, tabela `pedidos`, recorte dos últimos `200` por `created_at DESC`.
- Resultado objetivo:
  - incompletos (somente cidade): `37/200` (`18,5%`);
  - não incompletos: `163/200` (`81,5%`);
  - com porte preenchido: `123`;
  - não incompletos sem porte explícito: `40`.
- Distribuição de porte (contagem):
  - `Apenas 1 item grande`: `29`;
  - `Poucos itens (até 5 volumes)`: `22`;
  - `Pequena mudança`: `33`;
  - `Mudança de apartamento padrão`: `21`;
  - `Mudança completa de casa`: `13`;
  - `Carga comercial ou grande volume`: `5`.
- Normalização robusta aplicada (aliases + remoção de acento):
  - `unknown_port_values=0` no recorte.---

## 2026-02-26 — Revalidação do rollout tokenized (6 grupos)

- fonte única revisada: `C:\notificador\tokenized_pilot_groups.json`;
- configuração confirmada:
  - Ipatinga (MG) — `120363329985026016@g.us`
  - Montes Claros (MG) — `120363404258521988@g.us`
  - Foz do Iguaçu (PR) — `120363319453489081@g.us`
  - Fortaleza (CE) — `120363418394810828@g.us`
  - Petrolina (PE) — `120363311442748035@g.us`
  - Balneário Camboriú (SC) — `120363420004498085@g.us`
- checks de integridade executados:
  - JSON válido;
  - sem IDs repetidos;
  - sem ID fora do mapa `gruposids.json`;
  - 6/6 cidades-alvo com roteamento tokenized ativo por `groupId`.

## 2026-03-07 — Restore controlado para canário RM1 (Chrome + anti-rajada)

- Auditoria pré-código concluída e registrada em:
  - `C:\conveniente\docs\checkups\checkup_2026-03-07_dossie_pre_codigo_restore_chrome_antirajada_rm1.md`
- Snapshot do estado Chromium atual criado antes da reversão:
  - `C:\sitechatbot\backups\conveniente_code_chromium_pre_restore_20260307_112310`
- Restore executado em modo code-only (sem tocar `dados/`) para baseline:
  - `scripts/worker.js`, `scripts/browser.js`, `scripts/api_status.js`, `scripts/bootstrapService.js`, `instalar_conveniente.ps1`.
- Patch mínimo anti-rajada aplicado no `worker.js`:
  - LR scan único ~10min com jitter;
  - auto-login-remediate mínimo ~10min por perfil;
  - backoff progressivo no nurse/open para `ram_denied`;
  - reabertura curta padrão elevada para `60s`.

## 2026-03-07 — Forense RM7 (Florianopolis) sobre "chat feed recarregando"

- Evidência CT focada no perfil `florianopolis-1764625643701` (RM7):
  - cmdId `3f8dcb74-a366-46ea-8aef-074ce6b094f4`
  - requestId `rm7_floripa_forense_20260307_123545`
- Achado:
  - sem evidência de rajada recente de `page.reload` puro para o perfil;
  - o efeito visual de "recarregando chats" vinha do loop de humanização agressivo do Virtus (keepalive + scroll frequente + reforço em 800ms).
- Correção aplicada em `scripts/virtus.js`:
  - polling desacelerado para padrão humano (`60s` normal, `90s` slow);
  - scroll periódico desacelerado (`5min` normal, `8min` slow);
  - remoção do reforço de scroll em `+800ms`;
  - throttle de keepalive (`5min`);
  - gate de scroll por fila e ociosidade (janela de `10min`).
- Dossiê técnico:
  - `C:\conveniente\docs\checkups\checkup_2026-03-07_forense_floripa_reload_chatfeed.md`

## 2026-03-07 — Fase 2 forense pós-restart (worker/browser/virtus)

- Coletas canônicas:
  - `fetch_logs` cmdId `0c12f7c4-dd42-4a75-8edc-392c767975b3`
  - `fetch_logs_query` cmdId `cdeb8c5b-d1ec-4be6-90ef-c202cf8b13d9`
- Achado:
  - sem evidência de burst de reload no recorte curto pós-restart;
  - identificado padrão histórico de retry curto em `nurse_open_attempt` (perfil sem controller), potencialmente agressivo.
- Correção:
  - `scripts/worker.js` com guardrail de retry mínimo por perfil (`NURSE_OPEN_MIN_RETRY_MS=60s`) e tick mais humano (`NURSE_INTERVAL_MS=10s` por padrão).
- Objetivo:
  - impedir martelamento de abertura/navegação em janela curta sem comprometer recuperação normal e atendimento.

## 2026-03-07 — Fase 3 forense (humanização de micro-ações Virtus)

- Achado:
  - ainda existiam ações com assinatura sistemática rápida no `virtus` (digitação instantânea e click sintético em chat).
- Correção aplicada:
  - digitação por caractere com delay humano configurável;
  - pausa humana antes do Enter;
  - click nativo com delay no link do chat (remoção de cadeia agressiva de `MouseEvent` sintético);
  - pós-click/poll de URL desacelerados.
- Objetivo:
  - reduzir “cutucada” de micro-interações no Messenger mantendo estabilidade do atendimento.

## 2026-03-07 — Fase 4 forense (humanização global no Robe)

- Achado:
  - fluxo `robe` e `robeVeiculos` ainda concentrava sleeps curtos repetidos (assinatura sistemática).
- Correção:
  - guardrail global em ambos os scripts para converter pauses curtas em faixa humana com jitter configurável.
- Objetivo:
  - reduzir padrão mecânico de interação durante criação/publicação sem alterar a lógica de negócio.

## 2026-03-07 — Fase 5 forense (humanização no browser.js)

- Achado:
  - helper base de navegador ainda tinha delays fixos curtos em passos sensíveis de login/recuperação.
- Correção:
  - guardrail de pausa humana + jitter para click/type no `scripts/browser.js`.
- Objetivo:
  - reduzir previsibilidade de microtempo no núcleo de automação sem degradar estabilidade.

## 2026-03-07 — Fase 6 forense (microações residuais)

- Achado:
  - ainda havia microações rápidas/fixas em `virtus` e `robe`, além de loops curtos de manutenção em `worker`.
- Correção:
  - `virtus`: guardrail de pausa humana + aumento de ranges de type/click.
  - `robe`/`robeVeiculos`: delays curtos substituídos por jitter humano mais lento.
  - `browser`: prune passou a reutilizar `sleep` global humanizado (sem bypass local).
  - `worker`: watch/resume de stock-provision desacelerados por padrão e configuráveis.
- Objetivo:
  - reduzir assinatura mecânica residual mantendo estabilidade do atendimento/publicação.

## 2026-03-07 — Hotfix sem goto de chat + recovery com histerese

- Achado:
  - `virtus` ainda tinha navegação direta de chat por URL em caminhos de exceção; `worker` podia insistir em ciclos curtos de recuperação sob oscilação.
- Correção:
  - `virtus`: removido `goto` de chat e mantido retry por click.
  - `worker`: guardrails adicionais de tempo mínimo entre ações de recovery e cooldown maior em phantom fix.
- Objetivo:
  - reduzir cutucada sistemática sem quebrar rota de recuperação automática.
