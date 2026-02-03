### Timeline — mudanças (mais novo em cima)

Regra: toda mudança relevante entra aqui com:
- tags (projeto/área),
- o que mudou,
- por que mudou,
- evidência (arquivo/endpoint/log),
- impacto operacional (reinícios),
- rollback.

Tags (modelo A = timeline única):
- `[CONV]`: conveniente
- `[CT]`: sitechatbot / CT
- `[NOTIF]`: notificador
- `[CROSS]`: envolve 2+ sistemas (sempre use junto com as tags de cada sistema)
- `[DOCS]`: documentação/organização (sem runtime)
- `[OPS]`: operação (procedimentos/rollback/restart)

Quando for “a mesma iniciativa” em mais de um sistema, usar um identificador:
- `THREAD=TH-YYYY-MM-DD-slug-curto`

Formato canônico (copiar/colar):

- `#### YYYY-MM-DD — [TAGS...] Título curto`
- **O que**: 1–5 bullets (sem detalhe excessivo)
- **Por quê**: 1 frase
- **Evidência**: caminho de arquivo / endpoint / log (ou “ver checkup X”)
- **Reinícios**: quais serviços/nodes precisam reiniciar (ou “nenhum”)
- **Rollback**: como desfazer (1–2 linhas)
- **THREAD**: `TH-...` (somente quando `[CROSS]`)

---

#### 2026-02-03 — [DOCS][OPS] INBOX: remover duplicata que mantinha INC de migrações/cadastro como “in_progress”

- **O que**:
  - Removida a cópia duplicada do `INC-20260202-1600-01` que havia ficado em `docs/inbox/in_progress/` (o INC já estava corretamente em `docs/inbox/done/`).
  - Criada pasta `docs/inbox/need_evidence/` e movido `INC-20260201-0200-01` para lá (ticket de RAM fica “pausado”, sem parecer WIP ativo).
- **Por quê**: evitar confusão operacional (o humano via “em progresso” um INC já encerrado).
- **Evidência**:
  - `C:\conveniente\docs\inbox\done\INC-20260202-1600-01.md`
  - removido: `C:\conveniente\docs\inbox\in_progress\INC-20260202-1600-01.md`
  - movido: `C:\conveniente\docs\inbox\need_evidence\INC-20260201-0200-01.md`
  - índice: `C:\conveniente\docs\inbox\INDEX.md`
- **Reinícios**: nenhum
- **Rollback**: `git revert <commit>` (recria o arquivo removido; sem impacto em runtime)

#### 2026-02-02 — [CT][CROSS][FIX][OPS] Fonte Única (runtime): Virtus/Grupos + Contas Facebook passam a usar classificador canônico e UI explicita janela/supply

- **O que**:
  - `sitechatbot`: `/api/dashboard/virtus` e `/api/contas-facebook` passam a usar `computeAccountsByGroupFromSnapshots` (canônico) com `fbAccountState` para A/LR/LE/B.
  - `sitechatbot`: payload do Virtus inclui `groups.accountsMeta` (accountsMode/supplyMode/serversMeta) e UI Virtus mostra isso no topo (janela + supply + modo).
  - `sitechatbot`: UI Virtus corrige rótulo para `Contas (A/LR/LE/B)` (antes faltava LE no header).
- **Por quê**: garantir que CT “mostra” exatamente a mesma verdade que CT “decide” (evita divergência P0).
- **Evidência**: `C:\sitechatbot\index.js` (`/api/dashboard/virtus`, `/api/contas-facebook`, `computeAccountsByGroupFromSnapshots`) + `C:\sitechatbot\public\virtus.js`.
- **Reinícios**: `sitechatbot` (CT) — humano reinicia com `node index.js`.
- **Rollback**: reverter alterações no CT e reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-02-truth-single-source`

---

#### 2026-02-02 — [CROSS][DOCS][OPS] Dossiê cidades/grupos: plano de implementação auditável (warmup/LE/anti-pânico)

- **O que**:
  - Consolidado plano executável (CT-only) para score único por `cidade_uf` com guardrails: warmup 24h e LE por idade (12d).
  - Registrada evidência do contrato do `nome` do perfil (timestamp no sufixo) e knobs do anti-pânico do CT (env vars).
- **Por quê**: garantir 110% de rastreabilidade antes de tocar em runtime.
- **Evidência**: `C:\conveniente\docs\inbox\done\INC-20260202-1600-01.md` + `C:\conveniente\scripts\api_perfis.js` + `C:\sitechatbot\index.js`.
- **Reinícios**: nenhum (somente documentação/planejamento).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-02-02-city-score-plan`

---

#### 2026-02-03 — [CT][CROSS][FEAT][OPS] Cadastro (provisão) CT: rank por recent3d + remainingNeed (insight baixo amortecido por LE+pipeline)

- **O que**:
  - `sitechatbot`: `rankUrgentCityUFs()` passa a usar janela **recent3d** e prioriza **insight baixo** com amortecedor por `LE + pipelineW` (`remainingNeed`), evitando pânico/overfit em uma cidade.
  - `sitechatbot`: `pickUrgentCityUF()` passa a reutilizar `rankUrgentCityUFs` (fallback consistente).
  - `sitechatbot`: mantém anti‑pânico existente (TOP‑N + inflight cap + refresh) e continua “nunca parar” quando houver estoque + vaga (scheduler).
- **Por quê**: cidades “frias” precisam de contas novas, mas o insight demora a reagir; o CT precisa descontar supply futuro (LE/provisões recentes) para distribuir com lucidez.
- **Evidência**: `C:\sitechatbot\index.js` (`rankUrgentCityUFs`, `pickUrgentCityUF`, `pickNextCityUFForProvision`) + `C:\conveniente\docs\inbox\done\INC-20260202-1600-01.md`.
- **Reinícios**: `sitechatbot` (CT) — humano reinicia com `node index.js`.
- **Rollback**: restaurar lógica anterior em `rankUrgentCityUFs/pickUrgentCityUF` e reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-03-ct-provision-city-remaining-need`

---

#### 2026-02-03 — [CT][CROSS][FEAT][FIX][OPS] Migrações CT (V3): doador insight alto → receptor insight baixo + pareamento corajoso (insight = recent3d)

- **O que**:
  - `sitechatbot`: `/api/contas-facebook-v2` passa a sugerir migrações com regra mestre V3: **doador = insight alto**, **receptor = insight baixo**, com `canDrainToZero` quando `donorInsight >= 2x avgInsight`.
  - `sitechatbot`: corrige a divergência de janela do **insight_percent**: agora usa **recent3d** (igual Virtus/Grupos) ao calcular `totalEngajamento` e `ratio` (antes estava em `sent_24h`).
  - `sitechatbot`: **corrige elegibilidade do doador no `/api/contas-facebook-v2/migrations/preview`** para nunca “migrar LE por engano”: a seleção passa a usar `fbAccountState.classify({ perfil, robeRec }).kind === 'ok'` (antes podia pegar `paused_limit` porque o `estado` não estava espelhado em `p.robeEstado`).
  - Pareamento “corajoso” prioriza doadores mais quentes (config via `CT_MIG_DONOR_BONUS`, `CT_MIG_ALPHA`) e inclui `why` auditável em cada sugestão.
  - Continua **manual**: CT apenas sugere; execução ainda é via `/api/contas-facebook-v2/migrations/execute`.
- **Por quê**: evitar sugestões erradas (ex.: tirar de cidade fria) e alinhar decisão com o que o humano aprovou na simulação V3.
- **Evidência**: `C:\sitechatbot\index.js` (`/api/contas-facebook-v2` bloco migrations) + `INC-20260202-1600-01` (motor 1 migração).
- **Reinícios**: `sitechatbot` (CT) — humano reinicia com `node index.js`.
- **Rollback**: reverter o bloco de migrações no endpoint e reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-03-ct-migrations-v3`

#### 2026-02-02 — [CROSS][DOCS][OPS] P0: Fonte Única da Verdade (CT Virtus→Grupos vs Contas FB v2)

- **O que**:
  - Aberto INC P0 para unificar fonte da verdade entre dashboards e algoritmos (motoristas, engajamento e A/LR/LE/B).
  - Documentadas divergências atuais: janelas (recent3d vs rolling) e classificador simples (`p.estado`) vs canônico (`fbAccountState`).
- **Por quê**: evitar que humano veja uma coisa e o sistema decida outra (risco P0 de decisão errada).
- **Evidência**: `C:\conveniente\docs\inbox\done\INC-20260202-2000-01.md` + `C:\sitechatbot\index.js` (`/api/dashboard/virtus`, `/api/contas-facebook-v2`, `computeAccountsByGroupFromSnapshots`).
- **Reinícios**: nenhum (somente documentação/planejamento).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-02-02-truth-single-source`

---

#### 2026-02-01 — [CONV][FEAT][OPS] Autopilot “Tudo aberto”: toggle no painel + boot OFF + controle via desired

- **O que**:
  - `desired._autoOpen.enabled` controla o modo “Tudo aberto” (autopilot).
  - Boot do worker força OFF para evitar reabertura automática após restart.
  - `open-all-24h` liga o autopilot; `close-all` desliga; novo endpoint `POST /api/perfis/auto-open`.
  - `/api/status` passa a expor `autoOpen` e o painel mostra botão ON/OFF.
- **Por quê**: permitir abrir manualmente sem reabertura automática e manter controle explícito de “Tudo aberto”.
- **Evidência**: `C:\conveniente\scripts\worker.js`, `C:\conveniente\scripts\api_perfis.js`, `C:\conveniente\scripts\api_status.js`, `C:\conveniente\public\index.html`.
- **Reinícios**: `conveniente` (hosts).
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-auto-open-toggle`

---

#### 2026-02-01 — [CONV][FIX][OPS] Dashboard “Tudo aberto” não atualizava estado

- **O que**:
  - `/api/status` agora inclui `autoOpen` no payload principal e no fallback de erro.
  - UI atualiza o botão “Tudo aberto” imediatamente após o clique.
- **Por quê**: o botão ficava travado em OFF mesmo com autopilot ligado.
- **Evidência**: `C:\conveniente\scripts\api_status.js`, `C:\conveniente\public\index.html`.
- **Reinícios**: `conveniente` (hosts).
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-auto-open-toggle`

---

#### 2026-02-01 — [CONV][CT][CROSS][FEAT] CT/Servidores: contadores “Login/Cookies falhou” + “Recurso em análise” + ordenação OFFLINE primeiro

- **O que**:
  - `conveniente`: snapshot `status.json` passa a expor `loginRemediateFailed` em `status.perfis`.
  - `sitechatbot`: `GET /servers` agrega `flagsAgg.login_cookies_failed` e `flagsAgg.appeal_submitted`.
  - `sitechatbot`: UI do menu Servidores renderiza novos pills e o sort prioriza OFFLINE antes da capacidade.
- **Por quê**: dar visibilidade operacional exata no CT e manter lista estável (sem “dançar”).
- **Evidência**: `C:\conveniente\scripts\worker.js` (snapshotStatusAndWrite), `C:\sitechatbot\index.js` (flagsAgg + sort), `C:\sitechatbot\public\index.html` (pills).
- **Reinícios**: `conveniente` (hosts) e `sitechatbot` (CT) após deploy.
- **Rollback**: `git revert <hash>` em cada repo + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-ct-server-flags`

#### 2026-02-01 — [CONV][FIX][OPS] P0 total>ativos: impedir desativação automática e manter perfis sempre ativos

- **O que**:
  - `open_all_finalize_partial` não desativa mais `desired.active`; aplica backoff curto para reabrir quando houver RAM.
  - `nurseTick` reforça `desired.active=true` para perfis existentes (1x/min).
  - adiciona `OPEN_ALL_PARTIAL_BACKOFF_MS` (default 60s) para evitar loop agressivo.
- **Por quê**: evitar “browsers fechados sem motivo” e garantir abertura contínua quando há RAM.
- **Evidência**: `C:\conveniente\scripts\worker.js` (open_all_finalize_partial + nurseTick) + INC `INC-20260201-0300-01`.
- **Reinícios**: hosts `conveniente` após deploy.
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-open-gaps`

#### 2026-02-01 — [CONV][FIX][OPS] Abrir Todos: não bloquear abertura quando `loginRequired=captcha_*` ou `identityRequired` e browser fechado

- **O que**:
  - `nurseTick` deixa de dar `continue` em captcha/identidade quando `ctrl` está ausente; o perfil cai no fluxo normal `want.active && !ctrl` e o navegador abre.
  - Logs operacionais (sem segredos) no `provision_audit`: `nurse_captcha_required_no_ctrl_allow_open`, `nurse_identity_required_no_ctrl_allow_open`.
  - Removidas instrumentações temporárias desta rodada (POST local `127.0.0.1:7242`).
- **Por quê**: regra do negócio: “se está no servidor e tem `desired.active=true`, deve abrir — mesmo se estiver em captcha/identidade/appeal”.
- **Evidência**: `C:\conveniente\scripts\worker.js` + INC `INC-20260201-0300-01` + RM1 CT snapshot `C:\sitechatbot\dados\084c8fff-c508-47bd-a33e-3ab34aeb1e3d-*.json`.
- **Reinícios**: hosts `conveniente` após deploy.
- **Rollback**: `git revert <hash>` + reiniciar `node index.js`.
- **THREAD**: `TH-2026-02-01-open-gaps`

#### 2026-01-31 — [CONV][FEAT][OPS] Captcha: implementa OCR Groq para resolver captchas automaticamente (ultra enterprise melhor do mundo)

- **O que**:
  - Adicionada função `solveCaptchaWithGroq` em `scripts/browser.js` que extrai imagem do captcha via canvas, chama Groq API e processa resposta para retornar texto limpo.
  - Integrado OCR no fluxo de 3 tentativas em `runIdentityFlow`: extrai imagem, chama Groq, digita texto, verifica se botão "Continuar" ficou azul.
  - Se botão não ficar azul após digitar: reload para pegar nova imagem e tenta novamente (até 3 vezes).
  - Processamento robusto da resposta Groq: remove comentários/explicações e extrai apenas o texto do captcha.
- **Por quê**: automatizar resolução de captchas usando Groq OCR para reduzir necessidade de intervenção humana.
- **Evidência**:
  - `C:\conveniente\scripts\browser.js` (`solveCaptchaWithGroq`, logs `captcha_flow_ocr_attempt`, `captcha_flow_fill_attempt`)
  - `C:\conveniente\scripts\worker.js` (integração OCR no loop de 3 tentativas)
  - Commit: `2c9abe9` (feat: implementa OCR Groq para resolver captchas)
- **Reinícios**: `conveniente` (hosts) — humano reinicia com `node index.js`.
- **Rollback**: `git revert 2c9abe9` e reiniciar `node index.js`.

#### 2026-01-31 — [CONV][FIX][OPS] Identidade: remover cooldown do gate global (evita engessamento após captcha)

- **O que**:
  - `IDENTITY_GATE.cooldownMinMs` e `cooldownMaxMs` zerados para permitir sequência imediata de fluxos de identidade (ainda 1 por vez no host).
- **Por quê**: evidência mostrou `identity_flow_gate_denied` por cooldown, travando contas na tela de identidade após captcha.
- **Evidência**:
  - `C:\conveniente\scripts\worker.js` (IDENTITY_GATE)
  - RM7 `provision_audit`: eventos `identity_gate_denied why=cooldown` + `identity_flow_gate_denied` (fetch `rm7_fetch_identity_stuck_1769899549740.json`)
- **Reinícios**: `conveniente` (hosts) — humano reinicia com `node index.js`.
- **Rollback**: reverter commit desta mudança e reiniciar `node index.js`.

#### 2026-01-31 — [CONV][FIX][OPS] Pre-screen “Confirme que você é humano”: esperar “Continuar” habilitar e não invocar humano cedo

- **O que**:
  - Adicionado `waitForContinueEnabled` e usado no pre-screen.
  - Pre-screen não entra em humano quando “Continuar” está desabilitado; retorna e o nurse re-tenta com debounce.
- **Por quê**: evidência mostrou `continue_disabled` levando a humano cedo, mesmo sendo um estado transitório do Facebook.
- **Evidência**:
  - `C:\conveniente\scripts\browser.js` (`waitForContinueEnabled`)
  - `C:\conveniente\scripts\worker.js` (`captcha_flow_pre_screen_wait` / retorno `pre_screen_disabled`)
  - RM7 `provision_audit` (bundle CT: `rm7_fetch_sp_regression_1769899065677.json`)
- **Reinícios**: `conveniente` (hosts) — humano reinicia com `node index.js`.
- **Rollback**: reverter commit desta mudança e reiniciar `node index.js`.

#### 2026-01-31 — [CONV][FIX][OPS] Captcha: tratar pre-screen "Confirme que você é humano" + 3 tentativas antes de invocar humano (sem OCR implementado)

- **O que**:
  - `detectLoginRequired` passou a detectar `captcha_persona_pre_screen` (tela “confirme que você é humano para usar sua conta”) com sinais anti-falso-positivo.
  - Adicionados helpers em `scripts/browser.js` para clicar “Continuar”, detectar captcha (imagem+input) e preparar foco do input (sem OCR).
  - `login_remediate` e `runIdentityFlow` agora fazem **3 tentativas** (pre-screen click + captcha revalidar/click-se-habilitado/reload) antes de invocar humano.
- **Por quê**: evitar falso positivo e evitar “invocar humano imediato” quando dá para avançar pelo menos o “Continuar” e revalidar o estado.
- **Evidência**:
  - `C:\conveniente\scripts\browser.js` (`captcha_persona_pre_screen`, `clickContinueByLabel`, `detectCaptchaChallenge`)
  - `C:\conveniente\scripts\worker.js` (eventos `captcha_flow_*`, `captcha_requires_human_after_3_tries`)
- **Reinícios**: `conveniente` (hosts) — humano reinicia com `node index.js`.
- **Rollback**: `git revert` do commit desta mudança e reiniciar `node index.js`.

#### 2026-01-31 — [CROSS][CONV][CT][FEAT][OPS] Groq config: host auto-solicita e CT envia `set_groq_config` (persistente em `dados/groq_config.json`)

- **O que**:
  - Host (`conveniente`) passou a sinalizar `needsGroqConfig=true` quando faltar config e a aceitar comando `set_groq_config` para persistir em `C:\conveniente\dados\groq_config.json` (ignorado no git).
  - CT (`sitechatbot`) passou a enfileirar `set_groq_config` quando receber `/report` com `needsGroqConfig=true`, lendo `GROQ_API_KEY` e `GROQ_MODEL` do ambiente (modelo tem default).
- **Por quê**: permitir que cada host faça requisição própria ao Groq sem depender de `.env` no host e sem operação manual por host.
- **Evidência**:
  - `C:\conveniente\scripts\groqConfig.js`
  - `C:\conveniente\scripts\dashboard.js`
  - `C:\conveniente\.gitignore`
  - `C:\sitechatbot\index.js` (bloco AUTO-CONFIG GROQ no handler `/report`)
  - `C:\sitechatbot\convenientetecnologia\ct.env` (GROQ_MODEL)
- **Reinícios**:
  - `sitechatbot` (CT) — humano reinicia com `node index.js`
  - `conveniente` (hosts) — humano reinicia com `node index.js`
- **Rollback**: `git revert` do(s) commit(s) deste item e reiniciar `node index.js`.
- **THREAD**: `TH-2026-01-31-groq-config`

#### 2026-01-31 — [CONV][FIX][OPS] RM3: fila atômica para retry (governor_busy) não travar em `configurando=true`

- **O que**:
  - `queueAutoLoginRemediate(...force=true)` agora persiste `autoLoginRemediate.force` (para retries).
  - `autoLoginRemediateTick` pode avançar a fila mesmo com `ctrl.configurando=true` **somente** quando o item está `queued && force && nextAt<=now` e não há `provisionLock` ativo (mantendo `humanControl` como hard-stop).
  - Removidas instrumentações temporárias de debug (`127.0.0.1:7242/ingest/...`) após validação.
- **Por quê**: o retry existia, mas era pulado por `configurando=true`, causando “só 1 conta vai” / engessamento.
- **Evidência**:
  - `C:\conveniente\scripts\worker.js` (`autoLoginRemediateTick`, `queueAutoLoginRemediate`)
  - RM3 `provision_audit` no CT: `C:\sitechatbot\dados\logs\5d7c3309-8581-4a50-a421-e6cbb52d8070\rm3_pa_tail_verify_20260131_01.json`
- **Reinícios**: `conveniente` (hosts afetados) — humano reinicia com `node index.js` quando for testar/validar runtime novo.
- **Rollback**: `git revert d1d84f8` e reiniciar `node index.js`.

#### 2026-01-30 — [CONV][FIX][OPS] Retomar trabalho: retry imediato quando governor ocupado

- **O que**:
  - Adicionado retry imediato (forçado) do `login_remediate` quando o governor está ocupado em `human-resume`.
  - Log de evidência `login_remediate_governor_retry_queued` para rastrear a re-fila.
- **Por quê**: evitar “engessamento” após Retomar trabalho quando outro login_remediate está em andamento.
- **Evidência**: `C:\conveniente\scripts\worker.js` (human-resume + auto_login_remediate queue)
- **Reinícios**: `conveniente` no RM3 (node index.js).
- **Rollback**: reverter commit `fix: honor human mode + login form` + retry governor (ou `git revert` do último commit).

#### 2026-01-30 — [CONV][FIX][OPS] Open-all/manual limpa flags de login antes do re-probe

- **O que**:
  - Na abertura (open_all/manual), limpa flags de login (`loginRequired`, `loginRemediateFailed`, `messengerPin`) e registra evento.
  - Revalidação real continua via `probeHumanStateOnOpen`.
- **Por quê**: evitar UI “presa” com flags antigas e garantir reavaliação do estado atual.
- **Evidência**: `C:\conveniente\scripts\worker.js` (eventos `open_clear_login_flags*`).
- **Reinícios**: `conveniente` no RM3 (node index.js).
- **Rollback**: reverter commit do ajuste de open flags.

#### 2026-01-30 — [CROSS][DOCS][OPS] INBOX: novo INC para “CT mostra OFFLINE falso” (RM3) + clarificações hostId/telemetria

- **O que**:
  - Criado `INC-20260130-0905-01` (RM3 marcado OFFLINE no CT embora host esteja acessível) para investigação com evidência.
  - Registrado no `INBOX_RELATOS_DO_HUMANO.md` e no `docs/inbox/INDEX.md`.
  - Clarificado no `LIVRO_DE_BORDO.md` que `hostId` não muda com restart; e que a telemetria `/report` é enviada em loop (default 30s).
- **Por quê**: eliminar achismo (“máquina online” vs “CT recebendo `/report`”) e tornar o estado auditável antes de qualquer refactor.
- **Evidência**:
  - `C:\conveniente\docs\inbox\cancelled\INC-20260130-0905-01.md` (movido para cancelled)
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
- **Reinícios**: nenhum (somente docs/triagem).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-30-ct-offline-triage`

#### 2026-01-30 — [CONV][CT][DOCS][OPS] Auditoria estrutural: conveniente + integração CT

- **O que**:
  - Criado checkup de auditoria estrutural do `conveniente` + integração com CT, com mapa de módulos e riscos P1/P2.
  - Registrado plano de desengessamento (sem mudança de runtime nesta rodada).
- **Por quê**: pedido explícito de auditoria “ultra detalhada” para orientar correções sem achismo.
- **Evidência**: `C:\conveniente\docs\checkups\checkup_2026-01-30_auditoria_conveniente_ct.md`
- **Reinícios**: nenhum (documentação).
- **Rollback**: reverter o arquivo `.md` (não afeta runtime).

#### 2026-01-30 — [CT][CROSS][FIX][OPS] Servidores (CT): remover “Desconhecido” e expor flags acionáveis (Humano invocado + Outros (login))

- **O que**:
  - Estado `unknown` virou **`login_other`** (label humano: **Outros (login)**), mantendo `loginReason` para auditoria.
  - CT `/servers` passou a expor `flagsAgg` (ex.: `human_invoked`, `login_reasons_top`) para o dashboard ser fonte de verdade operacional.
  - UI “Servidores” removeu pill “Desconhecido” e passou a mostrar **Humano invocado** + **Outros (login)** (com tooltip de `loginReason` top).
  - UI “contas-facebook-contas” alinhada para `login_other` (sem “Desconhecido”).
- **Por quê**: o operador usa “Servidores” para decidir qual host ir; “Desconhecido” não é acionável e quebra a confiabilidade do painel.
- **Evidência**:
  - `C:\sitechatbot\convenientetecnologia\lib\fbAccountState.js`
  - `C:\sitechatbot\index.js` (`GET /servers` → `accountsAgg` + `flagsAgg`)
  - `C:\sitechatbot\public\index.html`
  - `C:\sitechatbot\convenientetecnologia\public\contas-facebook-contas.html`
  - Snapshot exemplo (motivo real): `C:\sitechatbot\dados\5d7c3309-...-30b3fe928b.json` contém `loginReason:"probe_failed"`
- **Reinícios**:
  - **CT (`sitechatbot`)**: **sim** — humano reinicia no host do CT com `node index.js`
  - **conveniente (hosts)**: **não** (mudança é no CT/UI; docs do conveniente foram atualizadas via git)
- **Rollback**:
  - CT: restaurar arquivos via `C:\sitechatbot\_backup_auto_root\...` + reiniciar `node index.js`
  - conveniente: `git revert 976c6ef` (somente docs)
- **THREAD**: `TH-2026-01-30-ct-servers-states-flags`

#### 2026-01-30 — [CROSS][DOCS][OPS] INBOX: cancelar INC-20260130-0905-01 (RM3 OFFLINE falso) a pedido do humano

- **O que**:
  - Marcado `INC-20260130-0905-01` como `cancelled` e movido para `docs/inbox/cancelled/`.
  - Atualizados índices (`docs/inbox/INDEX.md` e `INBOX_RELATOS_DO_HUMANO.md`) para não deixar link quebrado.
- **Por quê**: cancelado a pedido do humano (decisão consciente).
- **Evidência**:
  - `C:\conveniente\docs\inbox\cancelled\INC-20260130-0905-01.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
- **Reinícios**: nenhum (somente docs).
- **Rollback**: `git revert <commit>` (não afeta runtime).

#### 2026-01-29 — [CROSS][DOCS] Organização inicial do conhecimento (bootstrap)

- **O que**:
  - Criado `docs/LIVRO_DE_BORDO.md` como índice/porta de entrada.
  - Criado `docs/RUNBOOK_TECNICO.md` (procedimentos operacionais).
  - Criado `docs/TIMELINE.md` (este arquivo).
  - Criado `docs/checkup_geral_2026-01-29.md` com achados técnicos.
- **Por quê**: evitar perda de contexto entre chats/GPTs e reduzir criação de “caminhos paralelos”.
- **Evidência**: arquivos em `C:\conveniente\docs\`.
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: remover os arquivos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-docs-bootstrap`

---

#### 2026-01-29 — [CONV][FIX][OPS] P1: `close_all` com timeout/retry e erro explícito (sem “fetch failed” opaco)

- **O que**:
  - endurecido `httpJson()` no `dashboard.js` com timeout (AbortController) + retry leve + mensagem com URL/timeout.
  - `close_all` via comando agora usa timeout maior (até 15min) e seta `x-operator` com `cmdId` para rastreio.
- **Por quê**: logs do CT mostraram `close_all` falhando com `ackError: fetch failed` (erro opaco, sem contexto).
- **Evidência**:
  - CT: `C:\sitechatbot\dados\logs\bcf01e8d-82da-4d5d-aed0-d60305d4696d\ack_f941b889-b8d2-4823-a64e-4c507bc9df37.json`
  - código: `C:\conveniente\scripts\dashboard.js` (`httpJson`, `execCloseAll`)
- **Precisa reiniciar agora?** não (dá para continuar atualizando).
- **Precisa reiniciar para validar/testar?** sim (para o host aplicar a mudança).
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert <commit>` e reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][FIX][OPS] P1: `stock_provision` com evidência de “busy_timeout” (busyDetails/pauseableDetails)

- **O que**:
  - ampliado snapshot de quiescência do `stock_provision` para incluir `busyDetails` e `pauseableVirtusDetails` (flags reais por perfil).
  - erro de timeout agora inclui `sample=` com nomes para diagnóstico rápido no CT.
- **Por quê**: logs do CT mostraram `stock_provision` falhando com `busy_timeout count=21` sem contexto do “por quê” cada perfil estava ocupado.
- **Evidência**:
  - CT: `C:\sitechatbot\dados\logs\bcf01e8d-82da-4d5d-aed0-d60305d4696d\ack_2f0461f7-db74-478d-a43a-0c83485abfbe.json`
  - código: `C:\conveniente\scripts\dashboard.js` (`execStockProvision` → `computeQuiesceSnapshot`)
- **Precisa reiniciar agora?** não
- **Precisa reiniciar para validar/testar?** sim
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert <commit>` e reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][FIX][OPS] P1: evitar “sendLockActive preso” (Virtus libera via Browser, não via Page)

- **O que**:
  - `virtus.js`: `send-lock` agora é adquirido/liberado usando o objeto `browser` diretamente (não depende de `page.browser()`).
  - isso evita leak do lock quando a página fecha/desconecta durante o fluxo do chat.
- **Por quê**: evidência no CT mostra muitos perfis com `sendLockActive=true`, o que dispara `busy_timeout` e bloqueia operações críticas (provisão/locks).
- **Evidência**:
  - CT snapshot: `C:\sitechatbot\dados\bcf01e8d-82da-4d5d-aed0-d60305d4696d-de8717d9f1.json` (vários `sendLockActive=true`)
  - CT ack: `C:\sitechatbot\dados\logs\bcf01e8d-82da-4d5d-aed0-d60305d4696d\ack_2f0461f7-db74-478d-a43a-0c83485abfbe.json` (`busy_timeout`)
  - código: `C:\conveniente\scripts\virtus.js` (`acquireSendGuardBrowser`, `releaseSendGuardBrowser`)
- **Precisa reiniciar agora?** não
- **Precisa reiniciar para validar/testar?** sim
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert <commit>` e reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][DOCS] Achado P0 (ainda não corrigido): lock não owner-safe

- **O que**: identificado P0 de concorrência em lock de arquivo no `conveniente`.
- **Por quê**: `unlink` do lock pode acontecer mesmo sem adquirir o lock ⇒ risco de corrida/corrupção.
- **Evidência**: `docs/checkup_geral_2026-01-29.md` e `conveniente/scripts/fileStore.js`.
- **Reinícios**: nenhum (ainda não alterado).
- **Rollback**: n/a (não houve mudança).

---

#### 2026-01-29 — [CONV][FIX] Correção P0: lock owner-safe em `fileStore.js` + remove busy-wait (CPU)

- **O que**:
  - corrigido release de lock para **não** remover `.lock` quando o lock não foi adquirido.
  - adicionados metadados no lock (pid/ts/token) e recuperação best-effort de lock “stale” por idade.
  - trocado busy-wait do lock de `perfis.json` por `Atomics.wait` (não gasta CPU).
- **Por quê**: eliminar risco de corrida/corrupção em `desired.json`/`perfis.json` e reduzir congelos por contenção.
- **Evidência**: `C:\conveniente\scripts\fileStore.js` (seção de locks `desired.json`/`perfis.json`).
- **Reinícios**: **conveniente** (somente) — **humano** reinicia no host do `conveniente` (parar e rodar `node index.js`).
- **Rollback**: o GPT prepara rollback via Git (ex.: `git revert` / voltar tag). O humano aplica reiniciando `node index.js` no host do `conveniente`.

---

#### 2026-01-29 — [CONV][FIX] P1: deadline/logs no `ensureFreeMB` (sem espera infinita)

- **O que**: `ensureFreeMB()` no `conveniente/scripts/dashboard.js` deixou de esperar infinito; agora tem `timeoutMs`, logs de progresso e erro explícito no timeout.
- **Por quê**: regra canônica P1: nenhuma espera pode ser infinita.
- **Evidência**: `C:\conveniente\scripts\dashboard.js` (função `ensureFreeMB`).
- **Precisa reiniciar agora?** não (mudança preventiva; só “vale” no runtime após restart).
- **Precisa reiniciar para validar/testar?** sim, se você quiser testar `ensureFreeMB` em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][FIX] P1: auto-backup do `index.js` em subprocess (reduz freeze)

- **O que**: o snapshot automático (`CONVENIENTE_AUTO_BACKUP_*`) deixou de rodar com IO síncrono pesado no processo principal; agora dispara um subprocesso (`scripts/autoBackupWorker.js`) para fazer o trabalho.
- **Por quê**: P1 — reduzir latência/congelos do `conveniente` sob stress.
- **Evidência**:
  - `C:\conveniente\index.js` (função `startAutoBackupConveniente`)
  - `C:\conveniente\scripts\autoBackupWorker.js`
- **Precisa reiniciar agora?** não (só é necessário quando você quiser o benefício em runtime).
- **Precisa reiniciar para validar/testar?** sim, se você quiser observar “menos freeze” e confirmar que `_backup_auto/_snapshots.log` continua sendo gerado.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][FIX] P1: auto-backup evita snapshots concorrentes (lock)

- **O que**: adicionado lock no worker de backup para impedir snapshots concorrentes quando um snapshot demora mais que o intervalo (e stale recovery).
- **Por quê**: reduzir IO/carga e evitar “pile-up” de backups.
- **Evidência**: `C:\conveniente\scripts\autoBackupWorker.js` (lock `_snapshot_running.lock`).
- **Precisa reiniciar agora?** não
- **Precisa reiniciar para validar/testar?** sim, se quiser observar o comportamento em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][FIX] P1: logs/guardrails em waits de UI (browser/virtus)

- **O que**:
  - `browser.js`: `waitAny()` agora loga timeout quando `BROWSER_DEBUG=1`.
  - `browser.js`: loop de `identityAssistStep` ficou explicitamente bounded por budget/minTries (sem `while(true)`).
  - `virtus.js`: `assertOnChat` loga timeout quando `VIRTUS_DEBUG=1` (só em timeout).
- **Por quê**: P1 — reduzir “travou e não sei onde” e garantir que waits sejam sempre bounded.
- **Evidência**:
  - `C:\conveniente\scripts\browser.js`
  - `C:\conveniente\scripts\virtus.js`
- **Precisa reiniciar agora?** não
- **Precisa reiniciar para validar/testar?** sim, se quiser observar logs em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][FIX] P1: handlers globais de erro (master/worker) + opção de exit

- **O que**: padronizado `uncaughtException`/`unhandledRejection` no master (`index.js`) e no worker (`scripts/worker.js`), com logs consistentes e opção `CONVENIENTE_FATAL_EXIT=1` para sair (evitar “seguir vivo” corrompido).
- **Por quê**: P1 — política de erro consistente e auditável.
- **Evidência**:
  - `C:\conveniente\index.js`
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (baseline env)
- **Precisa reiniciar agora?** não (só é necessário quando você quiser que isso passe a valer no runtime).
- **Precisa reiniciar para validar/testar?** sim, se quiser simular erro e ver o comportamento/log.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Inbox canônica para “texto bomba” do humano (triage P0/P1/P2)

- **O que**: criado canal canônico para intake/triage de relatos desorganizados do humano (colagem do texto bruto + decomposição em itens + P0/P1/P2 + evidência).
- **Evidência**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seção “Intake de texto bomba do humano”)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (link no índice)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] INBOX: análise de impacto obrigatória (callers/callees/efeitos colaterais)

- **O que**: reforçado que “triagem inbox” inclui **investigação real** antes de mexer: mapear fluxo ponta a ponta e impactos (callers/callees/estados/efeitos colaterais).
- **Evidência**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (Mapa de impacto obrigatório)
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (intake: análise de impacto)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] INBOX: “olhar o histórico primeiro” (timeline + file_timeline)

- **O que**: padronizado que triagem inbox inclui checar histórico (TIMELINE + file_timeline/hotspots) para detectar regressão e evitar repetir erro.
- **Evidência**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (Histórico relacionado obrigatório)
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (intake: olhar histórico)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] INBOX: perguntas obrigatórias (como deveria ser / sucesso)

- **O que**: triagem inbox agora exige perguntas item-a-item (“como deveria ser”, “critério de sucesso”, prioridade) antes de qualquer correção.
- **Evidência**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Host registry (apelidos ↔ hostId)

- **O que**: criado registro canônico para mapear apelidos humanos (“robe mae 2”) para `hostId` e facilitar coleta de logs via CT.
- **Evidência**: `C:\conveniente\docs\HOST_REGISTRY.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Host registry preenchido (CT aliases + snapshots)

- **O que**: preenchido `HOST_REGISTRY.md` automaticamente a partir de `C:\sitechatbot\dados\server_names.json` + snapshots do CT.
- **Evidência**:
  - `C:\sitechatbot\dados\server_names.json`
  - `C:\conveniente\docs\HOST_REGISTRY.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] INBOX: bloco de “regras não negociáveis” (humano/GPT)

- **O que**: adicionado bloco de regras não negociáveis e lista de arquivos canônicos dentro do `INBOX_RELATOS_DO_HUMANO.md` para guiar triage em chats com relato confuso.
- **Evidência**: `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS] Checkup 3 (loops/timeouts/polling)

- **O que**:
  - Documentado contrato CT⇄Notificador (poll/ack).
  - Documentado canal de logs `*_secret` (requestId/response) no CT.
  - Registrada regra canônica anti “espera infinita” (deadlines/ACK/GC).
  - Registrado achado P1: risco de `while(true)` sem deadline (ex.: `ensureFreeMB` legado no `conveniente`).
- **Evidência**:
  - `docs/LIVRO_DE_BORDO.md`
  - `docs/RUNBOOK_TECNICO.md`
  - `docs/checkup_geral_2026-01-29.md`
- **Reinícios**: nenhum (somente documentação/auditoria).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-ops-contracts`

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Checklist canônico de release (P0/P1) no RUNBOOK

- **O que**: promovido checklist de “produção real de atualizações” para o `RUNBOOK_TECNICO.md`, com gate explícito P0/P1 e links para evidências/auditorias.
- **Por quê**: garantir que qualquer GPT consiga atualizar sem achismo e sem “caminhos paralelos”.
- **Evidência**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seção “Checklist de release / atualização (produção real) — CANÔNICO”)
  - `C:\conveniente\docs\checkup_geral_2026-01-29.md` (P0/P1)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-release-checklist-p0p1`

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Contrato humano/GPT (node manual) + `self_update` sem espera

- **O que**: reforçado contrato operacional: humano só reinicia manualmente com `node index.js`; GPT não “reinicia servidor”. Documentado comportamento real de `self_update` e regra de não ficar esperando resposta.
- **Evidência**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seções “Regra humana (restart)” e “self_update (comando) — como funciona”)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (regra humana)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] PowerShell gotchas (sem `&&`/heredoc) para commits/comandos

- **O que**: registrado “jeito certo” de rodar comandos no Windows/PowerShell (ex.: não usar `&&` e não usar heredoc `<<EOF`) para evitar GPTs repetirem tentativa/erro.
- **Evidência**: `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seção “Windows/PowerShell — pegadinhas operacionais”)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Vocabulário: “pull” = `self_update` (CT)

- **O que**: padronizado vocabulário humano: quando o humano disser “pull”, significa disparar `self_update` via CT (equivalente a `git pull` no host).
- **Evidência**:
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Regra: “precisa reiniciar agora?” vs “precisa reiniciar para validar”

- **O que**: registrado que nem toda atualização exige restart imediato para continuar trabalhando; restart é obrigatório quando a mudança precisa estar valendo no runtime (teste/validação).
- **Evidência**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (checklist: “Precisa reiniciar agora?” + regra de restart)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (regra de restart)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS] Reconstrução retroativa (~10 dias) a partir de evidências (Git/backups/recovery)

- **O que**: reconstruído histórico dos últimos ~10 dias (conveniente/sitechatbot/notificador) usando Git, logs de backups e arquivos de recovery.
- **Evidência**: `C:\conveniente\docs\checkups\checkup_2026-01-29_reconstrucao_ultimos_10_dias.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-timeline`

---

#### 2026-01-29 — [CROSS][DOCS] Backfill nível 2: Cursor timeline + planos/patches + backups recebidos

- **O que**: consolidado “rastro do Cursor” (transcripts/terminals) + patches/diffs + manifests de backups recebidos pelo CT + scripts de rollback/prune.
- **Por quê**: transformar evidência espalhada (plans/backups/patches) em material pesquisável para debug e RCA.
- **Evidência**: `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_planos_patches.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-cursor-plans`

---

#### 2026-01-29 — [CROSS][DOCS] Backfill nível 3: Cursor `agent-tools` (marcos reais: cmdId/requestId/git pull/push)

- **O que**: minerado `agent-tools/*.txt` do Cursor para recuperar marcos reais (ex.: `list_backups`, `bulk_gitpull_*`, `push_update`, scripts de start).
- **Por quê**: aumentar precisão de RCA/debug quando não há Git em todos os projetos e o passado está “espalhado”.
- **Evidência**: `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_agenttools.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-cursor-agenttools`

---

#### 2026-01-29 — [CROSS][DOCS] Timeline retroativa (09/01 → hoje) (formato “em tempo real”)

- **O que**: criada timeline retroativa 2026-01-09 → 2026-01-29 no formato “como se fosse em tempo real”, com THREADs e evidências (Git/backups/recovery/Cursor).
- **Por quê**: deixar o “passado” rastreável para RCA/debug, sem confundir retroativo com o padrão de qualidade do “ao vivo”.
- **Evidência**: `C:\conveniente\docs\checkups\checkup_2026-01-29_timeline_retroativa_2026-01-09_a_2026-01-29.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-retro-timeline-2026-01-09`

---

#### 2026-01-29 — [CONVENIENTE][P1] Status/CT: send-lock com metadados (owner/since/chatId) para diagnóstico “busy”

- **O que**: ampliado o snapshot de `perfis` no `worker.js` para incluir `sendLockOwner`, `sendLockChatId`, `sendLockSince`, `sendLockAgeMs` (além de `sendLockActive`).
- **Por quê**: quando existe `busy_timeout`, agora dá para provar *quem* segurou o send-lock e há quanto tempo, sem achismo e sem depender de logs ad-hoc.
- **Arquivos**: `C:\conveniente\scripts\worker.js`
- **Reinícios**: `conveniente` (para o runtime novo expor os campos no `/api/status` e no CT).
- **Rollback**: `git revert <commit>` (remove apenas campos extras do status; não altera fluxo Robe/Virtus).
- **THREAD**: `TH-2026-01-29-sendlock-status-meta`

---

#### 2026-01-29 — [CONVENIENTE][P1] Varredura final: loops/waits de UI sem deadline (robe/virtus/browser)

- **O que**: verificado que `scripts/browser.js`, `scripts/robe.js`, `scripts/robeVeiculos.js` não possuem `while(true)`/`for(;;)`; os loops críticos de UI existentes estão bounded por budget/timeout e (quando debug habilitado) já emitem logs em timeout nos helpers relevantes.
- **Por quê**: reduzir risco de “travou para sempre” por UI/espera infinita (sem mexer em comportamento quando está saudável).
- **Arquivos**: `C:\conveniente\scripts\browser.js`, `C:\conveniente\scripts\robe.js`, `C:\conveniente\scripts\robeVeiculos.js`
- **Reinícios**: nenhum (apenas validação/auditoria).
- **THREAD**: `TH-2026-01-29-ui-loop-audit`

---

#### 2026-01-29 — [CONVENIENTE][P2][DOCS] Baseline de logging de produção (clarificações)

- **O que**: clarificado no runbook que `LOG_TO_FILE=1` escreve em `C:\conveniente\dados\logger.log` e que o `logger.js` assume debug ligado por default (recomendação: `LOG_DEBUG=0`/`DEBUG=0`), com nota de rotação manual do arquivo.
- **Por quê**: reduzir ruído em produção e deixar o caminho de evidência/arquivos explícito.
- **Arquivos**: `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **Reinícios**: nenhum (doc).
- **THREAD**: `TH-2026-01-29-prod-logging-baseline`

---

#### 2026-01-29 — [CONVENIENTE][P2] CT: `health_bundle` + `rotate_logs` (coleta rápida + rotação de `logger.log`)

- **O que**:
  - adicionado comando `health_bundle` (1 requestId → resumo de status + manifest do allowlist; tails opt-in).
  - adicionado comando `rotate_logs` (rotaciona `logger.log` para `dados/logs/` e mantém N arquivos).
- **Por quê**: acelerar investigação (menos “ida e volta”) e evitar crescimento infinito do `dados/logger.log`.
- **Arquivos**:
  - `C:\conveniente\scripts\dashboard.js`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **Reinícios**: `conveniente` (para o host aceitar os novos tipos de comando).
- **Rollback**: `git revert <commit>` (remove comandos; não afeta Robe/Virtus).
- **THREAD**: `TH-2026-01-29-health-bundle-rotate-logs`

---

#### 2026-01-29 — [CONVENIENTE][OPS] RM4: humano precisou `git pull` (self_update não foi enviado) + validação com evidência CT

- **Relato humano**: após restart no **ROBE MÃE 4**, foi necessário `git pull` manual no host (o `self_update` não foi disparado pelo GPT).
- **Evidência (CT)**:
  - `C:\sitechatbot\dados\commands.log`: não há `enqueue` recente de `self_update` para `825a4485-1465-4c11-aa18-52f0597b23a3` no recorte do incidente.
  - Validação pós-restart:
    - `health_bundle` ACK ok: `C:\sitechatbot\dados\logs\825a4485-1465-4c11-aa18-52f0597b23a3\ack_c9475bed-3a3f-4cfd-89d9-fa244e7dcb81.json`
    - resposta do bundle: `C:\sitechatbot\dados\logs\825a4485-1465-4c11-aa18-52f0597b23a3\hb_1769726532463.json`
    - `git_main_ref` confirma commit no disco: `00cb4b38cc1c16535a82574d697d17833f25e11e` (arquivo `git_1769726532463.json`).
  - Fluxo `self_update` verificado (prova de que funciona via CT):
    - comando: `self_update` cmdId `de8dd0e9-9b0d-41d2-b519-dc41bc111361` (ACK ok em `ack_de8dd0e9-...json`)
    - `updates.jsonl` contém `requestId:"verify_self_update_1769726589134"` (via `updates_1769726606544.json`).
- **Ação**: runbook/livro atualizados para exigir **evidência mínima** do `self_update` (enqueue/deliver/ack + ack file) e registrar exceção quando humano precisar fazer `git pull`.
- **THREAD**: `TH-2026-01-29-rm4-manual-gitpull`

---

#### 2026-01-29 — [CONVENIENTE][P1] `stock_provision`: alinhar timeout HTTP local com `login_remediate` (evita abort 8s)

- **O que**: `execStockProvision` agora passa `timeoutMs` explícito (maior) nos steps longos (`activate` e principalmente `login_remediate`).
- **Por quê**: evidência real mostrou `login_remediate` abortando por timeout HTTP local de ~8s, apesar do worker usar `totalTimeoutMs=8min`, gerando falhas em massa do provision.
- **Evidência (CT)**:
  - RM2: `busy_timeout` (host ocupado) em `ack_20580076-ce15-4ff6-a54f-580afd80aeed.json` (step `quiesce_busy_done` com `busyCount=23`).
  - RM4: `login_remediate_fail` repetido com `timeoutMs=8000` em `ack_b69aa71e-714f-43eb-a48c-421dc4ca60df.json`.
- **Arquivos**: `C:\conveniente\scripts\dashboard.js`
- **Reinícios**: `conveniente` (para o runtime novo aplicar os timeouts).
- **Rollback**: `git revert <commit>` (retorna para timeout padrão).
- **THREAD**: `TH-2026-01-29-stock-provision-local-timeout`

---

#### 2026-01-29 — [CONVENIENTE][P1] `stock_provision`: modo “esperar busy mais tempo” (budget/waitBusy defaults)

- **O que**: aumentados os defaults de:
  - `STOCK_PROVISION_BUDGET_MS` (para 20min)
  - `STOCK_PROVISION_WAIT_BUSY_MS` (para 10min)
  - `STOCK_PROVISION_WAIT_PAUSE_MS` (para 2min)
- **Por quê**: alinhamento com o operador (humano): é mais seguro esperar ocupação terminar do que falhar rápido; no timeout, o histórico registra erro e o loop de guard re-tenta depois.
- **Arquivos**: `C:\conveniente\scripts\dashboard.js`
- **Reinícios**: `conveniente` (para runtime novo aplicar defaults).
- **Rollback**: `git revert <commit>` (volta para defaults anteriores).
- **THREAD**: `TH-2026-01-29-stock-provision-wait-busy-policy`

---

#### 2026-01-29 — [CONVENIENTE][DOCS] INBOX: banco de relatos por arquivo (1 INC por relato) + índice

- **O que**: `INBOX_RELATOS_DO_HUMANO.md` permanece como “entrada”, e cada incidente triado ganha arquivo em `docs/inbox/` com índice.
- **Por quê**: manter histórico pesquisável (“banco de relatos”) sem inflar o arquivo de entrada.
- **Arquivos**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\inbox\INDEX.md`
  - `C:\conveniente\docs\inbox\INC-20260129-2100-01.md`
- **Reinícios**: nenhum (docs).
- **THREAD**: `TH-2026-01-29-inbox-archive-per-inc`

---

#### 2026-01-29 — [CONVENIENTE][P1] Abrir/Fechar (painel): “Fechar Todos” não pode reabrir; “Abrir Todos 24h” modo seguro + lock renovável

- **Sintoma (humano)**: clicar “Fechar Todos” era lento e “brigava” com o sistema (reabria durante o fechamento); “Abrir Todos” gerava concorrência/travamentos e às vezes parecia abrir sozinho após restart.
- **Causa raiz**:
  - Painel fazia `deactivate` perfil-a-perfil sem o passo atômico `desired.active=false` para todos → `nurseTick` via `desired.active=true` e podia reabrir.
- **Correções**:
  - Painel passou a chamar endpoints canônicos:
    - `POST /api/perfis/close-all` (modo seguro; corta reabertura via desired)
    - `POST /api/perfis/open-all-24h` (modo seguro)
  - `open-all-24h`: TTL do `provision_lock` virou **curto e renovável** (`OPEN_ALL_LOCK_TTL_MS`, default 2min) com keepalive por shard no `nurseTick`, e finalização automática ao expirar.
  - `provision_lock.meta.kind`: `stock_provision` não pausa Virtus globalmente; pausa só em `open_all_map`/`close_all`.
- **Evidência (CT)**:
  - RM4 `provision_audit`: eventos `close_all_api_called` + `worker_hard_close_*` confirmam endpoint canônico.
- **Arquivos**:
  - `C:\conveniente\public\index.html`
  - `C:\conveniente\scripts\api_perfis.js`
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\scripts\dashboard.js`
- **Reinícios**: `conveniente` (para runtime novo aplicar).
- **THREAD**: `TH-2026-01-29-open-close-all-governance`
