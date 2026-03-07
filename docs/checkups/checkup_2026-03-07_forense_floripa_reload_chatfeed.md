### Checkup — Forense de "recarregando chats" (Florianopolis)

Data: 2026-03-07  
Host: RM7 (`29546e77-083e-4c81-b90f-4402499d0fef`)  
Perfil foco: `florianopolis-1764625643701`

---

### Evidência CT (coleta focada)

- Comando:
  - `fetch_logs_query` cmdId `3f8dcb74-a366-46ea-8aef-074ce6b094f4`
  - requestId `rm7_floripa_forense_20260307_123545`
- Filtro aplicado:
  - perfil + padrões de `reload`, `phantom_fix`, `bootstrap`, `login_required`, `identity`, `appeal`, `checkpoint`.
- Arquivo retorno:
  - `C:\sitechatbot\dados\logs\29546e77-083e-4c81-b90f-4402499d0fef\rm7_reload_focus_20260307_122746.json`

---

### Resultado forense (objetivo)

- O perfil foco no recorte recente não mostrou `page.reload` explícito em sequência curta.
- O comportamento visual de "feed recarregando" é compatível com:
  - **scroll forçado de topo** em loop do Virtus;
  - **keepalive sintético frequente** (focus/mousemove/visibility/keydown);
  - reforço duplicado de scroll (`+800ms`) no mesmo ciclo.
- Esse padrão pode parecer "refresh" para o operador humano mesmo sem `reload` puro.

---

### Causa técnica principal (código)

- Em `scripts/virtus.js`:
  - `POLL_INTERVAL_MS` curto (30s normal / 45s slow);
  - `SCROLL_TOP_INTERVAL_MS` curto (30s normal / 60s slow);
  - scroll executado também no loop principal + reforço `setTimeout(800)`;
  - keepalive sintético executado em alta frequência.

---

### Mitigação aplicada (humanização)

- `scripts/virtus.js` atualizado para reduzir comportamento agressivo:
  - `POLL_INTERVAL_MS` default:
    - normal: `60s` (antes `30s`)
    - slow: `90s` (antes `45s`)
  - `SCROLL_TOP_INTERVAL_MS` default:
    - normal: `5min` (antes `30s`)
    - slow: `8min` (antes `60s`)
  - novo `SCROLL_TOP_IDLE_MIN_GAP_MS` default `10min`;
  - novo `KEEPALIVE_MIN_GAP_MS` default `5min`;
  - remoção do reforço de scroll em `+800ms`;
  - scroll agora só roda quando:
    - há fila pendente, ou
    - passou janela mínima de ociosidade.

---

### Critério de sucesso pós-deploy

- Redução visível de "feed recarregando";
- Sem regressão de atendimento Virtus (fila e envio);
- Sem aumento de `login_required`/`blocked` em janela de observação.

---

### Fase 2 — Forense pós-restart RM7 (amplo, worker+browser+virtus)

Evidências CT:
- `fetch_logs` cmdId `0c12f7c4-dd42-4a75-8edc-392c767975b3`
- `fetch_logs_query` cmdId `cdeb8c5b-d1ec-4be6-90ef-c202cf8b13d9`
- artefatos:
  - `C:\sitechatbot\dados\logs\29546e77-083e-4c81-b90f-4402499d0fef\rm7_postrestart_forense_full_20260307_125355.json`
  - `C:\sitechatbot\dados\logs\29546e77-083e-4c81-b90f-4402499d0fef\rm7_postrestart_forense_query_20260307_125355.json`

Achado objetivo:
- no recorte pós-restart curto (~22.5 min), **não houve rajada de reload**;
- porém a trilha ampla mostrou padrão histórico de `nurse_open_attempt` com retry curto repetido em perfis sem controller (janela de ~10s por perfil em caso de flapping).

Risco:
- mesmo sem `page.reload` explícito, retry curto de abertura/navegação pode gerar "comportamento paranoico" para plataformas sensíveis.

Mitigação aplicada (worker):
- `scripts/worker.js`:
  - `NURSE_INTERVAL_MS` passou a ser configurável (default `10s`, antes fixo `5s`);
  - novo guardrail por perfil: `NURSE_OPEN_MIN_RETRY_MS` (default `60s`);
  - ao falhar abertura (`nurse_open_denied`), impõe `activationHeldUntil` mínimo de retry para impedir re-tentativa imediata.

Objetivo da mitigação:
- cortar loops de reabertura em janela curta sem quebrar recuperação normal de perfil.

---

### Fase 3 — Humanização de micro-ações Virtus (click/typing)

Achado de código (forense estática):
- em `scripts/virtus.js` havia pontos com assinatura robótica:
  - `keyboard.type(..., { delay: 0 })`;
  - sequência sintética de `dispatchEvent(MouseEvent...)` para abrir chat;
  - verificação de entrada em chat em polling curto (`250ms`).

Risco:
- mesmo sem `page.reload`, ações rápidas e repetitivas de click/typing podem aumentar sensibilidade anti-automação da plataforma.

Mitigação aplicada:
- `scripts/virtus.js`:
  - typing humanizado por caractere:
    - `VIRTUS_TYPE_DELAY_MIN_MS` default `55`
    - `VIRTUS_TYPE_DELAY_MAX_MS` default `120`
  - pausa humana antes de Enter:
    - `VIRTUS_ENTER_AFTER_TYPE_MIN_MS` default `350`
    - `VIRTUS_ENTER_AFTER_TYPE_MAX_MS` default `900`
  - abertura de chat com click nativo (delay humano) no lugar de cadeia agressiva de `MouseEvent` sintético;
  - pós-click com espera humana:
    - `VIRTUS_CHAT_OPEN_POST_CLICK_MIN_MS` default `700`
    - `VIRTUS_CHAT_OPEN_POST_CLICK_MAX_MS` default `1400`
  - polling de confirmação de URL desacelerado:
    - `VIRTUS_CHAT_OPEN_CHECK_INTERVAL_MS` default `450`
    - tentativas reduzidas de `8` para `6` (menos martelo).

Objetivo da fase 3:
- reduzir assinatura de automação em micro-interações sem comprometer taxa de resposta do Virtus.

---

### Fase 4 — Humanização global de pausas no Robe

Contexto:
- a varredura estática mostrou muitos `sleep` curtos no fluxo de publicação (`robe`/`robeVeiculos`) com cadência sistemática.

Mitigação aplicada:
- `scripts/robe.js` e `scripts/robeVeiculos.js`:
  - guardrail central de pausa humana para sleeps curtos:
    - `ROBE_HUMAN_PAUSE_MIN_MS` default `220`
    - `ROBE_HUMAN_PAUSE_JITTER_MS` default `180`
  - regra:
    - `sleep(0)` permanece `0` (não altera micro-agendamentos internos);
    - `sleep(ms<min)` sobe para faixa humana com jitter;
    - `sleep(ms>=min)` preserva valor original.

Objetivo da fase 4:
- reduzir padrão robótico no fluxo Robe sem alterar a lógica funcional de publicação.
