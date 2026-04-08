## Checkup — Dossiê pré‑código (CANÔNICO)
### Robe — fluxo ponta‑a‑ponta (execução, guards, humano, riscos de regressão)

- **Data**: 2026-04-08
- **Projeto**: `conveniente`
- **Escopo**: mapear o fluxo atual do **Robe** de ponta a ponta, com evidência (arquivos/funções/guards), antes de qualquer mudança.
- **Regra operacional**: sem achismo; qualquer decisão importante deve citar evidência (path + função + log key / cmdId / requestId quando aplicável).

---

## 1) Histórico relacionado (INC/Runbook)

INC(s) diretamente relevantes (para evitar regressão e não “reinventar”):

- `docs/inbox/done/INC-20260130-0005-01.md` — **Human Overlay / Invocar Humano (HUD)**: botões (fechar, Robe 24h, excluir) + garantia “robô não mexe no navegador humano” (rollout `needs_restart`).
- `docs/inbox/done/INC-20260130-1544-01.md` — RM3: “trabalhando 0” no CT; envolve fluxo de **invoke_human / retomar** (HUD) e governança.
- `docs/inbox/need_evidence/INC-20260216-1930-01.md` — RM4: **loop Robe login_required x Messenger saudável** (separação de domínios Robe vs Virtus).
- `docs/inbox/need_evidence/INC-20260215-1100-01.md` — RM1: **Robe postar / tela preta residual** (precisa evidência para fechar gap).

Índice canônico:
- `docs/inbox/INDEX.md` (linhas onde esses INCs aparecem e seus states/rollout/validation).

---

## 2) Onde o Robe “vive” no código (fonte da verdade)

Arquivo principal do runtime:
- `C:\conveniente\scripts\worker.js`

Pontos chave (evidência por código):

- **Scheduler do Robe**: `setInterval(robeTickGlobal, 7000)` e `setTimeout(robeTickGlobal, 3500)` (Robe roda como tick global).
- **Fila global do Robe**: `robeQueue.enqueue(nome, async () => { ... })` (execução serializada por nome).
- **Execução do Robe por módulo**: `startRobeDynamic(browser, nome, robePauseMs, workingNow)` chama `getRobeModuleFor(nome)` e `mod.startRobe(...)`.

---

## 3) Fluxo ponta‑a‑ponta (alto nível)

### 3.1 Tick global → seleção de perfis prontos

O Robe só considera perfis que estão realmente “trabalhando” e aptos, e não entra em perfis em modo humano:

- Guardrails (resumo):
  - **não rodar durante provisionamento** (`provisionLock.isActive()`) → skip do tick
  - **modo light/slowmode** → throttle/skip parcial (não “mata” o Robe totalmente, só reduz pressão)
  - por perfil:
    - precisa ter `ctrl.browser` conectado
    - precisa estar `ctrl.trabalhando`
    - não pode estar `ctrl.configurando`
    - não pode estar `ctrl.humanControl`
    - precisa ter `normalizeCooldown(nome) === 0`
    - não pode estar em fila nem em execução (`robeQueue.inQueue/isActive`)

### 3.2 Enfileira → stop Virtus → close páginas extras → startRobeDynamic

Ao executar um ciclo do Robe para um perfil:

- “cerca” a execução no browser: `ctrl.browser._robeActiveFor = nome`
- opcionalmente define `mainPage` e faz `wirePageObservers`
- **para Virtus** (se estava rodando) antes de rodar Robe
- fecha páginas extras (`closeExtraPages`)
- calcula `robePauseMs` (15–30 min)
- executa `startRobeDynamic(...)` (módulo específico da conta)

### 3.3 Saída → update meta/manifest → restaura Virtus (se aplicável)

- Se `res.ok`, atualiza `manifest.ultimaPostagemRobe = Date.now()`
- Registra meta: `estado ok/idle/erro`, cooldown, próxima postagem etc
- No `finally`, tenta fechar páginas extras e **restarta Virtus** se era o caso e `automationAllowed(ctrl)` for true.

---

## 4) Domínios e invariantes (não-negociáveis para não regredir)

### 4.1 Separação de domínio Robe vs Virtus (Messenger)

Risco conhecido: “Messenger saudável” não pode limpar/invalidar um bloqueio que é específico do Robe (ex.: create/item requer login).

INC de referência:
- `docs/inbox/need_evidence/INC-20260216-1930-01.md`

### 4.2 Modo Humano (Invocar Humano) — robô não mexe no navegador humano

Invariantes do modo humano:

- Ao invocar humano:
  - `ctrl.humanControl=true`
  - `desired.perfis[nome].humanHold=true`
  - `desired.perfis[nome].virtus='off'`
  - Virtus é parado (`stopVirtus(nome)`)
  - HUD/Overlay é sincronizado (`ensureHumanOverlay`)
- Regra: Robe **não enfileira** perfis com `humanControl=true` (guard na seleção de prontos).

INC de referência (HUD/ações):
- `docs/inbox/done/INC-20260130-0005-01.md`

---

## 5) Logs/telemetria relevantes (evidência)

Objetivo: qualquer investigação futura do Robe deve ser provável por chaves de log e sequência temporal.

Fontes esperadas:

- `provision_audit.jsonl`:
  - eventos relacionados a humano (ex.: `invoke_human_set`, `invoke_human_overlay_ok/err`)
  - eventos de ações do Robe (mil_action/reportAction/robe_start/robe_end)
- `issues` por perfil (`issues.append(...)`):
  - marcações de “skip”, “limit_posting”, “erro técnico”

---

## 6) Pontos de risco de regressão (lista cirúrgica)

Mudanças no Robe tendem a quebrar operação quando:

- mexe em guard de `humanControl/humanHold` (risco: Robe mexer no browser humano)
- mexe em relação Robe↔Virtus (risco: “trabalhando 0”, virtus não volta, ou robô concorre)
- mexe em cooldown/freeze/unfreeze (risco: Robe trava para sempre ou roda em loop)
- mexe em preflight/flags e “Retomar trabalho” (risco: limpar flag errada e gerar loops)
- mexe em `closeExtraPages`/mainPage (risco: matar a aba errada e induzir about:blank)

---

## 7) Próximos passos (pré‑código)

Antes de mexer em código do Robe, a execução enterprise recomendada é:

1) escolher 1 alvo (um INC por vez) como WIP (ex.: `INC-20260215-1100-01` ou `INC-20260216-1930-01`).
2) coletar evidência via logs (janela curta, 1 perfil referência).
3) somente então desenhar patch mínimo + rollback + rollout controlado.

