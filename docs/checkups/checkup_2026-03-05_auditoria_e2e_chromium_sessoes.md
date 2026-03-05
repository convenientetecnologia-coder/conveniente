### Checkup — auditoria E2E (Chromium + sessões existentes)

#### Contexto

- Data: 2026-03-05
- Escopo: `conveniente` (pré-código, sem deploy)
- Objetivo: provar, por código, o estado atual de:
  1) executar em Chromium sem fallback para Chrome,
  2) reaproveitar sessões já salvas,
  3) manter sessão "quente" ao navegar,
  4) preencher UX com nome/email no perfil do navegador.

---

### Resposta direta (estado atual)

- **Rodar Chromium 110% sem fallback para Chrome**: **NÃO GARANTIDO AINDA**.
- **Usar sessões já salvas no servidor**: **SIM, já é o comportamento padrão atual**.
- **Salvar sessão continuamente ao operar (sessão quente)**: **SIM, com atualização de cookies no fluxo**.
- **UX nome/email no menu nativo do perfil do navegador**: **NÃO IMPLEMENTADO AINDA**.

---

### Evidência técnica por requisito

#### R1) Engine Chromium sem fallback

- `C:\conveniente\scripts\browser.js`:
  - `findChromeStable()` aceita `CHROME_PATH` e `CHROMIUM_PATH`, mas no Windows lista defaults de Google Chrome.
  - `openBrowser(...)` usa `executablePath = findChromeStable()`.
- Conclusão:
  - sem endurecimento de regra, ainda existe fallback efetivo para Chrome.

#### R2) Reuso de sessões já salvas (existentes)

- `C:\conveniente\scripts\api_perfis.js`:
  - cria `userDataDir` em `...Google\\Chrome\\User Data\\Conveniente\\<nome>`.
- `C:\conveniente\scripts\browser.js`:
  - `ensureUserDataDirUnderChrome(manifest)` força esse root.
  - `puppeteer.launch({ userDataDir })` abre no mesmo diretório persistente.
- `C:\conveniente\scripts\worker.js` / `dashboard.js`:
  - diversos fluxos de manutenção/deleção/auditoria usam esse mesmo padrão de path.
- Conclusão:
  - sessões já salvas são reaproveitadas por design (desde que mantenha o mesmo `userDataDir` root).

#### R3) Sessão quente (persistência durante operação)

- `C:\conveniente\scripts\browser.js`:
  - `collectFreshCookies(...)` coleta cookies ativos (`facebook` + `messenger`).
- `C:\conveniente\scripts\worker.js`:
  - atualiza `manifest.cookies` com `collectFreshCookies(...)` em fluxos de configure/login_remediate.
- `C:\conveniente\scripts\manifestStore.js`:
  - escrita atômica + lock serializado para `manifest.json`.
- Conclusão:
  - persistência é automática e contínua em fluxos críticos (não depende de operação manual do humano).

#### R4) UX nome/email no menu de perfil do navegador

- Não há rotina implementada para preencher identidade de perfil nativa (nome/email visível) no Chromium/Chrome.
- Há apenas normalização de `Preferences`/`Local State` para estabilidade de sessão.
- Conclusão:
  - requisito ainda pendente de implementação/POC.

---

### Mapa E2E (cadastro -> uso -> persistência -> reabertura)

1. Cadastro cria perfil com `userDataDir` estável (`api_perfis.js`).
2. Manifest/perfis apontam para o mesmo diretório persistente.
3. Launch abre sempre com esse `userDataDir` (`browser.js`).
4. Fluxos de operação coletam cookies frescos e gravam no manifest (`worker.js` + `manifestStore.js`).
5. Reabertura usa o mesmo diretório e reaproveita estado local/sessão.

---

### Riscos abertos (pré-código)

- **P0**: fallback indesejado para Chrome enquanto `findChromeStable()` não for endurecido para modo Chromium estrito.
- **P0**: bootstrap/service mode pode iniciar sem env de engine/executable (drift operacional).
- **P1**: UX nome/email no perfil ainda sem implementação validada.

---

### Gate de prontidão para começar código (Go/No-Go)

- **Go parcial** (para Fase 1):
  - backup baseline já concluído,
  - auditoria técnica concluída,
  - sessões existentes mapeadas e preservação confirmada por design.
- **No-Go para rollout**:
  - enquanto não eliminar fallback para Chrome,
  - enquanto não padronizar env em modo serviço,
  - enquanto não validar UX nome/email.

---

### Reinícios necessários

- Nesta auditoria: **nenhum**.

