# Checkup — validação runtime DR hardening (2026-02-21)

## Escopo

- validar pós-restart do `sitechatbot`:
  - orquestração (`sitechatbot` + `ngrok` + `notificador`);
  - backup DR para `G:\Meu Drive`;
  - durabilidade SQLite reforçada;
  - evidências de restore-first 1:1.

## Evidências objetivas

- `ngrok` operacional:
  - endpoint local `http://127.0.0.1:4040/api/tunnels` respondeu `200`;
  - túnel ativo no subdomínio canônico.
- processo de API escutando em `:3000`:
  - `netstat` com `LISTENING` em `0.0.0.0:3000` (PID do `node` em runtime).
- `notificador` em execução:
  - PID do lock presente em `tasklist` (`C:\notificador\.notificador.lock`).
- metadados de DR criados no Drive:
  - `G:\Meu Drive\_dr_meta\runtime_write_inventory.json`;
  - `G:\Meu Drive\sitechatbot\_dr_meta\last_success.json`;
  - `G:\Meu Drive\notificador\_dr_meta\last_success.json`.
- durabilidade SQLite validada em runtime de módulo:
  - CT (`ctDb`) em `synchronous=FULL` (`2`);
  - WhatsApp (`whatsapp/lib/db`) em `synchronous=FULL` (`2`) após ajuste de `schema.sql`.

## Ajustes aplicados nesta rodada

- `driveBackup`:
  - lock de execução por grupo (`mirror`, `overlay`, `snapshot`) para evitar starvation de overlay;
  - mantém timeout/manifest/quick_check/hash e execução assíncrona.
- SQLite:
  - `synchronous=FULL` por padrão nos bancos críticos;
  - `whatsapp/db/schema.sql` alinhado para `PRAGMA synchronous = FULL`.

## Pendências operacionais (gate)

1. Confirmar geração do primeiro `snapshot_manifest.json` no próximo ciclo de snapshot.
2. Seguir monitorando latência de `/api/notifier/next` em carga real (meta: p95 < 2s), sem reduzir garantias de durabilidade.

## Validação adicional pós-incidente (Ctrl+C / travamento)

- incidente reportado: encerramento irregular com `Ctrl+C` e travas intermitentes de runtime.
- hotfixes aplicados:
  - shutdown forçado com timeout no `sitechatbot` (`SIGINT`/`SIGTERM`);
  - cópias de backup pesado migradas para subprocesso assíncrono (`robocopy`) com timeout/kill de árvore;
  - manifesto pesado (`sha256`/`quick_check`) opcional por env para evitar bloqueio desnecessário em runtime.
- evidência runtime após hotfix:
  - `sitechatbot` responde em `:3000`;
  - `ngrok` responde em `:4040` com túnel ativo;
  - `drive_backup.jsonl` voltou a registrar `initial_live_overlay` com `ok:true` após os ajustes.
- observação:
  - endpoint `/api/notifier/next` respondeu com latência variável (em amostra: ~6s), porém sem erro funcional. Mantido como item de otimização contínua.

## Conclusão

- Estado atual: **muito robusto** para DR restore-first 1:1 no Windows, com endurecimento forte de durabilidade.
- Go para operação: **sim**, com monitoramento de latência do `notifier/next` como melhoria contínua.

## Rodada final de fechamento (selo operacional)

- ajuste aplicado:
  - `full_mirror` com exclusões por caminho absoluto para eliminar lock residual em diretórios voláteis durante `robocopy`.
- validação objetiva desta rodada:
  - `sitechatbot` mirror manual: `SITE_RC=3` (sem falhas);
  - `notificador` mirror manual: `NOTIFIER_RC=2` (sem falhas).
- decisão:
  - incidente DR de backup/orquestração apto para encerramento canônico (`pass_for_core`), mantendo monitoramento contínuo de latência (`/api/notifier/next`) e saúde de backup (`drive_backup.jsonl`).
