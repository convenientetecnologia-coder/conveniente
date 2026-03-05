### Checkup — Dossiê pré-código blindagem total RM7 (Chromium canário)

- **Data**: 2026-03-05
- **Projeto**: `conveniente`
- **INC base**: `INC-20260305-1815-01`
- **Escopo**: auditoria e desenho técnico antes de codar blindagem/forense

---

## 1) Decisões fechadas

1. RM7 é o canário oficial de blindagem.
2. Engine congelada no canário: Chromium (sem zigue-zague).
3. Demais hosts não entram nessa mudança até aprovação.
4. Meta operacional: RM7 lotado por 24h com no máximo 2 quedas.

---

## 2) Sintoma e risco operacional

- Queda diária acima do tolerável (ex.: 6 quedas/dia reportadas no RM7 em janela recente).
- Impacto direto em custo operacional e reposição de contas.
- Evidência de instabilidade de abertura em episódios recentes (stuck parcial e flapping no open-all).

Risco principal:
- sem telemetria forense completa, o time corrige no escuro e repete ciclo de regressão.

---

## 3) Achados técnicos já conhecidos

### 3.1 Estabilidade runtime

- Houveram eventos de abertura parcial (`active` menor que `desired_active`).
- Lock/open-all com progresso intermitente e denials em perfis específicos.
- Parte dos hardenings já melhorou convergência, porém ainda não há garantia contínua.

### 3.2 Lacuna de observabilidade

- Falta timeline por perfil pronta para investigação de queda em janela curta.
- Falta taxonomia única de causa de falha.
- Falta correlação automática entre queda observada e eventos técnicos das horas anteriores.

---

## 4) Matriz de blindagem (implemented / partial / missing)

### Eixo A — Fingerprint e identidade técnica por perfil

- `implemented`:
  - base de presets UA/fp por perfil;
  - aplicação de parâmetros de perfil no runtime.
- `partial`:
  - confirmação forense contínua da consistência aplicada por sessão.
- `missing`:
  - trilha pronta para responder “o que estava aplicado exatamente nesta conta antes de cair”.

### Eixo B — Coerência geo/rede

- `implemented`:
  - estrutura de geolocalização/timezone no fluxo.
- `partial`:
  - validação de coerência em runtime.
- `missing`:
  - relatório automático de incoerência por perfil/host.

### Eixo C — Convergência operacional

- `implemented`:
  - nurse/open-all com diversos guardrails e retries.
- `partial`:
  - proteção contra stuck por tentativa longa; limpeza de estados órfãos.
- `missing`:
  - SLO formal de convergência + alarmes por desvio.

### Eixo D — Forense de queda

- `implemented`:
  - logs estruturados em múltiplos pontos (`provision_audit` e estados).
- `partial`:
  - cobertura de eventos sem taxonomia única.
- `missing`:
  - endpoint/consulta padronizada para timeline de queda por perfil.

---

## 5) Plano de implementação (sem execução neste checkup)

### F0 — Contrato forense (baixo risco)

- Definir schema de evento canônico para investigação:
  - `ts`, `hostId`, `profile`, `event`, `flowId`, `cause`, `decision`, `meta`.
- Normalizar nomenclatura de causas e decisões.

### F1 — Instrumentação P3 (olhos de deus)

- Cobrir pontos de decisão crítica:
  - pre-launch, launch, post-launch, fail-launch,
  - lock decision, bypass, timeout,
  - mudanças de flags de conta e transições de trabalho.
- Garantir cadeia de causalidade por `flowId`.

### F2 — Endpoints de diagnóstico

- Consulta por perfil e janela:
  - timeline cronológica,
  - causas mais frequentes,
  - últimos sinais antes da queda.

### F3 — Guardrails de redução de queda

- Respostas graduais por risco:
  - cooldown adaptativo por perfil,
  - bloqueio de ações sensíveis em sessão inconsistente,
  - desaceleração automática sob risco alto.

### F4 — Validação canário RM7

- T+2h: convergência técnica.
- T+24h: meta de queda.
- T+48h: ajuste fino e revalidação.

---

## 6) Critérios de aceite da blindagem RM7

1) Open-all convergente sem travamento recorrente.
2) Timeline forense completa por perfil.
3) RM7 lotado com <=2 quedas em 24h.

---

## 7) Rollback e segurança operacional

- Mudança sempre em lote pequeno e reversível.
- Em regressão:
  - `git revert`,
  - `self_update`,
  - restart humano (`node index.js`) no RM7.
- Nenhuma expansão para outros hosts sem aprovação pós-canário.

---

## 8) Resultado deste checkup

- Dossiê pré-código aprovado para iniciar codificação faseada no RM7 com foco:
  - estabilidade determinística,
  - forense total,
  - redução real de quedas com métrica objetiva.

---

## 9) Auditoria ponta a ponta (zero achismo)

### 9.1 Fluxo técnico auditado

1) CT enfileira comando -> `sitechatbot` (`commands.json` / `commands.log`)  
2) `conveniente` consome comando em `scripts/dashboard.js` (`applyCommands`)  
3) API local dispara ação (`scripts/api_perfis.js`)  
4) `worker.js` (`nurseTick` / `activateOnce`) decide abrir/fechar/reconciliar  
5) `browser.js` executa launch e patch de página  
6) ACK retorna ao CT com evidência (`dados/logs/<hostId>/ack_<cmdId>.json`)

### 9.2 Fontes de verdade auditadas

- Host `conveniente`:
  - `dados/desired.json`
  - `dados/status.json` e `dados/status_node_1.json`
  - `dados/provision_audit.jsonl`
  - `dados/issues_fallback.log`
  - `dados/perfis.json`
  - manifests por perfil (via `scripts/manifestStore.js`)
- CT `sitechatbot`:
  - `dados/commands.json`
  - `dados/commands.log`
  - `dados/logs/<hostId>/ack_<cmdId>.json`
  - ingest de `fetch_logs` / `logs_manifest`
  - domínio de estoque em SQLite (`ctFbStock.js`)

### 9.3 Riscos reais encontrados (priorização)

#### P0

- lock global por arquivo sem semântica transacional forte (risco de corrida entre owners);
- preempção de lock em `close_all` com potencial de interromper fluxo legítimo;
- episódios de parada parcial em open-all já observados no RM7 (evidência operacional).

#### P1

- reclaim/timeout de slot pode desalinhar sob abertura lenta;
- uso de estado em memória para parte de decisões de finalização parcial;
- cadeia de lock por perfil sem watchdog explícito por operação longa.

#### P2

- estado diferido de controle volátil em memória do dashboard em cenários de restart;
- cobertura de observabilidade desigual entre componentes.

### 9.4 Blindagem técnica do navegador (estado atual)

#### Implementado

- stealth base;
- aplicação de UA/UA-CH;
- patches anti-automação em JS;
- geolocalização por cidade;
- `userDataDir` por perfil e persistência robusta.

#### Gaps críticos

- coerência UA/UA-CH x versão real do binário;
- viewport/DPR nem sempre efetivos como identidade coerente fim-a-fim;
- ausência de política explícita de superfície WebRTC/DNS;
- validação forense de coerência não consolidada por sessão.

### 9.5 Lacunas forenses que impedem laudo causal rápido

- não existe timeline canônica por perfil com join automático entre:
  - `provision_audit`,
  - `issues`,
  - `status/desired`,
  - comandos/ACK do CT.
- falta taxonomia única de causa para investigação de queda;
- falta endpoint de diagnóstico por perfil/intervalo.

---

## 10) Backlog técnico pré-código (congelado para execução)

### B1 — Contrato canônico de evento

- normalizar evento com campos obrigatórios:
  - `tsEvent`, `hostId`, `profileName`, `eventType`, `cause`, `decision`, `traceId`, `commandId/requestId`, `meta`.

### B2 — Timeline por perfil no CT

- consulta por `hostId + profileName + janela`;
- join de runtime + control-plane + forense.

### B3 — Gate de coerência de identidade técnica

- validar antes de ativar:
  - UA/UA-CH,
  - viewport/DPR,
  - lang/tz/geo,
  - sinais de superfície de rede.

### B4 — Guardrails de convergência

- watchdog por operação de abertura no nurse;
- detecção de lock/contention e stuck com telemetria explícita;
- finalização de open-all sempre com razão auditável.

---

## 11) Resultado final da auditoria

- Auditoria ponta a ponta concluída com mapa de riscos e backlog técnico fechado.
- Sistema está pronto para iniciar codificação faseada no RM7, mantendo:
  - engine congelada no canário,
  - rollout controlado,
  - validação por evidência objetiva.

---

## 12) Execução inicial concluída (Lote 1)

Status: **executado e validado localmente**

- `scripts/worker.js`
  - introduzido evento canônico forense com `traceId` e metadados de decisão;
  - instrumentação do caminho de abertura do nurse (begin/end/success/ram_denied).

- `scripts/api_status.js`
  - endpoint `GET /api/perfis/:nome/forensics` para consulta rápida de timeline por perfil.

Validação:
- parse de sintaxe dos arquivos alterados em Node OK;
- lint sem erros nos arquivos alterados.

---

## 13) Execução incremental (Lote 2)

Status: **executado e validado localmente**

- `scripts/worker.js`
  - criado dossiê automático por queda em `dados/fall_forensics.jsonl`;
  - adicionado detector de padrão flapping em falhas repetidas de abertura;
  - snapshots automáticos em eventos de `nurse_open_failed`, `nurse_open_flapping_suspected`, `login_required_detected` e `banned_detected_predelete`.

- `scripts/api_status.js`
  - endpoint forense por perfil enriquecido com:
    - `fallSnapshots`,
    - `causeSummary`,
    - `fallCauseSummary`.

Impacto esperado:
- transformar “abre/fecha rápido e não sei por quê” em causa rastreável por timeline e classe de falha.
