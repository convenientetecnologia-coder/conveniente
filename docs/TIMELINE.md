### Timeline â€” mudanÃ§as (mais novo em cima)

Regra: toda mudanÃ§a relevante entra aqui com:
- tags (projeto/Ã¡rea),
- o que mudou,
- por que mudou,
- evidÃªncia (arquivo/endpoint/log),
- impacto operacional (reinÃ­cios),
- rollback.

Tags (modelo A = timeline Ãºnica):
- `[CONV]`: conveniente
- `[CT]`: sitechatbot / CT
- `[NOTIF]`: notificador
- `[CROSS]`: envolve 2+ sistemas (sempre use junto com as tags de cada sistema)
- `[DOCS]`: documentaÃ§Ã£o/organizaÃ§Ã£o (sem runtime)
- `[OPS]`: operaÃ§Ã£o (procedimentos/rollback/restart)

Quando for â€œa mesma iniciativaâ€ em mais de um sistema, usar um identificador:
- `THREAD=TH-YYYY-MM-DD-slug-curto`

Formato canÃ´nico (copiar/colar):

- `#### YYYY-MM-DD â€” [TAGS...] TÃ­tulo curto`
- **O que**: 1â€“5 bullets (sem detalhe excessivo)
- **Por quÃª**: 1 frase
- **EvidÃªncia**: caminho de arquivo / endpoint / log (ou â€œver checkup Xâ€)
- **ReinÃ­cios**: quais serviÃ§os/nodes precisam reiniciar (ou â€œnenhumâ€)
- **Rollback**: como desfazer (1â€“2 linhas)
- **THREAD**: `TH-...` (somente quando `[CROSS]`)

---

#### 2026-02-04 - [CT] Chat: abrir sala no 1º nao lido + marcar como lido ao chegar no fim

- **O que**:
  - Ao abrir sala com nao lidas, ancora no 1º nao lido (em vez de abrir no fim).
  - Ao chegar no fim do chat, marca como lido mesmo sem "Novas mensagens (x)".
  - Evita corridas: abertura concorrente de salas agora auto-cancela para nao baguncar estado.
- **Por que**: leitura operacional em ordem + parar de "voltar pro nao lido" apos ja ter lido.
- **Evidencia**: `c:\sitechatbot\.cursor\debug.log` runIds `chat_open_unread_v1` (strategy before/after) e `chat_open_unread_perf_v1` (`mark_read_bottom`).
- **Reinicios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `C:\sitechatbot\convenientetecnologia\public\ct.js` e reiniciar CT.

#### 2026-02-04 - [CT] Aprovados: notificação por usuário + som dedicado (vitória/dinheiro)

- **O que**:
  - Badge de “novos em Aprovados” ficou monótono (não depende de contagem que sobe/desce).
  - Estado de “visto” passa a ser **por usuário** (não vaza entre logins no mesmo browser).
  - Som dedicado de Aprovados (diferente do chat), com timbre “bell/coin”.
- **Por que**: operacional (financeiro) precisa de alerta confiável e motivador.
- **Evidência**: `debug.log` (runId `ct_approved_notify_v1`) + confirmação humana.
- **Reinicios**: CT (sitechatbot) - `node index.js` (migração/rotas/ct.js).

#### 2026-02-04 - [CT] Aprovados: latência realtime aceitável (~1–2s) após enviar para o financeiro

- **O que**: medição ponta-a-ponta de latência (ação → SSE `ct_changed` → refreshCore → badge/som).
- **Evidência**: `debug.log` runId `ct_approved_rt_v1` (ex.: ack ~141ms, SSE recv ~138ms, badge ~1946ms).
- **Decisão**: manter (sem ajuste adicional) — “tá ótimo desde que funcione”.

#### 2026-02-04 - [CT] Encerrar INC-20260204-0130-01 (Zoom/Layout) por decisao do humano

- **O que**: INC `INC-20260204-0130-01` movido para `cancelled` e encerrado por decisao do humano (tempo/custo/estresse).
- **Por que**: nao atingiu baseline desejado em 100% (comparacao com 75%) dentro do tempo aceitavel.
- **Evidencia**: `c:\sitechatbot\.cursor\debug.log` runIds `ct_zoom_layout_v1`, `ct_zoom_density_v2`, `ct_layout_cols_v1`, `ct_topbar_sync_v1`, `ct_approved_clip_v1/v2`.
- **Reinicios**: nenhum (encerramento documental).
- **Rollback**: n/a (INC encerrado; mudancas operacionais permanecem como estao no repo local do CT).

#### 2026-02-04 - [CT] Chat: "Ver mais" sem indent na 1Âª linha

- **O que**: Ajuste no HTML gerado pelo clamp do "Ver mais" para nÃ£o inserir whitespace de template literal que virava recuo visual na 1Âª linha.
- **Por que**: padronizar layout; evitar 1Âª linha deslocada quando o clamp estÃ¡ ativo.
- **EvidÃªncia**: `c:\sitechatbot\.cursor\debug.log` runId `chat_vermais_v2` (leadingWsLen=0) + validaÃ§Ã£o humana (CÃ¡ssio): â€œperfeito, foiâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/ct.js` e reiniciar CT.


#### 2026-02-04 - [CT] Chat: "Mais usados" no picker do composer (ðŸ˜€)

- **O que**: O picker do ðŸ˜€ agora mostra "Mais usados" no topo (mesmo ranking do menu de reaÃ§Ã£o) + "Todos" abaixo; clicar no emoji no composer tambÃ©m alimenta o ranking.
- **Por que**: acelerar operaÃ§Ã£o (os emojis mais usados ficam sempre a 1 clique).
- **EvidÃªncia**: `c:\sitechatbot\.cursor\debug.log` runId `chat_mostused_composer_v1` + validaÃ§Ã£o humana (CÃ¡ssio): â€œficou perfeitoâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/ct.js` e reiniciar CT.


#### 2026-02-04 - [CT] Chat: corrigir mistura de mensagens entre salas (P0)

- **O que**: Corrigido bug onde Equipe/Canais/Privados mostravam histÃ³rico misturado (cache global).
- **Por que**: P0 â€” inviabilizava uso de canais/privados e causava risco de enviar no lugar errado.
- **Como**: cache por `roomId` + outbox local filtrado por sala.
- **EvidÃªncia**: `c:\sitechatbot\.cursor\debug.log` runId `chat_roommix_v1` (antes: sala vazia count=0 mas mergedCount alto; depois: mergedCount=0).
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/ct.js` e reiniciar CT.


#### 2026-02-04 - [CT] Chat: composer (8 linhas) sem sobrepor + foco sem borda

- **O que**:
  - Composer ajustado para nÃ£o sobrepor o texto aos botÃµes quando bate o teto de ~8 linhas (scroll interno).
  - Ajuste de espaÃ§amento do textarea (padding/line-height) para nÃ£o colar na borda.
  - Removido halo/borda azul ao focar o textarea do chat (sÃ³ no chat).
- **Por que**: melhorar leitura/digitaÃ§Ã£o e evitar texto â€œpor baixoâ€ de emoji/enviar.
- **EvidÃªncia**: validaÃ§Ã£o humana (CÃ¡ssio): â€œficou excelenteâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/ct.css`/`public/app.html`/`public/ct.js` e reiniciar CT.


#### 2026-02-03 - [CT] Chat: emoji pack (padrÃ£o apps) + picker UX

- **O que**:
  - Atualizado pack de emojis para lista padrÃ£o (apps) com filtro de compatibilidade no Windows.
  - Picker do composer: abre acima do campo, nÃ£o fecha ao selecionar, sem scroll horizontal fantasma.
  - Menu de reaÃ§Ã£o: nÃ£o fica mais cortado embaixo (altura/posiÃ§Ã£o calculadas pelo espaÃ§o disponÃ­vel).
  - â€œMais usadosâ€ agora reseta/pruna quando o pack muda.
- **Por que**: emoji Ã© ferramenta operacional; padronizar melhora consistÃªncia e velocidade.
- **EvidÃªncia**: `c:\sitechatbot\.cursor\debug.log` (runId `chat_emoji_pack_v3/v4` e `chat_react_menu_v1`) + validaÃ§Ã£o humana (CÃ¡ssio): â€œficou muito bomâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/ct.js` e `public/ct.css` e reiniciar CT.


#### 2026-02-03 - [CT] Chat: composer layout (input full + botoes dentro)

- **O que**: textarea do chat agora ocupa largura total; botÃµes ðŸ˜€/ï¼‹/Enviar ficam dentro do campo embaixo.
- **Por que**: melhora digitaÃ§Ã£o (campo maior) e UX mais parecido com apps modernos.
- **EvidÃªncia**: validaÃ§Ã£o humana (CÃ¡ssio): â€œfuncionou e ficou muito bomâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `public/app.html` + `public/ct.css` e reiniciar CT.


#### 2026-02-03 - [CT] Chat: cores por usuÃ¡rio (pill no autor)

- **O que**: cada usuÃ¡rio recebe uma cor consistente no pill do nome (CÃ¡ssio/Matheo/Larissa/Abiline com cores fixas; demais automÃ¡tico).
- **Por que**: leitura mais rÃ¡pida e menos confusÃ£o operacional em conversas com mÃºltiplos autores.
- **EvidÃªncia**: validaÃ§Ã£o humana (CÃ¡ssio): â€œficou excelenteâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `ct.js`/`ct.css` e reiniciar CT.


#### 2026-02-03 - [CT] Chat: histÃ³rico infinito (paginaÃ§Ã£o pra trÃ¡s)

- **O que**:
  - Chat agora carrega mensagens antigas ao subir (infinite scroll), com banner â€œCarregando mais mensagensâ€¦â€ / â€œInÃ­cio do histÃ³ricoâ€.
  - API passou a aceitar cursor `beforeId` alÃ©m de `sinceId`.
- **Por que**: permitir auditoria/consulta do histÃ³rico completo e suportar testes como â€œreenviar falha antigaâ€.
- **EvidÃªncia**: `c:\sitechatbot\.cursor\debug.log` (runId `chat_history_v1`) com requests usando `beforeId` e `hasMoreOlder=false` no final.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `ct.js`/`ctStore.js`/`index.js` e reiniciar CT.

#### 2026-02-03 - [CT] Chat: Reenviar mensagem falhada

- **O que**: Mensagem com falha fica com âš  e mostra botÃµes **Reenviar**/**Remover**; reenvio reutiliza texto/anexo do outbox.
- **Por que**: reduzir atrito operacional quando rede/servidor falha no envio.
- **EvidÃªncia**: validaÃ§Ã£o humana (CÃ¡ssio): â€œreenviar funcionouâ€.
- **ReinÃ­cios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter `ct.js` e reiniciar CT.


#### 2026-02-03 - [CT] Chat: links clicaveis

- **O que**:
  - Mensagens agora transformam URLs em links clicaveis (https/http, www, wa.me).
- **Por que**: melhorar produtividade (abrir links direto do chat).
- **Evidencia**: `docs/inbox/done/INC-20260203-2510-01.md` + `sitechatbot/convenientetecnologia/public/ct.js`.
- **Reinicios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter ct.js/ct.css e reiniciar CT.


#### 2026-02-03 - [CT] Chat: editar mensagem (menu ... + modal)

- **O que**:
  - Adicionado item Editar no menu (3 pontinhos) das mensagens do proprio usuario.
  - Modal de edicao com preview + textarea + confirmar/cancelar.
  - Backend: endpoint para editar mensagem e auditar edited_at/edited_by (com recalc de mencoes).
- **Por que**: corrigir rapidamente mensagens erradas e deixar o chat mais profissional.
- **Evidencia**: `docs/inbox/done/INC-20260203-2500-01.md` + `sitechatbot/convenientetecnologia/public/ct.js` + `sitechatbot/convenientetecnologia/lib/ctStore.js`.
- **Reinicios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter ct.js/ctStore/ctDb/index.js e reiniciar CT.


#### 2026-02-03 â€” [CT] Chat: composer auto-grow + Ver mais

- **O que**:
  - Composer do chat agora cresce automaticamente ate ~8 linhas.
  - Mensagens grandes agora exibem Ver mais/Ver menos.
- **Por que**: melhorar UX/operacao do chat (nao perder texto e ler mensagens longas).
- **Evidencia**: `docs/inbox/done/INC-20260203-2400-01.md` + UI em `sitechatbot/convenientetecnologia/public/ct.js`/`ct.css`.
- **Reinicios**: CT (sitechatbot) - `node index.js`.
- **Rollback**: reverter ct.js/ct.css e reiniciar CT.


#### 2026-02-03 â€” [CT][OPS] CT Sistema Interno: WhatsApp verde + menu + auditoria â€œChamou no zapâ€

- **O que**:
  - Adicionado botÃ£o WhatsApp (verde) com menu (abrir / copiar link / copiar nÃºmero) em: Testes â€” Encerrados, Chamar depois, Cadastro e ParticipaÃ§Ã£o.
  - Persistido â€œChamou no zapâ€ (Ãºltima aÃ§Ã£o + data/hora + usuÃ¡rio) para outros usuÃ¡rios verem nas listas operacionais (Testes Encerrados e Chamar depois).
- **Por quÃª**: padronizar o acesso rÃ¡pido ao WhatsApp e deixar rastreÃ¡vel quando o cliente foi cobrado.
- **EvidÃªncia**: `docs/inbox/done/INC-20260203-2230-01.md` + cÃ³digo em `sitechatbot/convenientetecnologia/public/ct.js`.
- **ReinÃ­cios**: `sitechatbot` (CT) â€” `node index.js`.
- **Rollback**: reverter alteraÃ§Ãµes no `ct.js`/endpoints/migraÃ§Ãµes e reiniciar CT.


#### 2026-02-03 â€” [DOCS][OPS] INBOX: remover duplicata que mantinha INC de migraÃ§Ãµes/cadastro como â€œin_progressâ€

- **O que**:
  - Removida a cÃ³pia duplicada do `INC-20260202-1600-01` que havia ficado em `docs/inbox/in_progress/` (o INC jÃ¡ estava corretamente em `docs/inbox/done/`).
  - Criada pasta `docs/inbox/need_evidence/` e movido `INC-20260201-0200-01` para lÃ¡ (ticket de RAM fica â€œpausadoâ€, sem parecer WIP ativo).
- **Por quÃª**: evitar confusÃ£o operacional (o humano via â€œem progressoâ€ um INC jÃ¡ encerrado).
- **EvidÃªncia**:
  - `C:\conveniente\docs\inbox\done\INC-20260202-1600-01.md`
  - removido: `C:\conveniente\docs\inbox\in_progress\INC-20260202-1600-01.md`
  - movido: `C:\conveniente\docs\inbox\need_evidence\INC-20260201-0200-01.md`
  - Ã­ndice: `C:\conveniente\docs\inbox\INDEX.md`
- **ReinÃ­cios**: nenhum
- **Rollback**: `git revert <commit>` (recria o arquivo removido; sem impacto em runtime)

#### 2026-02-02 â€” [CT][CROSS][FIX][OPS] Fonte Ãšnica (runtime): Virtus/Grupos + Contas Facebook passam a usar classificador canÃ´nico e UI explicita janela/supply

- **O que**:
  - `sitechatbot`: `/api/dashboard/virtus` e `/api/contas-facebook` passam a usar `computeAccountsByGroupFromSnapshots` (canÃ´nico) com `fbAccountState` para A/LR/LE/B.
  - `sitechatbot`: payload do Virtus inclui `groups.accountsMeta` (accountsMode/supplyMode/serversMeta) e UI Virtus mostra isso no topo (janela + supply + modo).
  - `sitechatbot`: UI Virtus corrige rÃ³tulo para `Contas (A/LR/LE/B)` (antes faltava LE no header).
- **Por quÃª**: garantir que CT â€œmostraâ€ exatamente a mesma verdade que CT â€œdecideâ€ (evita divergÃªncia P0).
- **EvidÃªncia**: `C:\sitechatbot\index.js` (`/api/dashboard/virtus`, `/api/contas-facebook`, `computeAccountsByGroupFromSnapshots`) + `C:\sitechatbot\public\virtus.js`.
- **ReinÃ­cios**: `sitechatbot` (CT) â€” humano reinicia com `node index.js`.
- **Rollback**: reverter alteraÃ§Ãµes no CT e reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-02-truth-single-source`

---

#### 2026-02-02 â€” [CROSS][DOCS][OPS] DossiÃª cidades/grupos: plano de implementaÃ§Ã£o auditÃ¡vel (warmup/LE/anti-pÃ¢nico)

- **O que**:
  - Consolidado plano executÃ¡vel (CT-only) para score Ãºnico por `cidade_uf` com guardrails: warmup 24h e LE por idade (12d).
  - Registrada evidÃªncia do contrato do `nome` do perfil (timestamp no sufixo) e knobs do anti-pÃ¢nico do CT (env vars).
- **Por quÃª**: garantir 110% de rastreabilidade antes de tocar em runtime.
- **EvidÃªncia**: `C:\conveniente\docs\inbox\done\INC-20260202-1600-01.md` + `C:\conveniente\scripts\api_perfis.js` + `C:\sitechatbot\index.js`.
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o/planejamento).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-02-02-city-score-plan`

---

#### 2026-02-03 â€” [CT][CROSS][FEAT][OPS] Cadastro (provisÃ£o) CT: rank por recent3d + remainingNeed (insight baixo amortecido por LE+pipeline)

- **O que**:
  - `sitechatbot`: `rankUrgentCityUFs()` passa a usar janela **recent3d** e prioriza **insight baixo** com amortecedor por `LE + pipelineW` (`remainingNeed`), evitando pÃ¢nico/overfit em uma cidade.
  - `sitechatbot`: `pickUrgentCityUF()` passa a reutilizar `rankUrgentCityUFs` (fallback consistente).
  - `sitechatbot`: mantÃ©m antiâ€‘pÃ¢nico existente (TOPâ€‘N + inflight cap + refresh) e continua â€œnunca pararâ€ quando houver estoque + vaga (scheduler).
- **Por quÃª**: cidades â€œfriasâ€ precisam de contas novas, mas o insight demora a reagir; o CT precisa descontar supply futuro (LE/provisÃµes recentes) para distribuir com lucidez.
- **EvidÃªncia**: `C:\sitechatbot\index.js` (`rankUrgentCityUFs`, `pickUrgentCityUF`, `pickNextCityUFForProvision`) + `C:\conveniente\docs\inbox\done\INC-20260202-1600-01.md`.
- **ReinÃ­cios**: `sitechatbot` (CT) â€” humano reinicia com `node index.js`.
- **Rollback**: restaurar lÃ³gica anterior em `rankUrgentCityUFs/pickUrgentCityUF` e reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-03-ct-provision-city-remaining-need`

---

#### 2026-02-03 â€” [CT][CROSS][FEAT][FIX][OPS] MigraÃ§Ãµes CT (V3): doador insight alto â†’ receptor insight baixo + pareamento corajoso (insight = recent3d)

- **O que**:
  - `sitechatbot`: `/api/contas-facebook-v2` passa a sugerir migraÃ§Ãµes com regra mestre V3: **doador = insight alto**, **receptor = insight baixo**, com `canDrainToZero` quando `donorInsight >= 2x avgInsight`.
  - `sitechatbot`: corrige a divergÃªncia de janela do **insight_percent**: agora usa **recent3d** (igual Virtus/Grupos) ao calcular `totalEngajamento` e `ratio` (antes estava em `sent_24h`).
  - `sitechatbot`: **corrige elegibilidade do doador no `/api/contas-facebook-v2/migrations/preview`** para nunca â€œmigrar LE por enganoâ€: a seleÃ§Ã£o passa a usar `fbAccountState.classify({ perfil, robeRec }).kind === 'ok'` (antes podia pegar `paused_limit` porque o `estado` nÃ£o estava espelhado em `p.robeEstado`).
  - Pareamento â€œcorajosoâ€ prioriza doadores mais quentes (config via `CT_MIG_DONOR_BONUS`, `CT_MIG_ALPHA`) e inclui `why` auditÃ¡vel em cada sugestÃ£o.
  - Continua **manual**: CT apenas sugere; execuÃ§Ã£o ainda Ã© via `/api/contas-facebook-v2/migrations/execute`.
- **Por quÃª**: evitar sugestÃµes erradas (ex.: tirar de cidade fria) e alinhar decisÃ£o com o que o humano aprovou na simulaÃ§Ã£o V3.
- **EvidÃªncia**: `C:\sitechatbot\index.js` (`/api/contas-facebook-v2` bloco migrations) + `INC-20260202-1600-01` (motor 1 migraÃ§Ã£o).
- **ReinÃ­cios**: `sitechatbot` (CT) â€” humano reinicia com `node index.js`.
- **Rollback**: reverter o bloco de migraÃ§Ãµes no endpoint e reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-03-ct-migrations-v3`

#### 2026-02-02 â€” [CROSS][DOCS][OPS] P0: Fonte Ãšnica da Verdade (CT Virtusâ†’Grupos vs Contas FB v2)

- **O que**:
  - Aberto INC P0 para unificar fonte da verdade entre dashboards e algoritmos (motoristas, engajamento e A/LR/LE/B).
  - Documentadas divergÃªncias atuais: janelas (recent3d vs rolling) e classificador simples (`p.estado`) vs canÃ´nico (`fbAccountState`).
- **Por quÃª**: evitar que humano veja uma coisa e o sistema decida outra (risco P0 de decisÃ£o errada).
- **EvidÃªncia**: `C:\conveniente\docs\inbox\done\INC-20260202-2000-01.md` + `C:\sitechatbot\index.js` (`/api/dashboard/virtus`, `/api/contas-facebook-v2`, `computeAccountsByGroupFromSnapshots`).
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o/planejamento).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-02-02-truth-single-source`

---

#### 2026-02-01 â€” [CONV][FEAT][OPS] Autopilot â€œTudo abertoâ€: toggle no painel + boot OFF + controle via desired

- **O que**:
  - `desired._autoOpen.enabled` controla o modo â€œTudo abertoâ€ (autopilot).
  - Boot do worker forÃ§a OFF para evitar reabertura automÃ¡tica apÃ³s restart.
  - `open-all-24h` liga o autopilot; `close-all` desliga; novo endpoint `POST /api/perfis/auto-open`.
  - `/api/status` passa a expor `autoOpen` e o painel mostra botÃ£o ON/OFF.
- **Por quÃª**: permitir abrir manualmente sem reabertura automÃ¡tica e manter controle explÃ­cito de â€œTudo abertoâ€.
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js`, `C:\conveniente\scripts\api_perfis.js`, `C:\conveniente\scripts\api_status.js`, `C:\conveniente\public\index.html`.
- **ReinÃ­cios**: `conveniente` (hosts).
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-auto-open-toggle`

---

#### 2026-02-01 â€” [CONV][FIX][OPS] Dashboard â€œTudo abertoâ€ nÃ£o atualizava estado

- **O que**:
  - `/api/status` agora inclui `autoOpen` no payload principal e no fallback de erro.
  - UI atualiza o botÃ£o â€œTudo abertoâ€ imediatamente apÃ³s o clique.
- **Por quÃª**: o botÃ£o ficava travado em OFF mesmo com autopilot ligado.
- **EvidÃªncia**: `C:\conveniente\scripts\api_status.js`, `C:\conveniente\public\index.html`.
- **ReinÃ­cios**: `conveniente` (hosts).
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-auto-open-toggle`

---

#### 2026-02-01 â€” [CONV][CT][CROSS][FEAT] CT/Servidores: contadores â€œLogin/Cookies falhouâ€ + â€œRecurso em anÃ¡liseâ€ + ordenaÃ§Ã£o OFFLINE primeiro

- **O que**:
  - `conveniente`: snapshot `status.json` passa a expor `loginRemediateFailed` em `status.perfis`.
  - `sitechatbot`: `GET /servers` agrega `flagsAgg.login_cookies_failed` e `flagsAgg.appeal_submitted`.
  - `sitechatbot`: UI do menu Servidores renderiza novos pills e o sort prioriza OFFLINE antes da capacidade.
- **Por quÃª**: dar visibilidade operacional exata no CT e manter lista estÃ¡vel (sem â€œdanÃ§arâ€).
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js` (snapshotStatusAndWrite), `C:\sitechatbot\index.js` (flagsAgg + sort), `C:\sitechatbot\public\index.html` (pills).
- **ReinÃ­cios**: `conveniente` (hosts) e `sitechatbot` (CT) apÃ³s deploy.
- **Rollback**: `git revert <hash>` em cada repo + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-ct-server-flags`

#### 2026-02-01 â€” [CONV][FIX][OPS] P0 total>ativos: impedir desativaÃ§Ã£o automÃ¡tica e manter perfis sempre ativos

- **O que**:
  - `open_all_finalize_partial` nÃ£o desativa mais `desired.active`; aplica backoff curto para reabrir quando houver RAM.
  - `nurseTick` reforÃ§a `desired.active=true` para perfis existentes (1x/min).
  - adiciona `OPEN_ALL_PARTIAL_BACKOFF_MS` (default 60s) para evitar loop agressivo.
- **Por quÃª**: evitar â€œbrowsers fechados sem motivoâ€ e garantir abertura contÃ­nua quando hÃ¡ RAM.
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js` (open_all_finalize_partial + nurseTick) + INC `INC-20260201-0300-01`.
- **ReinÃ­cios**: hosts `conveniente` apÃ³s deploy.
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-open-gaps`

#### 2026-02-01 â€” [CONV][FIX][OPS] Abrir Todos: nÃ£o bloquear abertura quando `loginRequired=captcha_*` ou `identityRequired` e browser fechado

- **O que**:
  - `nurseTick` deixa de dar `continue` em captcha/identidade quando `ctrl` estÃ¡ ausente; o perfil cai no fluxo normal `want.active && !ctrl` e o navegador abre.
  - Logs operacionais (sem segredos) no `provision_audit`: `nurse_captcha_required_no_ctrl_allow_open`, `nurse_identity_required_no_ctrl_allow_open`.
  - Removidas instrumentaÃ§Ãµes temporÃ¡rias desta rodada (POST local `127.0.0.1:7242`).
- **Por quÃª**: regra do negÃ³cio: â€œse estÃ¡ no servidor e tem `desired.active=true`, deve abrir â€” mesmo se estiver em captcha/identidade/appealâ€.
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js` + INC `INC-20260201-0300-01` + RM1 CT snapshot `C:\sitechatbot\dados\084c8fff-c508-47bd-a33e-3ab34aeb1e3d-*.json`.
- **ReinÃ­cios**: hosts `conveniente` apÃ³s deploy.
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-open-gaps`

#### 2026-01-31 â€” [CONV][FEAT][OPS] Captcha: implementa OCR Groq para resolver captchas automaticamente (ultra enterprise melhor do mundo)

- **O que**:
  - Adicionada funÃ§Ã£o `solveCaptchaWithGroq` em `scripts/browser.js` que extrai imagem do captcha via canvas, chama Groq API e processa resposta para retornar texto limpo.
  - Integrado OCR no fluxo de 3 tentativas em `runIdentityFlow`: extrai imagem, chama Groq, digita texto, verifica se botÃ£o "Continuar" ficou azul.
  - Se botÃ£o nÃ£o ficar azul apÃ³s digitar: reload para pegar nova imagem e tenta novamente (atÃ© 3 vezes).
  - Processamento robusto da resposta Groq: remove comentÃ¡rios/explicaÃ§Ãµes e extrai apenas o texto do captcha.
- **Por quÃª**: automatizar resoluÃ§Ã£o de captchas usando Groq OCR para reduzir necessidade de intervenÃ§Ã£o humana.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\browser.js` (`solveCaptchaWithGroq`, logs `captcha_flow_ocr_attempt`, `captcha_flow_fill_attempt`)
  - `C:\conveniente\scripts\worker.js` (integraÃ§Ã£o OCR no loop de 3 tentativas)
  - Commit: `2c9abe9` (feat: implementa OCR Groq para resolver captchas)
- **ReinÃ­cios**: `conveniente` (hosts) â€” humano reinicia com `node index.js`.
- **Rollback**: `git revert 2c9abe9` e reiniciar `node index.js`.

#### 2026-01-31 â€” [CONV][FIX][OPS] Identidade: remover cooldown do gate global (evita engessamento apÃ³s captcha)

- **O que**:
  - `IDENTITY_GATE.cooldownMinMs` e `cooldownMaxMs` zerados para permitir sequÃªncia imediata de fluxos de identidade (ainda 1 por vez no host).
- **Por quÃª**: evidÃªncia mostrou `identity_flow_gate_denied` por cooldown, travando contas na tela de identidade apÃ³s captcha.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\worker.js` (IDENTITY_GATE)
  - RM7 `provision_audit`: eventos `identity_gate_denied why=cooldown` + `identity_flow_gate_denied` (fetch `rm7_fetch_identity_stuck_1769899549740.json`)
- **ReinÃ­cios**: `conveniente` (hosts) â€” humano reinicia com `node index.js`.
- **Rollback**: reverter commit desta mudanÃ§a e reiniciar `node index.js`.

#### 2026-01-31 â€” [CONV][FIX][OPS] Pre-screen â€œConfirme que vocÃª Ã© humanoâ€: esperar â€œContinuarâ€ habilitar e nÃ£o invocar humano cedo

- **O que**:
  - Adicionado `waitForContinueEnabled` e usado no pre-screen.
  - Pre-screen nÃ£o entra em humano quando â€œContinuarâ€ estÃ¡ desabilitado; retorna e o nurse re-tenta com debounce.
- **Por quÃª**: evidÃªncia mostrou `continue_disabled` levando a humano cedo, mesmo sendo um estado transitÃ³rio do Facebook.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\browser.js` (`waitForContinueEnabled`)
  - `C:\conveniente\scripts\worker.js` (`captcha_flow_pre_screen_wait` / retorno `pre_screen_disabled`)
  - RM7 `provision_audit` (bundle CT: `rm7_fetch_sp_regression_1769899065677.json`)
- **ReinÃ­cios**: `conveniente` (hosts) â€” humano reinicia com `node index.js`.
- **Rollback**: reverter commit desta mudanÃ§a e reiniciar `node index.js`.

#### 2026-01-31 â€” [CONV][FIX][OPS] Captcha: tratar pre-screen "Confirme que vocÃª Ã© humano" + 3 tentativas antes de invocar humano (sem OCR implementado)

- **O que**:
  - `detectLoginRequired` passou a detectar `captcha_persona_pre_screen` (tela â€œconfirme que vocÃª Ã© humano para usar sua contaâ€) com sinais anti-falso-positivo.
  - Adicionados helpers em `scripts/browser.js` para clicar â€œContinuarâ€, detectar captcha (imagem+input) e preparar foco do input (sem OCR).
  - `login_remediate` e `runIdentityFlow` agora fazem **3 tentativas** (pre-screen click + captcha revalidar/click-se-habilitado/reload) antes de invocar humano.
- **Por quÃª**: evitar falso positivo e evitar â€œinvocar humano imediatoâ€ quando dÃ¡ para avanÃ§ar pelo menos o â€œContinuarâ€ e revalidar o estado.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\browser.js` (`captcha_persona_pre_screen`, `clickContinueByLabel`, `detectCaptchaChallenge`)
  - `C:\conveniente\scripts\worker.js` (eventos `captcha_flow_*`, `captcha_requires_human_after_3_tries`)
- **ReinÃ­cios**: `conveniente` (hosts) â€” humano reinicia com `node index.js`.
- **Rollback**: `git revert` do commit desta mudanÃ§a e reiniciar `node index.js`.

#### 2026-01-31 â€” [CROSS][CONV][CT][FEAT][OPS] Groq config: host auto-solicita e CT envia `set_groq_config` (persistente em `dados/groq_config.json`)

- **O que**:
  - Host (`conveniente`) passou a sinalizar `needsGroqConfig=true` quando faltar config e a aceitar comando `set_groq_config` para persistir em `C:\conveniente\dados\groq_config.json` (ignorado no git).
  - CT (`sitechatbot`) passou a enfileirar `set_groq_config` quando receber `/report` com `needsGroqConfig=true`, lendo `GROQ_API_KEY` e `GROQ_MODEL` do ambiente (modelo tem default).
- **Por quÃª**: permitir que cada host faÃ§a requisiÃ§Ã£o prÃ³pria ao Groq sem depender de `.env` no host e sem operaÃ§Ã£o manual por host.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\groqConfig.js`
  - `C:\conveniente\scripts\dashboard.js`
  - `C:\conveniente\.gitignore`
  - `C:\sitechatbot\index.js` (bloco AUTO-CONFIG GROQ no handler `/report`)
  - `C:\sitechatbot\convenientetecnologia\ct.env` (GROQ_MODEL)
- **ReinÃ­cios**:
  - `sitechatbot` (CT) â€” humano reinicia com `node index.js`
  - `conveniente` (hosts) â€” humano reinicia com `node index.js`
- **Rollback**: `git revert` do(s) commit(s) deste item e reiniciar `node index.js`.
- **THREAD**: `TH-2026-01-31-groq-config`

#### 2026-01-31 â€” [CONV][FIX][OPS] RM3: fila atÃ´mica para retry (governor_busy) nÃ£o travar em `configurando=true`

- **O que**:
  - `queueAutoLoginRemediate(...force=true)` agora persiste `autoLoginRemediate.force` (para retries).
  - `autoLoginRemediateTick` pode avanÃ§ar a fila mesmo com `ctrl.configurando=true` **somente** quando o item estÃ¡ `queued && force && nextAt<=now` e nÃ£o hÃ¡ `provisionLock` ativo (mantendo `humanControl` como hard-stop).
  - Removidas instrumentaÃ§Ãµes temporÃ¡rias de debug (`127.0.0.1:7242/ingest/...`) apÃ³s validaÃ§Ã£o.
- **Por quÃª**: o retry existia, mas era pulado por `configurando=true`, causando â€œsÃ³ 1 conta vaiâ€ / engessamento.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\worker.js` (`autoLoginRemediateTick`, `queueAutoLoginRemediate`)
  - RM3 `provision_audit` no CT: `C:\sitechatbot\dados\logs\5d7c3309-8581-4a50-a421-e6cbb52d8070\rm3_pa_tail_verify_20260131_01.json`
- **ReinÃ­cios**: `conveniente` (hosts afetados) â€” humano reinicia com `node index.js` quando for testar/validar runtime novo.
- **Rollback**: `git revert d1d84f8` e reiniciar `node index.js`.

#### 2026-01-30 â€” [CONV][FIX][OPS] Retomar trabalho: retry imediato quando governor ocupado

- **O que**:
  - Adicionado retry imediato (forÃ§ado) do `login_remediate` quando o governor estÃ¡ ocupado em `human-resume`.
  - Log de evidÃªncia `login_remediate_governor_retry_queued` para rastrear a re-fila.
- **Por quÃª**: evitar â€œengessamentoâ€ apÃ³s Retomar trabalho quando outro login_remediate estÃ¡ em andamento.
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js` (human-resume + auto_login_remediate queue)
- **ReinÃ­cios**: `conveniente` no RM3 (node index.js).
- **Rollback**: reverter commit `fix: honor human mode + login form` + retry governor (ou `git revert` do Ãºltimo commit).

#### 2026-01-30 â€” [CONV][FIX][OPS] Open-all/manual limpa flags de login antes do re-probe

- **O que**:
  - Na abertura (open_all/manual), limpa flags de login (`loginRequired`, `loginRemediateFailed`, `messengerPin`) e registra evento.
  - RevalidaÃ§Ã£o real continua via `probeHumanStateOnOpen`.
- **Por quÃª**: evitar UI â€œpresaâ€ com flags antigas e garantir reavaliaÃ§Ã£o do estado atual.
- **EvidÃªncia**: `C:\conveniente\scripts\worker.js` (eventos `open_clear_login_flags*`).
- **ReinÃ­cios**: `conveniente` no RM3 (node index.js).
- **Rollback**: reverter commit do ajuste de open flags.

#### 2026-01-30 â€” [CROSS][DOCS][OPS] INBOX: novo INC para â€œCT mostra OFFLINE falsoâ€ (RM3) + clarificaÃ§Ãµes hostId/telemetria

- **O que**:
  - Criado `INC-20260130-0905-01` (RM3 marcado OFFLINE no CT embora host esteja acessÃ­vel) para investigaÃ§Ã£o com evidÃªncia.
  - Registrado no `INBOX_RELATOS_DO_HUMANO.md` e no `docs/inbox/INDEX.md`.
  - Clarificado no `LIVRO_DE_BORDO.md` que `hostId` nÃ£o muda com restart; e que a telemetria `/report` Ã© enviada em loop (default 30s).
- **Por quÃª**: eliminar achismo (â€œmÃ¡quina onlineâ€ vs â€œCT recebendo `/report`â€) e tornar o estado auditÃ¡vel antes de qualquer refactor.
- **EvidÃªncia**:
  - `C:\conveniente\docs\inbox\cancelled\INC-20260130-0905-01.md` (movido para cancelled)
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
- **ReinÃ­cios**: nenhum (somente docs/triagem).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-30-ct-offline-triage`

#### 2026-01-30 â€” [CONV][CT][DOCS][OPS] Auditoria estrutural: conveniente + integraÃ§Ã£o CT

- **O que**:
  - Criado checkup de auditoria estrutural do `conveniente` + integraÃ§Ã£o com CT, com mapa de mÃ³dulos e riscos P1/P2.
  - Registrado plano de desengessamento (sem mudanÃ§a de runtime nesta rodada).
- **Por quÃª**: pedido explÃ­cito de auditoria â€œultra detalhadaâ€ para orientar correÃ§Ãµes sem achismo.
- **EvidÃªncia**: `C:\conveniente\docs\checkups\checkup_2026-01-30_auditoria_conveniente_ct.md`
- **ReinÃ­cios**: nenhum (documentaÃ§Ã£o).
- **Rollback**: reverter o arquivo `.md` (nÃ£o afeta runtime).

#### 2026-01-30 â€” [CT][CROSS][FIX][OPS] Servidores (CT): remover â€œDesconhecidoâ€ e expor flags acionÃ¡veis (Humano invocado + Outros (login))

- **O que**:
  - Estado `unknown` virou **`login_other`** (label humano: **Outros (login)**), mantendo `loginReason` para auditoria.
  - CT `/servers` passou a expor `flagsAgg` (ex.: `human_invoked`, `login_reasons_top`) para o dashboard ser fonte de verdade operacional.
  - UI â€œServidoresâ€ removeu pill â€œDesconhecidoâ€ e passou a mostrar **Humano invocado** + **Outros (login)** (com tooltip de `loginReason` top).
  - UI â€œcontas-facebook-contasâ€ alinhada para `login_other` (sem â€œDesconhecidoâ€).
- **Por quÃª**: o operador usa â€œServidoresâ€ para decidir qual host ir; â€œDesconhecidoâ€ nÃ£o Ã© acionÃ¡vel e quebra a confiabilidade do painel.
- **EvidÃªncia**:
  - `C:\sitechatbot\convenientetecnologia\lib\fbAccountState.js`
  - `C:\sitechatbot\index.js` (`GET /servers` â†’ `accountsAgg` + `flagsAgg`)
  - `C:\sitechatbot\public\index.html`
  - `C:\sitechatbot\convenientetecnologia\public\contas-facebook-contas.html`
  - Snapshot exemplo (motivo real): `C:\sitechatbot\dados\5d7c3309-...-30b3fe928b.json` contÃ©m `loginReason:"probe_failed"`
- **ReinÃ­cios**:
  - **CT (`sitechatbot`)**: **sim** â€” humano reinicia no host do CT com `node index.js`
  - **conveniente (hosts)**: **nÃ£o** (mudanÃ§a Ã© no CT/UI; docs do conveniente foram atualizadas via git)
- **Rollback**:
  - CT: restaurar arquivos via `C:\sitechatbot\_backup_auto_root\...` + reiniciar `node index.js`
  - conveniente: `git revert 976c6ef` (somente docs)
- **THREAD**: `TH-2026-01-30-ct-servers-states-flags`

#### 2026-01-30 â€” [CROSS][DOCS][OPS] INBOX: cancelar INC-20260130-0905-01 (RM3 OFFLINE falso) a pedido do humano

- **O que**:
  - Marcado `INC-20260130-0905-01` como `cancelled` e movido para `docs/inbox/cancelled/`.
  - Atualizados Ã­ndices (`docs/inbox/INDEX.md` e `INBOX_RELATOS_DO_HUMANO.md`) para nÃ£o deixar link quebrado.
- **Por quÃª**: cancelado a pedido do humano (decisÃ£o consciente).
- **EvidÃªncia**:
  - `C:\conveniente\docs\inbox\cancelled\INC-20260130-0905-01.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
- **ReinÃ­cios**: nenhum (somente docs).
- **Rollback**: `git revert <commit>` (nÃ£o afeta runtime).

#### 2026-01-29 â€” [CROSS][DOCS] OrganizaÃ§Ã£o inicial do conhecimento (bootstrap)

- **O que**:
  - Criado `docs/LIVRO_DE_BORDO.md` como Ã­ndice/porta de entrada.
  - Criado `docs/RUNBOOK_TECNICO.md` (procedimentos operacionais).
  - Criado `docs/TIMELINE.md` (este arquivo).
  - Criado `docs/checkup_geral_2026-01-29.md` com achados tÃ©cnicos.
- **Por quÃª**: evitar perda de contexto entre chats/GPTs e reduzir criaÃ§Ã£o de â€œcaminhos paralelosâ€.
- **EvidÃªncia**: arquivos em `C:\conveniente\docs\`.
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: remover os arquivos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-docs-bootstrap`

---

#### 2026-01-29 â€” [CONV][FIX][OPS] P1: `close_all` com timeout/retry e erro explÃ­cito (sem â€œfetch failedâ€ opaco)

- **O que**:
  - endurecido `httpJson()` no `dashboard.js` com timeout (AbortController) + retry leve + mensagem com URL/timeout.
  - `close_all` via comando agora usa timeout maior (atÃ© 15min) e seta `x-operator` com `cmdId` para rastreio.
- **Por quÃª**: logs do CT mostraram `close_all` falhando com `ackError: fetch failed` (erro opaco, sem contexto).
- **EvidÃªncia**:
  - CT: `C:\sitechatbot\dados\logs\bcf01e8d-82da-4d5d-aed0-d60305d4696d\ack_f941b889-b8d2-4823-a64e-4c507bc9df37.json`
  - cÃ³digo: `C:\conveniente\scripts\dashboard.js` (`httpJson`, `execCloseAll`)
- **Precisa reiniciar agora?** nÃ£o (dÃ¡ para continuar atualizando).
- **Precisa reiniciar para validar/testar?** sim (para o host aplicar a mudanÃ§a).
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert <commit>` e reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX][OPS] P1: `stock_provision` com evidÃªncia de â€œbusy_timeoutâ€ (busyDetails/pauseableDetails)

- **O que**:
  - ampliado snapshot de quiescÃªncia do `stock_provision` para incluir `busyDetails` e `pauseableVirtusDetails` (flags reais por perfil).
  - erro de timeout agora inclui `sample=` com nomes para diagnÃ³stico rÃ¡pido no CT.
- **Por quÃª**: logs do CT mostraram `stock_provision` falhando com `busy_timeout count=21` sem contexto do â€œpor quÃªâ€ cada perfil estava ocupado.
- **EvidÃªncia**:
  - CT: `C:\sitechatbot\dados\logs\bcf01e8d-82da-4d5d-aed0-d60305d4696d\ack_2f0461f7-db74-478d-a43a-0c83485abfbe.json`
  - cÃ³digo: `C:\conveniente\scripts\dashboard.js` (`execStockProvision` â†’ `computeQuiesceSnapshot`)
- **Precisa reiniciar agora?** nÃ£o
- **Precisa reiniciar para validar/testar?** sim
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert <commit>` e reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX][OPS] P1: evitar â€œsendLockActive presoâ€ (Virtus libera via Browser, nÃ£o via Page)

- **O que**:
  - `virtus.js`: `send-lock` agora Ã© adquirido/liberado usando o objeto `browser` diretamente (nÃ£o depende de `page.browser()`).
  - isso evita leak do lock quando a pÃ¡gina fecha/desconecta durante o fluxo do chat.
- **Por quÃª**: evidÃªncia no CT mostra muitos perfis com `sendLockActive=true`, o que dispara `busy_timeout` e bloqueia operaÃ§Ãµes crÃ­ticas (provisÃ£o/locks).
- **EvidÃªncia**:
  - CT snapshot: `C:\sitechatbot\dados\bcf01e8d-82da-4d5d-aed0-d60305d4696d-de8717d9f1.json` (vÃ¡rios `sendLockActive=true`)
  - CT ack: `C:\sitechatbot\dados\logs\bcf01e8d-82da-4d5d-aed0-d60305d4696d\ack_2f0461f7-db74-478d-a43a-0c83485abfbe.json` (`busy_timeout`)
  - cÃ³digo: `C:\conveniente\scripts\virtus.js` (`acquireSendGuardBrowser`, `releaseSendGuardBrowser`)
- **Precisa reiniciar agora?** nÃ£o
- **Precisa reiniciar para validar/testar?** sim
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert <commit>` e reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][DOCS] Achado P0 (ainda nÃ£o corrigido): lock nÃ£o owner-safe

- **O que**: identificado P0 de concorrÃªncia em lock de arquivo no `conveniente`.
- **Por quÃª**: `unlink` do lock pode acontecer mesmo sem adquirir o lock â‡’ risco de corrida/corrupÃ§Ã£o.
- **EvidÃªncia**: `docs/checkup_geral_2026-01-29.md` e `conveniente/scripts/fileStore.js`.
- **ReinÃ­cios**: nenhum (ainda nÃ£o alterado).
- **Rollback**: n/a (nÃ£o houve mudanÃ§a).

---

#### 2026-01-29 â€” [CONV][FIX] CorreÃ§Ã£o P0: lock owner-safe em `fileStore.js` + remove busy-wait (CPU)

- **O que**:
  - corrigido release de lock para **nÃ£o** remover `.lock` quando o lock nÃ£o foi adquirido.
  - adicionados metadados no lock (pid/ts/token) e recuperaÃ§Ã£o best-effort de lock â€œstaleâ€ por idade.
  - trocado busy-wait do lock de `perfis.json` por `Atomics.wait` (nÃ£o gasta CPU).
- **Por quÃª**: eliminar risco de corrida/corrupÃ§Ã£o em `desired.json`/`perfis.json` e reduzir congelos por contenÃ§Ã£o.
- **EvidÃªncia**: `C:\conveniente\scripts\fileStore.js` (seÃ§Ã£o de locks `desired.json`/`perfis.json`).
- **ReinÃ­cios**: **conveniente** (somente) â€” **humano** reinicia no host do `conveniente` (parar e rodar `node index.js`).
- **Rollback**: o GPT prepara rollback via Git (ex.: `git revert` / voltar tag). O humano aplica reiniciando `node index.js` no host do `conveniente`.

---

#### 2026-01-29 â€” [CONV][FIX] P1: deadline/logs no `ensureFreeMB` (sem espera infinita)

- **O que**: `ensureFreeMB()` no `conveniente/scripts/dashboard.js` deixou de esperar infinito; agora tem `timeoutMs`, logs de progresso e erro explÃ­cito no timeout.
- **Por quÃª**: regra canÃ´nica P1: nenhuma espera pode ser infinita.
- **EvidÃªncia**: `C:\conveniente\scripts\dashboard.js` (funÃ§Ã£o `ensureFreeMB`).
- **Precisa reiniciar agora?** nÃ£o (mudanÃ§a preventiva; sÃ³ â€œvaleâ€ no runtime apÃ³s restart).
- **Precisa reiniciar para validar/testar?** sim, se vocÃª quiser testar `ensureFreeMB` em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX] P1: auto-backup do `index.js` em subprocess (reduz freeze)

- **O que**: o snapshot automÃ¡tico (`CONVENIENTE_AUTO_BACKUP_*`) deixou de rodar com IO sÃ­ncrono pesado no processo principal; agora dispara um subprocesso (`scripts/autoBackupWorker.js`) para fazer o trabalho.
- **Por quÃª**: P1 â€” reduzir latÃªncia/congelos do `conveniente` sob stress.
- **EvidÃªncia**:
  - `C:\conveniente\index.js` (funÃ§Ã£o `startAutoBackupConveniente`)
  - `C:\conveniente\scripts\autoBackupWorker.js`
- **Precisa reiniciar agora?** nÃ£o (sÃ³ Ã© necessÃ¡rio quando vocÃª quiser o benefÃ­cio em runtime).
- **Precisa reiniciar para validar/testar?** sim, se vocÃª quiser observar â€œmenos freezeâ€ e confirmar que `_backup_auto/_snapshots.log` continua sendo gerado.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX] P1: auto-backup evita snapshots concorrentes (lock)

- **O que**: adicionado lock no worker de backup para impedir snapshots concorrentes quando um snapshot demora mais que o intervalo (e stale recovery).
- **Por quÃª**: reduzir IO/carga e evitar â€œpile-upâ€ de backups.
- **EvidÃªncia**: `C:\conveniente\scripts\autoBackupWorker.js` (lock `_snapshot_running.lock`).
- **Precisa reiniciar agora?** nÃ£o
- **Precisa reiniciar para validar/testar?** sim, se quiser observar o comportamento em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX] P1: logs/guardrails em waits de UI (browser/virtus)

- **O que**:
  - `browser.js`: `waitAny()` agora loga timeout quando `BROWSER_DEBUG=1`.
  - `browser.js`: loop de `identityAssistStep` ficou explicitamente bounded por budget/minTries (sem `while(true)`).
  - `virtus.js`: `assertOnChat` loga timeout quando `VIRTUS_DEBUG=1` (sÃ³ em timeout).
- **Por quÃª**: P1 â€” reduzir â€œtravou e nÃ£o sei ondeâ€ e garantir que waits sejam sempre bounded.
- **EvidÃªncia**:
  - `C:\conveniente\scripts\browser.js`
  - `C:\conveniente\scripts\virtus.js`
- **Precisa reiniciar agora?** nÃ£o
- **Precisa reiniciar para validar/testar?** sim, se quiser observar logs em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CONV][FIX] P1: handlers globais de erro (master/worker) + opÃ§Ã£o de exit

- **O que**: padronizado `uncaughtException`/`unhandledRejection` no master (`index.js`) e no worker (`scripts/worker.js`), com logs consistentes e opÃ§Ã£o `CONVENIENTE_FATAL_EXIT=1` para sair (evitar â€œseguir vivoâ€ corrompido).
- **Por quÃª**: P1 â€” polÃ­tica de erro consistente e auditÃ¡vel.
- **EvidÃªncia**:
  - `C:\conveniente\index.js`
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (baseline env)
- **Precisa reiniciar agora?** nÃ£o (sÃ³ Ã© necessÃ¡rio quando vocÃª quiser que isso passe a valer no runtime).
- **Precisa reiniciar para validar/testar?** sim, se quiser simular erro e ver o comportamento/log.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Inbox canÃ´nica para â€œtexto bombaâ€ do humano (triage P0/P1/P2)

- **O que**: criado canal canÃ´nico para intake/triage de relatos desorganizados do humano (colagem do texto bruto + decomposiÃ§Ã£o em itens + P0/P1/P2 + evidÃªncia).
- **EvidÃªncia**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seÃ§Ã£o â€œIntake de texto bomba do humanoâ€)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (link no Ã­ndice)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] INBOX: anÃ¡lise de impacto obrigatÃ³ria (callers/callees/efeitos colaterais)

- **O que**: reforÃ§ado que â€œtriagem inboxâ€ inclui **investigaÃ§Ã£o real** antes de mexer: mapear fluxo ponta a ponta e impactos (callers/callees/estados/efeitos colaterais).
- **EvidÃªncia**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (Mapa de impacto obrigatÃ³rio)
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (intake: anÃ¡lise de impacto)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] INBOX: â€œolhar o histÃ³rico primeiroâ€ (timeline + file_timeline)

- **O que**: padronizado que triagem inbox inclui checar histÃ³rico (TIMELINE + file_timeline/hotspots) para detectar regressÃ£o e evitar repetir erro.
- **EvidÃªncia**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (HistÃ³rico relacionado obrigatÃ³rio)
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (intake: olhar histÃ³rico)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] INBOX: perguntas obrigatÃ³rias (como deveria ser / sucesso)

- **O que**: triagem inbox agora exige perguntas item-a-item (â€œcomo deveria serâ€, â€œcritÃ©rio de sucessoâ€, prioridade) antes de qualquer correÃ§Ã£o.
- **EvidÃªncia**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Host registry (apelidos â†” hostId)

- **O que**: criado registro canÃ´nico para mapear apelidos humanos (â€œrobe mae 2â€) para `hostId` e facilitar coleta de logs via CT.
- **EvidÃªncia**: `C:\conveniente\docs\HOST_REGISTRY.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Host registry preenchido (CT aliases + snapshots)

- **O que**: preenchido `HOST_REGISTRY.md` automaticamente a partir de `C:\sitechatbot\dados\server_names.json` + snapshots do CT.
- **EvidÃªncia**:
  - `C:\sitechatbot\dados\server_names.json`
  - `C:\conveniente\docs\HOST_REGISTRY.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] INBOX: bloco de â€œregras nÃ£o negociÃ¡veisâ€ (humano/GPT)

- **O que**: adicionado bloco de regras nÃ£o negociÃ¡veis e lista de arquivos canÃ´nicos dentro do `INBOX_RELATOS_DO_HUMANO.md` para guiar triage em chats com relato confuso.
- **EvidÃªncia**: `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS] Checkup 3 (loops/timeouts/polling)

- **O que**:
  - Documentado contrato CTâ‡„Notificador (poll/ack).
  - Documentado canal de logs `*_secret` (requestId/response) no CT.
  - Registrada regra canÃ´nica anti â€œespera infinitaâ€ (deadlines/ACK/GC).
  - Registrado achado P1: risco de `while(true)` sem deadline (ex.: `ensureFreeMB` legado no `conveniente`).
- **EvidÃªncia**:
  - `docs/LIVRO_DE_BORDO.md`
  - `docs/RUNBOOK_TECNICO.md`
  - `docs/checkup_geral_2026-01-29.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o/auditoria).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-ops-contracts`

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Checklist canÃ´nico de release (P0/P1) no RUNBOOK

- **O que**: promovido checklist de â€œproduÃ§Ã£o real de atualizaÃ§Ãµesâ€ para o `RUNBOOK_TECNICO.md`, com gate explÃ­cito P0/P1 e links para evidÃªncias/auditorias.
- **Por quÃª**: garantir que qualquer GPT consiga atualizar sem achismo e sem â€œcaminhos paralelosâ€.
- **EvidÃªncia**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seÃ§Ã£o â€œChecklist de release / atualizaÃ§Ã£o (produÃ§Ã£o real) â€” CANÃ”NICOâ€)
  - `C:\conveniente\docs\checkup_geral_2026-01-29.md` (P0/P1)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-release-checklist-p0p1`

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Contrato humano/GPT (node manual) + `self_update` sem espera

- **O que**: reforÃ§ado contrato operacional: humano sÃ³ reinicia manualmente com `node index.js`; GPT nÃ£o â€œreinicia servidorâ€. Documentado comportamento real de `self_update` e regra de nÃ£o ficar esperando resposta.
- **EvidÃªncia**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seÃ§Ãµes â€œRegra humana (restart)â€ e â€œself_update (comando) â€” como funcionaâ€)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (regra humana)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] PowerShell gotchas (sem `&&`/heredoc) para commits/comandos

- **O que**: registrado â€œjeito certoâ€ de rodar comandos no Windows/PowerShell (ex.: nÃ£o usar `&&` e nÃ£o usar heredoc `<<EOF`) para evitar GPTs repetirem tentativa/erro.
- **EvidÃªncia**: `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seÃ§Ã£o â€œWindows/PowerShell â€” pegadinhas operacionaisâ€)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] VocabulÃ¡rio: â€œpullâ€ = `self_update` (CT)

- **O que**: padronizado vocabulÃ¡rio humano: quando o humano disser â€œpullâ€, significa disparar `self_update` via CT (equivalente a `git pull` no host).
- **EvidÃªncia**:
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS][OPS] Regra: â€œprecisa reiniciar agora?â€ vs â€œprecisa reiniciar para validarâ€

- **O que**: registrado que nem toda atualizaÃ§Ã£o exige restart imediato para continuar trabalhando; restart Ã© obrigatÃ³rio quando a mudanÃ§a precisa estar valendo no runtime (teste/validaÃ§Ã£o).
- **EvidÃªncia**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (checklist: â€œPrecisa reiniciar agora?â€ + regra de restart)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (regra de restart)
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).

---

#### 2026-01-29 â€” [CROSS][DOCS] ReconstruÃ§Ã£o retroativa (~10 dias) a partir de evidÃªncias (Git/backups/recovery)

- **O que**: reconstruÃ­do histÃ³rico dos Ãºltimos ~10 dias (conveniente/sitechatbot/notificador) usando Git, logs de backups e arquivos de recovery.
- **EvidÃªncia**: `C:\conveniente\docs\checkups\checkup_2026-01-29_reconstrucao_ultimos_10_dias.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-timeline`

---

#### 2026-01-29 â€” [CROSS][DOCS] Backfill nÃ­vel 2: Cursor timeline + planos/patches + backups recebidos

- **O que**: consolidado â€œrastro do Cursorâ€ (transcripts/terminals) + patches/diffs + manifests de backups recebidos pelo CT + scripts de rollback/prune.
- **Por quÃª**: transformar evidÃªncia espalhada (plans/backups/patches) em material pesquisÃ¡vel para debug e RCA.
- **EvidÃªncia**: `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_planos_patches.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-cursor-plans`

---

#### 2026-01-29 â€” [CROSS][DOCS] Backfill nÃ­vel 3: Cursor `agent-tools` (marcos reais: cmdId/requestId/git pull/push)

- **O que**: minerado `agent-tools/*.txt` do Cursor para recuperar marcos reais (ex.: `list_backups`, `bulk_gitpull_*`, `push_update`, scripts de start).
- **Por quÃª**: aumentar precisÃ£o de RCA/debug quando nÃ£o hÃ¡ Git em todos os projetos e o passado estÃ¡ â€œespalhadoâ€.
- **EvidÃªncia**: `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_agenttools.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-cursor-agenttools`

---

#### 2026-01-29 â€” [CROSS][DOCS] Timeline retroativa (09/01 â†’ hoje) (formato â€œem tempo realâ€)

- **O que**: criada timeline retroativa 2026-01-09 â†’ 2026-01-29 no formato â€œcomo se fosse em tempo realâ€, com THREADs e evidÃªncias (Git/backups/recovery/Cursor).
- **Por quÃª**: deixar o â€œpassadoâ€ rastreÃ¡vel para RCA/debug, sem confundir retroativo com o padrÃ£o de qualidade do â€œao vivoâ€.
- **EvidÃªncia**: `C:\conveniente\docs\checkups\checkup_2026-01-29_timeline_retroativa_2026-01-09_a_2026-01-29.md`
- **ReinÃ­cios**: nenhum (somente documentaÃ§Ã£o).
- **Rollback**: reverter alteraÃ§Ãµes nos `.md` (nÃ£o afeta runtime).
- **THREAD**: `TH-2026-01-29-retro-timeline-2026-01-09`

---

#### 2026-01-29 â€” [CONVENIENTE][P1] Status/CT: send-lock com metadados (owner/since/chatId) para diagnÃ³stico â€œbusyâ€

- **O que**: ampliado o snapshot de `perfis` no `worker.js` para incluir `sendLockOwner`, `sendLockChatId`, `sendLockSince`, `sendLockAgeMs` (alÃ©m de `sendLockActive`).
- **Por quÃª**: quando existe `busy_timeout`, agora dÃ¡ para provar *quem* segurou o send-lock e hÃ¡ quanto tempo, sem achismo e sem depender de logs ad-hoc.
- **Arquivos**: `C:\conveniente\scripts\worker.js`
- **ReinÃ­cios**: `conveniente` (para o runtime novo expor os campos no `/api/status` e no CT).
- **Rollback**: `git revert <commit>` (remove apenas campos extras do status; nÃ£o altera fluxo Robe/Virtus).
- **THREAD**: `TH-2026-01-29-sendlock-status-meta`

---

#### 2026-01-29 â€” [CONVENIENTE][P1] Varredura final: loops/waits de UI sem deadline (robe/virtus/browser)

- **O que**: verificado que `scripts/browser.js`, `scripts/robe.js`, `scripts/robeVeiculos.js` nÃ£o possuem `while(true)`/`for(;;)`; os loops crÃ­ticos de UI existentes estÃ£o bounded por budget/timeout e (quando debug habilitado) jÃ¡ emitem logs em timeout nos helpers relevantes.
- **Por quÃª**: reduzir risco de â€œtravou para sempreâ€ por UI/espera infinita (sem mexer em comportamento quando estÃ¡ saudÃ¡vel).
- **Arquivos**: `C:\conveniente\scripts\browser.js`, `C:\conveniente\scripts\robe.js`, `C:\conveniente\scripts\robeVeiculos.js`
- **ReinÃ­cios**: nenhum (apenas validaÃ§Ã£o/auditoria).
- **THREAD**: `TH-2026-01-29-ui-loop-audit`

---

#### 2026-01-29 â€” [CONVENIENTE][P2][DOCS] Baseline de logging de produÃ§Ã£o (clarificaÃ§Ãµes)

- **O que**: clarificado no runbook que `LOG_TO_FILE=1` escreve em `C:\conveniente\dados\logger.log` e que o `logger.js` assume debug ligado por default (recomendaÃ§Ã£o: `LOG_DEBUG=0`/`DEBUG=0`), com nota de rotaÃ§Ã£o manual do arquivo.
- **Por quÃª**: reduzir ruÃ­do em produÃ§Ã£o e deixar o caminho de evidÃªncia/arquivos explÃ­cito.
- **Arquivos**: `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **ReinÃ­cios**: nenhum (doc).
- **THREAD**: `TH-2026-01-29-prod-logging-baseline`

---

#### 2026-01-29 â€” [CONVENIENTE][P2] CT: `health_bundle` + `rotate_logs` (coleta rÃ¡pida + rotaÃ§Ã£o de `logger.log`)

- **O que**:
  - adicionado comando `health_bundle` (1 requestId â†’ resumo de status + manifest do allowlist; tails opt-in).
  - adicionado comando `rotate_logs` (rotaciona `logger.log` para `dados/logs/` e mantÃ©m N arquivos).
- **Por quÃª**: acelerar investigaÃ§Ã£o (menos â€œida e voltaâ€) e evitar crescimento infinito do `dados/logger.log`.
- **Arquivos**:
  - `C:\conveniente\scripts\dashboard.js`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **ReinÃ­cios**: `conveniente` (para o host aceitar os novos tipos de comando).
- **Rollback**: `git revert <commit>` (remove comandos; nÃ£o afeta Robe/Virtus).
- **THREAD**: `TH-2026-01-29-health-bundle-rotate-logs`

---

#### 2026-01-29 â€” [CONVENIENTE][OPS] RM4: humano precisou `git pull` (self_update nÃ£o foi enviado) + validaÃ§Ã£o com evidÃªncia CT

- **Relato humano**: apÃ³s restart no **ROBE MÃƒE 4**, foi necessÃ¡rio `git pull` manual no host (o `self_update` nÃ£o foi disparado pelo GPT).
- **EvidÃªncia (CT)**:
  - `C:\sitechatbot\dados\commands.log`: nÃ£o hÃ¡ `enqueue` recente de `self_update` para `825a4485-1465-4c11-aa18-52f0597b23a3` no recorte do incidente.
  - ValidaÃ§Ã£o pÃ³s-restart:
    - `health_bundle` ACK ok: `C:\sitechatbot\dados\logs\825a4485-1465-4c11-aa18-52f0597b23a3\ack_c9475bed-3a3f-4cfd-89d9-fa244e7dcb81.json`
    - resposta do bundle: `C:\sitechatbot\dados\logs\825a4485-1465-4c11-aa18-52f0597b23a3\hb_1769726532463.json`
    - `git_main_ref` confirma commit no disco: `00cb4b38cc1c16535a82574d697d17833f25e11e` (arquivo `git_1769726532463.json`).
  - Fluxo `self_update` verificado (prova de que funciona via CT):
    - comando: `self_update` cmdId `de8dd0e9-9b0d-41d2-b519-dc41bc111361` (ACK ok em `ack_de8dd0e9-...json`)
    - `updates.jsonl` contÃ©m `requestId:"verify_self_update_1769726589134"` (via `updates_1769726606544.json`).
- **AÃ§Ã£o**: runbook/livro atualizados para exigir **evidÃªncia mÃ­nima** do `self_update` (enqueue/deliver/ack + ack file) e registrar exceÃ§Ã£o quando humano precisar fazer `git pull`.
- **THREAD**: `TH-2026-01-29-rm4-manual-gitpull`

---

#### 2026-01-29 â€” [CONVENIENTE][P1] `stock_provision`: alinhar timeout HTTP local com `login_remediate` (evita abort 8s)

- **O que**: `execStockProvision` agora passa `timeoutMs` explÃ­cito (maior) nos steps longos (`activate` e principalmente `login_remediate`).
- **Por quÃª**: evidÃªncia real mostrou `login_remediate` abortando por timeout HTTP local de ~8s, apesar do worker usar `totalTimeoutMs=8min`, gerando falhas em massa do provision.
- **EvidÃªncia (CT)**:
  - RM2: `busy_timeout` (host ocupado) em `ack_20580076-ce15-4ff6-a54f-580afd80aeed.json` (step `quiesce_busy_done` com `busyCount=23`).
  - RM4: `login_remediate_fail` repetido com `timeoutMs=8000` em `ack_b69aa71e-714f-43eb-a48c-421dc4ca60df.json`.
- **Arquivos**: `C:\conveniente\scripts\dashboard.js`
- **ReinÃ­cios**: `conveniente` (para o runtime novo aplicar os timeouts).
- **Rollback**: `git revert <commit>` (retorna para timeout padrÃ£o).
- **THREAD**: `TH-2026-01-29-stock-provision-local-timeout`

---

#### 2026-01-29 â€” [CONVENIENTE][P1] `stock_provision`: modo â€œesperar busy mais tempoâ€ (budget/waitBusy defaults)

- **O que**: aumentados os defaults de:
  - `STOCK_PROVISION_BUDGET_MS` (para 20min)
  - `STOCK_PROVISION_WAIT_BUSY_MS` (para 10min)
  - `STOCK_PROVISION_WAIT_PAUSE_MS` (para 2min)
- **Por quÃª**: alinhamento com o operador (humano): Ã© mais seguro esperar ocupaÃ§Ã£o terminar do que falhar rÃ¡pido; no timeout, o histÃ³rico registra erro e o loop de guard re-tenta depois.
- **Arquivos**: `C:\conveniente\scripts\dashboard.js`
- **ReinÃ­cios**: `conveniente` (para runtime novo aplicar defaults).
- **Rollback**: `git revert <commit>` (volta para defaults anteriores).
- **THREAD**: `TH-2026-01-29-stock-provision-wait-busy-policy`

---

#### 2026-01-29 â€” [CONVENIENTE][DOCS] INBOX: banco de relatos por arquivo (1 INC por relato) + Ã­ndice

- **O que**: `INBOX_RELATOS_DO_HUMANO.md` permanece como â€œentradaâ€, e cada incidente triado ganha arquivo em `docs/inbox/` com Ã­ndice.
- **Por quÃª**: manter histÃ³rico pesquisÃ¡vel (â€œbanco de relatosâ€) sem inflar o arquivo de entrada.
- **Arquivos**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\inbox\INC-20260129-2100-01.md`
- **ReinÃ­cios**: nenhum (docs).
- **THREAD**: `TH-2026-01-29-inbox-archive-per-inc`

---

#### 2026-01-29 â€” [CONVENIENTE][P1] Abrir/Fechar (painel): â€œFechar Todosâ€ nÃ£o pode reabrir; â€œAbrir Todos 24hâ€ modo seguro + lock renovÃ¡vel

- **Sintoma (humano)**: clicar â€œFechar Todosâ€ era lento e â€œbrigavaâ€ com o sistema (reabria durante o fechamento); â€œAbrir Todosâ€ gerava concorrÃªncia/travamentos e Ã s vezes parecia abrir sozinho apÃ³s restart.
- **Causa raiz**:
  - Painel fazia `deactivate` perfil-a-perfil sem o passo atÃ´mico `desired.active=false` para todos â†’ `nurseTick` via `desired.active=true` e podia reabrir.
- **CorreÃ§Ãµes**:
  - Painel passou a chamar endpoints canÃ´nicos:
    - `POST /api/perfis/close-all` (modo seguro; corta reabertura via desired)
    - `POST /api/perfis/open-all-24h` (modo seguro)
  - `open-all-24h`: TTL do `provision_lock` virou **curto e renovÃ¡vel** (`OPEN_ALL_LOCK_TTL_MS`, default 2min) com keepalive por shard no `nurseTick`, e finalizaÃ§Ã£o automÃ¡tica ao expirar.
  - `provision_lock.meta.kind`: `stock_provision` nÃ£o pausa Virtus globalmente; pausa sÃ³ em `open_all_map`/`close_all`.
- **EvidÃªncia (CT)**:
  - RM4 `provision_audit`: eventos `close_all_api_called` + `worker_hard_close_*` confirmam endpoint canÃ´nico.
- **Arquivos**:
  - `C:\conveniente\public\index.html`
  - `C:\conveniente\scripts\api_perfis.js`
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\scripts\dashboard.js`
- **ReinÃ­cios**: `conveniente` (para runtime novo aplicar).
- **THREAD**: `TH-2026-01-29-open-close-all-governance`
