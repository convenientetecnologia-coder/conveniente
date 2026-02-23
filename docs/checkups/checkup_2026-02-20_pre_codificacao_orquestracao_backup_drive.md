### Checkup — Pré-codificação (Orquestração 1 comando + Backup DR no Drive)

> Regra: este arquivo é um relatório. O resumo (1–3 linhas) vai para `docs/TIMELINE.md`.

#### Contexto

- Data: 2026-02-20
- Ambiente: prod (servidor operacional do owner)
- Escopo: `sitechatbot` + `notificador` + `ngrok`
- Objetivo: auditoria completa antes de codar, para garantir plano de inicialização única e backup/restore com perda próxima de zero.
- Situação atual (humano):
  - hoje a operação sobe 3 processos por terminais separados;
  - necessidade de 1 comando único;
  - necessidade de backup completo contínuo no Drive privado para DR.

---

### Evidências coletadas (objetivas)

- Acesso ao destino de backup:
  - drive visível em `G:\Meu Drive`.
- Binário de túnel:
  - `C:\sitechatbot\ngrok.exe` existe (`~30,58 MB`), apto para comando canônico informado pelo owner.
- Dados críticos ativos e com atualização recente:
  - `C:\sitechatbot\dados\pedidos.sqlite` (`~28,14 MB`) + `pedidos.sqlite-wal` (`~3,97 MB`);
  - `C:\sitechatbot\dados\convenientetecnologia.sqlite` (`~41,51 MB`) + `convenientetecnologia.sqlite-wal` (`~9,27 MB`);
  - `C:\sitechatbot\dados\commands.json` (`~4,75 MB`).
- Volume operacional relevante:
  - `C:\sitechatbot\dados` com `49.891` arquivos;
  - `C:\notificador` com `15.550` arquivos.
- Segredos/estado sensível presentes:
  - `C:\sitechatbot\convenientetecnologia\ct.env`;
  - `C:\sitechatbot\whatsapp\.env`;
  - `C:\notificador\.baileys_auth` (sessão WhatsApp, `1.645` arquivos).
- Mecanismos de backup já existentes (locais):
  - `sitechatbot`: rotina `startAutoBackupSitechatbot()` em `C:\sitechatbot\index.js`;
  - `notificador`: rotina `startAutoBackupNotificador()` em `C:\notificador\index.js`;
  - ambos ainda focados em backup local no próprio servidor.

---

### Achados (P0/P1/P2)

- **P0**:
  - risco real de continuidade: dados críticos mudam continuamente e o backup atual não está externalizado no Drive;
  - restore completo sem dossiê formal e sem drill validado pode gerar retomada parcial.
- **P1**:
  - startup operacional depende de múltiplos terminais/processos manuais;
  - sem orquestrador único, aumenta risco humano de esquecer processo ao reiniciar.
- **P1**:
  - backups atuais são best-effort locais; falta política DR formal (manifesto/hashes/RPO/RTO/restore testado).
- **P2**:
  - retenção e classificação de artefatos (quente/frio/forense) ainda sem política canônica para Drive.

---

### Decisão / Ação recomendada (cirúrgica)

- O que mudar (próxima etapa de código):
  - tornar `C:\sitechatbot\index.js` o orquestrador único para subir/encerrar:
    - API `sitechatbot`;
    - `ngrok` (comando canônico do owner);
    - `notificador` como subprocesso.
  - implementar backup para Drive em duas camadas:
    - hot backup frequente;
    - snapshot atômico diário para SQLite (`.sqlite` + `-wal` + `-shm`) com manifesto de integridade.
- Por quê:
  - reduz risco operacional humano e dá trilha de recuperação robusta para troca de servidor.
- Risco:
  - sem snapshot atômico, cópia de banco pode ficar inconsistente;
  - sem encerramento encadeado, subprocessos órfãos podem ficar ativos.
- Rollback:
  - manter caminho atual de operação manual por terminais;
  - desativar orquestração/backup por flags env, se necessário.

---

### Plano de rollout (pré-código aprovado)

- Reinícios necessários:
  - somente após implementação (ainda não executado nesta auditoria).
- Ordem planejada:
  1. implementar orquestrador único;
  2. validar start/stop encadeado sem regressão;
  3. implementar backup Drive (hot + atômico);
  4. validar restore em host limpo (drill).
- Validação pós-rollout (checks):
  - `node index.js` em `C:\sitechatbot` sobe os 3 componentes;
  - parar o processo principal derruba subprocessos;
  - backup no Drive gera manifesto por execução;
  - restore em servidor limpo sobe e opera com dados preservados.

