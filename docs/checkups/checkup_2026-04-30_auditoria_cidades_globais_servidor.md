# Checkup — 2026-04-30 — Cidades extras globais no Config do Servidor

## Escopo

Auditoria forense read-only para viabilizar, com risco minimo, a regra:

- manter cidade principal da conta;
- manter cidades extras por conta;
- adicionar cidades extras globais por servidor;
- usar a uniao sem duplicidade no sorteio de postagens.

Sem aplicar patch nesta etapa.

---

## Evidencias do estado atual

## 1) Cidades por conta ja existem e estao ativas no runtime

- `C:/conveniente/public/index.html`
  - modal da conta permite selecionar `cidadesExtras` e salvar;
  - observacao de UI: geolocalizacao continua na cidade principal.
- `C:/conveniente/scripts/api_perfis.js`
  - `PATCH /api/perfis/:nome/cidades-extras` valida coordenadas e grava `manifest.cidadesExtras`;
  - remove duplicatas e impede repetir cidade principal no payload final;
  - limpa `postCityCycle` (`order/idx`) para forcar novo ciclo.

Conclusao: a camada por-conta esta madura e pronta para composicao com camada global.

## 2) Robe ja monta pool e ciclo randomizado por conta

- `C:/conveniente/scripts/robe.js`
- `C:/conveniente/scripts/robeVeiculos.js`

Ambos repetem a mesma logica:

1. `buildPostingCityPool(manifest)` monta pool com principal + `cidadesExtras`;
2. `pickPostingCityForRun(nome)` usa `postCityCycle` (`order`, `idx`) para:
   - percorrer o pool sem repetir no ciclo;
   - ao terminar, reembaralhar e reiniciar.

Conclusao: o comportamento pedido pelo humano (usar tudo e reembaralhar) ja existe; falta apenas incluir a camada global do servidor na montagem do pool.

## 3) Config do servidor existe, mas hoje nao contem cidades globais

- `C:/conveniente/scripts/serverConfig.js`
  - persiste `dados/server_runtime_config.json`;
  - hoje aceita `capacity` e campos de `robe` (janela, horas, cooldown, foto).
- `C:/conveniente/scripts/api_perfis.js`
  - `GET/POST /api/server-config` expoe e salva essa estrutura.
- `C:/conveniente/public/index.html`
  - modal "Configuracao do Servidor" hoje exibe somente cooldown e politica de delecao.

Conclusao: existe trilha pronta para expandir schema/API/UI com baixo risco.

## 4) Runtime ja le config do servidor com cache curto

- `C:/conveniente/scripts/worker.js`
  - `getRuntimeServerConfig()` faz cache de 10s da config efetiva;
  - usado para cooldown/politicas do robe.

Conclusao: ha padrao consolidado para consumir config global de forma eficiente.

---

## Lacunas para atender o pedido

1. Schema de `serverConfig` nao possui `robe.cidadesExtrasGlobais`.
2. API de `server-config` nao valida nem normaliza lista de cidades.
3. UI de config do servidor nao possui seletor multi-cidades.
4. `buildPostingCityPool` (itens/veiculos) nao recebe camada global.
5. `apply-now` atual (`robe-replan-all`) nao toca `postCityCycle` (nao quebra, mas pode atrasar adocao imediata em contas sem nova execucao).

---

## Riscos e pontos de controle

## Risco A — duplicidade e colisao entre camadas

Mitigacao:

- unificar por normalizacao case-insensitive/acento-insensitive;
- ordem canonica do merge:
  1. principal da conta
  2. extras da conta
  3. extras globais do servidor
- dedupe final unico antes de gerar pool.

## Risco B — cidade sem coordenadas

Mitigacao:

- validar cada cidade global no backend com `utils.getCoords` (mesmo padrao das extras por conta);
- rejeitar save inteiro se houver qualquer cidade invalida (retorno com nome da cidade).

## Risco C — divergencia entre modos `itens` e `veiculos`

Mitigacao:

- aplicar mesma funcao de merge nas duas implementacoes (`robe.js` e `robeVeiculos.js`);
- manter assinatura/contrato equivalente para evitar comportamento diferente por modo.

## Risco D — adocao parcial apos salvar config

Mitigacao:

- no `apply-now`, limpar `postCityCycle.order/idx` para todas as contas (alem do que ja existe em `robe-replan-all`);
- assim o novo conjunto global entra no proximo disparo de postagem de forma deterministica.

---

## Desenho tecnico recomendado (sem patch ainda)

## 1) Schema canônico

Adicionar em `serverConfig.robe`:

- `cidadesExtrasGlobais: string[]` (default `[]`).

Regras:

- maximo sugerido: 200 cidades;
- sem vazios;
- sem duplicatas normalizadas;
- sem cidade sem coordenadas.

## 2) Normalizacao unica

Criar helper compartilhado para lista de cidades:

- trim;
- remover vazios;
- dedupe por chave normalizada (`NFD` sem acento + lower);
- preservar label original da primeira ocorrencia valida.

## 3) Composicao do pool final por conta

Pool efetivo:

`pool = uniq([cidadePrincipal, ...extrasConta, ...extrasServidor])`

Isso atende exatamente o pedido:

- conta de Anapolis + Anapolis global => continua 1x;
- contas de Floripa + Anapolis global => passam a incluir Anapolis;
- ciclo randomizado atual permanece igual.

## 4) UI de Config do Servidor

No modal existente:

- adicionar bloco "Cidades extras globais (servidor)";
- usar lista de `GET /api/cidades` com filtro + selecionar todas (mesmo padrao do modal da conta);
- mensagem clara de regra:
  - "aplica em todas as contas"
  - "cidade principal nunca duplica".

## 5) Apply-now e consistencia imediata

Quando salvar com "aplicar agora":

- manter `robe-replan-all`;
- adicionalmente invalidar `postCityCycle` globalmente para refletir a nova uniao sem depender de estado anterior.

---

## Plano de rollout (cirurgico)

1. Backend schema/validacao (`serverConfig.js`) com testes de normalizacao.
2. API `server-config` aceitando/retornando `cidadesExtrasGlobais`.
3. UI modal do servidor com seletor de cidades globais.
4. Merge no pool em `robe.js` + `robeVeiculos.js`.
5. `apply-now` limpando `postCityCycle` global.
6. Validacao em ambiente local com matriz:
   - principal duplicada no global;
   - conta sem extras;
   - conta com extras + global sobreposto;
   - modo itens e veiculos.

---

## Status desta auditoria

- Viabilidade tecnica: **alta**.
- Risco de regressao: **baixo a medio**, desde que a normalizacao e o merge sejam implementados de forma identica em `itens` e `veiculos`.
- Recomendacao: seguir para fase de implementacao atomica em 1 PR/commit cirurgico com evidencia de validacao.

---

## Execucao — fase 1 (2026-04-30)

Implementacao aplicada com patch minimo e sem alterar contratos existentes de conta:

1. `C:/conveniente/scripts/serverConfig.js`
   - novo campo `robe.cidadesExtrasGlobais` no schema/default;
   - normalizacao/deduplicacao canonica;
   - validacao de coordenadas (`utils.getCoords`) no save.
2. `C:/conveniente/public/index.html`
   - modal "Configuracao do Servidor" agora permite selecionar cidades extras globais com filtro e selecao em massa;
   - payload de save inclui `robe.cidadesExtrasGlobais`.
3. `C:/conveniente/scripts/robe.js` e `C:/conveniente/scripts/robeVeiculos.js`
   - pool de cidades por conta agora usa uniao:
     `principal + extras_da_conta + extras_globais_do_servidor`
   - com deduplicacao case/acento-insensitive.
4. `C:/conveniente/scripts/worker.js`
   - `robe-replan-all` limpa `postCityCycle.order/idx` globalmente para refletir nova composicao imediatamente no proximo ciclo.
