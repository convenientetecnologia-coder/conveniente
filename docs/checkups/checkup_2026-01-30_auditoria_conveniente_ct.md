### Checkup — Auditoria estrutural `conveniente` + CT (2026-01-30)

> Regra: este arquivo é um **relatório**. O resumo (1–3 linhas) vai para `docs/TIMELINE.md`.

#### Contexto

- Data: 2026-01-30
- Ambiente: prod (análise documental, sem coleta runtime nesta rodada)
- Hosts envolvidos (hostId/hostname): n/a
- Sintoma: complexidade crescente, “engessamento” e acoplamento entre partes do sistema
- Impacto: risco de regressão em mudanças pequenas; dificuldade de debugar fluxo ponta a ponta

---

### Evidências coletadas (objetivas)

- Arquivos (conveniente):
  - `C:\conveniente\index.js` (boot, cluster, startDashboardMonitor)
  - `C:\conveniente\scripts\dashboard.js` (telemetria/report/commands)
  - `C:\conveniente\scripts\supervisor.js` (governador/permissoes/cooldowns)
  - `C:\conveniente\scripts\worker.js` (core Virtus/Robe, status, governança, filas)
  - `C:\conveniente\scripts\api_status.js` (shape militar do `/api/status`)
  - `C:\conveniente\scripts\api_perfis.js` (endpoints de perfil, provision, maintenance)
  - `C:\conveniente\scripts\ctConfig.js` + `notifierEndpoints.js` (origem CT base)
  - `C:\conveniente\scripts\fileStore.js` (locks e escrita de `desired/perfis`)
- Arquivos (CT/sitechatbot):
  - `C:\sitechatbot\index.js` (`/report`, `commands/*`, `logs/ingest`, `notifier/*`)
- Docs:
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
  - `C:\conveniente\docs\checkup_geral_2026-01-29.md`
  - `C:\conveniente\docs\ultra_enterprise_system_audit_2026-01-24.md`

---

### Mapa do sistema (norte técnico)

#### 1) Boot e runtime local
- Entry: `C:\conveniente\index.js`
  - Express + UI estática (`/public`)
  - Cluster multi-node (`scripts/clusterMaster.js`)
  - Start da telemetria (`startDashboardMonitor` em `scripts/dashboard.js`)

#### 2) Execução core (Virtus/Robe/fluxos)
- Worker central: `C:\conveniente\scripts\worker.js`
  - Virtus, Robe, governança, provisão, status e evidências (JSONL)
  - Alto acoplamento funcional: múltiplos fluxos críticos no mesmo arquivo

#### 3) Governança/Orquestração de slots
- `C:\conveniente\scripts\supervisor.js`
  - Permits por tipo (login/identity)
  - Controle de RAM/slots, TTLs, cooldowns
  - Stream de eventos em memória (`eventStream`)

#### 4) Telemetria e CT (report + comandos)
- Envio de report: `scripts/dashboard.js` → CT `/report`
  - Base do CT vem de `CT_BASE_URL`/`CT_URL` ou `dados/ct_config.json`
  - Fallback hardcoded para ngrok em `scripts/notifierEndpoints.js`
- CT recebe e persiste: `C:\sitechatbot\index.js` `handleReport(...)`
  - Grava snapshot por `hostId`
  - Atualiza estoque (server_profiles), com guardrails anti “mass delete”
- CT comandos/ACK:
  - `POST /api/commands/enqueue(_secret)`
  - `POST /api/commands/ack`
  - Evidência por `ack_<cmdId>.json`

#### 5) Estado e arquivos críticos
- `C:\conveniente\dados\`:
  - `perfis.json`, `desired.json`, `status.json`
  - `provision_audit.jsonl`, `login_remediate_evidence.jsonl`, `issues.jsonl` etc.
- Locks e consistência via `scripts/fileStore.js`

---

### Achados (P0/P1/P2)

- **P0**:
  - Nenhum P0 confirmado **nesta rodada** (sem evidência runtime).

- **P1**:
  1) **Múltiplas fontes de status podem divergir**  
     - Evidência: `/api/status` monta baseline de `perfis.json` e overlay de worker (`scripts/api_status.js`), enquanto a telemetria do CT pode cair no fallback de `status_node_*.json` (`scripts/dashboard.js`).  
     - Risco: diagnóstico inconsistente (“trabalhando 0” no CT vs UI local).
  2) **Dependência crítica de configuração do CT**  
     - Evidência: `scripts/notifierEndpoints.js` usa fallback hardcoded de ngrok se `CT_BASE_URL`/`ct_config.json` ausentes.  
     - Risco: envio de report para endpoint inválido (telemetria “morta”).
  3) **Acoplamento forte CT⇄estoque dentro do `/report`**  
     - Evidência: `sitechatbot/index.js` `handleReport(...)` realiza reconciliação/arquivamento/queue de delete no mesmo fluxo de ingest.  
     - Risco: falhas parciais no report afetam estoque/estado operacional.
  4) **Estado crítico em arquivos JSON com concorrência**  
     - Evidência: `perfis.json`/`desired.json` e locks em `scripts/fileStore.js`.  
     - Risco: lock contention e inconsistência em fluxos concorrentes (ex.: provision, open/close, governança).

- **P2**:
  1) **Monolito funcional no `worker.js`**  
     - Evidência: `scripts/worker.js` concentra Virtus, Robe, governança, CT archive, status, etc.  
     - Risco: manutenção difícil e risco de regressões em mudanças pontuais.
  2) **Observabilidade fragmentada**  
     - Evidência: múltiplos JSONL (`provision_audit`, `login_remediate_evidence`, `issues`, `governor_snapshots`) sem índice único.  
     - Risco: investigação lenta; dependência de conhecimento tácito.
  3) **Config distribuída (env + ct_config + fallback)**  
     - Evidência: `scripts/ctConfig.js` + `scripts/notifierEndpoints.js`.  
     - Risco: comportamento diferente por host sem visibilidade rápida.

---

### Decisão / Ação recomendada (cirúrgica)

- O que mudar: **neste checkup não há mudança de código**.  
- Por quê: o pedido foi **auditoria estrutural**; a próxima etapa deve ser priorização com evidência runtime por item.
- Risco: nenhuma ação imediata, mas **não resolve o engessamento** sem priorização.
- Rollback: n/a (somente relatório).

---

### Plano de rollout

- Reinícios necessários (quais processos/nodes): nenhum (documental).
- Ordem: n/a
- Validação pós-rollout (checks): n/a

---

### Plano de desengessamento (proposto, sem mudanças ainda)

1) **Contrato de status unificado**  
   - Criar spec do shape do `/api/status` e do snapshot CT (campos mínimos + fonte de verdade).
2) **Camada de integração CT isolada**  
   - Extrair o que é “telemetria + commands” para módulo único dentro do `conveniente` (ex.: `ctClient.js`), reduzindo acoplamento em `dashboard.js`.
3) **Separar domínios no worker**  
   - Quebrar `worker.js` por domínio (virtus / robe / provision / governance) e expor interfaces bem definidas.
4) **Mapa operacional com evidências**  
   - Criar “mapa de logs” (key → objetivo) para acelerar RCA sem adivinhar path.
5) **Priorizar por risco real (P0/P1)**  
   - Cada item deve virar INC com evidência runtime (logs/ACK).

