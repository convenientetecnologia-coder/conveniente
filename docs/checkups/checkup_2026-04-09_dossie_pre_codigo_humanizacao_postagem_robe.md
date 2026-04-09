# Checkup 2026-04-09 — Dossie pre-codigo: humanizacao da postagem Robe (itens/veiculos)

## Escopo

- Objetivo: levantar baseline e desenho seguro para aumentar o tempo de criacao/publicacao de anuncio para faixa humana (60-120s), sem alterar runtime neste checkup.
- Fora de escopo neste momento: implementacao de codigo, rollout, restart, alteracao de flags.

## Contexto operacional

- Fluxo atual de postagem e funcional (foto, campos, publicar), porem rapido e com cadencia curta.
- Risco apontado: assinatura de automacao por ritmo muito previsivel.
- Restricao mandataria: preservar confiabilidade do fluxo atual e evitar regressao de publicacao.

## Evidencias de arquitetura (fonte de verdade)

- Seletor de modulo no worker:
  - `scripts/worker.js` -> `getRobeModuleFor(...)` / `startRobeDynamic(...)`.
- Fluxo itens:
  - `scripts/robe.js` -> `startRobe(...)` + helpers de preenchimento e publicacao.
- Fluxo veiculos:
  - `scripts/robeVeiculos.js` -> `startRobe(...)` + helpers especificos.
- Observabilidade por etapa:
  - `scripts/stepLog.js` grava JSONL com `ts` por `step` em `dados/perfis/<perfil>/robe-step.log`.

## Baseline tecnico (aferido por leitura do codigo)

### Itens (`scripts/robe.js`)

- Etapas logadas: `upload_start`, `title_ok`, `price_ok`, `category_ok`, `condition_ok`, `description_try`, `location_ok`, `publish_try_race`, `publish_ok`.
- Delays predominantes curtos:
  - pausas na faixa de centenas de ms entre subetapas;
  - digitar/clicar com jitter de dezenas de ms.
- Resultado esperado por desenho atual: throughput alto por tentativa quando DOM responde rapido.

### Veiculos (`scripts/robeVeiculos.js`)

- Etapas logadas: `upload_start`, `vehicle_type_ok`, `location_ok`, `vehicle_year_ok`, `vehicle_make_model_ok`, `vehicle_price_ok`, `vehicle_description_ok`, `publish_try_race`, `publish_ok`.
- Mesmo perfil de pausas curtas e race de publicacao.

## Baseline quantitativo (coleta real de logs)

Fontes de artefato:
- `C:\sitechatbot\dados\tmp_robe_timing_audit_summary.md`
- `C:\sitechatbot\dados\tmp_robe_timing_audit_summary.json`
- Script de consolidacao: `C:\sitechatbot\tools\tmp_robe_timing_audit_from_logs.js`

Metodo aplicado:
- Parse de `provision_audit` historico (arquivos coletados em `sitechatbot/dados/logs/...`).
- Pareamento por `hostId + nome` entre:
  - inicio: `dbg_robe_start_entry`
  - fim: `dbg_startRobeDynamic_module_return`
- Filtro de qualidade: duracao entre 0 e 20 minutos.

Resultados:
- Total pareado: **938** (OK=695, falha=243)
- Todas amostras:
  - p50: **37.28s**
  - p90: **143.38s**
  - p95: **200.23s**
- Apenas OK:
  - min: **19.84s**
  - p50: **36.30s**
  - p90: **97.33s**
  - p95: **177.99s**
- Faixas (OK):
  - `<20s`: 1
  - `20..60s`: 561
  - `60..120s`: 74
  - `>120s`: 59

Conclusao de baseline:
- O comportamento atual de sucesso concentra majoritariamente em **20..60s**, corroborando risco de cadencia curta/repetitiva.
- O alvo de design para humanizacao (**60..120s por tentativa**) e justificavel e mensuravel.

Limitacao declarada:
- Essa metrica e de janela operacional (`startRobe` ate retorno do modulo), nao estritamente "foto -> publicar".
- Para medicao cirurgica de "foto -> publicar", o ideal e consolidar `robe-step.log` por etapa no host durante rollout controlado.

## Riscos de mudanca (pre-implementacao)

1) Inserir espera longa no meio de transicao de DOM pode causar stale element/timeout.
2) Aumentar apenas `type delay` nao garante janela total alvo, e pode degradar confiabilidade.
3) Variacao "falsa" (padrao repetitivo) pode continuar detectavel mesmo com tempo maior.
4) Itens e veiculos compartilham contrato de publicacao; ajuste deve evitar divergencia de comportamento sem controle.

## Proposta de desenho (ainda sem codar)

### Principio

- Humanizacao por **orcamento de tempo por tentativa**, nao por delays soltos.

### Modelo

1) Sorteia `targetTotalMs` por tentativa em [60_000..120_000].
2) Quebra em orcamento por etapas com pesos + jitter (ex.: upload 8-15%, campos 55-70%, publish prep 10-20%, folga final 5-15%).
3) Em cada etapa, aplica atraso apenas em pontos estaveis (apos validacao de campo / antes de proximo bloco).
4) Recalcula folga residual para respeitar alvo total sem travar quando a pagina estiver lenta por rede/DOM.

### Guardrails

- Nao segurar durante clique critico de publicacao.
- Nao dormir com handle fragil em transicao.
- Manter limites maximos por etapa para evitar timeout.
- Preservar caminho de abort por `limit_posting` e por `login_required`.

## Implementacao aplicada (2026-04-09)

Arquivos:
- `scripts/robe.js`
- `scripts/robeVeiculos.js`

Resumo:
- O fluxo agora cria um plano de budget por tentativa para o bloco de formulario (compose), com alvo default de 60-120s.
- Entre etapas, aplica pausa randomizada com teto pelo tempo restante do budget.
- Antes do primeiro clique de publicar, aplica espera final para atingir o budget sorteado da tentativa.

Parametros:
- `ROBE_POST_HUMANIZE_ENABLED=1`
- `ROBE_POST_COMPOSE_MIN_MS=60000`
- `ROBE_POST_COMPOSE_MAX_MS=120000`
- `ROBE_POST_ACTION_DELAY_MIN_MS=900`
- `ROBE_POST_ACTION_DELAY_MAX_MS=4200`

Observabilidade:
- `humanize_compose_plan`
- `humanize_compose_pause`
- `humanize_compose_budget_wait`
- `humanize_compose_budget_hit`

Nota:
- O tempo total end-to-end (abrir aba, publicar, verificar, fechar) pode ultrapassar 120s; o budget alvo cobre o bloco de formulario ate o clique em publicar.

## Plano de validacao (quando houver implementacao)

1) Baseline 24h pre-patch (duracao total e por etapa via `robe-step.log`).
2) Rollout controlado (coorte pequena).
3) Comparar:
   - p50/p90 de `start -> publish_ok`;
   - variancia por etapa;
   - taxa de `publish_ok` e erros tecnicos.
4) Criterio de GO:
   - tempo total concentrado em 60-120s;
   - sem queda relevante de sucesso de publicacao.

Metricas de aceite propostas (objetivas):
- M1: em amostras OK, pelo menos 75% no intervalo `60..120s`.
- M2: p50 OK dentro de `70..95s`.
- M3: taxa de sucesso `publish_ok` sem queda acima de 2 p.p. versus baseline da coorte.

## Relacao com incidente

- Incidente principal: `docs/inbox/need_evidence/INC-20260409-1400-01.md`.

## Addendum tecnico (2026-04-09b)

Aprendizado da primeira rodada:
- A estrategia de "budget com sobra final" elevou o tempo total, porem concentrou espera perto do publish.
- Esse padrao nao atende o objetivo de ritmo humano no preenchimento.

Ajuste aplicado:
- Novo modelo de compose com distribuicao aleatoria de budget em timers **pre-acao** (nao no final).
- Janela default do budget pre-acao: `30..90s` (`ROBE_POST_COMPOSE_MIN_MS=30000`, `ROBE_POST_COMPOSE_MAX_MS=90000`).
- Fases de espera (itens): upload, titulo, preco, categoria, condicao, descricao, localizacao, publicar.
- Fases de espera (veiculos): upload, tipo, localizacao, ano, fabricante/modelo, preco, descricao, publicar.

Complemento de humanizacao:
- Digitacao desacelerada em titulo/preco/descricao/localizacao com ranges dedicados por campo.
- Em ~20% dos casos de titulo/descricao, simulacao de typo com correcao via backspace.

Observabilidade revisada:
- `humanize_compose_plan` (slots por fase).
- `humanize_compose_pre_action_wait`.
