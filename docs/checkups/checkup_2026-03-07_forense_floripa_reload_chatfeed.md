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
