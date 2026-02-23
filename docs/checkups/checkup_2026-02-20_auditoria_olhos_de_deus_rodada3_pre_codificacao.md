### Checkup — Auditoria "olhos de deus" (3a rodada) pré-codificação

> Regra: este arquivo é um relatório. O resumo (1–3 linhas) vai para `docs/TIMELINE.md`.

#### Contexto

- Data: 2026-02-20
- Ambiente: prod (servidor operacional)
- Objetivo: revisão final extrema antes de codar orquestração única + backup DR no Drive.

---

### Evidências coletadas (objetivas)

- Runtime e portas:
  - API ativa em `:3000` (`LISTENING`, PID 4232).
  - ngrok ativo em `127.0.0.1:4040` (`LISTENING`, PID 1656).
  - túnel público ativo na API local:
    - `https://c0nv3n13nt3t3cn0l0g14jesus.sa.ngrok.io` -> `http://localhost:3000`.
- Dependências de integração:
  - `sitechatbot` expõe `/api/notifier/next` e `/api/notifier/ack` (contrato que o `notificador` consome).
  - `notificador` usa `SITECHATBOT_API_BASE` com default `http://127.0.0.1:3000`.
- Dados críticos vivos:
  - `whatsapp.sqlite` ~`610,62 MB` com `-wal` ativo;
  - `convenientetecnologia.sqlite` e `pedidos.sqlite` com WAL ativos;
  - `audit.jsonl` do WhatsApp ~`163,89 MB`;
  - `dados/snapshots.log` ~`530,66 MB`.
- Capacidade do Drive:
  - `G:` com ~`28,38 GB` livres.

---

### Achados (P0/P1/P2)

- **P0 — Cobertura DR ainda insuficiente**
  - backup local atual do `sitechatbot` não inclui `whatsapp.sqlite` (`db/whatsapp.sqlite` + wal/shm).
  - impacto: perda de continuidade de conversas no restore.

- **P0 — Sessão de mensageria fora do snapshot padrão**
  - backup local atual do `notificador` não inclui `.baileys_auth`.
  - impacto: possível necessidade de novo vínculo sessão/QR em desastre.

- **P1 — Crescimento de artefatos exige política forte**
  - `whatsapp.sqlite` + logs grandes e em crescimento contínuo.
  - com `G:` livre em ~`28,38 GB`, sem retenção por camadas o backup pode saturar.

- **P1 — Operação de boot ainda sensível a erro humano de comando**
  - evidência em terminal histórico mostra comando PowerShell com export env malformado (`=puppeteer`, `=false`) antes do `node index.js`.
  - impacto: ruído operacional e risco de configuração inconsistente.

- **P2 — Visibilidade de processo do notificador**
  - no momento da coleta, evidência forte de API+ngrok ativos; rastreabilidade de processo `notificador` precisa ser padronizada no futuro orquestrador (logs/pid/health).

---

### Decisão / Ação recomendada (cirúrgica)

- Pré-condições obrigatórias para início da implementação:
  1. incluir `whatsapp.sqlite` (+ wal/shm) no plano DR de Drive;
  2. incluir `.baileys_auth` no plano DR de Drive;
  3. incluir retenção por camadas com teto de uso do `G:`;
  4. padronizar boot único com logs explícitos de subprocessos (`sitechatbot/ngrok/notificador`) e shutdown encadeado.

- Sem essas pré-condições, o risco de restore incompleto permanece acima do aceitável para “quase zero perda”.

---

### Plano de rollout (auditoria)

- Reinícios necessários: nenhum (rodada somente de auditoria e documentação).
- Status desta rodada:
  - auditoria deep-dive concluída;
  - bloqueios de continuidade formalmente registrados;
  - pronto para codificação com guardrails explícitos.

