### Ultra Enterprise — Auditoria completa (2026-01-24)

Este documento é o **checkup completo, minucioso e impiedoso** do que foi implementado nos sistemas `conveniente`, `sitechatbot` e (quando aplicável) `notificador`, incluindo **políticas**, **guardrails**, **observabilidade**, **testes executados**, **evidências**, e uma lista explícita de **pendências/riscos** (sem “achismo”).

> **Regra de ouro (enterprise)**: tudo aqui deve ser verificável por código, logs e ACKs. Onde algo foi “planejado”, mas não implementado, está marcado como **PENDENTE**.

---

### 1) Contexto: problemas que motivaram o trabalho

#### 1.1 “Close-all storm” durante provisão (bug grave)
- **Sintoma**: ao chegar conta nova / provisão, dezenas de navegadores eram fechados (ex.: 58/63), e depois reabertos — ciclo “fecha tudo → provisiona → reabre tudo”.
- **Impacto**: pico de CPU/RAM, instabilidade e violação da regra “mínimo impacto”.
- **Exigência enterprise**: fechar **apenas o mínimo necessário**, e **nunca** executar `close_all` automaticamente em momentos inesperados.

#### 1.2 Login Required: falso positivo e travamentos
- **Sintoma**: logs indicavam sucesso, mas visualmente o Facebook caía em “confirme que você é uma pessoa” (captcha/checkpoint) ou telas de consentimento/LGPD/novidades, e o processo ficava pendurado.
- **Exigência enterprise**:
  - Sem falsos positivos.
  - Capturar evidência (HTML/screenshot) para auditoria.
  - Timeouts duros para nunca “carregar infinito”.
  - Se não automatizável: **fail-fast para humano**, com sinalização consistente em todos os lugares.

#### 1.3 “Dashboard cego” (telemetria inconsistente)
- **Sintoma**: navegador aberto (abas visíveis), mas dashboard mostrava `active=false`/`trabalhando=false`.
- **Causa raiz identificada**: execução por “worker paralelo” fora do cluster, gerando browsers **não gerenciados** pelo caminho que alimenta `/api/status`.
- **Correção**: unificar execução de `login_remediate` via **cluster** (mesma fonte do status).

---

### 2) Princípios operacionais implementados (ultra enterprise)

#### 2.1 Princípio Zero — mínimo impacto
- Nunca fechar dezenas de browsers “por segurança”.
- Sempre preferir:
  - **pausar** automações (Virtus/Robe),
  - fazer **headroom** com fechamento mínimo,
  - executar provisão/config,
  - liberar tudo e retomar gradualmente.

#### 2.2 Política de RAM (centralizada e auditável)
- Base: **2GB** para o host + **1GB por node** (operação normal).
- Durante provisão: reservar **2GB + 1.5GB (spike)**, permitindo “emprestar” a reserva dos nodes.
- Implementado como módulo único em `conveniente/scripts/ramPolicy.js`.

#### 2.3 Isolamento de provisão via lock global (cross-process)
- `conveniente/scripts/provisionLock.js` implementa lock com TTL via arquivo.
- Regra: enquanto lock ativo, só o **dono** do lock pode executar ações sensíveis; demais recebem bloqueio (`maintenance_provision`).

---

### 3) Implementações em `conveniente` (código e guardrails)

#### 3.1 Política de RAM (módulo único)
- Arquivo: `conveniente/scripts/ramPolicy.js`
- O que entrega:
  - `calcNodesByTotalMemMB()` (heurística: 1 node a cada 16GB).
  - `calcReserveNormalMB()` = base + nodes*1024.
  - `calcReserveProvisionMB()` = base + spike (default 1536MB).
  - `snapshotPolicy()` para auditoria e debug.
- Configuração por env:
  - `HOST_BASE_MB` (default 2048)
  - `PROVISION_SPIKE_MB` (default 1536)

#### 3.2 Lock global de provisão
- Arquivo: `conveniente/scripts/provisionLock.js`
- Detalhes:
  - TTL padrão “seguro” (min 10s), gravação atômica.
  - `shouldBlock(operator)` implementa a regra “somente owner passa”.

#### 3.3 Rebalance sticky / mínimo impacto (fix do shard_moved storm)
- Arquivo: `conveniente/scripts/clusterMaster.js`
- Mudança essencial:
  - O rebalance **não movimenta** perfis existentes entre workers.
  - Remove perfis deletados e atribui **apenas perfis novos** ao worker com menor shard.
- Efeito: elimina deactivations massivas com `reason: shard_moved`.

#### 3.4 Telemetria agregada e debug de nodes
- Arquivos:
  - `conveniente/scripts/worker.js`: `get-status` inclui `controllersCount`, `pid`, `shardSize` em `_debug`.
  - `conveniente/scripts/clusterMaster.js`: agrega `_debug.nodes[]` e preserva fallback via `status_node_*.json`.
- Motivação: diagnosticar rapidamente “dashboard cego” vs “controllers vivos”.

#### 3.5 Guardrail de `close_all`
- Arquivo: `conveniente/scripts/dashboard.js`
- Regra:
  - Se `provision_lock` ativo:
    - `close_all` humano (UI) é **deferido**.
    - `close_all` não-humano (deploy/script) é **bloqueado**.

#### 3.6 `login_remediate` (core) + evidência visual + fail-fast
- Arquivo: `conveniente/scripts/worker.js`
- Implementação:
  - Tentativa 1: reinjetar cookies.
  - Se necessário e automatizável: tentativa 2 com login/senha (quando `login_form`).
  - Se detectar estado não automatizável (`captcha_persona`, checkpoint, identidade): **fail-fast** para humano.
- Evidência:
  - Arquivo: `conveniente/dados/login_remediate_evidence.jsonl` (captura screenshot base64 + HTML snippet).
  - Arquivo: `conveniente/scripts/browser.js` contém `ensureFbUiUnblocked` e detecções robustas.
- Timeouts:
  - Timeout global e por stage para não travar.
  - “deactivate” do fail-fast com timeout duro (anti-hang).

#### 3.7 Pós-sucesso determinístico (login_remediate)
- Arquivo: `conveniente/scripts/worker.js`
- Regra:
  - Atualiza `desired` (active=true, virtus=on, humanHold=false).
  - Fecha browser temporário pós-config.
  - Faz “nudge” de reopen.
  - Tenta `activateOnce` com retries curtos; se não conseguir, marca passo `post_success_deferred_to_nurse` e deixa o nurse completar, sem loop infinito e sem falso start.

#### 3.8 Correção do “worker paralelo” (causa do dashboard cego)
- Problema: `conveniente/scripts/dashboard.js` executava `login_remediate` via `workerClient.js` (spawn de outro `worker.js` fora do cluster).
- Correção:
  - `dashboard.js` agora chama endpoint local `POST /api/perfis/:nome/login-remediate`, que por sua vez usa o **workerClient do cluster** (injetado por `index.js`).
  - Arquivos envolvidos:
    - `conveniente/scripts/api_perfis.js` (novo endpoint)
    - `conveniente/scripts/dashboard.js` (routing)
- Resultado: browser aberto passa a ser gerenciado pelo mesmo caminho que alimenta `/api/status`, e o dashboard volta a refletir `active/trabalhando` corretamente.

---

### 4) Implementações em `sitechatbot` (fila de comandos + estoque)

#### 4.1 GC enterprise de comandos pendurados (anti “carregando infinito”)
- Arquivo: `sitechatbot/index.js`
- Implementações:
  - Lock da fila (`commands.json`) com detecção de stale lock (Windows EPERM/EBUSY hardening).
  - GC para `close_all` e `login_remediate` quando não há ACK (`stale_no_ack` / `timeout_no_ack`).
  - Em GC, também grava evento `ack` com `source:"gc"` para encerrar UI/scripts.
  - Intervalo padrão de prune: `CT_COMMANDS_PRUNE_INTERVAL_MS` (default 30s).

#### 4.2 Auditoria de ACK detalhado
- Arquivo: `sitechatbot/index.js`
- O ACK (quando `details` existe) é persistido em `dados/logs/<hostId>/ack_<cmdId>.json`.
- Isso fornece evidência “alta resolução” para:
  - `stock_provision`
  - `close_all`
  - `login_remediate`

#### 4.3 Endpoint de credenciais para fallback (CT → conveniente)
- Arquivo: `sitechatbot/index.js`
- Endpoint: `POST /api/stock/profile_credentials_secret`
- Segurança: exige `X-Log-Secret` (LOG_INGEST_SECRET) ou requisição local.
- Fonte: `ctFbStock.getServerProfileCredentials()` (join server profile ↔ stock account).

#### 4.4 “Excluídas” (UI + backend) — excluir/restaurar em massa e delete permanente
- Front: `sitechatbot/convenientetecnologia/public/estoque.html`
  - Botões: “Excluir permanente” (por conta), “Restaurar tudo”, “Excluir tudo”.
  - Confirmação via modal (não `confirm()` do navegador).
- Backend: `sitechatbot/index.js` + `sitechatbot/convenientetecnologia/lib/ctFbStock.js`
  - Endpoints:
    - `POST /api/stock/archived/unarchive_all`
    - `POST /api/stock/archived/purge_all`
    - `DELETE /api/stock/accounts/:id/purge`
  - Guardrails:
    - só permite purge se conta estiver `archived` e não estiver atribuída a host.

---

### 5) Evidências e testes executados (com resultados)

#### 5.1 Prova de versão no host
- `fetch_logs` allowlist inclui `git_head` e `git_main_ref`.
- Exemplo prático (RM1):
  - `git_main_ref` retornou SHA: `9c2afa36e3cedc3b8354e5acd09466e795be8a51`

#### 5.2 Teste: `login_remediate` sucesso (porto_alegre-1769044966103)
- Evidência:
  - `ack_<cmdId>.json` mostrou execução completa e `success=true`.
  - Snapshot posterior mostrou `activeCount>0`, perfil alvo `active=true` e `trabalhando=true`.
- Observação enterprise:
  - Elimina “dashboard cego” ao rodar via cluster (fix aplicado).

#### 5.3 Teste: `login_remediate` fail-fast (curitiba-1768243899180)
- Resultado: `ok=false`, `error="login_requires_human"`.
- Motivo objetivo: `captcha_persona` detectado (não automatizável).
- Estado final correto:
  - `humanHold=true`
  - `loginRequired=true`
  - `loginSource="login_remediate"`
  - browser fechado (mínimo impacto)

---

### 6) Segurança e governança (auditável)

#### 6.1 Segredos e canais
- `sitechatbot`:
  - `LOG_INGEST_SECRET` protege ingest de logs e endpoints `*_secret`.
- `conveniente`:
  - `fetch_logs` allowlist limita arquivos retornáveis.
  - `provision_lock` evita concorrência perigosa.

#### 6.2 Anti travamento / timeouts
- `login_remediate` tem:
  - timeouts por etapa
  - deadline global
  - GC no `sitechatbot` caso ACK não chegue (evita UI “carregando infinito”).

---

### 7) Itens verificados como **PENDENTES** / riscos conhecidos (sem maquiagem)

#### 7.1 “Manual Injetar Cookies” com modal progressivo e handshake de fechamento
- Pedido: quando humano clicar “injetar cookies”, ter o mesmo pipeline de pause/check RAM/close mínimo + modal progressivo e “complete quando humano fechar o browser”.
- **Status**: **PENDENTE** (não foi encontrado endpoint `configure/finish` e não há modal progressivo no `conveniente` para esse fluxo).
- Risco: operador humano pode iniciar configure manual e o sistema não ter “fim” transacional claro além do timeout/return.

#### 7.2 Logs persistentes do `conveniente` (logger.log)
- `conveniente/scripts/logger.js` escreve em arquivo **somente se** `LOG_TO_FILE` estiver setado.
- **Status**: comportamento atual é aceitável, mas para 24/7/365 enterprise recomenda-se ativar `LOG_TO_FILE=1` nos hosts críticos.

#### 7.3 `issues` via fetch_logs
- `fetch_logs` allowlist expõe `issues_fallback`, não `issues` direto.
- **Status**: por design (segurança/allowlist). Se precisarmos de `issues.jsonl` por perfil, criar chave allowlist específica e controlada.

#### 7.4 Notificador
- Não houve mudanças críticas auditadas aqui neste ciclo (foco foi estoque/provisão/browser automation).

---

### 8) Checklist final (110% enterprise)

#### 8.1 Provisionamento
- [x] RAM policy centralizada (`ramPolicy.js`)
- [x] Lock global com TTL (`provisionLock.js`)
- [x] Rebalance sticky (sem storm)
- [x] Guardrail de `close_all` durante provisão
- [x] Auditoria (`provision_audit.jsonl` + ACK detalhado no CT)

#### 8.2 Login remediation
- [x] Tentativa cookies + validação real
- [x] Detecção de estados não automatizáveis (captcha/checkpoint/identity)
- [x] Fail-fast para humano com `humanHold=true`
- [x] Evidência visual (`login_remediate_evidence.jsonl`)
- [x] Pós-sucesso determinístico (desired+nudge+retry curto; fallback nurse)
- [x] GC de comandos pendurados (CT)
- [x] Fix do “worker paralelo” (dashboard consistente)

#### 8.3 Estoque UI
- [x] Excluídas: excluir permanente por conta
- [x] Excluídas: restaurar tudo / excluir tudo (com modal)

---

### 9) Próximos passos recomendados (para fechar 110% sem brechas)

1) Implementar **flow manual de configure** com:
   - modal progressivo (opsState),
   - `configure/finish` explícito,
   - detecção do “browser fechado” para liberar lock e reabrir perfis fechados por RAM.
2) Opcional: habilitar `LOG_TO_FILE=1` nos hosts críticos e incluir `logger` no `fetch_logs` (já allowlisted).
3) Padronizar e documentar variáveis de ambiente “de produção” em um único lugar (runbook).

