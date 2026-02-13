### Checkup — RM1: alinhamento de perfis no disco (órfãos / recovery / purge) — 2026-02-13

- **Host**: ROBE MÃE 1
  - `hostId=084c8fff-c508-47bd-a33e-3ab34aeb1e3d`
- **Objetivo**: deixar o host **100% alinhado** entre:
  - `C:\conveniente\dados\perfis.json` (fonte runtime),
  - `C:\conveniente\dados\desired.json` (estado desejado),
  - `C:\conveniente\dados\perfis\` (registro por diretório),
  - `Chrome User Data\Conveniente\<nome>` (User Data).
- **Regras de segurança usadas**:
  - **Nunca** ressuscitar legado automaticamente: rebuild de `perfis.json` a partir de `dados/perfis/` fica **desligado** por default (flag `PERFIS_ALLOW_REBUILD_FROM_RECORDS=1` permanece **OFF**).
  - Toda ação destrutiva gera **evidência** (ACK no CT + relatório `_ops_audit` no host).

---

## Estado observado (pós-purge “ctDeleted” e pré-relink)

O host RM1 tinha discrepância histórica entre `perfis.json` e `dados/perfis/` (pastas antigas permaneciam).

Evidência (FS audit no host, via CT):

- `cmdType=profiles_fs_audit`
- `cmdId=57ecd300-62a6-458c-bada-36eac4b9f54c` (ACK ok)
- ACK (CT): `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_57ecd300-62a6-458c-bada-36eac4b9f54c.json`
- Report (host): `C:\conveniente\dados\_ops_audit\profiles_fs_audit_1771003251211_57ecd300-62a6-458c.json`

Resumo do FS audit:

- `perfisJsonCount=51`
- `desiredCount=51`
- `perfisDirCount=68`
- `orphanDirsCount=17`

---

## Probing (sanitizado) dos 17 órfãos

Objetivo: identificar quais órfãos possuem `manifest.json`/cookies/login (potenciais “quentes” para teste visual).

Evidência:

- `cmdType=profiles_manifest_probe`
- `cmdId=47603d26-2696-4832-a878-832877e263ac` (ACK ok)
- ACK (CT): `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_47603d26-2696-4832-a878-832877e263ac.json`
- Report (host): `C:\conveniente\dados\_ops_audit\profiles_manifest_probe_1771004067305_47603d26-2696-4832.json`

---

## Relink (recovery controlado) — 10 perfis

Objetivo: **re-add** os perfis órfãos que possuem `User Data + manifest` para `perfis.json` de forma segura para **teste visual humano**.

Regras do relink:

- Só relinka se:
  - não estiver em `perfis.json` **nem** em `desired.json`, e
  - existir `userDataDir` e `manifest.json`.
- Escreve guardrails em `desired.json` para evitar auto-trabalho:
  - `active=false`, `virtus='off'`, `humanHold=true`

Evidência:

- `cmdType=profiles_relink_orphans`
- `cmdId=8b9d16a8-07b6-4dd6-bb5c-940ac2738b30` (ACK ok; `okCount=10`, `skippedCount=7`)
- ACK (CT): `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_8b9d16a8-07b6-4dd6-bb5c-940ac2738b30.json`
- Report (host): `C:\conveniente\dados\_ops_audit\profiles_relink_orphans_1771004870931_8b9d16a8-07b6-4dd6.json`

Perfis relinkados (10):

- `campo_grande-1759195112852` (Laura Oliveira)
- `caxias_do_sul-1759196033602` (Isaac Suarez)
- `ipatinga-1768507032189` (Gajsi Id)
- `manaus-1759193729710` (Bruno Guerrero)
- `novo_hamburgo-1759199761107` (Delia Cahuascanco)
- `porto_alegre-1769043525760` (Maicon Freitas)
- `porto_velho-1759200221805` (Accilus Paul)
- `ribeirao_preto-1769047186116` (5579991110072)
- `rio_de_janeiro-1760123880316` (Junior Maquiavel Silva)
- `taubate-1769132654273` (Carlos Santos)

Evidência de “nome humano ↔ slug” (export via host):

- `cmdType=stock_export_profiles`
- `cmdId=0e7f720e-7fe7-40d1-b1af-9195fdabafdb` (ACK ok; `profilesCount=10`)
- ACK (CT): `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_0e7f720e-7fe7-40d1-b1af-9195fdabafdb.json`

---

## Teste visual humano (resultado)

Relato humano (pós-relink): das 10, **somente 1 ficou ativa**:

- **Ativa (manter)**:
  - `Laura Oliveira — campo_grande-1759195112852`

- **Ruins (excluir)**:
  - `Isaac Suarez — caxias_do_sul-1759196033602` (desabilitada)
  - `Gajsi Id — ipatinga-1768507032189` (2FA)
  - `Bruno Guerrero — manaus-1759193729710` (desabilitada)
  - `Delia Cahuascanco — novo_hamburgo-1759199761107` (desabilitada)
  - `Maicon Freitas — porto_alegre-1769043525760` (desabilitada)
  - `Accilus Paul — porto_velho-1759200221805` (desabilitada)
  - `5579991110072 — ribeirao_preto-1769047186116` (senha inválida / desabilitada)
  - `Junior Maquiavel Silva — rio_de_janeiro-1760123880316` (desabilitada)
  - `Carlos Santos — taubate-1769132654273` (sem login/senha / desabilitada)

---

## Exclusão final — 9 perfis ruins (delete_perfis)

Objetivo: manter somente o perfil ativo e remover os 9 ruins do host (estado + disco).

Evidência:

- `cmdType=delete_perfis`
- `cmdId=bd31e092-5ac8-4a92-9e93-a8a06e9df38c` (ACK ok; `okCount=9`, `failCount=0`)
- ACK (CT): `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_bd31e092-5ac8-4a92-9e93-a8a06e9df38c.json`
- Observação: o ACK marcou `alreadyMissing=true` para:
  - `caxias_do_sul-1759196033602`
  - `rio_de_janeiro-1760123880316`

---

## Limpeza de lixo remanescente (órfãos sem manifest) — purge dirs

Objetivo: remover **somente diretórios órfãos** que não estão em `perfis.json` nem `desired.json`.

Evidência (apply):

- `cmdType=profiles_purge_dirs`
- `cmdId=8fc23b09-abaf-41a1-a723-824af9493012` (ACK ok; `okCount=6`, `failCount=0`)
- ACK (CT): `C:\sitechatbot\dados\logs\084c8fff-c508-47bd-a33e-3ab34aeb1e3d\ack_8fc23b09-abaf-41a1-a723-824af9493012.json`
- Report (host): `C:\conveniente\dados\_ops_audit\profiles_purge_dirs_1771005859983_8fc23b09-abaf-41a1.json`

Perfis/pastas removidos (6):

- `bauru-1769283484286`
- `cuiaba-1769237405159`
- `curitiba-1759189721518`
- `goiania-1768510447163`
- `juiz_de_fora-1759191210848`
- `ponta_grossa-1768509895748`

---

## Próximo (replicação RM2–RM7)

Para repetir em outro host:

1) `profiles_fs_audit` (somente auditoria; sem deletar)
2) classificar órfãos em grupos:
   - **CT deleted** (safe purge),
   - **CT missing** (investigar/probe/relink/teste visual),
   - **system** (ignorar).
3) `profiles_manifest_probe` para sanitizar e decidir “relink para teste” vs “lixo”.
4) `profiles_relink_orphans` para teste visual humano (sempre com `humanHold=true`)
5) `delete_perfis` para os reprovados
6) `profiles_purge_dirs` para sobras órfãs (com gate: nunca apaga se estiver em perfis/desired)

