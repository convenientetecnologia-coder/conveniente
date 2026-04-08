## Checkup — Matriz Função a Função (Olhos de Deus)
### Robe Daily Plan V1 (gate de elegibilidade + pills no dashboard)

- **Data**: 2026-04-08
- **Projeto**: `conveniente`
- **Modo**: pré‑código (auditoria total, sem alteração de runtime)
- **Princípio**: **não mexer na execução interna do Robe**; apenas gate de elegibilidade + visibilidade operacional.

---

## 1) Escopo exato (o que entra e o que não entra)

### Entra (superfície de mudança)

- `C:\conveniente\scripts\worker.js` (gate no `robeTickGlobal` + cálculo/plano diário por conta)
- `C:\conveniente\scripts\api_status.js` (expor resumo do plano para o front)
- `C:\conveniente\public\index.html` (pills de plano diário por conta)
- `C:\conveniente\scripts\manifestStore.js` (persistência já existente; usar `read/update`)

### Não entra (V1)

- `C:\conveniente\scripts\robe.js`
- `C:\conveniente\scripts\robeQueue.js`
- Fluxo interno de execução do ciclo (start/stop virtus, módulo de postagem, cooldown 15–30)

---

## 2) Contrato funcional aprovado (V1)

1) **Gate só na elegibilidade**  
2) **Plano determinístico por perfil+data** (restart não muda o dia)  
3) **Renovação diária** (padrão muda a cada dia)  
4) **25% OFF por dia**  
5) Das contas ON: **60% em 6–12h** e **40% em extremos (1–6 / 12–14)**  
6) **Ativação global + rollback**

---

## 3) Fluxo ponta‑a‑ponta (call graph operacional)

1. `public/index.html` chama `GET /api/status`  
2. `api_status.js` monta payload (`perfis`, `robes`, `robeQueue`)  
3. `public/index.html` (`reloadPerfis` -> `buildList`) renderiza pills por conta  
4. Em paralelo, `worker.js` roda `robeTickGlobal` em intervalo fixo  
5. `robeTickGlobal` seleciona `prontos` e enfileira no `robeQueue`  
6. V1 entra aqui: antes de considerar `prontos`, aplicar `isRobeWindowOpenNow(...)`

---

## 4) Matriz função‑a‑função (com responsabilidade e ponto de mudança)

### 4.1 `worker.js` (runtime Robe)

#### `loadPerfisJson()`
- **Responsabilidade atual**: carregar perfis (com filtro por shard, se aplicável).
- **Mudança V1**: nenhuma.
- **Risco**: baixo.

#### `normalizeCooldown(nome)`
- **Responsabilidade atual**: reconciliar `robeCooldownUntil` vs `robeCooldownRemainingMs`.
- **Mudança V1**: nenhuma (continua igual).
- **Risco**: médio se alterado (não alterar no V1).

#### `freezeCooldownIfNotWorking(nome)` / `unfreezeCooldownIfWorking(nome)`
- **Responsabilidade atual**: congelar/retomar contagem de cooldown conforme estado de trabalho.
- **Mudança V1**: nenhuma.
- **Risco**: alto se alterado; manter intacto.

#### `startRobeDynamic(browser, nome, robePauseMs, workingNow)`
- **Responsabilidade atual**: valida manifesto e delega ao módulo de Robe.
- **Mudança V1**: nenhuma.
- **Risco**: alto se alterado; manter intacto.

#### `robeTickGlobal()`
- **Responsabilidade atual**:
  - respeita `provisionLock`, slowmode/throttle,
  - calcula lista `prontos`,
  - enfileira em `robeQueue`,
  - executa ciclo e loga eventos.
- **Mudança V1 (único ponto runtime)**:
  - adicionar gate de elegibilidade:
    - `if (!isRobeWindowOpenNow(nome, now)) return null;`
  - sem alterar ordem/fila/ciclo/cooldown.
- **Risco**: médio (impacto em volume).
- **Mitigação**: feature flag + logs de gate + rollout canário.

#### `snapshotStatusAndWrite()`
- **Responsabilidade atual**:
  - monta snapshot por perfil com estado operacional,
  - preenche campos usados pelo dashboard.
- **Mudança V1**:
  - anexar resumo leve do plano por conta (ex.: `robeDailyPlanSummary`).
- **Risco**: baixo/médio (shape de status).
- **Mitigação**: adicionar campo opcional sem quebrar campos existentes.

---

### 4.2 Persistência (`manifestStore.js`)

#### `read(nome)` / `update(nome, patchFn)`
- **Responsabilidade atual**: leitura/escrita atômica lockada do `manifest.json`.
- **Mudança V1**:
  - persistir `manifest.robeDailyPlanV1`.
- **Risco**: baixo (módulo já é robusto para update atômico).
- **Regra rígida**: não gravar manifest fora desse módulo.

---

### 4.3 API (`api_status.js`)

#### `app.get('/api/status', ...)`
- **Responsabilidade atual**: endpoint canônico de status.
- **Mudança V1**: manter endpoint; apenas incluir resumo de plano no payload final.

#### `montarPayloadCompleto(rawStatus, erroMsg, warning)`
- **Responsabilidade atual**: construir shape completo (`perfis`, `robes`, `robeQueue`, etc.).
- **Mudança V1**:
  - incluir `robeDailyPlanSummary` por perfil (campo opcional).

#### `overlayFields(base, overlay)`
- **Responsabilidade atual**: merge de overlay em baseline.
- **Mudança V1**: nenhuma (só garantir que novo campo passe no merge).

---

### 4.4 UI (`public/index.html`)

#### `reloadPerfis()`
- **Responsabilidade atual**: busca status e atualiza caches.
- **Mudança V1**: nenhuma estrutural.

#### `buildList(perfisInput, robes, robeQueue)`
- **Responsabilidade atual**: render dos cards e pills por conta.
- **Mudança V1**:
  - incluir pills do plano diário por conta:
    - `Robe hoje: OFF`
    - `Robe hoje: Xh (Y blocos)`
    - `Robe: dentro do bloco` / `Robe: fora do bloco`
  - tooltip com blocos horários.

#### `buildPill(...)`, `buildCooldownPill(...)`, `buildRobeEstadoPill(...)`
- **Responsabilidade atual**: render visual das pills.
- **Mudança V1**: reaproveitar utilitários; sem mudança de contrato.

#### `classifyAccountFinal(...)`
- **Responsabilidade atual**: estado final operacional (login/captcha/banned/etc).
- **Mudança V1**: nenhuma (evitar misturar classificação com plano diário).

---

## 5) Contrato de dados V1 (novo)

### 5.1 Persistido no manifest (por conta)

`manifest.robeDailyPlanV1`:
- `date`: `YYYY-MM-DD`
- `enabled`: boolean
- `dailyHours`: number (1..14 quando enabled)
- `blocks`: array `{ startMin, endMin }`
- `seed`: string

### 5.2 Exposto no `/api/status` (por perfil)

`perfis[].robeDailyPlanSummary` (opcional):
- `date`
- `enabled`
- `dailyHours`
- `blocksCount`
- `blocks` (opcional compactado)
- `inWindowNow`
- `nextWindowStartMin` (se fora de bloco)

---

## 6) Telemetria “olhos de deus” (sem spam)

Logs em `provision_audit` (rate-limited):
- `robe_plan_generated` (1x por conta/dia)
- `robe_plan_loaded` (quando já existe para a data)
- `robe_gate_closed` (amostrado)
- `robe_gate_open` (amostrado)
- `robe_plan_day_rollover` (quando vira o dia)

Regras anti-spam:
- emit no máximo 1 evento “open/closed” por conta a cada N minutos (ex.: 10 min).

---

## 7) Invariantes anti-regressão (não negociáveis)

1) Não alterar ciclo interno de execução do Robe.  
2) Não alterar `robeQueue` nem módulo `robe.js`.  
3) Não alterar semântica de `humanControl/humanHold`.  
4) Não alterar reconciliação de cooldown atual.  
5) Novo campo no status deve ser opcional (backward compatible).  

---

## 8) Cenários críticos e comportamento esperado

### Restart no meio do dia
- Esperado: plano do dia não muda (determinístico + persistido).

### Virada de dia
- Esperado: novo plano para cada conta (muda padrão do dia).

### Conta em `humanControl`
- Esperado: continua fora da execução normal do Robe como já é hoje; plano diário não força nada.

### Provision lock ativo
- Esperado: `robeTickGlobal` segue respeitando lock (gate diário não muda isso).

---

## 9) Rollout/rollback (operacional)

- Ativação:
  - **sempre ON** no código (sem feature-flag).
- Rollout:
  - por update/restart dos hosts (entra no runtime quando subir código novo).
- Rollback:
  - revert commit
  - restart `node index.js`

---

## 10) Evidência de arquivos/funções auditadas nesta rodada

- `C:\conveniente\scripts\worker.js`
  - `loadPerfisJson`, `normalizeCooldown`, `startRobeDynamic`, `robeTickGlobal`, `snapshotStatusAndWrite`
- `C:\conveniente\scripts\manifestStore.js`
  - `read`, `update`
- `C:\conveniente\scripts\api_status.js`
  - `app.get('/api/status')`, `montarPayloadCompleto`, `overlayFields`
- `C:\conveniente\public\index.html`
  - `reloadPerfis`, `buildList`, `buildPill`, `buildCooldownPill`, `buildRobeEstadoPill`, `classifyAccountFinal`
- `C:\conveniente\index.js`
  - wiring de servidor/API/static (confirmação de fronteira de responsabilidade)

