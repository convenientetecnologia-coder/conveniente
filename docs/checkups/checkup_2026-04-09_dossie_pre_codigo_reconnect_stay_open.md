### Checkup — Dossie Pre-codigo Reconnect + Stay-Open

> Regra: este arquivo e um **relatorio**. O resumo (1-3 linhas) vai para `docs/TIMELINE.md`.

#### Contexto

- Data: 2026-04-09
- Ambiente: prod
- Hosts envolvidos (hostId/hostname): analise estatica (sem host unico nesta etapa)
- Sintoma: apos `invoke_human` e `human-resume`, parte dos perfis fecha/reabre e volta com captcha
- Impacto: aumenta risco de captcha/deslog e reduz estabilidade operacional percebida

---

### Evidencias coletadas (objetivas)

- Logs (keys):
  - `browser_disconnected`
  - `nurse_reopen_scheduled(disconnected)`
  - `reopen_scheduled(...)`
  - `worker_hard_close_begin` / `worker_hard_close_done`
  - `login_remediate_step` (especialmente `post_success_*`)
- Arquivos/snapshots:
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\scripts\browser.js`
  - `C:\conveniente\scripts\dashboard.js`
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260409-2300-01.md`
- cmdId/requestId:
  - N/A (auditoria pre-codigo sem execucao CT nesta rodada)
- Trechos relevantes:
  - `hardCloseController`: tenta `browser.close()` e escala para kill por PID quando necessario
  - `login_remediate` pos-sucesso: `closeAfterSuccess` (default true) + nudge de reabertura
  - `ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS = 5000`

---

### Achados (P0/P1/P2)

- **P0**: existe caminho de fecha/reabre agressivo no pos-sucesso do `login_remediate`, que pode virar kill por PID se close gracioso falhar no timeout.
- **P0**: `REOPEN_DELAY_SHORT_MS=5000` em caminhos relevantes de recovery (`disconnected` e `preserveDesired`) pode amplificar padrao bot-like.
- **P0**: nao existe reconnect CDP (`wsEndpoint` + `puppeteer.connect`) antes de cair para restart.
- **P1**: o desenho "logou e segue no mesmo browser" e tecnicamente viavel com baixo impacto estrutural porque o fluxo ja tem `forceCloseExtras` e `start virtus` no controller atual.
- **P1**: autopilot (`autoLoginRemediateTick`) hoje fixa `closeAfterSuccess: true`; sem alinhar esse caminho, mudanca parcial pode gerar comportamento inconsistente.
- **P2**: uso de CDP pesado (Tracing/IO) esta parcialmente condicionado por cache/orcamento, mas ainda deve entrar em hardening de fases seguintes.

---

### Decisao / Acao recomendada (cirurgica)

- O que mudar (pre-codigo aprovado para futura implementacao):
  1) **Fase 1A - Reconnect primeiro**:
     - persistir `wsEndpoint` por perfil no runtime;
     - ao perder controle, checar PID vivo e tentar reconnect (2s -> 5s -> 10s);
     - so fechar quando reconnect falhar com evidencia.
  2) **Fase 1B - Stay-open no sucesso**:
     - no pos-sucesso do `login_remediate`, default operacional para nao fechar browser;
     - fechar apenas abas extras; manter controller; ligar `virtus` no browser atual.
  3) **Fase 1C - Reopen controlado**:
     - quando fechamento for inevitavel em falha nao-RAM, usar janela randomizada (ex.: 5-15min) com jitter por perfil;
     - manter politica diferenciada para RAM/CPU kill.
- Por que:
  - reduz restart desnecessario, reduz padrao fecha/abre, e diminui vetor de captcha pos-retomada.
- Risco:
  - risco principal e manter browser em estado "meio quebrado" se reconnect/filtro de saude for fraco.
  - mitigacao: gate de saude antes de iniciar `virtus` e fallback deterministico para close controlado.
- Rollback:
  - flags de runtime para voltar ao comportamento atual sem novo patch;
  - rollback de codigo por `git revert` se necessario.

---

### Matriz de decisao operacional (go/no-go)

- Caso A: `disconnected`, PID vivo, `wsEndpoint` presente
  - Acao: reconnect
  - Resultado esperado: manter sessao e evitar restart
  - Stop condition: 3 falhas seguidas de reconnect no mesmo evento

- Caso B: `disconnected`, PID morto
  - Acao: close/reopen controlado
  - Resultado esperado: recuperar operacao com menor risco de rajada
  - Stop condition: 3 ciclos sem estabilizar em janela curta (entra quarentena futura)

- Caso C: login remediate sucesso (FB + Messenger OK)
  - Acao: stay-open (sem hard close), `forceCloseExtras`, `virtus on`
  - Resultado esperado: elimina fecha/abre desnecessario
  - Stop condition: health check falhar apos sucesso (entao fallback para close controlado)

- Caso D: falha nao-RAM que exige fechamento
  - Acao: reopen com jitter controlado (nao imediato)
  - Resultado esperado: reduzir padrao mecanico/captcha
  - Stop condition: escalacao de falhas por perfil (quarentena fase 2+)

---

### Plano de rollout

- Reinicios necessarios (quais processos/nodes):
  - nesta etapa: nenhum (somente auditoria/documentacao)
  - na etapa de implementacao: `conveniente` no host canario (1 host), depois expansao gradual
- Ordem:
  1) aprovar contrato Fase 1A/1B/1C (este checkup + INC)
  2) implementar flags e telemetria de reconnect/stay-open
  3) canario em 1 host
  4) expandir por lotes
- Validacao pos-rollout (checks):
  - queda de `worker_hard_close_*` no pos-sucesso de login_remediate
  - queda de `reopen_scheduled(disconnected)` em cenarios com PID vivo
  - queda de captcha pos `human-resume`
  - sem aumento de perfis presos (`humanHold` indevido, desired ativo sem controller)

---

### Criterios de aceite (fase 1)

- Reconnect acionado com sucesso quando Chrome estiver vivo (evidencia em logs dedicados)
- Pos-sucesso de login_remediate sem fecha/abre na maioria dos casos
- Fechamento inevitavel com reopen randomizado (nao imediato) para falhas nao-RAM
- Rollback simples por flag + restart

---

### Contrato final executavel (sem codar)

#### Fase 1A - Reconnect inteligente (escopo minimo)

- Entregaveis obrigatorios:
  - flag de runtime para habilitar reconnect;
  - persistencia de `wsEndpoint` no ciclo de vida do controller;
  - tentativa de reconnect com retries `2s -> 5s -> 10s`;
  - fallback deterministico para fechamento quando reconnect falhar.
- Evidencia minima esperada:
  - eventos `reconnect_attempt`, `reconnect_success`, `reconnect_fail`, `restart_fallback`;
  - correlacao por perfil (`nome`) e motivo da falha.
- Critico para aprovar:
  - nao quebrar fluxo legado quando reconnect estiver desabilitado.

#### Fase 1B - Eliminar fecha/abre desnecessario no sucesso

- Entregaveis obrigatorios:
  - politica `stay-open-after-success` com flag;
  - em sucesso do `login_remediate`: manter browser, `forceCloseExtras`, `virtus on`;
  - alinhar os 3 caminhos: manual/API, stock_provision, autopilot.
- Evidencia minima esperada:
  - queda de `post_success_hard_close`;
  - aumento de `post_success_start_virtus_ok` no mesmo browser.
- Critico para aprovar:
  - nenhum aumento de perfis "ativos sem controller".

#### Fase 1C - Reopen controlado em falha inevitavel

- Entregaveis obrigatorios:
  - politica de reopen com jitter para falhas nao-RAM (janela 5-15 min default);
  - manter politica atual separada para RAM/CPU kill.
- Evidencia minima esperada:
  - `reopen_scheduled_policy` com faixa/jitter/motivo.
- Critico para aprovar:
  - queda de reopen imediato em sequencia curta no mesmo perfil.

---

### Checklist de aprovacao pre-codigo (go/no-go)

- [ ] Escopo fechado: Fase 1A/1B/1C sem incluir refatoracao estrutural grande.
- [ ] Flags de rollback definidas antes do primeiro patch.
- [ ] Telemetria minima definida antes de alterar comportamento.
- [ ] Caminhos cobertos: manual/API, `stock_provision`, `autoLoginRemediateTick`.
- [ ] Plano canario fechado (1 host) com janela de observacao.
- [ ] Criterios de stop imediato definidos:
  - aumento de captcha em canario;
  - aumento de perfis presos;
  - aumento de `disconnected` sem recuperacao.
- [ ] Rollback operacional validado: voltar por flag + restart.

---

### Ordem de execucao recomendada (quando codar)

1) Implementar somente Fase 1A (reconnect) com flags e logs.
2) Validar canario.
3) Implementar Fase 1B (stay-open no sucesso), ainda com fallback ligado.
4) Validar canario novamente.
5) Implementar Fase 1C (reopen controlado para falhas nao-RAM).
6) Expandir gradualmente.

Observacao: se qualquer fase degradar estabilidade, parar expansao e rollback por flag.
