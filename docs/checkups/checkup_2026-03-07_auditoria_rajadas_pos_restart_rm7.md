### Checkup — Auditoria de rajadas pós-restart (RM7)

Data: 2026-03-07  
Host: RM7 (`29546e77-083e-4c81-b90f-4402499d0fef`)  
Objetivo: detectar rajadas residuais (reload, verificação, remediação) após restore Chrome + patch anti-rajada.

---

### Evidência coletada via CT

- `logs_manifest`:
  - cmdId `15b72497-bfd4-4912-aa82-9db4421859d6`
  - requestId `rm7_burst_manifest_20260307_114730`
  - ack ok em `C:\sitechatbot\dados\logs\29546e77-083e-4c81-b90f-4402499d0fef\ack_15b72497-bfd4-4912-aa82-9db4421859d6.json`
- `fetch_logs`:
  - cmdId `5fca2ab4-2a7d-4ba3-b227-009a1cc6927b`
  - requestId `rm7_burst_fetch_20260307_114730`
  - arquivo retorno: `C:\sitechatbot\dados\logs\29546e77-083e-4c81-b90f-4402499d0fef\rm7_burst_fetch_20260307_114730.json`
- `fetch_logs_query` (provision_audit com padrões de rajada):
  - cmdId `94da4e23-68b1-4a08-a935-d33ce544cd53`
  - requestId `rm7_burst_query_20260307_114730`
  - arquivo retorno: `C:\sitechatbot\dados\logs\29546e77-083e-4c81-b90f-4402499d0fef\rm7_burst_query_20260307_114730.json`

---

### Achados forenses (janela 20 min)

- Volume total analisado:
  - `provision_audit`: `1008` eventos (de `4999` no tail coletado)
  - `login_required_events`: `872` eventos

- Eventos de maior frequência (`provision_audit`, 20 min):
  - `auto_login_remediate_queued`: `83`
  - `lr_scan_deferred`: `28`
  - `lr_scan_cadence_applied`: `20`
  - `auto_login_remediate_begin`: `5`

- Sinal de rajada residual:
  - `auto_login_remediate_queued` repetindo no mesmo perfil com intervalo mínimo de ~`4.6s` a `5.1s` em múltiplos perfis.
  - `login_required_events` com `lr_scan_tabs=865` na janela de 20 min (cadência ainda acima do esperado para meta de ~10min por perfil).

- Sinais positivos (sem rajada no recorte):
  - `reload_related_20m=0`
  - `supervisor_denied_mentions_20m=0`
  - sem explosão de `nurse_open_denied` no recorte coletado.

---

### Causa raiz encontrada no código

- O gate de cadência do LR scan foi introduzido, mas o bloco `finally` que grava `nextAt`/`lr_scan_cadence_applied` ficou fora do ponto correto no `worker.js` em uma rodada anterior.
- Efeito prático: o `nextAt` não era consolidado no ciclo de scan, permitindo varredura em ritmo curto e consequente pressão de `auto_login_remediate_queued`.

---

### Correção aplicada nesta rodada

- `scripts/worker.js`:
  - removido `finally` indevido em fluxo de delete banido;
  - reposicionado `finally` no bloco correto da varredura LR para garantir atualização de `lrMeta.nextAt` e aplicação de cadência.

Impacto esperado:
- queda forte de `lr_scan_tabs` por minuto;
- redução de `auto_login_remediate_queued` repetitivo por perfil;
- manutenção da reação a LR real com ritmo humano.

---

### Próxima validação (obrigatória)

Após deploy + restart no RM7:
- repetir coleta (`logs_manifest`, `fetch_logs`, `fetch_logs_query`) em 20-30 min;
- comparar:
  - `lr_scan_tabs` (deve cair substancialmente);
  - `auto_login_remediate_queued` por perfil (intervalos mínimos devem sair da faixa ~5s);
  - ausência de rajada de `reload` e `nurse_open_denied`.
