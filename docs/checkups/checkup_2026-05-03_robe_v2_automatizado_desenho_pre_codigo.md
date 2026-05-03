### Checkup — 2026-05-03 — [CONVENIENTE][ROBE] Desenho pré‑código: “Robe V2 automatizado” (justiça por Habitantes × Insight) + fila global atômica

> Regra: este arquivo é um **relatório/desenho**. O resumo (1–3 linhas) vai para `docs/TIMELINE.md`.

#### Contexto

- Data: 2026-05-03
- Ambiente: prod (pré‑código / desenho)
- Hosts envolvidos (hostId/hostname): n/a (desenho global; sem execução)
- Sintoma:
  - hoje, cidades com **habitantes muito diferentes** estão recebendo volume de postagens parecido, gerando “injustiça” operacional;
  - o Robe V1 distribui por pool (cidade da conta + extras da conta + extras globais) sem um plano “por servidor” guiado por dados do CT.
- Impacto:
  - baixa eficiência de engajamento (postar “demais” onde não precisa e “de menos” onde precisa);
  - leitura humana do painel CT (Virtus) fica desconectada do comportamento do Robe.

---

### Evidências coletadas (objetivas)

- Logs (keys): n/a (pré‑código)
- Arquivos/snapshots:
  - Fila global Robe no worker (execução serializada; base para atomicidade do consumo de “próxima cidade”):
    - `C:\conveniente\scripts\worker.js` (`robeTickGlobal` e handler `robe-play`) usando `robeQueue.enqueue(...)`.
  - Locks de arquivo cluster-safe já existentes (padrão para estado persistente da fila V2):
    - `C:\conveniente\scripts\fileStore.js` (`withDesiredFileLockUpdate`, locks de `perfis.json` + `writeJsonAtomic`).
  - Padrão CT de endpoints “secret” por header `X-Log-Secret` (LOG_INGEST_SECRET):
    - `C:\sitechatbot\index.js` (`logsCheckSecret(req)` e múltiplos `*_secret`).
  - Fonte de dados humana (Virtus) para `insight` e para `habitantes` (já existe coluna editável no CT):
    - `C:\sitechatbot\index.js` `GET /api/dashboard/virtus` (insight e janela 3d)
    - `C:\sitechatbot\index.js` `POST /api/dashboard/city_population` (override manual de habitantes)
- cmdId/requestId: n/a (pré‑código)

---

### Achados (P0/P1/P2)

- **P0**: Concorrência real (enterprise) não é “2 contas no mesmo tick” apenas; em cenário de sharding/multi‑processo, dois processos podem tentar consumir a mesma “próxima cidade”.
  - Implicação: o estado da fila V2 precisa ser **persistente + lockado** (arquivo + `.lock`) e o “pick” precisa ser atômico.
- **P0**: V2 exige um endpoint CT “server→CT” que não dependa de login/painel, com autenticação por secret (padrão existente no CT).
  - Implicação: criar endpoint `*_secret` no CT no mesmo padrão de `logsCheckSecret`.
- **P0**: “Insight = 0 / null” pode existir; dividir por insight ou aplicar inverso sem guardrail gera explosão de peso.
  - Implicação: fórmula com `ref` robusto (mediana) + clamps + fallback explícito (não silencioso).
- **P1**: Plano diário precisa ser “estável” (não regenerar a cada conta) e “explicável” (auditável).
  - Implicação: definir `planId`, `validUntil`, e um único lugar de geração (servidor).
- **P1**: Reabastecimento não pode esperar zerar: precisa prefetch (ex.: restarem ~20 itens).
  - Implicação: `prefetchThreshold` e controle anti‑storm (`regenPending`, `regenInFlight`, backoff).
- **P2**: Randomização “equilibrada” (evitar rajada de mesma cidade) melhora UX operacional e reduz outliers.

---

### Decisão / Ação recomendada (cirúrgica)

#### 1) Configuração: seletor “Tipo de Robe” no servidor (V1 vs V2)

- O que mudar:
  - `C:\conveniente\scripts\serverConfig.js`:
    - adicionar `robe.workMode` com valores canônicos:
      - `v1` (default; comportamento atual)
      - `v2_auto` (novo; “Robe V2 automatizado”)
  - `C:\conveniente\public\index.html` (modal “Configuração do Servidor”):
    - adicionar seletor “Tipo de Robe” com labels:
      - “Robe V1”
      - “Robe V2 automatizado”
- Por quê:
  - precisa ser uma decisão **por servidor** e aplicada a **todas as contas** do servidor quando em V2.
- Risco:
  - baixo se default continuar `v1` e se V2 ficar inativo até existir fila/endpoint.
- Rollback:
  - trocar `workMode` para `v1` no dashboard; reiniciar `conveniente` após deploy do runtime.

#### 2) Endpoint CT “secret” para estatísticas por cidade (Habitantes + Insight)

- O que mudar:
  - `C:\sitechatbot\index.js`:
    - criar `POST /api/robe/v2/city_stats_secret`
    - autenticar com `logsCheckSecret(req)` (header `X-Log-Secret` com `LOG_INGEST_SECRET`) e permitir localhost.
  - Contrato (request):
    - `hostId`: string (opcional, mas recomendado para audit/ledger)
    - `cities`: array de strings (nomes exatos no padrão do CT, ex.: `"Porto Alegre (RS)"`)
    - `windowDays`: number (fixo em `3` por padrão; ignorar/normalizar se vier diferente)
  - Contrato (response):
    - `{ ok:true, requestId, generatedAt, windowDays:3, statsByCity: { [city]: { habitantes, insightPercent, motoristas, chamados3d } } }`
- Por quê:
  - o V2 precisa de dados do CT para distribuir o plano diário com justiça “Habitantes × Insight”.
- Risco:
  - endpoint secreto exposto sem secret configurado.
- Rollback:
  - remover endpoint ou negar acesso quando `LOG_INGEST_SECRET` ausente (já é padrão em `logsCheckSecret` → `secret_not_configured`).

#### 3) Cálculo do plano diário (N postagens/24h) no conveniente

- Regra:
  - `avgCooldownMin = (cooldownMinMinutes + cooldownMaxMinutes) / 2`
  - `postsPerAccountPerDay = 1440 / avgCooldownMin`
  - `N = ceil(postsPerAccountPerDay * totalContasNoServidor)`
  - “totalContasNoServidor” = total cadastradas no host (inclui offline).
- Fonte da contagem:
  - usar leitura global de perfis (não só “working”):
    - preferir `fileStore.loadPerfisJson()` (visão total do host), evitando filtro por shard.
- Guardrails:
  - clamp de `avgCooldownMin` mínimo (ex.: >= 5) para evitar N absurdo por configuração inválida.

#### 4) Fórmula de distribuição “Habitantes × Insight” (auditável e robusta)

Objetivo: mais habitantes ⇒ mais posts; menor insight ⇒ mais posts; sem explosões com insight 0/null.

- Entrada por cidade `i`:
  - `pop_i` = habitantes (inteiro > 0) ou “missing”
  - `ins_i` = insightPercent (float > 0) ou “missing”
- `ref`:
  - `ref = mediana(ins_i válidos do conjunto)` (robusto a outliers).
- Boost por insight (inverso com clamp):
  - se `ins_i` inválido/<=0: `boost_i = 1`
  - senão:
    - `boost_i = clamp( (ref / ins_i) ^ beta, minBoost, maxBoost )`
  - parâmetros iniciais (canônicos para implementação):
    - `beta = 1.0`
    - `minBoost = 0.35`
    - `maxBoost = 3.0`
- Peso final:
  - se `pop_i` inválido/<=0: tratar como “missing” e usar `pop_i = popFallback`
    - `popFallback = mediana(pop válidos)`; se não houver, usar `1`.
  - `w_i = (pop_i ^ alpha) * boost_i`
  - parâmetro inicial:
    - `alpha = 1.0` (garante “1M vs 100k com mesmo insight ≈ 10×”).
- Alocação de slots (soma exata = N):
  - `raw_i = N * w_i / sum(w)`
  - `n_i = floor(raw_i)` + distribuir o “resto” pelos maiores `raw_i - floor(raw_i)` até somar N.
- Observabilidade (sem achismo):
  - registrar no ledger/audit (servidor) o vetor final:
    - `{ N, ref, params, cities: [{city, pop, ins, boost, w, n}] }` (sem segredos).

#### 5) Fila global V2 (persistente + atômica + prefetch + anti‑storm)

- Estado canônico no host:
  - arquivo: `C:\conveniente\dados\robe_v2_queue.json`
  - lock: `C:\conveniente\dados\robe_v2_queue.json.lock`
- Shape sugerido do estado:
  - `planId`: string (hash do plano)
  - `generatedAt`: ms
  - `validUntil`: ms (aprox. 24h)
  - `targetN`: number
  - `cities`: array (cidades consideradas)
  - `queue`: array (itens já randomizados; tamanho >= 0)
  - `prefetchThreshold`: number (canônico: 20; se `targetN` pequeno, `max(5, min(20, floor(targetN*0.1)))`)
  - `regenPending`: boolean
  - `regenInFlightId`: string|null
  - `lastRegenAt`: ms|null
  - `failures`: `{ count, lastAt, backoffUntil }`
- Operações (todas com lock de arquivo):
  - `pickNextCity()`:
    - lock → ler estado → se vazio: `need_regen` → gravar estado (marcando pending/backoff se aplicável) → unlock
    - senão `shift()` 1 item → gravar → unlock → retorna cidade.
  - `maybePrefetch()` (chamado após pick e/ou em timer leve):
    - se `queue.length <= prefetchThreshold` e não `regenInFlight` e não `backoffUntil`:
      - lock → marcar `regenPending=true` + set `regenInFlightId` → unlock
      - fora do lock: buscar stats no CT → gerar nova lista → lock → anexar ao final se `regenInFlightId` ainda bater → limpar pending → unlock.
- Anti‑storm (não “fazer e refazer a lista” por bug):
  - `regenInFlight` em memória + `regenInFlightId` em disco
  - backoff exponencial em falhas (ex.: 30s, 2m, 10m, 30m) com clamp.
  - nunca regenerar se já existe fila “suficiente” e `validUntil` ainda não expirou.
- Randomização equilibrada:
  - gerar lista expandida com `n_i` repetições por cidade e embaralhar com regra “anti‑streak” (evitar repetir a mesma cidade em sequência quando houver alternativa).

#### 6) Cache por 24h (onde e por quê)

- Cache “24h” é do **plano no conveniente** (arquivo `robe_v2_queue.json` com `validUntil`).
  - Motivo: estabilidade operacional e controle de storm.
- CT pode ter cache curto (segundos/minutos) para evitar recalcular em bursts, mas não é o “cache principal”.

#### 7) Falhas e comportamento (sem fallback silencioso)

- CT indisponível:
  - se ainda há itens em `queue`: continuar consumindo, marcar `regenPending` e registrar evento.
  - se `queue` vazia: **fail‑closed** (não postar), registrar erro claro e respeitar backoff.
- Insight 0/null:
  - `boost_i = 1` (neutro) e a cidade é ponderada por habitantes (se houver).
- Habitantes missing:
  - usar `popFallback` (mediana dos conhecidos) e registrar `pop_missing=true` na auditoria.

---

### Plano de rollout

- Reinícios necessários (quais processos/nodes):
  - **neste checkup (pré‑código): nenhum**
  - quando implementar:
    - `sitechatbot` (CT) precisa de restart para carregar o novo endpoint
    - `conveniente` precisa de restart para ler `workMode` e iniciar a fila V2
- Ordem (quando for codar):
  - Deploy CT (endpoint secret) → restart CT
  - Deploy conveniente (config + fila + consumo no Robe) → commit/push + `self_update` → restart conveniente
  - Ajustar o servidor para `Robe V2 automatizado` no dashboard (se default for V1)
- Validação pós-rollout (checks):
  - CT: endpoint secret responde `ok:true` com stats esperados para 1–2 cidades (sem expor segredos).
  - conveniente: ao alternar para V2, gera `robe_v2_queue.json` com `targetN` esperado e consumo monotônico (não duplica topo).
  - prefetch: quando `queue.length <= threshold`, anexa novo bloco sem resetar/duplicar.

