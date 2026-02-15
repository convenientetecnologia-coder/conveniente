### Livro de bordo — Conveniente / Sitechatbot / Notificador (handoff para GPT)

Objetivo: ser a **porta de entrada** (índice) do sistema, apontando para:

- **Runbook técnico (como operar)**: `docs/RUNBOOK_TECNICO.md`
- **Linha do tempo (o que mudou e por quê)**: `docs/TIMELINE.md`

Motivo: isso evita engessar futuros GPTs e, ao mesmo tempo, evita “cada GPT inventar um caminho novo” sem deixar rastros.

---

### Regras (110% enterprise)

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
  - Runbook (operar/restart/diagnóstico) — `docs/RUNBOOK_TECNICO.md`
  - Timeline (mudanças) — `docs/TIMELINE.md`
  - Incidentes P0 concluídos desta etapa — `docs/inbox/done/INC-20260214-0900-01.md` e `docs/inbox/done/INC-20260214-1020-01.md`
  - Incidente P0 encerrado desta etapa — `docs/inbox/done/INC-20260215-1100-01.md`
  - **Inbox de relatos do humano (intake/triage)** — `docs/INBOX_RELATOS_DO_HUMANO.md`
  - **Host registry (apelidos ↔ hostId)** — `docs/HOST_REGISTRY.md`
  - Checkups (relatórios) — `docs/checkups/`
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

