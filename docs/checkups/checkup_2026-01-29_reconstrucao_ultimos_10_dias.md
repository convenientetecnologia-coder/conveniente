### Checkup — Reconstrução retroativa (~10 dias) (2026-01-29)

Objetivo: recuperar o “ouro” dos últimos ~10 dias (mudanças e eventos) usando **evidências já existentes** (Git, backups, logs operacionais), e registrar isso para futuros GPTs trabalharem com contexto real.

> Importante: isto NÃO é “plano do futuro”. É reconstrução do passado (o que dá para provar).

---

## Fontes de evidência usadas

### `conveniente` (repo Git)

- `git log --since='2026-01-19'` (mensagens + hashes + datas)

### `sitechatbot` (CT)

- Backups automáticos: `C:\sitechatbot\_backup_auto_root\_snapshots.log`
- Recovery/restores: `C:\sitechatbot\_recovery\restore_summary_*.txt` + `restore_plan_*.json`
- Auditoria de rollback (documento): `C:\sitechatbot\docs\AUDITORIA_ROLLBACK_CONVENIENTE_20260127_165414.md`

### `notificador`

- Backups automáticos: `C:\notificador\_backup_auto\_snapshots.log`

Limitações (honesto):
- O “Cursor Timeline” (histórico interno da IDE) não está sendo usado aqui; esta reconstrução é baseada apenas no que está no disco (Git/backups/logs).

---

## 1) `conveniente` — reconstrução por dia (2026-01-19 → 2026-01-29)

Fonte: `git log` no repo `C:\conveniente`.

### 2026-01-19 (início da janela)

- **Painel/estoque + deploy**:
  - self_update com opção de restart e depois guardrail para não reiniciar automaticamente (`0730428`, `cda3f1b`).
  - CORS local hardening para Electron (`26ca165`, `36d9651`).
  - modal “Nova Conta” com diagnóstico enterprise e escapes (`51085d5`, `638b763`, `452f0a3`).
  - CT config via arquivo (`26526dc`).

### 2026-01-20

- **Provision resiliente / PIN guard / fb_gpt resolve**:
  - `enterprise: provision resiliente + PIN modal guard + fb_gpt resolve` (`3b6813e`).

### 2026-01-21

- **Comandos remotos + “Nova Conta” por categoria + PIN automation**:
  - `delete_perfis` remote command (`643f30c`).
  - `ct_config` (LOG_INGEST_SECRET) via arquivo quando missing (`14f9d1b`).
  - UI nova conta manual com seletor (fretes/veículos) (`75c8aa0`).
  - fluxo PIN do Messenger com iter ações/revert (`b894426`, `40aa6b8`, `08a286a`).

### 2026-01-22

- **ProvisionLock + auto-backup + provision_unlock**:
  - provision lock reentrante por owner (`46186dd`) + hardening stock_provision (`6ab1622`).
  - precedence do secret: `ct_config` > env (`cd474ba`).
  - auto-backup com retenção no conveniente (`b6bc7a7`).
  - `provision_unlock` + exposição do lock via fetch_logs (`4ab834c`).
  - close_all adquire lock e retorna falhas corretamente (`30723c3`).

### 2026-01-23

- **Login_remediate “enterprise” (evidência, timeouts, failfast) + docs audit**:
  - grande ciclo de melhorias no `login_remediate` (timeouts, fail-fast, evidência, detecção captcha/PIN/consent) (`3a26eab` … `be77706`).
  - sticky shard rebalance para evitar storm (`ffc62a2`).
  - docs: `ultra_enterprise_system_audit_2026-01-24.md` (commit `6d771c7`).
  - comandos/ops: `profiles_cleanup` e allowlist de logs de estado (`2f82c24`).

### 2026-01-24

- **Quiesce + status flags + login_required hardening**:
  - expor flags de virtus/robe/sendLock no status (`c578a81`).
  - quiesce obrigatório antes de injetar cookies (`cb9b8de`) e ajustes de login/human-resume.

### 2026-01-25

- **Ban/2FA pipeline + “Recurso/Identidade”**:
  - auto-archive/auto-delete com evidência, regras de “não deletar com Chrome vivo”, e monitoramento (muitos commits `fcf0de0`…`b8cfecd`).
  - overlay humano persistente e monitor de recurso/identidade.

### 2026-01-26

- **Políticas de humano/identity/captcha + hardening open-all**:
  - política “humano só via invoke_human” (depois vários ajustes) (`05f7ea8` …).
  - robustez de ban/2FA e kill de Chrome por userDataDir/rootPid.
  - open-all/human-resume para evitar about:blank, e probe pós-abertura.

### 2026-01-27

- **Stock provision 3-tabs + PIN + archive CT + self_update hot-restart**:
  - 3 tabs durante configure/login_remediate (`c8cede1`, `8351fe5`, `aacd4b0`).
  - PIN typing mais lento/robusto (`7b79f49`).
  - worker hot-restart após self_update (`fe8adb1`).
  - UA/FP para CT (`58c6afa`, `8e3d75c`).

### 2026-01-28

- **Open-all governance + perfis.json recovery + master-only writes**:
  - orquestração open-all (sequenciador/pausas/backoff/menos flicker) (`0fb616d`, `cc1563b`, `86d50f8`).
  - recuperação de perfis.json em boot + lock + comando repair (`229f109`, `5c62c07`, `554748f`).
  - master-only writes para perfis.json (IPC + audit) (`2ad6f9e`) e get-status respeitando shard (`f05e9d4`).
  - backup ops locais (list/restore snapshot) (`14f9391`, `1814d9b`).

### 2026-01-29 (fim da janela)

- **Correções de cluster/perfis + delete_perfis idempotente + ajustes open_all/login_required**:
  - `withPerfisFileLockUpdate` (cluster-safe) (`0477b47`) — *obs*: isso está ligado ao P0 identificado de lock owner-safe (checkup do conveniente).
  - delete_perfis mais idempotente e menos ruído (`d33fc85`, `805443f`).
  - ajustes open_all “messenger-only” (`151ebe3`) e login_required virtus off (`d99e2b0`).

---

## 2) `sitechatbot` — eventos observáveis (sem Git)

### Recovery/restore em 2026-01-20 (evidência direta)

Arquivos:
- `C:\sitechatbot\_recovery\restore_summary_20260120_214606.txt`
- `C:\sitechatbot\_recovery\restore_summary_20260120_214721.txt`
- `C:\sitechatbot\_recovery\restore_summary_20260120_220220.txt`

Resumo do que dá para provar:
- houve planos de restore com substituições de arquivos críticos (ex.: `index.js`, `ctDb.js`, `ctFbStock.js`, e `estoque.html`) com cutoff relacionado a `2026-01-20 10:36`.

### Backups automáticos do CT (evidência)

Arquivo:
- `C:\sitechatbot\_backup_auto_root\_snapshots.log`

Dados objetivos:
- **Quantidade**: 829 snapshots
- **Primeiro tag**: `20260121_110746`
- **Último tag**: `20260129_131415`

Interpretação:
- o auto-backup do CT esteve ativo continuamente ao menos de **21/01 até 29/01**.

### Auditoria de rollback (evidência)

Arquivo:
- `C:\sitechatbot\docs\AUDITORIA_ROLLBACK_CONVENIENTE_20260127_165414.md`

O que prova:
- houve comparação/rollback de snapshot de `conveniente` (RM4) e análise de diferenças “atual vs snapshot 20260127_165414”.

---

## 3) `notificador` — eventos observáveis (sem Git)

### Backups automáticos (evidência)

Arquivo:
- `C:\notificador\_backup_auto\_snapshots.log`

Dados objetivos:
- **Quantidade**: 390 snapshots
- **Primeiro tag**: `20260121_110755`
- **Último tag**: `20260129_131406`

Interpretação:
- o auto-backup do notificador esteve ativo continuamente ao menos de **21/01 até 29/01**.

---

## Conclusão (o “ouro” recuperado)

- O `conveniente` tem uma trilha bem completa via Git (mensagens descrevem o que mudou).
- O `sitechatbot` e o `notificador` têm trilha via backups + recovery + docs locais de auditoria.
- Próximo passo recomendado (se quiser enriquecer mais): selecionar 5–10 “marcos” e registrar no `docs/TIMELINE.md` como entradas resumidas com link para este checkup, mantendo o detalhe aqui.

