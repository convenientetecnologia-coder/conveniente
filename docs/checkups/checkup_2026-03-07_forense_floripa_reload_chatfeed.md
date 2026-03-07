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

---

### Fase 5 — Humanização de base no Browser Helper

Contexto:
- `browser.js` ainda mantinha delays fixos curtos em ações sensíveis (click/type/mouse click), o que reforça assinatura sistemática.

Mitigação aplicada:
- `scripts/browser.js`:
  - guardrail central de pausa humana:
    - `BROWSER_HUMAN_PAUSE_MIN_MS` default `220`
    - `BROWSER_HUMAN_PAUSE_JITTER_MS` default `180`
  - jitter humano para ações:
    - click: `BROWSER_CLICK_DELAY_MIN_MS=90`, `BROWSER_CLICK_DELAY_MAX_MS=170`
    - type: `BROWSER_TYPE_DELAY_MIN_MS=65`, `BROWSER_TYPE_DELAY_MAX_MS=140`
  - pontos cobertos:
    - `clickByXPath` (CTA/fallbacks de navegação);
    - `resolveNonceIfPresent` (botão recarregar nonce);
    - `hackedAssistStep` (mouse click real);
    - `tryLoginEmailPass` (digitação email/senha).

Objetivo da fase 5:
- reduzir previsibilidade temporal no helper base de browser sem quebrar fluxos de recuperação/login.

---

### Validação pós-restart RM7 (fase 5)

Evidência coletada:
- `fetch_logs` requestId `rm7_postrestart_forense_full5_20260307_132424` (`cmdId=ddb4b477-9175-4591-bd53-bd75a8eb0e8a`).
- `fetch_logs_query` requestId `rm7_postrestart_forense_query5_20260307_132424` (`cmdId=55e18e4a-319e-4ddf-8a36-a0c5ebd14b2e`).

Recorte `provision_audit` (janela ~25.6 min):
- `reload_rows=0`.
- `nurse_open_attempt`: `67` eventos, `gap_p50 ~20.5s` (global multi-perfil).
- `bootstrap_messenger_ok`: `65` eventos, `gap_p50 ~20.7s`.
- `bootstrap_messenger_ready`: `63` eventos, `gap_p50 ~20.8s`.
- `open_human_probe_clear`: `62` eventos, `gap_p50 ~20.8s`.

Foco perfil observado (`florianopolis-1764625643701`):
- sem `nurse_open_denied` no recorte.
- ciclo principal presente e estável (`nurse_open_attempt` -> `bootstrap_messenger_ok` -> `bootstrap_messenger_ready` -> `open_human_probe_clear`).
- gaps de `nurse_open_attempt` do perfil no recorte: `9.73 min`, `5.23 min`, `9.67 min`.

Leitura técnica:
- não houve evidência de rajada de `reload` no pós-restart observado.
- permanece prioridade forense em reduzir retries curtos residuais por perfil quando houver janela abaixo de 10 min (ex.: gap `5.23 min`).

---

### Fase 6 — Forense de microações sistemáticas (virtus/robe/worker)

Contexto:
- varredura estática identificou microações ainda rápidas/fixas e loops de manutenção curtos:
  - `virtus.js`: `sleep` sem guardrail humano e delays de type/click ainda agressivos.
  - `robe.js`/`robeVeiculos.js`: delays de `click/type` na faixa `40..70ms` e `10..22ms`.
  - `browser.js`: `sleep` locais em rotinas de prune bypassavam guardrail global.
  - `worker.js`: watch/resume de stock-provision em `2s/5s` fixos.

Mitigação aplicada:
- `scripts/virtus.js`:
  - guardrail de pausa humana no `sleep`:
    - `VIRTUS_HUMAN_PAUSE_MIN_MS=260`
    - `VIRTUS_HUMAN_PAUSE_JITTER_MS=220`
  - aumento e randomização de microtempos:
    - `VIRTUS_TYPE_DELAY_MIN_MS=85`, `VIRTUS_TYPE_DELAY_MAX_MS=180`
    - `VIRTUS_ENTER_AFTER_TYPE_MIN_MS=550`, `VIRTUS_ENTER_AFTER_TYPE_MAX_MS=1300`
    - `VIRTUS_CHAT_OPEN_CLICK_DELAY_MIN_MS=110`, `VIRTUS_CHAT_OPEN_CLICK_DELAY_MAX_MS=220`
    - `VIRTUS_CHAT_OPEN_POST_CLICK_MIN_MS=1100`, `VIRTUS_CHAT_OPEN_POST_CLICK_MAX_MS=2200`
    - `VIRTUS_CHAT_OPEN_CHECK_INTERVAL_MS=700`
- `scripts/robe.js` e `scripts/robeVeiculos.js`:
  - novos limites globais para microações:
    - `ROBE_CLICK_DELAY_MIN_MS=110`, `ROBE_CLICK_DELAY_MAX_MS=220`
    - `ROBE_TYPE_DELAY_MIN_MS=45`, `ROBE_TYPE_DELAY_MAX_MS=95`
  - substituição de delays curtos fixos por jitter humano nas ações de click/type.
- `scripts/browser.js`:
  - remoção de `sleep` locais sem humanização em rotinas de prune (passa a usar guardrail global do arquivo).
- `scripts/worker.js`:
  - watch/resume de stock-provision agora configurável e mais desacelerado por padrão:
    - `STOCK_PROVISION_LOCK_WATCH_INTERVAL_MS=5000`
    - `STOCK_PROVISION_RESUME_INTERVAL_MS=10000`

Objetivo da fase 6:
- reduzir assinatura mecânica residual em microinterações e loops curtos sem alterar o fluxo funcional principal.

---

### Hotfix regressão pós-fase 6 (virtus chat open)

Evidência do incidente (RM7):
- erro em produção logo após restart/update:
  - `Não entrou no chat correto após o click simulado. (urlAtual=/marketplace, esperado=<chatId>)`
  - perfil: `petrolina-1771560719856`

Leitura técnica:
- regressão concentrada no caminho de abertura de chat do `virtus` após endurecimento de timings da fase 6.
- decisão operacional: **não** introduzir fallback por URL; restaurar caminho de click previamente estável.

Correção aplicada:
- `scripts/virtus.js` (somente no caminho de open chat):
  - remoção do guardrail global de `sleep` introduzido na fase 6;
  - restauração dos ranges anteriores:
    - `VIRTUS_TYPE_DELAY_*`: `55..120`
    - `VIRTUS_ENTER_AFTER_TYPE_*`: `350..900`
    - `VIRTUS_CHAT_OPEN_POST_CLICK_*`: `700..1400`
    - `VIRTUS_CHAT_OPEN_CHECK_INTERVAL_MS`: `450`
  - restauração de `found.click({ delay: randomBetween(60, 140) })`.

Objetivo do hotfix:
- recuperar estabilidade do atendimento (abrir chat por click) sem adicionar fluxo novo.

Adendo técnico (correção complementar sem fallback de URL):
- `scripts/virtus.js` recebeu robustez no **mesmo** fluxo de click:
  - até 2 tentativas de abertura do chat por click;
  - reforço por click real via coordenada (`mouse.click`) no mesmo item quando o click leve não navega;
  - revalidação de URL após cada tentativa e re-busca da âncora (DOM virtualizado).
- resultado esperado:
  - reduzir falso-negativo de abertura (`urlAtual=/marketplace`) sem mudar estratégia funcional.

Adendo técnico 2 (telemetria + ordem primária):
- para eliminar ambiguidade operacional no RM7, o fluxo passou a registrar no `provision_audit`:
  - `virtus_chat_open_click_attempt` (modo/tentativa)
  - `virtus_chat_open_click_result` (modo/tentativa/ok/url)
- ordem de tentativa agora configurável por env:
  - `VIRTUS_CHAT_OPEN_PRIMARY_MODE=mouse|dom` (default: `mouse`).
- decisão atual:
  - manter `mouse` como primário e `dom` como secundário, preservando fallback interno por click (sem `goto`).

---

### Hotfix complementar (sem `goto` de chat + anti-insistência no worker)

Decisão operacional:
- remover navegação direta para chat por URL no `virtus` (inclusive reconciliação de pendências).
- manter recuperação no `worker`, porém com histerese/cooldown maior para não virar padrão de insistência.

Correções aplicadas:
- `scripts/virtus.js`:
  - removido `p.goto('https://www.messenger.com/marketplace/t/${chatId}/')` do fluxo de composer missing;
  - removido `goto` de chat em `reconcilePendingsIfAny`;
  - reconciliação de pending envelhecido agora só libera reprocessamento da fila (`pendingDel`) e registra evento `virtus_pending_reconcile_release_no_goto`.
- `scripts/worker.js`:
  - `HEALTH_CFG.MIN_ACTION_GAP_MS=120000` (env: `HEALTH_RECOVERY_MIN_ACTION_GAP_MS`);
  - `PHANTOM_CFG.COOLDOWN_BETWEEN_TRIES_MS=120000` (env: `PHANTOM_COOLDOWN_BETWEEN_TRIES_MS`);
  - trilha de health recovery passa a respeitar `lastRecoveryActionAt` entre `reload/navHome/newPage`.

Objetivo:
- reduzir “cutucada” por navegação forçada e evitar oscilação insistente em recuperação, sem remover o mecanismo de auto-cura.
