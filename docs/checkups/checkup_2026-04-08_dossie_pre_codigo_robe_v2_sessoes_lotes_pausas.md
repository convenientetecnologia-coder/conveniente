## Checkup — Dossiê pré-código V2 (Olhos de Deus)
### Robe: sessões/lotes/pausas dentro do bloco (sem quebrar fila global)

- **Data**: 2026-04-08
- **Projeto**: `conveniente`
- **Objetivo**: remover padrão previsível "postar -> cooldown fixo -> postar" e migrar para comportamento por sessões humanas dentro dos blocos.
- **Regra de escopo**: mudança mínima; preservar arquitetura atual (tick global + `robeQueue` + `startRobeDynamic`).

---

## 1) Verdade do código atual (evidência)

### Onde o ritmo atual nasce

- `C:\conveniente\scripts\worker.js`
  - `robeTickGlobal` só enfileira quando `normalizeCooldown(nome) === 0`.
  - hoje o gate diário V1 já filtra por janela/bloco (`isRobeWindowOpenNow`).

- `C:\conveniente\scripts\robe.js`
  - `startRobe(...)` aplica cooldown padrão no fim/erro:
    - 20–35 min na maioria dos casos;
    - exceção de retry curto em `MARKETPLACE_RATE_LIMIT_ERR`.
  - essa lógica mantém padrão de intervalo entre posts mesmo com bloco diário.

### Fila global (não pode quebrar)

- `C:\conveniente\scripts\robeQueue.js`
  - invariante de exclusividade: 1 execução Robe por vez (global no processo).
  - V2 deve respeitar isso.

---

## 2) Contrato funcional V2 (alvo)

Dentro de cada bloco diário da conta:

1) definir total aproximado de posts do bloco (ex.: taxa alvo por hora com variação);
2) quebrar em sessões/lotes de 1..5 posts;
3) entre sessões, inserir pausas variáveis:
   - curtas (~10–30 min),
   - médias (~30–90 min),
   - longas ocasionais (até algumas horas, quando couber no bloco);
4) dentro da sessão: posts quase em sequência (delay técnico curto);
5) fora de sessão: não posta, mesmo dentro do bloco.

Resiliência:
- plano interno do bloco persistido no manifest;
- restart retoma do ponto correto.

---

## 3) Design mínimo proposto (sem refatoração pesada)

### 3.1 Camada nova: "session gate" no worker (antes da fila)

No `robeTickGlobal`, após validar bloco diário:
- consultar estado de sessão do bloco (`robeBlockSessionV2`);
- se próxima ação = `pause` e ainda não venceu, não enfileirar;
- se ação = `post`, enfileirar normalmente.

### 3.2 Persistência nova no manifest (por conta)

Adicionar objeto:
- `manifest.robeBlockSessionV2`:
  - `date`
  - `blockId` (índice do bloco diário ativo)
  - `actions` (sequência determinística)
  - `ptr` (índice da ação atual)
  - `remainingInAction` (para ação `post`, quantos posts faltam no lote)
  - `pauseUntil` (epoch ms quando ação `pause` está ativa)
  - `lastAdvanceAt`

Sequência de ações (exemplo):
- `[ {type:'post', count:3}, {type:'pause', min:24}, {type:'post', count:1}, {type:'pause', min:87}, ... ]`

### 3.3 Cooldown vira apoio técnico, não regra principal

Hoje `robe.js` força 20–35 min.
Para V2 funcionar, precisamos:

- em `robe.js`, trocar cooldown hardcoded por:
  - `cooldown técnico curto` quando ação atual é lote (`post`) (ex.: 15–90s),
  - fallback padrão só quando sessão indisponível/erro.

Mecanismo mínimo:
- aproveitar `robePauseMs` que já é passado do worker para `startRobe(...)`;
- em `robe.js`, usar `robePauseMs` quando válido, em vez de sempre sortear 20–35 min.

Assim:
- worker decide ritmo humano (sessão/pause),
- `robe.js` só executa e aplica cooldown técnico coerente.

---

## 4) Função a função — o que precisa mexer

### `scripts/worker.js`

1) `robeTickGlobal`  
- inserir consulta/avanço da sessão V2:
  - `getOrCreateBlockSessionState(nome, now, dailyPlan)`
  - `isSessionPostAllowedNow(state, now)`
  - bloquear fila quando em pausa.

2) ponto pós-execução (`res` do Robe)  
- em sucesso de post, avançar contador da ação `post`;
- se lote encerrou, mover para `pause` e setar `pauseUntil`.

3) snapshot/status  
- expor resumo:
  - `sessionState` (`in_post`/`in_pause`),
  - `sessionNextAt`,
  - `sessionActionRemaining`.

### `scripts/robe.js`

1) `startRobe(browser, nome, robePauseMs, ...)`
- usar `robePauseMs` como cooldown preferencial (quando fornecido);
- manter fallback atual para erro sem plano.

2) preservar:
- `limit_posting`/rate-limit guardrails;
- invariantes de publicação/commit de foto.

### `scripts/api_status.js`

1) shape de baseline/fallback
- incluir campos opcionais da sessão V2 para não quebrar frontend.

### `public/index.html`

1) pills por conta
- mostrar:
  - `Sessão: postando (lote x/y)` ou
  - `Sessão: pausa até HH:MM`
  - opcional: `Posts bloco: realizados/planejados`.

---

## 5) Regras determinísticas (anti-estranheza no restart)

- todas as escolhas do bloco/sessão devem derivar de seed estável:
  - `sha256(v2|nome|date|blockId|...)`.
- restart no mesmo dia/bloco:
  - não regenera sequência do zero;
  - retoma `ptr`/`pauseUntil` do manifest.

---

## 6) Riscos e mitigação

1) **Volume despencar**
- risco: pausas exageradas.
- mitigação: limites mínimo/máximo de posts por bloco e observabilidade.

2) **Loop de sessão quebrado**
- risco: ação não avança e conta trava.
- mitigação: watchdog com auto-heal (`ptr` inválido => rebuild determinístico do bloco).

3) **Concorrência com `humanControl/configurando/provisionLock`**
- mitigação: sessão só roda após os gates existentes; nunca "força" execução.

4) **Regressão de `limit_posting`**
- mitigação: manter lógica atual como prioridade sobre sessão.

---

## 7) Observabilidade V2 (olhos de deus)

Eventos novos em `provision_audit`:
- `robe_v2_session_plan_generated`
- `robe_v2_session_post_granted`
- `robe_v2_session_pause_enter`
- `robe_v2_session_pause_exit`
- `robe_v2_session_advance`
- `robe_v2_session_recovered_after_restart`

Critério de qualidade:
- provar que a distribuição deixou de ser "intervalo fixo" e virou lotes + pausas.

---

## 8) Rollout/rollback

Como V1 está sempre ON hoje, para V2 recomendamos:
- implementar com flag interna temporária de rollout canário (apenas V2, não V1),
- validar em 1 host (RM7),
- expandir.

Rollback:
- revert commit V2 + restart `node index.js`.

---

## 9) Decisão recomendada antes de codar

Para manter simplicidade:

1) V2 controla apenas:
- elegibilidade por sessão (post/pause),
- cooldown técnico curto.

2) Não mexer em:
- módulo de publicação (`robe.js`) além da parte de cooldown parametrizável,
- fila global,
- contratos de erro/limit posting.

