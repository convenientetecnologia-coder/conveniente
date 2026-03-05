### Checkup — Fase 1 Chromium estrito (implementação em código)

#### Contexto

- Data: 2026-03-05
- Escopo: `conveniente`
- Tipo: implementação cirúrgica (sem deploy neste passo)

---

### O que foi implementado

- `scripts/browser.js`
  - adicionado `BROWSER_ENGINE` (default `chromium`);
  - `BROWSER_ENGINE=chromium` agora resolve **somente Chromium** (sem fallback para Chrome);
  - erro explícito orientando instalação/configuração quando Chromium não é encontrado;
  - log de evidência do engine/binário efetivo no launch.

- `scripts/bootstrapService.js`
  - propagação de envs para task/NSSM:
    - `BROWSER_ENGINE`
    - `CHROMIUM_PATH`
    - `CHROME_PATH`
  - objetivo: evitar drift entre sessão interativa e modo serviço.

- `instalar_conveniente.ps1`
  - Chromium marcado como obrigatório;
  - verificação pós-instalação (paths padrão Windows);
  - falha explícita se Chromium não existir.

---

### Evidências

- `C:\conveniente\scripts\browser.js`
- `C:\conveniente\scripts\bootstrapService.js`
- `C:\conveniente\instalar_conveniente.ps1`
- validação sintática local:
  - `node -e "require('./scripts/browser.js'); require('./scripts/bootstrapService.js'); console.log('ok')"` => `ok`

---

### Observação importante (Puppeteer)

- Ter `puppeteer` no `package.json` **não garante** que o runtime está usando Chromium no fluxo real.
- O `conveniente` usa `executablePath` explícito; portanto, o binário efetivo depende da resolução de paths/env no código.
- Com a Fase 1, o modo `chromium` ficou estrito no launcher.

---

### Reinícios necessários

- Para aplicar no runtime: reiniciar `conveniente` no host alvo (`node index.js`) após deploy.
- Nesta etapa (apenas código local): nenhum.

