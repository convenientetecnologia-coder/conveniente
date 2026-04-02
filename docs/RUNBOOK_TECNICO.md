### Runbook técnico — operação diária (Conveniente / CT / Notificador)

Este arquivo é o **manual de operação**. Ele não “engessa”: se você precisar de um novo procedimento, adicione aqui como **EXPERIMENTAL** e, quando estabilizar, promova a **CANÔNICO**.

---

### Regras para evitar “caminhos paralelos”

- **CANÔNICO**: existe, é usado em produção e tem evidência.
- **EXPERIMENTAL**: novo caminho; deve ter:
  - motivo,
  - risco,
  - como validar,
  - como reverter,
  - e prazo/condição para virar canônico ou ser removido.

Regra adicional (obrigatória):
- Se um GPT fez **tentativa/erro** e descobriu o jeito certo, ele deve **promover o jeito certo para este runbook** (CANÔNICO) e registrar na `docs/TIMELINE.md` quando fizer sentido — para os próximos GPTs não repetirem erro.

---

### Cabeçalho obrigatório (sempre no início da resposta do GPT) — **CANÔNICO**

Sempre começar com (4 linhas, sem exceção):

- **Precisa reiniciar?** sim/não
- **Qual projeto?** conveniente / sitechatbot / notificador / site *(ou outro projeto, ex.: `afiliadozap`)*
- **Como reiniciar (humano)?** `node index.js`
- **Por quê?** (1 frase objetiva)

Regras acopladas (não negociar):

- **Humano**: só reinicia processos com `node index.js` e responde “reiniciado”. Não coleta logs manualmente, não roda comandos, não copia/cola evidência.
- **GPT**: edita código, cria comandos, coleta logs via CT, registra docs (RUNBOOK/LIVRO/TIMELINE) e faz commit/push quando aplicável.
- **Sem achismo**: decisões importantes precisam citar **evidência** (arquivo/path, log key, cmdId/requestId, endpoint).
- **Windows/PowerShell**: não usar `&&` nem heredoc `<<EOF` (usar `;` e `git commit -m ... -m ...`).
- **Se mexeu no `conveniente`**: padrão é commit/push + disparar `self_update` e só então pedir restart ao humano.

Motivo: evita desalinhamento e impede que um texto confuso vire mudança errada.

---

### Reativação tokenized por praça + reset de baseline financeiro (CANÔNICO)

Objetivo: reativar praças no tokenized sem carregar saldo/fatura legado da fase de testes.

Escopo atual aprovado:
- `Montes Claros (MG)`
- `Foz do Iguaçu (PR)`
- `Fortaleza (CE)`
- `Petrolina (PE)`
- + telefone explícito de operador/teste: `48991985634`

Passos canônicos:
1. Atualizar pilotos tokenized em `C:\notificador\tokenized_pilot_groups.json`.
2. Garantir janela de sorteio no runtime (`C:\sitechatbot\lib\pedidosStore.js`) em `180000` ms (3 min).
3. Rodar **dry-run** financeiro:
   - `node tools/reset_wallets_tokenized_rollout.js`
4. Aplicar reset financeiro:
   - `node tools/reset_wallets_tokenized_rollout.js --apply`
5. Validar saída:
   - `drivers_targeted` esperado;
   - cada item com `balance_cents_after=0` e `open_invoice_cents_after=0`.
6. Reiniciar runtime:
   - `sitechatbot` com `node index.js`.

Guardrail obrigatório (legado T+15):
- manter `CONTEST_LEGACY_T15_ENABLED=0` (default);
- não reativar follow-up legado T+15/T+1h no piloto atual de contestação imediata.

Garantias do script:
- quita faturas abertas via rotina oficial (`settleDriverBalance`);
- aplica ajuste residual (`addManualAdjustment`) só quando necessário para zerar saldo final;
- mantém trilha auditável no ledger (sem edição manual de tabela).

Rollback:
- pilotos: restaurar arquivo anterior de `tokenized_pilot_groups.json`;
- janela: restaurar constante anterior em `pedidosStore.js`;
- financeiro: aplicar ajuste compensatório no ledger por script (nunca apagar histórico).

---

### Migração de crédito (mensalidade → tokenized) — **CANÔNICO**

Objetivo: migrar crédito proporcional remanescente (e opcionalmente “em dobro”) para motoristas que entram no tokenized, sem risco de inverter sinal (crédito virar dívida).

#### Contrato do ledger (não negociar)

- **No ledger interno (`ct_driver_lead_ledger.amount_cents`)**:
  - **positivo = dívida**
  - **negativo = crédito**
- O CT/UI mostra a “carteira” invertendo o sinal (exibição humana).
- O botão do CT **Adicionar crédito** é seguro porque usa o endpoint que força `amountCents` negativo internamente:
  - `POST /convenientetecnologia/api/lead_ledger/add_credit` (backend: `amountCents: -amount`).

#### Formato de entrada (padrão)

Lista no formato:

```text
telefone/mensalidade_brl/dia_vencimento
```

Exemplo:

```text
96981111306/80/24
79999521849/125/05
```

#### Script base (CT / sitechatbot)

- Script: `C:\sitechatbot\tools\apply_tokenized_credit_migration_lote1.js`
- Como usar:
  1) Atualize:
     - `MIGRATION_KEY` (tem que ser único por lote e data)
     - `INPUT[]` com `{ phone, monthly_brl, due_day }`
  2) Dry-run (obrigatório):
     - `cd C:\sitechatbot`
     - `node tools\apply_tokenized_credit_migration_lote1.js`
  3) Aplicar (exige dupla intenção):
     - `node tools\apply_tokenized_credit_migration_lote1.js --apply --confirm`

Guard rails do script:
- sempre converte para crédito interno com `toLedgerCreditCents(...)` (resultado deve ser **negativo**);
- se por qualquer motivo sair `>= 0`, o script aborta (`invalid_credit_direction_*`);
- grava `metadata.credit_direction=negative_is_credit`.

#### Auditoria (obrigatória após aplicar)

- `node tools\audit_tokenized_migration_lote1.js`
- Critério de sucesso:
  - lançamentos do lote aparecem com `migration_sign != debt` **após** eventual correção;
  - saldos finais fazem sentido na carteira humana (crédito positivo na UI).

#### Correção de incidente (playbook)

Se um lote foi aplicado com sinal invertido (crédito entrou como dívida):

- Script idempotente de correção: `C:\sitechatbot\tools\fix_tokenized_credit_migration_lote1_sign.js`
- Uso:
  - dry-run: `node tools\fix_tokenized_credit_migration_lote1_sign.js`
  - aplicar: `node tools\fix_tokenized_credit_migration_lote1_sign.js --apply --confirm`

Regra: **nunca** apagar histórico do ledger; correção é sempre por lançamento compensatório (`manual_adjustment`) com `correction_key`.

---

### Checklist de release / atualização (produção real) — **CANÔNICO**

Objetivo: qualquer GPT/humano consegue atualizar e debugar com **prova**, sem “achismo” e sem travar produção.

#### Regra humana (importante)

Este runbook assume um fato: **o humano é falho** e não deve operar “na unha”.

- **O humano**: só aprova a mudança e cobra evidência (“o que mudou?”, “qual serviço reiniciar?”, “o que você vai fazer se der ruim?”).
- **O GPT**: prepara a execução (mudança + commit/push + comando CT quando existir, ex.: `self_update`) e deixa tudo registrado (evidência + timeline).
- **O humano**: quando for necessário aplicar no host, faz o restart manual com `node index.js` e avisa “reiniciado”.
- **Proibido**: pedir para o humano “trocar arquivo”, “copiar script”, “abrir pastas” ou “fazer rollback manual”.

#### 0) Registro mínimo (antes de mexer)

- [ ] Definir `THREAD` (se for cross-system): `TH-YYYY-MM-DD-slug-curto`
- [ ] Definir **escopo** (quais serviços): `conveniente` / `sitechatbot` / `notificador`
- [ ] Definir **alvo** (quais arquivos/funções):
  - Para `conveniente`: começar em `C:\conveniente\docs\checkups\file_timeline\INDEX_2026-01-09_a_2026-01-29.md` e nos hotspots.
- [ ] Definir **rollback** antes de aplicar (como desfazer rápido).
- [ ] Definir **validação** (endpoints/logs/ACK) antes de aplicar.

#### 1) Gate P0/P1 (não negociar)

Fonte canônica dos riscos conhecidos:
- `C:\conveniente\docs\checkup_geral_2026-01-29.md`

- **P0 (bloqueador de release)**:
  - [ ] Nenhum P0 aberto “sem mitigação”. Se existir P0 aberto, só pode seguir com:
    - mitigação clara + evidência + rollback pronto, **ou**
    - primeiro corrigir o P0.
  - P0 atual conhecido (referência):
    - lock não owner-safe em `conveniente/scripts/fileStore.js` (risco de corrida/corrupção) — **corrigido** em 2026-01-29 (ver `docs/TIMELINE.md` e `scripts/fileStore.js`).

- **P1 (permitido somente com guardrails)**:
  - [ ] Nenhuma espera infinita: qualquer wait precisa de deadline + logs + erro/ACK.
  - [ ] Evitar busy-wait / IO síncrono em caminho crítico (ou documentar impacto e agendar refactor).
  - [ ] Política de erro (unhandled) e logging devem ser consistentes no contexto da mudança.

#### 2) Execução (mudança)

- [ ] Implementar a mudança **mínima** (cirúrgica).
- [ ] Coletar evidência “depois”:
  - commits/diffs (no `conveniente`)
  - `ack_<cmdId>.json` (quando envolver CT)
  - logs relevantes (keys allowlisted)
- [ ] Atualizar docs na mesma sessão (se mudou comportamento/procedimento):
  - `C:\conveniente\docs\TIMELINE.md` (entrada curta, com evidência + reinícios + rollback)
  - se for grande/complexo: criar um checkup em `C:\conveniente\docs\checkups\`

#### 3) Restart e validação (pós-mudança)

- [ ] Restart do(s) serviço(s) afetado(s) (ver seção “Restart / validação (padrão)” abaixo).
- [ ] O GPT deve dizer **em português direto** (sem ambiguidades):
  - **Precisa reiniciar agora?** sim/não (para continuar o trabalho atual)
  - **Precisa reiniciar?** sim/não
  - **Qual projeto?** `conveniente` / `sitechatbot` / `notificador`
  - **Como reinicia (humano)?** `node index.js`
  - **Por quê precisa reiniciar?** (1 frase)
  - **O que muda se NÃO reiniciar agora?** (1 frase)
- [ ] Validação mínima:
  - `conveniente`: `GET /health` + `GET /api/status`
  - CT: enfileirar comando simples + confirmar `ack_<cmdId>.json`
  - notificador: polling/ACK no CT
- [ ] Se falhar: aplicar rollback + registrar evidência do incidente.

---

### Restart / validação (padrão)

#### Regra humana (restart)

Neste ambiente, “restart” significa: **o humano vai no servidor e reinicia manualmente** (parar e rodar de novo):

- `node index.js`

O GPT **não** consegue reiniciar os seus processos remotos.

#### Mudou `conveniente/scripts/*.js` (runtime core)

- **Reiniciar (humano)**: no host do `conveniente`, parar o processo e subir de novo com `node index.js`.
- **Validar**:
  - `GET /health`
  - `GET /api/status`
  - logs (`dados/logger.log` se `LOG_TO_FILE=1`)

#### Mudou `sitechatbot/index.js` (CT)

- **Reiniciar (humano)**: no host do CT, parar o processo e subir de novo com `node index.js`.
- **Nota (UI/cache)**: se a mudança foi em `sitechatbot/convenientetecnologia/public/` (ex.: `ct.js`) e após restart a tela parecer “antiga”, fazer **hard refresh** no browser (`Ctrl+F5`) ou abrir em janela anônima para eliminar “asset fantasma”.
- **Validar**:
  - enfileirar um comando simples + confirmar ACK
  - `sitechatbot/dados/commands.log` registrando `ack`

##### CT — UI de Boletos/Cobranças (CANÔNICO, pós-aborto tokenized/pay-per-lead)

- **Onde ver os boletos de um motorista**:
  - `Cadastros` → buscar → abrir cadastro → botão **`Boletos / Cobranças`**
  - (alternativo) aba `Boletos` → filtrar/achar pelo nome/telefone
- **Ação correta para “apagar/cancelar”**:
  - usar **`Excluir cobrança`** (cancela no Asaas + marca cancelado no CT; pede motivo obrigatório).
- **O que NÃO usar (obsoleto)**:
  - fluxos de “editar leads / excluir boleto / cancelar boleto / reemitir” do pay-per-lead (removidos da UI para reduzir risco).
- **Evidência (código UI)**:
  - `C:\sitechatbot\convenientetecnologia\public\ct.js`

---

### RM3: recovery CDP fatal (navegadores não reabrem) — **CANÔNICO**

Objetivo: quando RM3 apresentar "navegadores fecham e não reabrem" (~12h de uptime), o sistema agora se auto-recupera.

**Comportamento (desde 2026-03-16):**
- Erro CDP (Target closed, Network.enable timed out) → worker faz `exit(1)` → cluster respawna em ~2s.
- Antes do exit: `fatalExitCleanupChrome()` mata Chrome por userDataDir (zero zumbi).
- Dossiê: `docs/checkups/checkup_2026-03-16_dossie_forense_rm3_browser_morto_12h.md`

**Se o humano reportar o sintoma:**
1. O cluster deve respawnar automaticamente (verificar no CT se RM3 voltou a "trabalhando").
2. Se não respawnou: reiniciar manualmente com `node index.js` no host RM3.
3. Para investigar causa raiz (por que só RM3): usar checklist em `docs/checkups/checkup_2026-03-16_investigacao_rm3_vs_outros.md`.

---

### Simulação OFFLINE (CT) — cidades/grupos/migração/provisão (EXPERIMENTAL)

Objetivo: validar fórmulas e guardrails com dados reais **antes** de tocar em runtime.

Regra operacional (anti-trava):
- Evitar “suíte única” sem deadline. Preferir rodar **blocos isolados** com timeout e evidência por arquivo.
- Se um comando ficar “parado/infinito”, identificar PID do `node.exe` e encerrar; registrar a evidência no checkup/timeline.

Ferramentas (no host do CT):

- Verificador Virtus/Grupos (insight + A/LR/LE/B): `C:\sitechatbot\tools\verify_virtus_groups_truth.js`
- Simulador de plano (rank/picks/migrações): `C:\sitechatbot\tools\simulate_city_plan.js`

Comandos (PowerShell):

- Verificador (gera JSON parseável):
  - `cd C:\sitechatbot; node tools\verify_virtus_groups_truth.js --category fretes --top 15 --out tools\_verify_virtus_groups_truth_out.json`
- Simulador (gera texto com auditoria):
  - `cd C:\sitechatbot; $env:SIM_ACCOUNT_STATE_MODE='fbAccountState'; $env:SIM_INCLUDE_OFFLINE='1'; $env:SIM_WARMUP_HOURS='24'; $env:SIM_LE_DAYS='12'; $env:SIM_LE_MAX_WEIGHT='0.35'; node tools\simulate_city_plan.js --category fretes --n 20 > tools\_simulate_city_plan_out.txt`

Critério de sucesso:

- o verificador bate com a UI Virtus/Grupos em 2–3 cidades amostrais (chamados, motoristas, insight, A/LR/LE/B).
- o simulador respeita anti-pânico (TOP‑N + inflight cap) e não sugere migração quando a ação correta é LOGAR (LR>0).

Rollback:

- nenhum (offline, não mexe em runtime).

#### Mudou `notificador/index.js`

- **Reiniciar (humano)**: no host do notificador, parar o processo e subir de novo com `node index.js`.
- **Validar**:
  - autenticação Baileys (quando aplicável)
  - polling/integração com CT

---

### Diagnóstico rápido (incidente)

Copiar/colar e preencher:

```text
Timestamp:
Fuso:
HostId:
Projeto/serviço: (conveniente | sitechatbot | notificador)
Sintoma:
Impacto:
RequestId/cmdId/profileName:

Evidência coletada:
- logs keys:
- trecho:

Ação executada:
- mudança:
- restart:

Validação:
- endpoint/status:
- logs:
```

---

### Playbook (CANÔNICO) — Auditoria CT “Em uso” vs perfis reais do servidor (por host)

Objetivo: repetir de forma atômica e auditável (um host por vez) a conferência que garante:

- CT (`ct_fb_stock_accounts` `assigned`) bate com o servidor (perfis reais),
- não há duplicatas, cross-host, fantasmas ou sobras sem decisão explícita,
- exclusão manual no servidor reflete no CT (vai para Excluídas).

**Fonte (baseline validada)**:
- RM1: `C:\conveniente\docs\inbox\done\INC-20260212-0605-01.md`

Procedimento (ordem):

1) **Export do servidor (via CT)**
   - Enfileirar `stock_export_profiles` para o `hostId` alvo.
   - Evidência obrigatória: `C:\sitechatbot\dados\logs\<hostId>\ack_<cmdId>.json`

2) **Auditoria offline no CT**
   - Rodar auditoria comparando:
     - CT `assigned` (estoque) vs perfis do export do servidor (preferir correlação por `cookie_fp`).
   - Script (CT): `C:\sitechatbot\scripts\auditHostAssigned.js`

3) **Correções (somente com evidência)**
   - Duplicado no servidor: usar `delete_perfis` no perfil duplicado (guardar ACK).
   - Cross-host: decidir “onde fica”, corrigir CT e deletar duplicata no host errado (um por vez).
   - Fantasma: reprovisionar 1 por vez **ou** arquivar em Excluídas (motivo explícito).

4) **Teste real de exclusão manual (opcional, mas recomendado antes de repetir em massa)**
   - Humano exclui manualmente 1–2 perfis.
   - GPT confirma:
     - export pós-exclusão (perfil não existe; contagem caiu),
     - CT: conta saiu de `assigned` e foi para `archived` (Excluídas),
     - inventário `ct_fb_stock_server_profiles` marcou `deleted_on_server_at/reason`.

Reinícios:
- normalmente **nenhum** (é operação via CT + ação manual do humano no host).

---

### Playbook (CANÔNICO) — Alinhamento no disco: `perfis.json` vs `dados/perfis` vs Chrome User Data (órfãos/recovery/purge)

Objetivo: repetir de forma **forense e segura** (um host por vez) a limpeza/recuperação de perfis “órfãos” no host, sem “ressuscitar legado”.

Quando usar:

- discrepância do tipo: `perfis.json` tem X perfis, mas `C:\conveniente\dados\perfis\` tem muito mais pastas,
- suspeita de wipe/falha histórica de exclusão (pastas ficaram no disco),
- necessidade de recuperar “perfis quentes” que podem existir no `User Data` mesmo fora do `perfis.json`.

Regras não negociáveis (segurança):

- **NUNCA** habilitar rebuild automático do `perfis.json` a partir de `dados/perfis/` durante limpeza.
  - Flag perigosa (manter OFF): `PERFIS_ALLOW_REBUILD_FROM_RECORDS=1`.
- Toda ação destrutiva deve ter **ACK** no CT e **report** no host (`dados/_ops_audit`).
- Separar em grupos antes de apagar:
  - **lixo confirmado** (órfão + sem `manifest`/sem `User Data`),
  - **recovery candidates** (órfão + `manifest` existe),
  - **system** (ignorar).

Fonte/validação:

- Exemplo validado (RM1): `C:\conveniente\docs\checkups\checkup_2026-02-13_rm1_profiles_orphans_alignment.md`

Procedimento (ordem canônica):

1) **FS audit no host (somente leitura)**
   - Comando remoto (via CT): `profiles_fs_audit`
   - Evidência:
     - ACK: `C:\sitechatbot\dados\logs\<hostId>\ack_<cmdId>.json`
     - Report no host: `C:\conveniente\dados\_ops_audit\profiles_fs_audit_<ts>_<cmdId>.json`

2) **Classificar órfãos no CT (sem tocar no host)**
   - Cruzar lista de órfãos com CT `ct_fb_stock_server_profiles` (se possível).
   - Ferramenta CT (offline):
     - `C:\sitechatbot\tools\ct_audit_orphans_from_profiles_fs_audit_ack.js`
   - Saída: listas para automatizar purge/relink em lotes (ex.: `tools\_rmX_ctDeleted_*.json`, `tools\_rmX_ctMissing_*.json`)

3) **Purge seguro (apenas órfãos CT-deleted)**
   - Comando remoto (via CT): `profiles_purge_dirs`
   - Primeiro `DRY_RUN=1`, depois `DRY_RUN=0`.
   - Guardrail do comando: **não apaga** se o nome estiver em `perfis.json` ou `desired.json`.

4) **Probe sanitizado (órfãos CT-missing)**
   - Comando remoto (via CT): `profiles_manifest_probe`
   - Objetivo: extrair metadata **sem secrets** (ex.: `hasLogin/hasPassword/cookiesCount/cookie_fp`) para decidir se vale relink.

5) **Relink para teste visual humano (controlado)**
   - Comando remoto (via CT): `profiles_relink_orphans`
   - Regras:
     - só relinka se existir `User Data + manifest`
     - grava `humanHold=true` (para não abrir/rodar automaticamente)

6) **Humano testa visualmente (fora do CT)**
   - Resultado deve voltar como lista: “manter” vs “excluir”.

7) **Excluir reprovados (remoção física)**
   - Comando remoto (via CT): `delete_perfis` com `profileNames[]`
   - Evidência: `ack_<cmdId>.json` com `okCount/failCount`.

8) **Purge final (lixo remanescente)**
   - Rodar `profiles_purge_dirs` para órfãos restantes (se existirem), sempre com dry-run antes.

Reinícios:

- normalmente **nenhum** (são comandos via CT). Só reiniciar `conveniente` se houver deploy de runtime envolvido.

Rollback:

- operações de limpeza não têm rollback automático. Se for necessário “voltar”, a ação correta é reprovisionar por decisão humana/CT.

### CT (sitechatbot) — Dashboard **Servidores**: catálogo de estados/flags (CANÔNICO)

Objetivo: o menu **Servidores** é fonte de verdade operacional. O operador precisa ver “qual host, qual problema, o que fazer”, sem “Desconhecido” genérico.

#### 1) Estados finais (mutuamente exclusivos) — `accountsAgg`

Fonte: CT `/servers` calcula agregados por host a partir de `status.perfis[]` do snapshot e do classificador:
- `C:\sitechatbot\convenientetecnologia\lib\fbAccountState.js`

Chaves canônicas:
- `captcha` (Captcha/Checkpoint)
- `login` (Tela de login)
- `session` (Sessão expirada)
- `two_factor` (2FA)
- `identity` (Identidade)
- `consent` (Consentimento)
- `login_other` (**Outros (login)** — obrigatório exibir o `loginReason` técnico para auditoria)
- `limit_exceeded` (Limite excedido — via Robe)
- `banned` (Banida/suspensa)
- `ok` (OK)

Observação:
- `lr_total` existe no backend como **AGREGADO** (soma dos subtipos), mas **não é estado final** e não deve ser somado junto com os subtipos.

#### 2) Flags operacionais (não exclusivas) — `flagsAgg`

Essas flags existem para guiar ação humana (ex.: “ir no host e resolver no browser”).

Chaves canônicas (CT `/servers`):
- `human_invoked`: conta perfis com `humanControl=true` **ou** `humanHold=true`
- `messenger_pin`: perfis com `messengerPin=true`
- `problem`: perfis com `problem=true`
- `virtus_offline`: perfis com `virtusOnline=false`
- `login_required`: perfis com `loginRequired=true`
- `login_reasons_top`: top 8 `loginReason` (array `{ reason, count }`) para explicar `login_other` sem payload gigante

Regras:
- O CT só retorna `accountsAgg/flagsAgg` quando o snapshot está fresco (`onlineRaw=true`) para evitar contagem enganosa em OFFLINE/stale.

---

### Intake de “texto bomba” do humano (CANÔNICO)

Quando o humano mandar uma mensagem grande/bagunçada com vários sintomas misturados, o GPT deve:

- colar o texto bruto em `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (RAW_INPUT)
- quebrar em itens separados na tabela TRIAGE (P0/P1/P2)
- coletar evidência via CT (logs_manifest/fetch_logs/ACK), sem pedir para o humano “investigar”
- **fazer análise de impacto antes de mexer em código**:
  - mapear fluxo ponta a ponta (callers/callees)
  - listar estados tocados (desired/status/perfis/locks)
  - listar possíveis efeitos colaterais (“corrigir fechar todos” pode afetar “abrir todos”, nurse, desired, virtus/robe)
- **olhar o histórico antes de reinventar a roda**:
  - checar `C:\conveniente\docs\TIMELINE.md` por entradas relacionadas (e por regressões)
  - checar `C:\conveniente\docs\checkups\file_timeline\INDEX_*.md` + hotspots para achar os arquivos certos rapidamente
- **perguntas obrigatórias (alinhamento)**, item-a-item:
  - “como deveria ser?” (comportamento esperado)
  - “qual é o critério de sucesso?” (validação objetiva)
  - “qual é a prioridade (P0/P1/P2) na visão do humano?”
  - “precisa reiniciar agora ou pode ser depois?” (pra não travar o trabalho)
- dizer de forma direta:
  - precisa reiniciar agora? sim/não
  - precisa reiniciar para validar? sim/não
  - qual projeto e como (`node index.js`)

Motivo: isso impede o GPT de “misturar problemas” e evita que um texto confuso vire mudança errada.

---

### Windows/PowerShell — pegadinhas operacionais (para GPT não perder tempo)

Este workspace roda no Windows com PowerShell. Algumas coisas “padrão Linux” **falham** aqui:

- **Sem `&&`**: em PowerShell, usar `;` para encadear comandos.
- **Sem heredoc `<<EOF`**: não usar `cat <<EOF` / heredoc para mensagem de commit.
  - Jeito correto para commit com mensagem multi-linha:
    - usar múltiplos `-m` (ex.: `git commit -m "título" -m "corpo..."`)
- **`node -e`**: strings longas com aspas/regex podem quebrar o parse do PowerShell.
  - Preferir `node -e "..."` com JSON simples, ou criar um script `.js` e executar `node script.js`.

Regra: quando um GPT registrar um procedimento com comandos, escrever no formato PowerShell.

---

### Incidente ativo (template “em tempo real”)

Use este bloco quando você e o GPT estiverem investigando algo agora. Quando fechar:
- registrar o **resumo** na `docs/TIMELINE.md`
- se virar procedimento, promover para este runbook (CANÔNICO/EXPERIMENTAL)

```text
INCIDENTE_ATIVO:
Criado em:
Responsável humano:
Responsável GPT:

Hipóteses (curtas):
- H1:
- H2:

Coletas pendentes (objetivas):
- logs (keys/patterns):
- request_secret:
- cmdId:

Evidências coletadas (links/paths):
- 

Decisão atual:
- 

Próximo passo:
- 
```

---

### Operações de recuperação (canônicas)

#### 1) Comando “travado/zumbi” no CT

- **Verificar**:
  - `sitechatbot/dados/commands.log` (eventos `enqueued`, `delivered`, `ack`, `gc_*`)
  - evidência por comando: `sitechatbot/dados/logs/<hostId>/ack_<cmdId>.json`

#### 2) Inventário de logs do servidor (sem adivinhar paths)

- **Preferir**: comando `logs_manifest` (retorna tamanho/mtime das keys allowlisted no servidor).

#### 3) Coleta de logs (tail)

- **Preferir**: `fetch_logs` por keys (allowlist no servidor).
- **Quando precisar de filtro**: `fetch_logs_query` com `patterns` (substring).

#### 3.1) Health bundle (P2) — coleta rápida “1 comando” (status + manifest)

Objetivo: acelerar investigações sem “adivinhar” paths e sem precisar pedir várias coletas.

- **Comando CT**: `health_bundle`
  - **Payload**:
    - `requestId` (obrigatório)
    - `includeTail` (opcional, default `false`) — **cuidado**: tail pode conter dados sensíveis
    - `tailLines` (opcional, default `400` quando `includeTail=true`)
  - **Resultado**: escreve no CT em `sitechatbot/dados/logs/<hostId>/<requestId>.json` via `/api/logs/ingest` com:
    - `health_summary` (JSON com contagens e amostras de perfis busy)
    - `health_manifest` (JSON com bytes/mtimeMs das keys allowlisted)
    - opcionalmente `tail_logger`/`tail_issues_fallback`

#### 3.2) Rotação de logs (P2) — evitar crescimento infinito do `logger.log`

- **Comando CT**: `rotate_logs`
  - **Payload**:
    - `keys` (opcional, default `["logger"]`) — keys do allowlist do servidor
    - `keep` (opcional, default `30`) — quantos arquivos antigos manter
  - **Efeito**:
    - rotaciona para `C:\conveniente\dados\logs\<key>.<YYYYMMDD-HHMMSS>.log`
    - recria o arquivo original vazio (para continuar append)

#### 4) Lock de provisão preso (maintenance_provision)

- **Verificar**:
  - `fetch_logs` key `provision_lock`
- **Recuperação**:
  - comando `provision_unlock` (force) — usar apenas quando tiver certeza que não há provisão legítima em andamento.

---

### Coleta de logs via CT (sem UI) — canal `*_secret`

Use quando você precisa pedir logs rapidamente sem depender do painel.

- **Criar requisição**: `POST {CT_BASE}/api/logs/request_secret`
  - Headers:
    - `x-log-secret: <LOG_INGEST_SECRET>` (valor não deve ser colado em docs)
  - Body:
    - `hostId`: (obrigatório)
    - `keys`: array com até 8 keys do allowlist do servidor
    - `tailLines`: opcional (default 1200)

- **Consultar resultado**: `GET {CT_BASE}/api/logs/request_secret/<requestId>`
  - Retorna `hasResponse` e o payload quando disponível.

- **Manifest (inventário)**: `POST {CT_BASE}/api/logs/manifest_secret`

Observação: esses endpoints também aceitam request **localhost** no CT (para debug direto no host do CT).

---

### Notificador — diagnóstico rápido

- O `notificador` NÃO expõe HTTP (opera por polling no CT).
- CT endpoints usados:
  - `GET /api/notifier/next`
  - `POST /api/notifier/ack`
- Auth recomendada: `NOTIFIER_API_KEY` via header `x-api-key`.
- Identidade do worker: header `x-worker-id` (no notificador: `NOTIFIER_WORKER_ID`, default hostname).

---

### Regra anti-loop-infinito (comandos/esperas)

Problema histórico: “GPT enviou comando e ficou esperando resposta para sempre”.

Regras canônicas:

- **Nunca** implementar espera infinita (`while(true)` / polling) sem:
  - **deadline** (`timeoutMs`/`budgetMs`)
  - **telemetria** (log por etapa + motivo do wait)
  - **saída com erro** (para o CT registrar e o GC encerrar)
- Em fluxos que envolvem CT⇄Servidor:
  - o CT é **assíncrono** (fila/ACK); o cliente deve esperar no máximo um tempo e então coletar evidência (`ack_<cmdId>.json`, logs) em vez de ficar girando.

Checklist para qualquer “espera” nova:

- Qual é o **timeout máximo**?
- Qual é o **critério de sucesso**?
- O que acontece no **timeout** (ACK/erro/rollback)?
- Onde fica a **evidência** (log key, arquivo, requestId/cmdId)?

---

### Nota operacional (CANÔNICO) — “só 1 conta vai” em login_remediate (fila/governor)

Sintoma típico:
- Após **Retomar trabalho** em 2 perfis, só 1 executa login/cookies; o outro fica em `loginRequired` “parado”.

Causa raiz (comum):
- o segundo fluxo caiu em `governor_busy` (permit max=1) e enfileirou retry, mas o `autoLoginRemediateTick` pode pular se o perfil estiver `configurando=true` (ex.: ainda em provision/abas).

Mitigação (fix aplicado em 2026-01-31):
- o retry marcado como `force=true` pode avançar mesmo com `configurando=true` quando `queued && nextAt<=now` e não há `provisionLock` ativo; `humanControl` continua sendo hard-stop.

Evidência/diagnóstico:
- `fetch_logs` key `provision_audit` e procurar:
  - `login_remediate_governor_denied` / `login_remediate_governor_retry_queued`
  - `auto_lr_tick_override_configurando`
  - `auto_login_remediate_begin`

---

### Postura sobre “keys” (para não virar fonte de bug)

Objetivo do projeto neste estágio: **confiabilidade interna**. Segurança “externa” não é prioridade agora.

Regras canônicas (para evitar “perdi a chave e quebrei o sistema”):

- Se uma key/secret estiver ausente, o sistema **não deve travar** nem entrar em loop.
- O comportamento deve ser **determinístico e explícito**:
  - logar um warning “key ausente” (para visibilidade),
  - continuar operando do jeito mais simples possível,
  - e jamais depender de “prompt humano” para continuar.

Observação: isso NÃO significa “inventar chaves novas”. Significa “se existir, usa; se não existir, segue sem quebrar”.

### Baseline de env (produção) — sugerido

- `conveniente`:
  - `OPEN_CHROMIUM_ON_START=0`
  - `LOG_TO_FILE=1` (logs em `C:\conveniente\dados\logger.log` via append)
  - `LOG_DEBUG=0` (ou `DEBUG=0`) (por default o `logger.js` assume debug ligado)
  - observação: `logger.log` pode crescer sem limite; monitorar tamanho e rotacionar manualmente se necessário.
  - `ALLOW_SELF_UPDATE_RESTART=0` (**importante**: evita `self_update` derrubar o processo sozinho)
  - `CONVENIENTE_FATAL_EXIT=0` (default). Se colocar `1`, o processo sai em `uncaughtException/unhandledRejection` para evitar “seguir vivo” corrompido (humano reinicia `node index.js`).
  - `BROWSER_ENGINE=chromium` (fase 1 canônica: engine padrão Chromium)
  - `CHROMIUM_PATH` (opcional, recomendado quando o binário não estiver no path default)
  - regra Fase 1: em `BROWSER_ENGINE=chromium`, o launcher é **estrito** (não faz fallback para Chrome).

- `sitechatbot`:
  - `LOG_LEVEL=INFO`
  - `CT_COMMANDS_PRUNE_INTERVAL_MS=30000`

---

### `self_update` (comando) — como funciona (canônico)

Fonte: `C:\conveniente\scripts\dashboard.js`.

- **O que ele faz**: executa `git` no diretório do repo do `conveniente` (equivalente a “atualizar código pelo Git”).
- **O que ele NÃO faz**: não garante que o código novo “entrou em execução” sem restart.
- **Sobre `restart=1`**:
  - se `ALLOW_SELF_UPDATE_RESTART=1`, o `conveniente` pode **sair do processo** após o update (para um gerenciador reiniciar).
  - como aqui não existe reinício automático, isso pode derrubar o serviço até o humano rodar `node index.js` de novo.
  - por padrão, manter `ALLOW_SELF_UPDATE_RESTART=0`.

Regra operacional:
- O GPT pode enviar `self_update` sem “ficar esperando”.
- Se a investigação/mudança precisar do código novo rodando, o GPT deve avisar: **“preciso que você reinicie `node index.js` no host X para continuar”**.

---

### Update padrão (CANÔNICO) — `conveniente` (sem perda de tempo)

Objetivo: o humano (Cássio) **não precisa repetir instruções**. Sempre que houver mudança no `conveniente`, o padrão é:

- **GPT faz**:
  - `git commit` + `git push` (GitHub)
  - **dispara `self_update` via CT** (sem ficar esperando)
  - avisa o humano com uma frase curta: **“reinicia `node index.js` no host X”**
- **Humano faz**:
  - reinicia manualmente no host do `conveniente`: `node index.js`
  - responde “reiniciado” (para o GPT registrar na `docs/TIMELINE.md`)

Regra importante:
- **Nem toda mudança precisa de restart “agora”** para continuar desenvolvendo outras correções.
- Restart é obrigatório quando você precisa que a mudança **esteja valendo no runtime** (ex.: testar “open_all/close_all” corrigido).
- Se a próxima tarefa não depende do runtime novo, o GPT pode continuar trabalhando e o humano pode reiniciar depois (quando for validar/testar).

#### Como o GPT dispara `self_update` via CT (canônico)

Fonte (CT): `C:\sitechatbot\index.js` endpoint `POST /api/commands/enqueue_secret`.

Regras de auth (importante):
- **Se o request for localhost no CT**: o endpoint aceita sem secret (isso existe exatamente para o humano não “ficar preso” por auth em emergências).
- **Se o request for remoto**: precisa `x-log-secret: <LOG_INGEST_SECRET>` (não colar valor em docs/chat).

Payload do `self_update` (servidor `conveniente`): `branch` (default `main`), `restart` (default **0**), `requestId` (opcional).

Exemplo de requisição (o GPT executa; o humano não):

```text
POST {CT_BASE}/api/commands/enqueue_secret
Headers:
  x-log-secret: <LOG_INGEST_SECRET>
Body (JSON):
  {
    "target": "<hostId>" | "all",
    "type": "self_update",
    "payload": { "branch": "main", "restart": 0, "requestId": "deploy_conveniente_YYYYMMDD_HHMM" }
  }
```

Evidência mínima (obrigatória) para provar que o `self_update` foi enviado:
- `C:\sitechatbot\dados\commands.log` deve conter:
  - `event:"enqueue"` com `type:"self_update"` e `target:"<hostId>"` (ou `target:"*"`),
  - depois `event:"deliver"` para o mesmo `hostId`,
  - e `event:"ack"` com `ok:true/false`.
- Por comando, o CT salva ACK em: `C:\sitechatbot\dados\logs\<hostId>\ack_<cmdId>.json`.

Se o humano reportar “tive que dar git pull no host”:
- Tratar como **falha de processo** (o `self_update` não foi enfileirado/entregue/ack).
- O GPT deve coletar evidência acima e registrar em `TIMELINE.md` (com `hostId`, `cmdId`, paths).

Notas:
- `target="all"` vira broadcast (`*`) no CT.
- **Não usar** `restart=1` neste ambiente (sem reinício automático).
 - Vocabulário humano: “**pull**” = disparar `self_update` (update de Git no host).

---

### EXPERIMENTAL — “comandos novos sem restart” (hot-load / plugins)

Ideia: permitir que o GPT crie “novos comandos” em tempo real sem depender de deploy + restart.

Status: **não implementado** (somente proposta).

Observações importantes:
- Para isso ser possível com segurança e auditabilidade, precisa existir uma **infra** no servidor que já saiba:
  - receber um “plugin/ação” (arquivo ou pacote),
  - validar (mínimo: hash/assinatura/segredo),
  - registrar evidência (quem criou, quando, hash),
  - carregar e executar sem quebrar o processo.
- Mesmo com hot-load, normalmente ainda existe **um primeiro rollout** (deploy/restart) para instalar essa infra.

Quando formos implementar, vira um checkup próprio com:
- riscos,
- formato do plugin,
- logs/evidência,
- kill-switch,
- rollback.

---

### EXPERIMENTAL — Integração Asaas (novo fluxo de leads pay-per-lead)

Objetivo: preparar cobrança automática por lead (sem expor secrets).

Escopo desta fase:
- geração de cobrança **fixa**: **segunda e quinta às 22:00** (fuso `America/Sao_Paulo`);
- bloqueio por inadimplência: **quinta e segunda às 10:00**;
- regra de competência: tudo que entrar desde a última emissão entra na próxima emissão (corte no instante real de emissão);
- baixa automática por webhook de pagamento;
- desbloqueio de elegibilidade por baixa confirmada.Configuração (sem valor em docs/chat):
- `ASAAS_ACCESS_TOKEN` (token API);
- `ASAAS_BASE_URL` (ex.: produção/sandbox);
- `ASAAS_WEBHOOK_TOKEN` (validação de webhook, se aplicável);
- `ASAAS_BILLING_METHODS` (ex.: `boleto,pix`).Local recomendado de configuração:
- ambiente do `sitechatbot` (`process.env`) no host do CT;
- nunca salvar valor de token em arquivo versionado.Evidência mínima por rodada:
- requestId/correlationId por emissão;
- id da cobrança no Asaas + status retornado;
- evento de baixa recebido no webhook;
- transição de elegibilidade no CT (bloqueado -> liberado).Regra:
- se token for compartilhado em texto livre por engano, abrir INC de rotação imediata e revogar chave anterior.

---

## Atualizacao operacional (2026-02-23) — transicao legado/tokenized

### 1) Voltar grupos para legado (manter apenas Ipatinga tokenized)

- Arquivo fonte unica:
  - `C:\notificador\tokenized_pilot_groups.json`
- Estado atual canônico:
  - somente `120363329985026016@g.us` (Ipatinga) no piloto tokenized.
- Observacao:
  - o `notificador` usa cache curto da lista (segundos); restart nao e obrigatorio, mas pode ser feito para efeito imediato.

### 2) Reset total de carteiras/leads (baseline zero)

- Script canônico:
  - `C:\sitechatbot\tools\reset_all_wallets_full_wipe.js`
- Execucao:
  - dry-run: `node tools/reset_all_wallets_full_wipe.js`
  - aplicar: `node tools/reset_all_wallets_full_wipe.js --apply`
- Efeito:
  - zera `ct_driver_lead_ledger`, `ct_driver_lead_invoices`, `ct_driver_lead_controls` (financeiro de leads).
- Validacao objetiva esperada:
  - `ledger=0`, `invoices=0`, `open_invoices=0`, `active_lead_awards=0`.

### 3) Limpeza seletiva de leads em aberto (quando nao for wipe total)

- Script:
  - `C:\sitechatbot\tools\cleanup_open_leads_tokenized_rollout.js`
- Uso:
  - dry-run: `node tools/cleanup_open_leads_tokenized_rollout.js`
  - aplicar: `node tools/cleanup_open_leads_tokenized_rollout.js --apply`
  - opcional: `--keep-token=<LEAD_TOKEN>` para preservar leads especificos.

### 4) Regra de leitura no CT ("Leads em aberto")

- Critério correto:
  - nao exibir `lead_award` que ja tenha exclusao vinculada (`lead_contested_exclusion` via `contest_source_entry_id`).
- Objetivo:
  - evitar dupla leitura visual (lead aparecendo em "aberto" e "excluido" ao mesmo tempo).

### 5) Safeguard obrigatorio em scripts destrutivos (2026-02-23)

- Scripts com escrita destrutiva agora exigem **dupla intencao**:
  - `node tools/reset_all_wallets_full_wipe.js --apply --confirm`
  - `node tools/cleanup_open_leads_tokenized_rollout.js --apply --confirm`
  - `node tools/reset_wallets_tokenized_rollout.js --apply --confirm`
- Comportamento sem `--confirm`:
  - retorno `ok=false`
  - `error=missing_confirm`
  - `hint` com comando correto.
- Objetivo:
  - reduzir risco operacional de execucao acidental em ambiente errado.

### 6) Simulacao canônica pre-Go/No-Go (contestacao)

- Matriz completa (10 motivos + bloqueio da segunda contestacao no mesmo case):
  - `node tools/simulate_contestation_matrix_live.js --driver 48991985634 --customer 48991985634`
- Concorrencia:
  - `node tools/simulate_contestation_concurrency_live.js --driver 48991985634 --customer 48991985634 --count 36`
- Gate de aprovacao:
  - matriz `ok=true` e `pass=true`;
  - concorrencia `ok=true`, `fail=0`.

---

## Diagnóstico enterprise — “pedido não chega no grupo” (fila não drena)

### Sintomas típicos

- Pedidos ficam em `status=pending` por muito tempo (sem virar `sending` e sem `sent_at`).
- Ou um pedido fica preso em `status=sending` com `sent_at=NULL` por muito tempo.

### Causas raiz mais prováveis (já observadas no campo)

1) **`notificador` parado**
- Evidência: lock stale em `C:\notificador\.notificador.lock` apontando para PID morto.
- Ação: iniciar `C:\notificador` → `node index.js`.

2) **Roteamento de cidade inválido**
- Evidência: `pedidos.last_error` com `no_group_for_city:<cidade_uf>`.
- Exemplo observado: `no_group_for_city:IPATINGA-MG`.
- Ação imediata: usar a cidade canônica que existe no mapa do notificador (ex.: `Ipatinga (MG)`).

### Evidência objetiva (como checar)

- Ver status da fila:
  - `C:\sitechatbot\dados\pedidos.sqlite` → tabela `pedidos`:
    - `status`, `sent_at`, `locked_at`, `locked_by`, `last_error`

- Checar se `notificador` está vivo:
  - lock: `C:\notificador\.notificador.lock` (PID gravado)
  - processo: `node index.js` em execução no diretório `C:\notificador`

### Procedimento de recuperação (seguro)

- Se `notificador` estiver parado: **subir primeiro**.
- Se houver pedido preso em `sending` sem `sent_at`: pode requeuear para `pending` (caso único) para reprocessar.

> Importante: a correção definitiva é manter o `notificador` como serviço/instância única saudável. Se o lock aponta PID morto, isso é sinal de encerramento inesperado e deve ser tratado como incidente operacional.

---

## Diagnóstico enterprise — CT “engessado” / API lenta (timeouts)

### Sintomas típicos

- UI do CT demora muito para carregar (ou desconecta).
- Requisições internas (incluindo `/health`) ficam lentas, intermitentes ou estouram timeout.

### Causa raiz provável (já observada)

- O `sitechatbot` executa tarefas pesadas com I/O síncrono no mesmo processo do servidor HTTP.
  - Exemplo: snapshots de auto-backup com `copyFileSync/statSync/rmSync` podem bloquear o event-loop por segundos.

### Correção (hardening)

- Rodar o auto-backup em **processo filho** (worker), evitando bloquear o event-loop:
  - worker: `C:\sitechatbot\tools\ct_auto_backup_worker.js`
  - `sitechatbot/index.js` dispara o worker via `spawn()` no boot e a cada intervalo.

### Validação objetiva (pós-fix)

- Medir latência do `/health` em loop (esperado: < 200ms em ambiente local estável).
- Abrir o CT e repetir 10 navegações rápidas (sem travar).

### Impacto operacional

- Requer restart do `sitechatbot` para valer.---

## Operação enterprise (recomendado) — 3 processos separados (CT / Notificador / Ngrok)

### Objetivo

- Isolar falhas e reduzir acoplamento operacional.
- Evitar mistura “runtime unificado” (spawn de filhos) com instâncias manuais.

### Como subir (padrão recomendado)

> Importante: o runtime unificado agora é **opt-in** (desligado por padrão).  
> Se você rodar `node index.js` em `C:\sitechatbot`, ele **não** deve tentar subir ngrok/notificador automaticamente.

#### Terminal 1 — `sitechatbot` (CT + WhatsApp + API)

- Pasta: `C:\sitechatbot`
- Comando:
  - `node index.js`

#### Terminal 2 — `notificador`

- Pasta: `C:\notificador`
- Comando:
  - `node index.js`

#### Terminal 3 — `ngrok` (túnel)

- Pasta: `C:\sitechatbot`
- Comando simples:
  - `node ngrok.js`

### Customizações (sem mexer em código)

- Para passar argumentos customizados ao ngrok (subdomain etc.):
  - `CT_NGROK_ARGS="http --region sa --subdomain <...> 3000"`

### Anti-padrão (não fazer)

- Rodar `sitechatbot` com runtime unificado **e** iniciar `notificador` manualmente.
  - Sintoma: `[LOCK] notificador já em execução` + logs confusos.

---

## Blindagem runtime (anti-travamento) — checklist de implantação segura

### Escopo aplicado- Audit assíncrono com retry/fallback/rotação:
  - `C:\sitechatbot\whatsapp\lib\audit.js`
- Retry WhatsApp com classificação de timeout/conexão + jitter:
  - `C:\sitechatbot\whatsapp\lib\whatsappApi.js`
  - `C:\sitechatbot\whatsapp\lib\outboxSender.js`
  - `C:\sitechatbot\whatsapp\lib\config.js`
- Observabilidade leve:
  - `C:\sitechatbot\whatsapp\lib\runtimeMetrics.js`
  - `C:\sitechatbot\whatsapp\index.js`
  - `C:\sitechatbot\index.js` (`/health` com `latency_ms`)

### Ordem de restart (para ativar no runtime)

1) Reiniciar `sitechatbot` (`C:\sitechatbot` -> `node index.js`)
2) Manter `notificador` separado (`C:\notificador` -> `node index.js`)
3) Manter `ngrok` separado (`C:\sitechatbot` -> `node ngrok.js` ou comando manual)### Gates de validação pós-restart

- `GET /health`:
  - `200` estável
  - presença de `latency_ms.samples/p50/p95/max`
- `GET /api/whatsapp/stats`:
  - presença de `runtime.counters` e `runtime.latencies`
- Fila de pedidos:
  - sem `pending/sending/error` presos
- Audit:
  - ausência de spam `EBUSY` em janela de observação
  - se lock ocorrer, fallback funcionando sem bloquear runtime

### Rollback rápido

- Reverter arquivos acima e reiniciar apenas `sitechatbot`.

---

## Monitoração do próximo turno (protocolo enxuto, produção controlada)

### Duração

- 2 janelas de 30 a 60 minutos com uso real.

### Coleta mínima obrigatória

- `/health`:
  - HTTP 200
  - `latency_ms.p95`
- `/api/whatsapp/stats`:
  - `runtime.counters` (`wa_api.timeout`, `audit.write_fail`, `outbox.retry_scheduled`, `outbox.failed_nonretryable`)
  - `runtime.latencies.wa_api.send_ms.p95`
- Fila `pedidos`:
  - sem stuck em `pending/sending/error`

### Critério de aceite rápido

- sem stuck de fila;
- sem crescimento anormal de `audit.write_fail`;
- `wa_api.timeout` apenas intermitente e com recuperação por retry.

### Registro canônico da rodada- consolidar evidências em:
  - `C:\conveniente\docs\inbox\need_evidence\INC-20260224-0005-01.md`

---

## Checkpoint oficial (12h) — produção controlada

### Resultado da rodada

- Runtime estável por ~12h na configuração de 3 processos separados.
- Endpoints operacionais respondendo (`/health`, `/api/whatsapp/stats`, `/api/pedidos/stats`).
- Fila de pedidos sem stuck (`pending/sending/error`).
- Outbox do recorte sem erro novo e com volume entregue.

### Estado de governança após checkpoint

- `INC-20260222-2310-01`: fechado (`done`, `pass_for_core`).
- `INC-20260224-0005-01`: permanece aberto (`need_evidence`, `in_progress`) para fechamento formal após próxima janela assistida.
- Sorteio: manter produção em `3 minutos`.

### Padrão operacional congelado

- Manter 3 terminais/processos separados:
  - `C:\sitechatbot` -> `node index.js`
  - `C:\notificador` -> `node index.js`
  - `C:\sitechatbot` -> `node ngrok.js` (ou comando manual ngrok)
- Não reativar runtime unificado durante monitoracão assistida.

---

## Fechamento de cobrança (E2E real) + reset de base

### Resultado validado

- Fluxo CT↔Asaas de boleto validado em produção controlada nos 5 cenários críticos:
  1) criar sem duplicar;
  2) pagar e baixar automático;
  3) cancelar e reabrir lead;
  4) excluir e compensar lead;
  5) editar e reemitir.

### Controles obrigatórios ativos

- criação idempotente por `externalReference`;
- cancelamento com confirmação remota (`deleted=true`);
- reconciliação periódica anti-zumbi/órfão;
- baixa manual com governança (override explícito + motivo + trilha).

### Reset operacional (quando solicitado pelo owner)

- comando:
  - `node C:\sitechatbot\tools\reset_all_wallets_full_wipe.js --apply --confirm`
- pré-condição:
  - preflight Asaas sem falhas (`failures=0`);
- pós-condição esperada:
  - `ct_driver_lead_ledger=0`
  - `ct_driver_lead_invoices=0`
  - `ct_driver_lead_controls=0`
  - `open_invoices=0`.

---

## Estado vigente — pilotos tokenized (2026-02-26)

Fonte única:
- `C:\notificador\tokenized_pilot_groups.json`

Grupos ativos:
- `120363329985026016@g.us` (Ipatinga)
- `120363404258521988@g.us` (Montes Claros)
- `120363319453489081@g.us` (Foz do Iguaçu)
- `120363418394810828@g.us` (Fortaleza)
- `120363311442748035@g.us` (Petrolina)
- `120363420004498085@g.us` (Balneário Camboriú)

Checklist rápido de revalidação:
1. arquivo JSON válido;
2. IDs sem duplicidade;
3. cada `groupId` existente em `C:\notificador\gruposids.json`;
4. mapeamento 6/6 cidades-alvo confirmado.

---

## Sorteio `rank_mode=load` — contingência canônica (sem fallback silencioso)

Diretriz enterprise desta frente:

- sem fallback silencioso de regra de negócio (`load` -> `legacy`);
- sem travamento global do sistema;
- falha fica contida na janela/token afetado (fail-closed por janela), com evidência obrigatória e reprocesso explícito.

Documento canônico:
- `C:\conveniente\docs\checkups\checkup_2026-03-02_anexo_canonico_contingencia_sorteio_load.md`

Regra operacional:
- se uma janela entrar em erro de cálculo de carga, o GPT registra evidência e executa fluxo de reprocesso controlado; não “troca de critério em silêncio”.

---

## Canary RM1 — restore Chrome + anti-rajada mínimo (2026-03-07)

Objetivo:
- reduzir rajada interna de scan/open sem carregar as camadas amplas do experimento Chromium.

Pré-condição obrigatória:
- snapshot do estado atual antes de restore:
  - `C:\sitechatbot\backups\conveniente_code_chromium_pre_restore_20260307_112310\_code_snapshot_manifest.json`

Restore code-only (sem tocar dados):
- arquivos restaurados:
  - `scripts/worker.js`
  - `scripts/browser.js`
  - `scripts/api_status.js`
  - `scripts/bootstrapService.js`
  - `instalar_conveniente.ps1`

Patch mínimo obrigatório pós-restore (`scripts/worker.js`):
- `LR_SCAN_BASE_MS` default: `10min`
- `LR_SCAN_JITTER_MS` default: `2min`
- `AUTO_LOGIN_REMEDIATE_MIN_INTERVAL_MS` default: `10min`
- backoff progressivo `nurse/open` em `ram_denied`:
  - `NURSE_OPEN_BACKOFF_MIN_MS` default `2min`
  - `NURSE_OPEN_BACKOFF_MAX_MS` default `45min`
  - `NURSE_OPEN_BACKOFF_GROWTH` default `2`
  - `NURSE_OPEN_BACKOFF_JITTER_MS` default `20s`
- `REOPEN_DELAY_SHORT_MS` default: `60s`

Validação canônica (janela de horas):
- confirmar redução de repetição curta de `nurse_open_denied` por perfil;
- confirmar presença de `lr_scan_cadence_applied` e ausência de scan contínuo em segundos;
- quando houver LR real, confirmar `auto_login_remediate_queued` -> `auto_login_remediate_begin`;
- manter observabilidade por `provision_audit` e `login_required_events.jsonl`.

---

## Hardening Virtus anti-"feed reload visual" (2026-03-07, RM7)

Contexto:
- operação detectou efeito visual de "recarregando chats" no perfil `florianopolis-1764625643701` sem confirmação de `page.reload` puro em rajada recente.

Evidência canônica:
- CT `fetch_logs_query` cmdId `3f8dcb74-a366-46ea-8aef-074ce6b094f4`;
- requestId `rm7_floripa_forense_20260307_123545`;
- dossiê: `C:\conveniente\docs\checkups\checkup_2026-03-07_forense_floripa_reload_chatfeed.md`.

Mudança técnica (`scripts/virtus.js`):
- `POLL_INTERVAL_MS` default humanizado:
  - normal `60s` (antes `30s`);
  - slow `90s` (antes `45s`).
- `SCROLL_TOP_INTERVAL_MS` default humanizado:
  - normal `5min` (antes `30s`);
  - slow `8min` (antes `60s`).
- novos guardrails:
  - `SCROLL_TOP_IDLE_MIN_GAP_MS=10min`;
  - `KEEPALIVE_MIN_GAP_MS=5min`.
- removido reforço `scroll +800ms` no loop.

Pós-deploy (janela 60 min):
- medir queda de eventos visuais de refresh em operação;
- manter taxa de resposta Virtus estável;
- verificar ausência de regressão de `login_required`/bloqueio temporário no perfil foco.

---

## Guardrail Nurse anti-retry curto (2026-03-07, RM7)

Contexto:
- investigação fase 2 encontrou risco de tentativas repetidas de `nurse_open_attempt` em intervalo curto quando perfis ficam sem controller (flapping).

Evidência:
- `fetch_logs` cmdId `0c12f7c4-dd42-4a75-8edc-392c767975b3`
- `fetch_logs_query` cmdId `cdeb8c5b-d1ec-4be6-90ef-c202cf8b13d9`

Mudança técnica:
- `scripts/worker.js`
  - `NURSE_INTERVAL_MS` configurável (default `10000`);
  - `NURSE_OPEN_MIN_RETRY_MS` configurável (default `60000`);
  - `nurse_open_denied` agora aplica `activationHeldUntil` mínimo, evitando retry imediato.

Resultado esperado:
- reduzir tentativa/open "nervoso" sem bloquear recuperação legítima do perfil.

---

## Humanização de micro-ações Virtus (2026-03-07, RM7)

Contexto:
- após estabilizar loops de abertura, persistia risco de assinatura robótica em click/typing no `virtus`.

Mudança técnica:
- `scripts/virtus.js`
  - typing:
    - `VIRTUS_TYPE_DELAY_MIN_MS=55`
    - `VIRTUS_TYPE_DELAY_MAX_MS=120`
  - pré-envio:
    - `VIRTUS_ENTER_AFTER_TYPE_MIN_MS=350`
    - `VIRTUS_ENTER_AFTER_TYPE_MAX_MS=900`
  - abertura de chat:
    - click nativo com delay no elemento alvo (fallback simples);
    - `VIRTUS_CHAT_OPEN_POST_CLICK_MIN_MS=700`
    - `VIRTUS_CHAT_OPEN_POST_CLICK_MAX_MS=1400`
    - `VIRTUS_CHAT_OPEN_CHECK_INTERVAL_MS=450`
    - tentativas de confirmação `8 -> 6`.

Resultado esperado:
- menor assinatura de automação no Messenger sem perda de funcionalidade de atendimento.

---

## Humanização global de pausas no Robe (2026-03-07, RM7)

Contexto:
- fluxo de publicação (`robe`/`robeVeiculos`) apresentava muitos sleeps curtos repetidos.

Mudança técnica:
- `scripts/robe.js`, `scripts/robeVeiculos.js`:
  - novo guardrail central:
    - `ROBE_HUMAN_PAUSE_MIN_MS=220`
    - `ROBE_HUMAN_PAUSE_JITTER_MS=180`
  - comportamento:
    - `sleep(0)` preservado;
    - `sleep` abaixo do mínimo sobe para faixa humana;
    - `sleep` acima do mínimo mantém valor.

Resultado esperado:
- menos assinatura de ritmo robótico no Robe sem impacto funcional relevante.

---

## Humanização no Browser Helper (2026-03-07, RM7)

Contexto:
- `browser.js` ainda continha delays fixos curtos em ações de click/type.

Mudança técnica:
- `scripts/browser.js`
  - pausa humana central:
    - `BROWSER_HUMAN_PAUSE_MIN_MS=220`
    - `BROWSER_HUMAN_PAUSE_JITTER_MS=180`
  - jitter de ação:
    - click `90..170ms`
    - type `65..140ms`
  - aplicado em caminhos de nonce/login/fallback e click real de assistente.

Resultado esperado:
- menor assinatura sistemática no helper base de navegador com manutenção de robustez.

---

## Forense de microações residuais (2026-03-07, RM7)

Contexto:
- auditoria estática detectou pontos ainda mecânicos:
  - `virtus`: `sleep` sem guardrail e ranges curtos em type/click;
  - `robe`/`robeVeiculos`: delays de click/type muito baixos;
  - `browser`: `sleep` local em prune bypassava guardrail;
  - `worker`: loops fixos curtos de stock-provision.

Mudança técnica:
- `scripts/virtus.js`
  - `VIRTUS_HUMAN_PAUSE_MIN_MS=260`, `VIRTUS_HUMAN_PAUSE_JITTER_MS=220`;
  - type `85..180ms`, enter pós-type `550..1300ms`;
  - click de abertura de chat `110..220ms`;
  - pós-click `1100..2200ms`; polling de confirmação `700ms`.
- `scripts/robe.js` e `scripts/robeVeiculos.js`
  - click `110..220ms`; type `45..95ms` com jitter.
- `scripts/browser.js`
  - prune usa `sleep` global humanizado (remove bypass local).
- `scripts/worker.js`
  - `STOCK_PROVISION_LOCK_WATCH_INTERVAL_MS=5000` (default);
  - `STOCK_PROVISION_RESUME_INTERVAL_MS=10000` (default).

Resultado esperado:
- menos microassinatura sistemática em interações de DOM/teclado/mouse e menor pressão de loops curtos de manutenção.

---

## Hotfix: sem `goto` de chat + recovery com anti-insistência (2026-03-07, RM7)

Contexto:
- evitar fallback de URL de chat no Virtus e reduzir repetição agressiva em rotas de recuperação do Worker.

Mudança técnica:
- `scripts/virtus.js`
  - removido `goto` para `.../marketplace/t/${chatId}/` em `composer_missing`;
  - reconciliação de pendências sem `goto` (libera pending envelhecido para fila normal).
- `scripts/worker.js`
  - `HEALTH_RECOVERY_MIN_ACTION_GAP_MS` default `120000`;
  - `PHANTOM_COOLDOWN_BETWEEN_TRIES_MS` default `120000`;
  - `recoveryStep()` usa `lastRecoveryActionAt` para impedir ações repetidas em janela curta.

Resultado esperado:
- menor assinatura de insistência em recuperação e eliminação de navegação forçada para chat.

---

## Robe criar item — categoria/descrição/localização em DOM variável (CANÔNICO, 2026-04-02)

Objetivo:
- manter o fluxo de publicação estável mesmo quando o Facebook muda o layout entre contas.

Regras canônicas de seleção de **categoria**:

1) **Modelo com input search** (`input[aria-label="Categoria"][type="search"]`):
- digitar `Diversos`;
- priorizar seleção efetiva com `ArrowDown` + `Enter` (com retry curto);
- validar que a categoria foi realmente aplicada (não apenas texto digitado no input).

2) **Modelo por cards/lista** (`role="radio"`/`role="button"` sem input search):
- escolher categoria randomizada da lista aprovada;
- clicar opção por texto normalizado;
- validar aplicação no combobox/estado da tela.

3) **Modelo legacy TAB**:
- manter mapeamento controlado de tabs (1/2/23/24) com fallback por clique textual;
- evitar sequência de TAB agressiva.

Regras canônicas de **descrição**:
- preencher antes de localização;
- fonte: `C:\conveniente\dados\descricaoItens.json`;
- localizar textarea por label `Descrição`; se não achar, usar fallback por textarea visível próxima da seção.

Regras canônicas de **localização**:
- tentar localizar na etapa atual normalmente;
- se não existir, clicar `Avançar` (até 2 etapas), reabrir `Mais detalhes` e tentar novamente;
- só falhar após esse fallback explícito.

Evidência operacional mínima:
- logs do Robe com `step`:
  - `category_ok` (com `method`),
  - `description_try`,
  - `location_ok`.

Rollback:
- `git revert` dos commits da rodada Robe e novo `self_update` + restart manual do `conveniente`.