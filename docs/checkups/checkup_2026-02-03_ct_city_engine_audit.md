### Checkup — CT City Engine (Migrações + Cadastro) — 2026-02-03

Escopo: auditar e “bater” (com evidência) o que foi aprovado no dossiê `INC-20260202-1600-01` versus o que está implementado no runtime do CT (`sitechatbot/index.js`) para:
- **Motor 1 (Migração)**: sugestões **manuais** (CT sugere, humano executa).
- **Motor 2 (Cadastro/Provisão)**: escolha automática de `cidade_uf` para `stock_provision` (anti‑pânico + pipeline).

> Regra: sem achismo. Tudo aqui aponta para arquivos/paths e campos auditáveis no payload/DB.

---

## 1) Contratos aprovados (fonte canônica)

- **Dossiê/INC**: `C:\conveniente\docs\inbox\in_progress\INC-20260202-1600-01.md`
  - Migração V3 “corajosa”: doador insight alto → receptor insight baixo, com pareamento preferindo doador mais quente (donorBonus) e `canDrainToZero` somente se `donorInsight >= 2 * avgInsight`.
  - Cadastro: prioridade por insight baixo, amortecida por supply futuro (LE + pipeline de provisões recentes), evitando “pânico” e evitando cidades quentes.
- **Reports de simulação (evidência)**:
  - V3 migração (pareamento corajoso): `C:\sitechatbot\dados\_reports\sim_city_plan_fretes_2026-02-02T23-05-45-725Z.json`

---

## 2) Implementação atual (runtime CT)

### 2.1 Migração (manual) — endpoint

- **Endpoint**: `GET /api/contas-facebook-v2`
- **Arquivo**: `C:\sitechatbot\index.js`
- **Onde (bloco migrações)**: dentro de `/api/contas-facebook-v2`, seção `// ===== Migrações (V3 corajoso) ... =====`.

**Regras implementadas (precisas):**
- **Doador**:
  - `insight_percent > avgInsight`
  - `loginRequired == 0` (não doar de grupo instável)
  - `A_real >= 1`
  - `minAfter = (canDrainToZero ? 0 : CT_MIG_A_MIN)`
  - `canDrainToZero = donorInsight >= CT_MIG_DONOR_DRAIN_FACTOR * avgInsight`
- **Receptor**:
  - `insight_percent < avgInsight`
  - sem `snooze`
  - `loginRequired == 0` (primeiro logar)
  - prioridade para `A_real == 0`
- **Pareamento V3 “corajoso”**:
  - `scorePair = receiverNeed + (CT_MIG_DONOR_BONUS * donorCost) - (CT_MIG_ALPHA * donorCost)`
  - onde `donorCost = donorInsight - avgInsight`

**Correção P0 aplicada hoje**:
- `insight_percent` agora usa **janela `recent3d`** (mesma do Virtus/Grupos), via `sent_recent3d`, em vez de `sent_24h`.
- Isso elimina a divergência UI vs decisão (o que fazia a sugestão “parecer burra”).

**Knobs (env) e defaults**:
- `CT_MIG_ALPHA` default `0`
- `CT_MIG_DONOR_BONUS` default `0.35`
- `CT_MIG_A_MIN` default `1`
- `CT_MIG_DONOR_DRAIN_FACTOR` default `2`

**Auditoria (payload)**
- Cada migração inclui `why` com:
  - `avgInsight`, `donorInsight`, `receiverInsight`, `receiverNeed`
  - `alpha`, `donorBonus`
  - `donorARealBefore`, `donorARealAfter`, `donorMinAfter`, `allowedDrainToZero`

### 2.2 Cadastro/Provisão (automático) — ranking e anti‑pânico

- **Funções**: `rankUrgentCityUFs()`, `pickUrgentCityUF()`, `pickNextCityUFForProvision()`
- **Arquivo**: `C:\sitechatbot\index.js`

**Janela e métrica**
- `rankUrgentCityUFs()` usa **`recent3d` start-of-day** (timezone do CT).
- `pressure = rate3d = sent_recent3d / motoristas`
- `insight_percent` é share do `rate3d` no totalEngajamento (igual ao Virtus/Grupos).

**Pipeline + amortecimento (remainingNeed)**
- Pipeline vem do DB do CT:
  - `ct_fb_stock_jobs` com `kind='provision'` e `status in ('running','done')`, somados por `city_uf` (ou `city` fallback), ponderado por idade do job.
- Fórmula implementada:
  - `supplyUnits = LE + pipelineW`
  - `remainingNeed = insightNeed / (1 + CT_STOCK_PROV_SUPPLY_DAMP * supplyUnits)` (somente para cidades de insight baixo)
  - `score = (remainingNeed * CT_STOCK_PROV_INSIGHT_WEIGHT) + (expectedDeficit * 120) + (pressure * 20)`
- Regra mestre:
  - se existir pelo menos 1 cidade `isLowInsight==true`, o rank **filtra somente cidades frias**.

**Anti‑pânico**
- TOP‑N + fila circular + inflight cap:
  - `CT_STOCK_CITY_TOP_N` default `10`
  - `CT_STOCK_CITY_INFLIGHT_CAP` default `1`
  - `CT_STOCK_CITY_QUEUE_REFRESH_MS` default `45000ms`
  - `CT_STOCK_CITY_INFLIGHT_OLDER_MS` default `6h`

**Knobs (env) e defaults do pipeline**
- `CT_STOCK_PROV_PIPELINE_DAYS` default `18`
- `CT_STOCK_PROV_PIPE_DAY0_WEIGHT` default `0.25`
- `CT_STOCK_PROV_PIPE_LE_WEIGHT` default `0.35`
- `CT_STOCK_PROV_PIPE_LE_DAYS` default `12`
- `CT_STOCK_PROV_PIPE_ACTIVE_DAYS` default `15`
- `CT_STOCK_PROV_PIPE_ACTIVE_WEIGHT` default `1`
- `CT_STOCK_PROV_INSIGHT_WEIGHT` default `1000`
- `CT_STOCK_PROV_SUPPLY_DAMP` default `0.35`

---

## 3) Verificações “110%” (pós-restart do CT)

### 3.1 Migração (UI/endpoint) — consistência de insight

1) **Endpoint**:
- `GET /api/contas-facebook-v2?category=fretes&includeOffline=1`

2) **Critérios de sucesso**:
- `windows.recent3d` existe no payload (declarado).
- Cada `migrations[i].why` tem:
  - `avgInsight`, `donorInsight`, `receiverInsight`, `receiverNeed`
  - `donorBonus` e `alpha` coerentes com os defaults (se env não setado).
- Validar que não aparece “doador frio → receptor quente” (pela regra `donorInsight > avgInsight` e `receiverInsight < avgInsight`).

### 3.2 Cadastro/Provisão — rank e justificativa

1) **Endpoint (visível via jobs)**:
- CT: `GET /api/stock/jobs` filtrando `kind=provision` e olhar `details_json.rankTop` e `details_json.pickedCityUf` (quando presente).

2) **Critérios de sucesso**:
- `rankTop` lista cidades com `remainingNeed`, `pipelineW`, `LE`, `supplyUnits`, `insight_percent`, `avgInsight`.
- Cidade escolhida (`pickedCityUf`) está entre as cidades frias, salvo exceção explícita (quando não houver nenhuma com insight baixo).
- Inflight cap bloqueia excesso (não cria 10 jobs simultâneos para a mesma cidade).

---

## 4) Riscos / gaps (para deixar realmente “enterprise”)

- **Versionamento do CT**: se `C:\sitechatbot` não estiver sob Git, há risco operacional de “não saber exatamente qual versão está rodando”.
  - Mitigação mínima: manter backup datado (já existe `_backup_auto_root/...` no workspace).
  - Mitigação ideal: colocar o CT sob Git (ou espelhar `index.js` em repo) para `self_update` do CT também ser possível.

---

## 5) Rollback (sem drama)

- **CT (sitechatbot)**:
  - restaurar `C:\sitechatbot\index.js` a partir de backup datado (ex.: `_backup_auto_root/.../index.js`) e reiniciar `node index.js`.
- **Docs (conveniente)**:
  - `git revert <hash>` (apenas documentação).

