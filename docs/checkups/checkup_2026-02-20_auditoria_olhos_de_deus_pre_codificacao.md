### Checkup — Auditoria "olhos de deus" pré-codificação (2a rodada)

> Regra: este arquivo é um relatório. O resumo (1–3 linhas) vai para `docs/TIMELINE.md`.

#### Contexto

- Data: 2026-02-20
- Ambiente: prod (servidor operacional)
- Escopo: validar 110% antes de codar:
  - startup unificado (`sitechatbot` + `ngrok` + `notificador`);
  - continuidade/DR com backup completo no Drive privado.

---

### Evidências coletadas (objetivas)

- Componentes de startup:
  - `ngrok` existe: `C:\sitechatbot\ngrok.exe`
  - API do `sitechatbot` já expõe fila do notificador:
    - `GET /api/notifier/next`
    - `POST /api/notifier/ack`
  - `notificador` consome `SITECHATBOT_API_BASE` (default `http://127.0.0.1:3000`).
- Volume e dados críticos vivos:
  - `C:\sitechatbot\whatsapp\db\whatsapp.sqlite` ~`610,62 MB` (+ `-wal` ativo);
  - `C:\sitechatbot\dados\convenientetecnologia.sqlite` + `-wal` ativos;
  - `C:\sitechatbot\dados\pedidos.sqlite` + `-wal` ativos;
  - `C:\notificador\.baileys_auth` presente (sessão WhatsApp, 1645 arquivos).
- Capacidade de armazenamento:
  - Drive `G:` com ~`28,38 GB` livres.
- Rotinas atuais de backup local (código):
  - `sitechatbot`: snapshot local em `_backup_auto_root` com subset de arquivos + 2 bancos SQLite em `dados`.
  - `notificador`: snapshot local em `_backup_auto`; inclui código/config básicos; spool só opcional e amostrado.

---

### Achados (P0/P1/P2)

- **P0 — Gap crítico de continuidade de dados**
  - `whatsapp.sqlite` (e WAL/SHM) não está no snapshot local de `sitechatbot`.
  - impacto: restore pode voltar sem histórico/estado de conversas.

- **P0 — Gap crítico de sessão operacional**
  - rotina local do `notificador` não inclui `.baileys_auth`.
  - impacto: restore pode exigir novo pareamento/QR e interromper operação imediata.

- **P1 — Backup do notificador incompleto por desenho atual**
  - `spool` só entra se `NOTIFIER_AUTO_BACKUP_SPOOL=1` e ainda em amostra limitada.
  - impacto: possibilidade de perda parcial de fila em desastre.

- **P1 — Risco de consistência em banco ativo**
  - cópia contínua sem janela/snapshot atômico pode capturar estado intermediário.
  - impacto: restore com inconsistência lógica ou necessidade de recuperação manual.

- **P1 — Capacidade**
  - `G:` livre (~28,38 GB) é suficiente para começar, mas exige retenção disciplinada.
  - impacto: sem retenção/higiene, backup pode encher drive e falhar silenciosamente.

---

### Decisão / Ação recomendada (cirúrgica)

- Antes de codar features novas, fechar 4 guardrails de continuidade:
  1. incluir `whatsapp.sqlite` (+ wal/shm) no plano DR;
  2. incluir `.baileys_auth` no plano DR;
  3. definir snapshot atômico diário para SQLite;
  4. definir retenção e monitor de espaço no `G:`.

- Gate de prontidão para iniciar codificação:
  - **Go técnico** somente após esses guardrails serem aceitos no INC e refletidos no desenho final.

---

### Plano de rollout (desta auditoria)

- Reinícios necessários: nenhum (apenas auditoria/documentação).
- Saída desta rodada:
  - achados críticos formalizados (P0/P1);
  - critérios de gate pré-código definidos;
  - trilha canônica pronta para implementação cirúrgica.

