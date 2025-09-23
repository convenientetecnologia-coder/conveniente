// scripts/api_perfis.js
const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveChromeUserDataRoot() {
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA;
    if (la) return path.join(la, 'Google', 'Chrome', 'User Data');
    // Fallback defensivo
    return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  // Fallback genérico (não usado no seu ambiente atual)
  return path.join(os.homedir(), '.config', 'google-chrome');
}

module.exports = (app, workerClient, fileStore) => {
  // Listar todas as contas (útil para debug/testing)
  app.get('/api/perfis', (req, res) => {
    try {
      const arr = fileStore.loadPerfisJson();
      res.json({ ok: true, perfis: arr });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Criar perfil (POST) { cidade, cookies }
  app.post('/api/perfis', async (req, res) => {
    try {
      const { cidade, cookies } = req.body || {};
      if (!cidade || !cookies) return res.json({ ok: false, error: 'Cidade e cookies obrigatórios.' });

      // BLOQUEIO DE CADASTRO (militar): bloqueia cadastro se RAM <= 3GB
      {
        const osmod = require('os');
        const freeMB = Math.floor(osmod.freemem() / (1024*1024));
        const MIN_CREATE_MB = parseInt(process.env.MIN_OPEN_REG_MB || '3072', 10);
        if (freeMB <= MIN_CREATE_MB) {
          try { require('./issues.js').append('system', 'mem_block_signup', `Cadastro bloqueado: RAM livre=${freeMB}MB <= ${MIN_CREATE_MB}MB`); } catch {}
          return res.json({
            ok: false,
            error: `Impossível abrir nova conta por falta de RAM (livre ${freeMB} MB, mínimo ${MIN_CREATE_MB} MB)`
          });
        }
      }

      // Memória livre (warning only)
      /*
      try {
        const osmod = require('os');
        const freeMB = Math.floor(osmod.freemem() / (1024*1024));
        const minMB = parseInt(process.env.MIN_FREE_RAM_MB || '1536', 10);
        if (freeMB < minMB) {
          console.warn(`[CRIAR-PERFIL] AVISO: Memória livre ${freeMB} MB abaixo de ${minMB} MB. A criação seguirá mesmo assim.`);
        }
      } catch {}
      */

      if (!fileStore.existsDir(fileStore.perfisDir)) fs.mkdirSync(fileStore.perfisDir, { recursive: true });

      let nome = require('./utils').slugify(cidade) + '-' + Date.now();
      while (fileStore.existsDir(path.join(fileStore.perfisDir, nome))) nome += Math.floor(Math.random() * 100);

      // UA com fallback
      const preset = fileStore.pickUaPreset() || {};

      const cookiesArr = require('./utils').normalizeCookies(cookies);
      if (
        !cookiesArr.length ||
        !cookiesArr.find(c => c.name === 'c_user') ||
        !cookiesArr.find(c => c.name === 'xs')
      ) {
        return res.json({ ok: false, error: 'Cookies inválidos ou ausentes: precisa de c_user e xs!' });
      }

      // Checagem de coordenadas (AVISO só)
      try {
        const geo = require('./utils').getCoords(cidade);
        if (!geo || !geo.latitude || !geo.longitude) {
          console.warn(`[CRIAR-PERFIL] AVISO: cidade "${cidade}" sem coordenadas em cidades_coords.json (seguindo normal).`);
        }
      } catch {}

      // userDataDir dentro do User Data do Chrome
      const chromeRoot = resolveChromeUserDataRoot();
      const userDataDir = path.join(chromeRoot, 'Conveniente', nome);
      try { fs.mkdirSync(userDataDir, { recursive: true }); } catch {}

      const perfilObj = {
        nome, cidade,
        uaPresetId: preset.id || 'default',
        uaString: preset.uaString,
        uaCh: preset.uaCh || {},
        fp: {
          viewport: preset.viewport || { width: 1366, height: 768 },
          dpr: preset.dpr || 1,
          hardwareConcurrency: preset.hardwareConcurrency || 4
        },
        cookies: cookiesArr,
        robeCooldownUntil: 0,
        configuredAt: null,
        userDataDir // <- AGORA dentro do User Data do Chrome
      };

      // Atualiza perfis.json
      const perfisArr = fileStore.loadPerfisJson();
      perfisArr.push(perfilObj);
      fileStore.savePerfisJson(perfisArr);

      // Grava manifest.json SOMENTE no userDataDir externo
      fs.writeFileSync(path.join(userDataDir, 'manifest.json'), JSON.stringify(perfilObj, null, 2), 'utf8');

      // desired.json default (não liga nada)
      const desired = fileStore.readJsonSafe(fileStore.desiredPath, { perfis: {} });
      desired.perfis = desired.perfis || {};
      desired.perfis[nome] = desired.perfis[nome] || { active: false, virtus: 'off' };
      fileStore.writeJsonAtomic(fileStore.desiredPath, desired);

      res.json({ ok: true, perfil: perfilObj });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Ativar perfil (declarativo: reconciliador faz a abertura)
  app.post('/api/perfis/:nome/activate', async (req, res) => {
    const nome = req.params.nome;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });

    // BLOQUEIO DE ATIVAÇÃO (militar): bloqueia ativação se RAM <= 3GB
    {
      const freeMB = Math.floor(require('os').freemem() / (1024*1024));
      const MIN_OPEN_MB = parseInt(process.env.MIN_OPEN_REG_MB || '3072', 10);
      if (freeMB <= MIN_OPEN_MB) {
        try { require('./issues.js').append(nome, 'mem_block_activate', `Ativação bloqueada: RAM livre=${freeMB}MB <= ${MIN_OPEN_MB}MB`); } catch {}
        return res.json({ ok: false, error: `Impossível abrir nova conta por falta de RAM (livre ${freeMB} MB, mínimo ${MIN_OPEN_MB} MB)` });
      }
    }

    try { fileStore.patchDesired(nome, { active: true }); } catch {}

    // Não chama o worker diretamente para evitar corrida com o reconciliador
    return res.json({ ok: true, queued: true });
  });

  // Desativar perfil (declarativo: reconciliador faz o fechamento)
  app.post('/api/perfis/:nome/deactivate', async (req, res) => {
    const nome = req.params.nome;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });

    try { fileStore.patchDesired(nome, { active: false, virtus: 'off' }); } catch {}

    // Não chama o worker diretamente para evitar corrida com o reconciliador
    return res.json({ ok: true, queued: true });
  });

  // Configurar/injetar cookies
  app.post('/api/perfis/:nome/configure', async (req, res) => {
    const nome = req.params.nome;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    // Timeout aumentado para 180000ms (3min) para comando configure
    const resp = await workerClient.sendWorkerCommand('configure', { nome }, { timeoutMs: 180000 });
    return res.json(resp);
  });

  // Iniciar atendimento/postagem
  app.post('/api/perfis/:nome/start-work', async (req, res) => {
    const nome = req.params.nome;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });

    // BLOQUEIO DE START-WORK (militar): bloqueia start-work se RAM <= 3GB
    {
      const freeMB = Math.floor(require('os').freemem() / (1024*1024));
      const MIN_OPEN_MB = parseInt(process.env.MIN_OPEN_REG_MB || '3072', 10);
      if (freeMB <= MIN_OPEN_MB) {
        try { require('./issues.js').append(nome, 'mem_block_activate', `Ativação bloqueada: RAM livre=${freeMB}MB <= ${MIN_OPEN_MB}MB`); } catch {}
        return res.json({ ok: false, error: `Impossível abrir nova conta por falta de RAM (livre ${freeMB} MB, mínimo ${MIN_OPEN_MB} MB)` });
      }
    }

    try {
      fileStore.patchDesired(nome, { virtus: 'on', active: true, robePause24h: true });
    } catch (e) {}
    // Apenas declara o desejo, reconciliador executa de fato
    return res.json({ ok: true, queued: true });
  });

  // Invocar humano
  app.post('/api/perfis/:nome/invoke-human', async (req, res) => {
    const nome = req.params.nome;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    const resp = await workerClient.sendWorkerCommand('invoke_human', { nome });
    return res.json(resp);
  });

  // Robe Play
  app.post('/api/perfis/:nome/robe-play', async (req, res) => {
    const nome = req.params.nome;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    const resp = await workerClient.sendWorkerCommand('robe-play', { nome });
    return res.json(resp);
  });

  // Robe 24h (individual)
  app.post('/api/perfis/:nome/robe-24h', async (req, res) => {
    const nome = req.params.nome;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    fileStore.patchDesired(nome, { robePause24h: true });
    return res.json({ ok: true });
  });

  // Retomar trabalho (desabilita controle humano e religa virtus/robe)
  // ***** MODIFICADO CONFORME INSTRUÇÃO *****
  app.post('/api/perfis/:nome/human-resume', async (req, res) => {
    const nome = req.params.nome;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    // Marca o "fine" do modo humano e ativa virtus novamente
    try {
      fileStore.patchDesired(nome, { humanResume: true });
    } catch (e) {}
    return res.json({ ok: true, queued: true });
  });

  // Alterar label do perfil (só label)
  app.patch('/api/perfis/:nome/label', (req, res) => {
    try {
      const nome = req.params.nome;
      const { novoLabel } = req.body || {};
      if (!nome || !novoLabel) return res.json({ ok: false, error: 'Parâmetros inválidos' });
      fileStore.updatePerfilLabel(nome, String(novoLabel));
      res.json({ ok: true, renamed: false, labelUpdated: true, nome });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Rename slug físico (diretório) — só se inativo! + mover userDataDir externo
  app.post('/api/perfis/:nome/rename', (req, res) => {
    try {
      const nome = req.params.nome;
      const { novoLabel } = req.body || {};
      if (!nome || !novoLabel) return res.json({ ok: false, error: 'Parâmetros inválidos' });
      if (fileStore.isPerfilAtivo(nome)) return res.json({ ok: false, error: 'Feche o navegador desta conta antes de renomear.' });

      // Renomeia diretório lógico (dados/perfis/NOME) + atualiza manifest interno
      const resp = fileStore.renamePerfilSlug(nome, novoLabel);

      // Atualiza label
      try { fileStore.updatePerfilLabel(resp.nome, String(novoLabel)); } catch {}

      res.json({ ok: true, ...resp });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Delete perfil (apenas se inativo!) — remove também userDataDir externo, se existir
  app.delete('/api/perfis/:nome', (req, res) => {
    try {
      const nome = req.params.nome;
      if (!nome) return res.json({ ok: false, error: 'nome ausente' });
      if (fileStore.isPerfilAtivo(nome)) return res.json({ ok: false, error: 'Feche o navegador antes de excluir esta conta.' });

      // Tenta remover userDataDir externo de forma correta (busca perfis.json)
      try {
        const perfisArr = fileStore.loadPerfisJson();
        const perfil = perfisArr.find(p => p && p.nome === nome);
        const udir = perfil && perfil.userDataDir;
        if (udir && fileStore.existsDir(udir)) {
          fileStore.rimrafSync(udir);
        }
      } catch {}

      // Remove de perfis.json
      const arr = fileStore.loadPerfisJson().filter(p => p && p.nome !== nome);
      fileStore.savePerfisJson(arr);

      // Remove desired.json
      try {
        const d = fileStore.readJsonSafe(fileStore.desiredPath, { perfis: {} });
        if (d.perfis && d.perfis[nome]) {
          delete d.perfis[nome];
          fileStore.writeJsonAtomic(fileStore.desiredPath, d);
        }
      } catch {}

      // Remove diretório do perfil (manifest/meta)
      const dir = path.join(fileStore.perfisDir, nome);
      fileStore.rimrafSync(dir);

      // Limpar status.json (cosmético; worker atualizará)
      try {
        const st = fileStore.readJsonSafe(fileStore.statusPath, null);
        if (st && Array.isArray(st.perfis)) {
          st.perfis = st.perfis.filter(p => p && p.nome !== nome);
          fileStore.writeJsonAtomic(fileStore.statusPath, st);
        }
      } catch {}

      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });
};