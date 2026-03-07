### Checkup — Pré-código (restore Chrome + anti-rajada mínimo RM1)

#### Contexto

- Data: 2026-03-07
- Ambiente: produção controlada (canário)
- Host alvo inicial: RM1 (somente canário nesta etapa)
- Objetivo: voltar para baseline de código Chrome e reaplicar somente o que comprovou reduzir queda por rajada, sem mexer em dados.

---

### Evidências coletadas (objetivas)

- Backup baseline Chrome válido (feito antes da frente Chromium):
  - `C:\sitechatbot\backups\conveniente_full_20260305_140355\_backup_manifest.json`
  - `C:\sitechatbot\backups\conveniente_full_20260305_140355\_backup_robocopy.log`
  - resumo do log: `Falha: 0`, `Arquivos copiados: 12160`, `Diretórios: 947`.

- Snapshot de segurança do estado Chromium atual (code-only, antes do restore):
  - `C:\sitechatbot\backups\conveniente_code_chromium_pre_restore_20260307_112310\_code_snapshot_manifest.json`
  - `robocopy_exit_code=1` (sucesso com cópia).

- Auditoria de diff do runtime (`worker.js`) entre baseline e estado atual:
  - baseline: `C:\sitechatbot\backups\conveniente_full_20260305_140355\scripts\worker.js`
  - atual: `C:\conveniente\scripts\worker.js`
  - evidência técnica: diff salvo em `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\agent-tools\477ac33a-2d75-4372-bc1d-f6a71c7428ed.txt`.

---

### Achados técnicos (prioridade)

- **P0 — Mudanças grandes não essenciais para o objetivo imediato**
  - O runtime atual adicionou uma camada extensa de `recovery_queue` (`desired._recoveryQueue`, novos estados/tipos, executor e endpoint), que altera o fluxo padrão de LR/captcha/identity.
  - Para o objetivo atual ("restaurar base Chrome + conter rajada"), essa camada não é requisito funcional obrigatório.

- **P0 — Fonte real de pressão operacional está na cadência de varredura e reabertura**
  - No baseline, a varredura de LR em abas roda em ciclo curto do nurse.
  - Também há reabertura curta (`REOPEN_DELAY_SHORT_MS=5000`) e backoff fixo muito baixo em ramos de negação por RAM/slots.
  - Isso aumenta chance de comportamento de "pânico" nas entranhas, mesmo quando visualmente parece estável.

- **P1 — Risco de regressão de LR se desaceleração for exagerada**
  - Cadência muito longa ou gating excessivo pode fazer parecer "LR parou".
  - Decisão do owner: cadência única para todos em ~10min + auto-LR com intervalo mínimo de ~10min por perfil.

- **P1 — Mudanças Chromium estritas não são alvo desta rodada**
  - Alterações de engine em `browser.js` (modo estrito Chromium, retries extras de launch e ajustes de abas Messenger/Create) não entram no recorte do canário RM1 Chrome.

---

### Decisão de implementação (cirúrgica)

- Estratégia aprovada:
  1) restaurar **somente código** para baseline Chrome (sem tocar `dados/`);
  2) reaplicar patch mínimo anti-rajada no `worker.js`;
  3) rollout apenas em RM1;
  4) validar por janela de horas antes de escalar.

- Escopo mínimo de restore code-only (baseline):
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\scripts\browser.js`
  - `C:\conveniente\scripts\api_status.js`
  - `C:\conveniente\scripts\bootstrapService.js`
  - `C:\conveniente\instalar_conveniente.ps1`

- Patch mínimo anti-rajada (após restore do `worker.js`):
  - Cadência única de LR scan para todos os perfis: ~10min com jitter (evitar burst sincronizado).
  - `AUTO_LOGIN_REMEDIATE_MIN_INTERVAL_MS` default para ~10min.
  - Backoff progressivo no nurse/open (substituir intervalo curto/fixo por escalonamento com teto).
  - Sem `recovery_queue` nesta rodada.

---

### Plano de validação canário (RM1)

- Provas obrigatórias pós-deploy:
  - `logs_manifest` e `fetch_logs` com keys:
    - `provision_audit`, `status`, `desired`, `login_required_events`, `issues_fallback`.

- Sinais esperados:
  - redução de repetição curta de `nurse_open_denied` para o mesmo perfil;
  - presença de `login_required_detected` + `auto_login_remediate_begin` quando houver LR real;
  - ausência de rajada de scan contínuo em segundos.

---

### Rollout e rollback

- Rollout:
  - commit/push;
  - `self_update` somente no RM1;
  - restart humano no RM1 com `node index.js`;
  - observação por algumas horas.

- Rollback rápido:
  - reverter commits do restore/patch;
  - `self_update` no RM1;
  - restart humano `node index.js`.

---

### Reinícios necessários

- Durante auditoria/documentação: nenhum.
- Para aplicar no runtime: somente `conveniente` do RM1 (`node index.js`).
