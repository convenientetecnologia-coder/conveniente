## Checkup — Dossiê pré‑código (CANÔNICO)
### Robe: agenda diária (gate de elegibilidade) + visibilidade no dashboard (pills)

- **Data**: 2026-04-08
- **Projeto**: `conveniente`
- **Objetivo**: reduzir padrão “robotizado” do Robe **sem mexer na execução interna** (fila global, cooldown, módulos).
- **Estratégia**: adicionar apenas um **gate** “pode enfileirar agora?” baseado em um **plano diário determinístico por conta**.
- **UX (enterprise)**: exibir no dashboard por conta (pills) o plano do dia: trabalha hoje? blocos? próximo bloco? estado “fora de janela”.

---

## 1) Verdade do sistema atual (evidência por arquivo)

### Runtime HTTP/UI e APIs

- **Servidor web + APIs**: `C:\conveniente\index.js`
  - Serve `public/` (UI) e expõe rotas API (status/perfis/robes/etc).

- **UI (dashboard local)**:
  - `C:\conveniente\public\index.html` (contém a lógica de render/pills e lista de contas)
  - `C:\conveniente\public\app.js` (wrapper simples de endpoints)

- **API status canônica (shape “militar”)**:
  - `C:\conveniente\scripts\api_status.js` (`GET /api/status`)
  - O front usa `st.perfis`, `st.robes`, `st.robeQueue`.

### Robe (execução interna — NÃO MEXER AGORA)

- `C:\conveniente\scripts\worker.js`
  - Tick global (`robeTickGlobal`) + `robeQueue.enqueue` + `startRobeDynamic(...)`.
  - Cooldown do ciclo: 15–30 min (já existente).

Dossiê do fluxo do Robe (ponta a ponta):
- `docs/checkups/checkup_2026-04-08_dossie_pre_codigo_robe_fluxo_ponta_a_ponta.md`

---

## 2) Requisitos aprovados (alinhamento)

1) **Gate apenas na elegibilidade**
   - Fora de janela/bloco → não entra na fila (`prontos`).
   - Dentro de bloco → comportamento atual do Robe permanece (fila+cooldown+módulo).

2) **Plano diário determinístico por perfil+data**
   - Restart não pode “embaralhar o dia”.
   - Regra: se o plano não existir ou a data mudou, gerar/regerar de forma determinística.

3) **Feature‑flag + rollout + rollback**
   - Default OFF (ativar por host/coorte).
   - Rollout controlado.
   - Rollback = revert único + restart (`node index.js`).

4) **UX enterprise no pill**
   - Mostrar por conta:
     - trabalha hoje? (sim/não)
     - total de horas do dia (alvo)
     - blocos (ex.: 08:10–10:40, 13:20–16:05)
     - status “fora do bloco” vs “dentro do bloco”

---

## 3) Modelo de plano diário (V1 — simples e robusto)

### 3.1 Janela diária (fixa)

- Janela operacional: **06:00–23:00** (minutos 360–1380).

### 3.2 Quem trabalha hoje

- **25%** das contas: **não trabalham** no dia (`enabled=false`).
- **75%**: trabalham (`enabled=true`).

### 3.3 Distribuição de “horas de trabalho” (pedido do humano)

Objetivo: evitar muitas contas com “só 1h”; concentrar a maioria em algo como um “dia de trabalho humano”.

Distribuição sugerida (entre as contas `enabled=true`) — **versão alinhada (60/40)**:

- **60%**: `dailyHours` inteiro uniforme em **[6..12]**
- **40%**: mistura de extremos:
  - `dailyHours` inteiro uniforme em **[1..6]** OU **[12..14]** (proporção configurável; default 60/40)

Observação: isto aumenta o volume de horas por conta, mas ainda **remove o 24/7** e reduz cluster se os blocos forem bem espalhados.

### 3.3.1 Renovação diária (padrão muda todo dia)

- Regra: o plano é **diário** e é gerado para a data local do host (`YYYY-MM-DD`).
- Consequência desejada: a cada dia:
  - muda quem são os **25% OFF**,
  - mudam `dailyHours` e blocos das demais,
  - mantendo **determinismo por perfil+data** (restart não muda o plano do dia).


### 3.4 Blocos (1–3 por dia)

- `blocksCount` ∈ [1..3], com viés:
  - `dailyHours <= 3` → 1 bloco
  - `4..8` → 1–2 blocos
  - `9..14` → 2–3 blocos
- Restrições:
  - sem sobreposição
  - pausas entre blocos (ex.: 20–120 min, determinístico)
  - blocos sempre dentro de 06:00–23:00

### 3.5 Determinismo (restart‑safe)

Regra: plano deve ser derivado de `seed = sha256("robe_daily_plan_v1|" + nome + "|" + YYYY-MM-DD + "|" + hostIdOpcional)` e um PRNG seedado.

Nota: incluir `hostId` no seed é opcional:
- **Sem hostId**: a mesma conta tende a ter o mesmo padrão diário em qualquer host (bom para coerência).
- **Com hostId**: evita que várias cópias do mesmo perfil (se existirem por bug) coincidam (bom anti‑cluster).

---

## 4) Persistência (onde guardar e por quê)

Requisito: sobreviver a restart.

Opção V1 recomendada (mínima e não invasiva):
- Guardar no `manifestStore` do perfil (já existe e já carrega meta do Robe).

Shape sugerido:
- `manifest.robeDailyPlanV1 = { date, enabled, dailyHours, blocks:[{startMin,endMin}], seed }`

---

## 5) Onde plugar (gate) — pontos de código

### 5.1 Gate no Robe (runtime)

Local: `C:\conveniente\scripts\worker.js`

No `robeTickGlobal`, na seleção de `prontos` (antes de enfileirar), adicionar:
- `if (!isRobeWindowOpenNow(nome, Date.now())) return null;`

Invariantes:
- nunca enfileirar se `ctrl.humanControl` ou `ctrl.configurando` (já existe)
- gate só reduz elegibilidade; não “força” execução

### 5.2 Exibir no dashboard (pills)

Local: `C:\conveniente\public\index.html`

Ponto: função `buildList(...)` monta `titleRow` e adiciona pills (já existe lógica de Robe/Queue/Cooldown).

Adicionar pills novas (V1):
- `Robe hoje: OFF` (quando `enabled=false`)
- `Robe hoje: 8h (2 blocos)` + tooltip com lista de blocos
- `Robe: fora do bloco` vs `Robe: dentro do bloco` (status em tempo real)

Para isso, o front precisa receber do `GET /api/status` um resumo por perfil, por exemplo:
- em `perfis[]`: `robeDailyPlanSummary` (recomendado, pois pill é por perfil)
  - ou em `robes[nome]`: `dailyPlan` (se preferir centralizar em “robes”)

Local provável do shape:
- `C:\conveniente\scripts\api_status.js` (monta payload final para o front)

---

## 6) Validação (quando codarmos)

Sem teste manual:
- Validar por evidência em logs + UI:
  - 1) Pill aparece e bate com o plano persistido.
  - 2) Fora de bloco: conta não entra em `Robe: Na fila / Aguardando fila / Pronto` (fica “fora do bloco”).
  - 3) Dentro de bloco: comportamento atual continua.
  - 4) Restart no meio do dia: plano permanece idêntico (mesma seed, mesmos blocos).

---

## 7) Rollout/rollback (enterprise)

- Feature‑flag default OFF.
- Rollout por host (canário 1 host → 2 hosts → todos).
- Rollback:
  - `git revert` do commit
  - restart: `node index.js`

