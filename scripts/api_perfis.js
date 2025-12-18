// scripts/api_perfis.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const issues = require('./issues.js');
const { getAvailableMB } = require('./utils.js'); // <<< ADICIONADO CONFORME INSTRUÇÃO
const logger = require('./logger.js');

// --- HELPERS DE VALIDAÇÃO (conforme instrução) ---
const isValidSlug = s => typeof s === 'string' && /^[a-z0-9_-]+$/.test(s);
function assertPerfilExists(fileStore, nome) {
  if (!isValidSlug(nome)) throw new Error('nome invalido');
  const perfis = fileStore.loadPerfisJson();
  if (!perfis.find(p => p && p.nome === nome)) throw new Error('perfil inexistente');
}

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

// ===== IMPORTAÇÃO DO p-limit NO TOPO (conforme instrução) =====
const pLimitImport = require('p-limit');
const pLimit = pLimitImport.default || pLimitImport;

// ===== IMPORTAÇÃO DO manifestStore (conforme PASSO 1) =====
const manifestStore = require('./manifestStore.js');

module.exports = (app, workerClient, fileStore) => {
  // Listar todas as contas (útil para debug/testing)
  app.get('/api/perfis', (req, res) => {
    try {
      const arr = fileStore.loadPerfisJson();
      res.json({ ok: true, perfis: arr });
    } catch (e) {
      logger.error('Erro fatal na rota listagem de perfis', { rota: '/api/perfis', error: e && e.message }, e);
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // ===== PASSO 2 — Adicionar endpoint GET /api/perfis/:nome/manifest =====
  // GET /api/perfis/:nome/manifest — devolve manifest.json do perfil
  app.get('/api/perfis/:nome/manifest', async (req, res) => {
    const nome = req.params.nome;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      return res.json({ ok:false, error:e.message });
    }
    try {
      const man = await manifestStore.read(nome);
      res.json({ ok: true, manifest: man });
    } catch (e) {
      res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // Criar perfil (POST) { cidade, cookies }
  app.post('/api/perfis', async (req, res) => {
    logger.info('POST /api/perfis chamada', {});
    try {
      const { cidade, cookies } = req.body || {};
      if (!cidade || !cookies) {
        logger.warn('Tentativa de criação de perfil sem cidade ou cookies', { cidade });
        return res.json({ ok: false, error: 'Cidade e cookies obrigatórios.' });
      }

      // BLOQUEIO DE CADASTRO (militar): bloqueia cadastro se RAM <= 3GB
      {
        const freeMB = getAvailableMB();
        const MIN_CREATE_MB = parseInt(process.env.MIN_OPEN_REG_MB || '3072', 10);
        if (freeMB <= MIN_CREATE_MB) {
          logger.warn('Cadastro bloqueado por RAM', { cidade, freeMB, minRequiredMB: MIN_CREATE_MB });
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
        logger.warn('Tentativa de criação de perfil com cookies inválidos', { cidade });
        return res.json({ ok: false, error: 'Cookies inválidos ou ausentes: precisa de c_user e xs!' });
      }

      // Checagem de coordenadas (AVISO só)
      try {
        const geo = require('./utils').getCoords(cidade);
        if (!geo || !geo.latitude || !geo.longitude) {
          logger.warn('Cidade sem coordenadas definida em cidades_coords.json', { cidade });
        }
      } catch (e) {
        logger.error('Erro durante checagem de coordenadas', { cidade, error: e && e.message }, e);
      }

      // userDataDir dentro do User Data do Chrome
      const chromeRoot = resolveChromeUserDataRoot();
      const userDataDir = path.join(chromeRoot, 'Conveniente', nome);
      try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (e) {
        logger.error('Falha ao criar userDataDir externo', { nome, userDataDir, error: e && e.message }, e);
      }

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

      // desired.json default (não liga nada) - ATOMICIDADE GARANTIDA PELO LOCK!
      // ATENÇÃO: Toda alteração de desired.json DEVE ser feita por await fileStore.patchDesired para garantir atomicidade! Não manipule desired manualmente.
      await fileStore.withDesiredFileLockUpdate(desired => {
        desired.perfis = desired.perfis || {};
        desired.perfis[nome] = { ...(desired.perfis[nome] || {}), active: false, virtus: 'off' };
        return desired;
      });

      logger.info('Perfil criado com sucesso', { nome, cidade });
      res.json({ ok: true, perfil: perfilObj });
    } catch (e) {
      logger.error('Erro fatal na rota criação de perfil', { rota: '/api/perfis', cidade: req.body && req.body.cidade, error: e && e.message }, e);
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Ativar perfil (declarativo: reconciliador faz a abertura)
  app.post('/api/perfis/:nome/activate', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/activate chamada', { nome });
    const op = String(req.headers['x-operator'] || 'unknown');
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) { 
      logger.warn('Ativação de perfil inexistente ou inválido', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message }); 
    }
    await issues.append(nome, 'admin_activate_request', `by=${op}`);

    // Override explícito do hold humano ao ativar manualmente/por Abrir Todos
    await fileStore.withDesiredFileLockUpdate(desired => {
      desired.perfis = desired.perfis || {};
      desired.perfis[nome] = { ...(desired.perfis[nome] || {}), humanHold: false };
      return desired;
    });

    // BLOQUEIO DE ATIVAÇÃO (militar): bloqueia ativação se RAM <= 3GB
    {
      const freeMB = getAvailableMB();
      const MIN_OPEN_MB = parseInt(process.env.MIN_OPEN_REG_MB || '3072', 10);
      if (freeMB <= MIN_OPEN_MB) {
        logger.warn('Ativação bloqueada por RAM', { nome, freeMB, minRequiredMB: MIN_OPEN_MB });
        try { require('./issues.js').append(nome, 'mem_block_activate', `Ativação bloqueada: RAM livre=${freeMB}MB <= ${MIN_OPEN_MB}MB`); } catch {}
        return res.json({ ok: false, error: `Impossível abrir nova conta por falta de RAM (livre ${freeMB} MB, mínimo ${MIN_OPEN_MB} MB)` });
      }
    }

    // BLOQUEIO de ativação por limit_posting
    // --- PATCH CIRÚRGICO: BLOCO REMOVIDO CONFORME INSTRUÇÃO ---

    try { 
      await fileStore.withDesiredFileLockUpdate(desired => {
        desired.perfis = desired.perfis || {};
        desired.perfis[nome] = { ...(desired.perfis[nome] || {}), active: true };
        return desired;
      });
    } catch (e) {
      logger.error('Erro ao patchDesired para ativação', { nome, rota: '/api/perfis/:nome/activate', error: e && e.message }, e);
    }
    // Chama worker para ativar imediatamente:
    const r = await workerClient.sendWorkerCommand('activate', { nome }, { timeoutMs: 60000 }).catch(e => {
      logger.error('Erro ao enviar comando activate para worker', { nome, rota: '/api/perfis/:nome/activate', error: e && e.message }, e);
      return null;
    });
    if (!r || r.ok !== true) {
      logger.error('Falha ao ativar perfil', { nome, error: (r && r.error) || 'activate_failed' });
      return res.json({ ok: false, error: (r && r.error) || 'activate_failed' });
    }
    logger.info('Perfil ativado por API', { nome });
    return res.json({ ok: true });
  });

  // Desativar perfil (declarativo: reconciliador faz o fechamento)
  app.post('/api/perfis/:nome/deactivate', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/deactivate chamada', { nome });
    const op = String(req.headers['x-operator'] || 'unknown');
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      logger.warn('Tentativa de desativar perfil inexistente ou inválido', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message }); 
    }
    await issues.append(nome, 'admin_deactivate_request', `by=${op}`);

    try { 
      await fileStore.withDesiredFileLockUpdate(desired => {
        desired.perfis = desired.perfis || {};
        desired.perfis[nome] = { ...(desired.perfis[nome] || {}), active: false, virtus: 'off' };
        return desired;
      });
    } catch (e) {
      logger.error('Erro ao patchDesired durante desativação', { nome, rota: '/api/perfis/:nome/deactivate', error: e && e.message }, e);
    }
    // Chama worker para desativar imediatamente e propaga resultado real para o frontend
    try {
      const resp = await workerClient.sendWorkerCommand('deactivate', { nome, reason: 'admin', policy: null }, { timeoutMs: 60000 });
      if (!resp || resp.ok !== true) {
        logger.error('Falha ao desativar perfil (worker respondeu NOK)', { nome, resp });
        return res.json({ ok: false, error: (resp && resp.error) || 'deactivate_failed' });
      }
      logger.info('Perfil desativado por API', { nome });
      return res.json({ ok: true });
    } catch (e) {
      logger.error('Erro ao enviar comando deactivate ao worker', { nome, rota: '/api/perfis/:nome/deactivate', error: e && e.message }, e);
      return res.json({ ok: false, error: (e && e.message) || 'deactivate_failed' });
    }
  });

  // Configurar/injetar cookies
  app.post('/api/perfis/:nome/configure', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/configure chamada', { nome });
    const op = String(req.headers['x-operator'] || 'unknown');
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      logger.warn('Tentativa de configurar perfil inexistente ou inválido', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message }); 
    }
    await issues.append(nome, 'admin_configure_request', `by=${op}`);
    // Timeout aumentado para 180000ms (3min) para comando configure
    try {
      const resp = await workerClient.sendWorkerCommand('configure', { nome }, { timeoutMs: 180000 });
      logger.info('Perfil configurado por API', { nome });
      return res.json(resp);
    } catch (e) {
      logger.error('Erro fatal na rota configurar perfil', { nome, rota: '/api/perfis/:nome/configure', error: e && e.message }, e);
      return res.json({ ok: false, error: (e && e.message) || 'configure_failed' });
    }
  });

  // Iniciar atendimento/postagem
  app.post('/api/perfis/:nome/start-work', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/start-work chamada', { nome });
    const op = String(req.headers['x-operator'] || 'unknown');
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      logger.warn('Tentativa de start_work perfil inexistente ou inválido', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message }); 
    }
    await issues.append(nome, 'admin_start_work_request', `by=${op}`);

    // BLOQUEIO DE START-WORK (militar): bloqueia start-work se RAM <= 3GB
    {
      const freeMB = getAvailableMB();
      const MIN_OPEN_MB = parseInt(process.env.MIN_OPEN_REG_MB || '3072', 10);
      if (freeMB <= MIN_OPEN_MB) {
        logger.warn('Start work bloqueado por RAM', { nome, freeMB, minRequiredMB: MIN_OPEN_MB });
        try { require('./issues.js').append(nome, 'mem_block_activate', `Ativação bloqueada: RAM livre=${freeMB}MB <= ${MIN_OPEN_MB}MB`); } catch {}
        return res.json({ ok: false, error: `Impossível abrir nova conta por falta de RAM (livre ${freeMB} MB, mínimo ${MIN_OPEN_MB} MB)` });
      }
    }

    try {
      await fileStore.withDesiredFileLockUpdate(desired => {
        desired.perfis = desired.perfis || {};
        desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'on', active: true };
        return desired;
      });
    } catch (e) {
      logger.error('Erro ao patchDesired para start_work', { nome, error: e && e.message }, e);
    }
    // Garante ativação do browser e início do Virtus imediatamente
    const r1 = await workerClient.sendWorkerCommand('activate', { nome }, { timeoutMs: 60000 }).catch(e => {
      logger.error('Erro ao enviar activate p/ worker em start_work', { nome, error: e && e.message }, e);
      return null;
    });
    if (!r1 || r1.ok !== true) {
      // PATCH — se falhar, segure activationHeldUntil 60s
      logger.error('Falha ao ativar perfil para start_work', { nome, error: (r1 && r1.error) || 'activate_failed' });
      try {
        const statusPath = fileStore.statusPath || path.join(__dirname, '../dados/status.json');
        const st = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : null;
        if (st && Array.isArray(st.perfis)) {
          const ent = st.perfis.find(p => p && p.nome === nome);
          if (ent) ent.activationHeldUntil = Date.now() + 5000;
          fileStore.writeJsonAtomic && fileStore.writeJsonAtomic(statusPath, st);
        }
      } catch (e) {
        logger.error('Falha ao atualizar activationHeldUntil em erro de activate/start_work', { nome, error: e && e.message }, e);
      }
      return res.json({ ok: false, error: (r1 && r1.error) || 'activate_failed' });
    }
    const r2 = await workerClient.sendWorkerCommand('start_work', { nome }, { timeoutMs: 60000 }).catch(e => {
      logger.error('Erro ao enviar start_work p/ worker', { nome, error: e && e.message }, e);
      return null;
    });
    if (!r2 || r2.ok !== true) {
      // PATCH — se falhar, segure activationHeldUntil 5s (alinhado com padrão do sistema)
      logger.error('Falha ao start_work', { nome, error: (r2 && r2.error) || 'start_work_failed' });
      try {
        const statusPath = fileStore.statusPath || path.join(__dirname, '../dados/status.json');
        const st = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : null;
        if (st && Array.isArray(st.perfis)) {
          const ent = st.perfis.find(p => p && p.nome === nome);
          if (ent) ent.activationHeldUntil = Date.now() + 5000;
          fileStore.writeJsonAtomic && fileStore.writeJsonAtomic(statusPath, st);
        }
      } catch (e) {
        logger.error('Falha ao atualizar activationHeldUntil em erro de start_work', { nome, error: e && e.message }, e);
      }
      return res.json({ ok: false, error: (r2 && r2.error) || 'start_work_failed' });
    }
    logger.info('Start work realizado por API', { nome });
    return res.json({ ok: true });
  });

  // Invocar humano
  app.post('/api/perfis/:nome/invoke-human', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/invoke-human chamada', { nome });
    const op = String(req.headers['x-operator'] || 'unknown');
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      logger.warn('Tentativa de invoke-human em perfil inexistente ou inválido', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message });
    }
    await issues.append(nome, 'admin_invoke_human_request', `by=${op}`);
    try {
      const resp = await workerClient.sendWorkerCommand('invoke_human', { nome });
      logger.info('Comando invoke_human disparado', { nome });
      return res.json(resp);
    } catch (e) {
      logger.error('Erro fatal na rota invoke_human', { nome, rota: '/api/perfis/:nome/invoke-human', error: e && e.message }, e);
      return res.json({ ok: false, error: (e && e.message) || 'invoke_human_failed' });
    }
  });

  // Invocar Humano em TODOS os navegadores ATIVOS (não abre navegadores fechados)
  app.post('/api/perfis/invoke-human-all-active', async (req, res) => {
    try {
      await issues.append('system', 'admin_invoke_human_request', 'mass_invoke_all_active');
      const st = await workerClient.sendWorkerCommand('get-status', {}, { timeoutMs: 25000 });
      const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
      const ativos = perfis.filter(p => p.active && !p.humanControl);
      let okCount = 0, fail = [];
      for (const p of ativos) {
        try {
          // ====== ALTERAÇÃO ======
          await issues.append(p.nome, 'admin_invoke_human_request', 'by=mass');
          const r = await workerClient.sendWorkerCommand('invoke_human', { nome: p.nome }, { timeoutMs: 60000 });
          if (r && r.ok) okCount++;
          else fail.push(p.nome);
        } catch (e) {
          fail.push(p.nome);
        }
      }
      if (fail.length) return res.json({ ok: false, invoked: okCount, failed: fail });
      return res.json({ ok: true, invoked: okCount });
    } catch (e) {
      return res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // ===== NOVO ENDPOINT: Retomar trabalho em todos ATIVOS + humanControl (conforme instrução) =====
  app.post('/api/perfis/human-resume-all', async (req, res) => {
    const limit = pLimit(parseInt(process.env.RESUME_ALL_CONCURRENCY || '4', 10));
    try {
      await issues.append('system', 'admin_human_resume_request', 'mass_resume_all');

      const st = await workerClient.sendWorkerCommand('get-status', {}, { timeoutMs: 25000 });
      const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
      // Filtro: somente ativos + humanControl; ignora congelados (opcional)
      const candidatos = perfis.filter(p =>
        p && p.active === true && p.humanControl === true && !(p.robeFrozenUntil && p.robeFrozenUntil > Date.now())
      );

      let okCount = 0;
      const failed = [];
      const tasks = candidatos.map(p => limit(async () => {
        try {
          await issues.append(p.nome, 'admin_human_resume_request', 'by=mass');
          const r = await workerClient.sendWorkerCommand('human-resume', { nome: p.nome }, { timeoutMs: 60000 });
          if (r && r.ok) okCount++; else failed.push(p.nome);
        } catch (e) {
          failed.push(p.nome);
        }
      }));
      await Promise.all(tasks);

      return failed.length
        ? res.json({ ok: false, resumed: okCount, failed, total: candidatos.length })
        : res.json({ ok: true, resumed: okCount, total: candidatos.length });

    } catch (e) {
      return res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Robe Play
  app.post('/api/perfis/:nome/robe-play', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/robe-play chamada', { nome });
    const op = String(req.headers['x-operator'] || 'unknown');
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      logger.warn('Tentativa de robe-play para perfil inexistente ou inválido', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message });
    }
    await issues.append(nome, 'admin_robe_play_request', `by=${op}`);
    try {
      const resp = await workerClient.sendWorkerCommand('robe-play', { nome });
      logger.info('Comando robe-play disparado', { nome });
      return res.json(resp);
    } catch (e) {
      logger.error('Erro fatal na rota robe-play', { nome, rota: '/api/perfis/:nome/robe-play', error: e && e.message }, e);
      return res.json({ ok: false, error: (e && e.message) || 'robe_play_failed' });
    }
  });

  // Robe 24h (individual)
  app.post('/api/perfis/:nome/robe-24h', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/robe-24h chamada', { nome });
    const op = String(req.headers['x-operator'] || 'unknown');
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      logger.warn('Tentativa de robe-24h para perfil inexistente ou inválido', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message });
    }
    await issues.append(nome, 'admin_robe24h_request', `by=${op}`);
    const manifestStore = require('./manifestStore.js');
    const plus24 = 24 * 60 * 60 * 1000;
    try {
      await manifestStore.update(nome, man => {
        const now = Date.now();
        man = man || {};
        man.robeCooldownUntil = now + plus24; // worker em working
        man.robeCooldownRemainingMs = 0; // worker não working
        man.robePauseReason = 'manual';    // <-- NOVO!
        return man;
      });
      logger.info('Robe 24h aplicado manualmente', { nome });
      res.json({ ok: true });
    } catch (e) {
      logger.error('Falha ao aplicar robe 24h', { nome, rota: '/api/perfis/:nome/robe-24h', error: e && e.message }, e);
      await issues.append(nome, 'robe24h_failed', e && e.message || e);
      res.json({ ok: false, error: 'Não foi possível aplicar pause 24h: ' + (e && e.message || e) });
    }
  });

  // ===== PASSO 3 — Adicionar endpoint POST /api/perfis/:nome/custom-virtus-message =====
  // POST /api/perfis/:nome/custom-virtus-message — atualiza mensagem personalizada Virtus
  app.post('/api/perfis/:nome/custom-virtus-message', async (req, res) => {
    const nome = req.params.nome;
    const { enabled, message } = req.body || {};
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      logger.warn('Tentativa de custom-virtus para perfil inexistente', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message });
    }
    try {
      await manifestStore.update(nome, m => {
        m = m || {};
        m.customVirtusMessageEnabled = !!enabled;
        m.customVirtusMessage = String(message || '');
        return m;
      });
      res.json({ ok:true });
    } catch (e) {
      res.json({ ok:false, error: (e && e.message) || String(e) });
    }
  });

  // *** INÍCIO DA ALTERAÇÃO SOLICITADA ***
  // Define o modo do Robe por perfil ('itens' ou 'veiculos')
  app.post('/api/perfis/:nome/robe-mode', async (req, res) => {
    const nome = req.params.nome;
    const { mode } = req.body || {};
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      return res.json({ ok:false, error:e.message });
    }
    const m = String(mode || '').toLowerCase();
    if (m !== 'itens' && m !== 'veiculos') {
      return res.json({ ok: false, error: 'mode inválido (use "itens" ou "veiculos")' });
    }
    try {
      await manifestStore.update(nome, (man) => {
        man = man || {};
        man.robeMode = m;
        return man;
      });
      res.json({ ok:true });
    } catch (e) {
      res.json({ ok:false, error: (e && e.message) || String(e) });
    }
  });
  // *** FIM DA ALTERAÇÃO SOLICITADA ***

  // Retomar trabalho (desabilita controle humano e religa virtus/robe)
  // ***** MODIFICADO CONFORME INSTRUÇÃO *****
  app.post('/api/perfis/:nome/human-resume', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/human-resume chamada', { nome });
    const op = String(req.headers['x-operator'] || 'unknown');
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      logger.warn('Tentativa de human-resume para perfil inexistente ou inválido', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message });
    }
    await issues.append(nome, 'admin_human_resume_request', `by=${op}`);
    // Marca o "fine" do modo humano e ativa virtus novamente
    try {
      const resp = await workerClient.sendWorkerCommand('human-resume', { nome }, { timeoutMs: 60000 }).catch(()=>null);
      if (!resp || resp.ok !== true) {
        logger.error('Falha em human-resume para perfil', { nome, error: (resp && resp.error) || 'human_resume_failed' });
        return res.json({ ok: false, error: (resp && resp.error) || 'human_resume_failed' });
      }
      logger.info('Human resume aplicado', { nome });
      return res.json({ ok: true });
    } catch (e) {
      logger.error('Erro fatal na rota human-resume', { nome, rota: '/api/perfis/:nome/human-resume', error: e && e.message }, e);
      return res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Descongelar perfil manualmente
  app.post('/api/perfis/:nome/unfreeze', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/unfreeze chamada', { nome });
    const op = String(req.headers['x-operator'] || 'unknown');
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      logger.warn('Tentativa de unfreeze de perfil inexistente ou inválido', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message });
    }
    await issues.append(nome, 'admin_unfreeze', `by=${op}`);
    // Passa comando ao worker e retorna resultado
    try {
      const resp = await workerClient.sendWorkerCommand('unfreeze', { nome }, { timeoutMs: 10000 });
      logger.info('Perfil descongelado pelo admin', { nome });
      res.json(resp);
    } catch (e) {
      logger.error('Erro ao descongelar perfil', { nome, rota: '/api/perfis/:nome/unfreeze', error: e && e.message }, e);
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Descongelar todos os perfis
  app.post('/api/perfis/unfreeze-all', async (req, res) => {
    const op = String(req.headers['x-operator'] || 'unknown');
    logger.info('POST /api/perfis/unfreeze-all chamada', {});
    await issues.append('system', 'admin_unfreeze_all', `by=${op}`);
    try {
      const resp = await workerClient.sendWorkerCommand('unfreeze-all', {}, { timeoutMs: 20000 });
      logger.info('Unfreeze all realizado por API', {});
      res.json(resp);
    } catch (e) {
      logger.error('Erro fatal na rota unfreeze-all', { rota: '/api/perfis/unfreeze-all', error: e && e.message }, e);
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Alterar label do perfil (só label)
  app.patch('/api/perfis/:nome/label', async (req, res) => {
    logger.info('PATCH /api/perfis/:nome/label chamada', { nome: req.params && req.params.nome });
    try {
      const nome = req.params.nome;
      const op = String(req.headers['x-operator'] || 'unknown');
      const { novoLabel } = req.body || {};
      if (!nome || !novoLabel) {
        logger.warn('Parâmetros inválidos ao alterar label', { nome, novoLabel });
        return res.json({ ok: false, error: 'Parâmetros inválidos' });
      }
      try { assertPerfilExists(fileStore, nome); } catch(e) { 
        logger.warn('Tentativa de alterar label de perfil inexistente', { nome, error: e && e.message });
        return res.json({ ok:false, error:e.message });
      }
      await issues.append(nome, 'admin_rename_label', `by=${op}`);
      fileStore.updatePerfilLabel(nome, String(novoLabel));
      logger.info('Label do perfil alterado', { nome, novoLabel });
      res.json({ ok: true, renamed: false, labelUpdated: true, nome });
    } catch (e) {
      logger.error('Erro fatal na rota alterar label', { rota: '/api/perfis/:nome/label', nome: req.params && req.params.nome, error: e && e.message }, e);
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Rename slug físico (diretório) — só se inativo! + mover userDataDir externo
  app.post('/api/perfis/:nome/rename', async (req, res) => {
    logger.info('POST /api/perfis/:nome/rename chamada', { nome: req.params && req.params.nome });
    try {
      const nome = req.params.nome;
      const op = String(req.headers['x-operator'] || 'unknown');
      const { novoLabel } = req.body || {};
      if (!nome || !novoLabel) {
        logger.warn('Parâmetros inválidos ao renomear perfil', { nome, novoLabel });
        return res.json({ ok: false, error: 'Parâmetros inválidos' });
      }
      try { assertPerfilExists(fileStore, nome); } catch(e) {
        logger.warn('Tentativa de renomear perfil inexistente', { nome, error: e && e.message });
        return res.json({ ok:false, error:e.message });
      }
      if (fileStore.isPerfilAtivo(nome)) {
        logger.warn('Tentativa de renomear perfil ativo', { nome });
        return res.json({ ok: false, error: 'Feche o navegador desta conta antes de renomear.' });
      }
      await issues.append(nome, 'admin_rename_slug', `by=${op}`);

      // Renomeia diretório lógico (dados/perfis/NOME) + atualiza manifest interno
      const resp = fileStore.renamePerfilSlug(nome, novoLabel);

      // Atualiza label
      try { fileStore.updatePerfilLabel(resp.nome, String(novoLabel)); } catch (e) {
        logger.warn('Falha ao atualizar label durante rename', { nome, novoLabel, error: e && e.message }, e);
      }

      logger.info('Perfil renomeado com sucesso', { nome, novoLabel });
      res.json({ ok: true, ...resp });
    } catch (e) {
      logger.error('Erro fatal na rota rename', { rota: '/api/perfis/:nome/rename', nome: req.params && req.params.nome, error: e && e.message }, e);
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Delete perfil (apenas se inativo!) — remove também userDataDir externo, se existir
  app.delete('/api/perfis/:nome', async (req, res) => {
    logger.info('DELETE /api/perfis/:nome chamada', { nome: req.params && req.params.nome });
    try {
      const nome = req.params.nome;
      const op = String(req.headers['x-operator'] || 'unknown');
      if (!nome) {
        logger.warn('Tentativa de delete perfil sem nome', { nome });
        return res.json({ ok: false, error: 'nome ausente' });
      }
      try { assertPerfilExists(fileStore, nome); } catch(e) {
        logger.warn('Tentativa de delete perfil inexistente', { nome, error: e && e.message });
        return res.json({ ok:false, error:e.message });
      }
      if (fileStore.isPerfilAtivo(nome)) {
        logger.warn('Tentativa de deletar perfil ativo', { nome });
        return res.json({ ok: false, error: 'Feche o navegador antes de excluir esta conta.' });
      }
      await issues.append(nome, 'admin_delete_perfil', `by=${op}`);

      // Tenta remover userDataDir externo de forma correta (busca perfis.json)
      try {
        const perfisArr = fileStore.loadPerfisJson();
        const perfil = perfisArr.find(p => p && p.nome === nome);
        const udir = perfil && perfil.userDataDir;
        if (udir && fileStore.existsDir(udir)) {
          fileStore.rimrafSync(udir);
        }
      } catch (e) {
        logger.warn('Falha ao remover userDataDir externo em delete', { nome, error: e && e.message }, e);
      }

      // Remove de perfis.json
      const arr = fileStore.loadPerfisJson().filter(p => p && p.nome !== nome);
      fileStore.savePerfisJson(arr);

      // Remove desired.json COMPLETAMENTE
      try {
        await fileStore.removeDesired(nome);
      } catch (e) {
        logger.warn('Não removeu desired.json durante delete', { nome, error: e && e.message }, e);
      }

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
      } catch (e) {
        logger.warn('Não limpou status.json durante delete', { nome, error: e && e.message }, e);
      }

      logger.info('Perfil deletado com sucesso', { nome });
      res.json({ ok: true });
    } catch (e) {
      logger.error('Erro fatal na rota delete perfil', { rota: '/api/perfis/:nome', nome: req.params && req.params.nome, error: e && e.message }, e);
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

// ========== ENDPOINT CANÔNICO: abrir todos 24h (identico ao local) ==========
  app.post('/api/perfis/open-all-24h', async (req, res) => {
    const issues = require('./issues.js');

    try {
      const perfisArr = fileStore.loadPerfisJson() || [];

      // 1) PASSO ATÔMICO: zera humanHold, e já seta virtus:on + active:true em todos
      await fileStore.withDesiredFileLockUpdate(desired => {
        desired.perfis = desired.perfis || {};
        for (const p of perfisArr) {
          if (!p || !p.nome) continue;
          const nome = p.nome;
          desired.perfis[nome] = {
            ...(desired.perfis[nome] || {}),
            humanHold: false,
            active: true,
            virtus: 'on'
          };
        }
        return desired;
      });

      // LOG por perfil: hold reset
      for (const p of perfisArr) {
        try { await issues.append(p.nome, 'mil_action', 'human_hold=false (bulk_open_all)'); } catch {}
      }

      // 2) Loop de abertura + start-work (sequencial)
      const results = [];
      for (const p of perfisArr) {
        const nome = p.nome;
        let okActivate = false, okStart = false, err = null;

        try {
          const r1 = await workerClient.sendWorkerCommand('activate', { nome }, { timeoutMs: 60000 });
          okActivate = !!(r1 && r1.ok);
        } catch (e) {
          err = (e && e.message) || String(e);
        }

        if (okActivate) {
          try {
            const r2 = await workerClient.sendWorkerCommand('start_work', { nome }, { timeoutMs: 60000 });
            okStart = !!(r2 && r2.ok);
          } catch (e) {
            err = (e && e.message) || String(e);
          }
        }

        results.push({ nome, activate: okActivate, start: okStart, error: err || null });

        // pequeno respiro (igual ao front local)
        await new Promise(r => setTimeout(r, 800));
      }

      return res.json({ ok: true, total: perfisArr.length, results });

    } catch (e) {
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // ====== PATCH — trocar cidade do perfil (atômico + apply em runtime) ======
  app.patch('/api/perfis/:nome/cidade', async (req, res) => {
    const nome = req.params.nome;
    const { novaCidade } = req.body || {};
    const op = String(req.headers['x-operator'] || 'unknown');

    try {
      if (!nome) return res.json({ ok:false, error:'nome ausente' });

      if (!novaCidade || typeof novaCidade !== 'string' || !novaCidade.trim()) {
        return res.json({ ok:false, error:'novaCidade ausente' });
      }

      assertPerfilExists(fileStore, nome);

      // Validação de coordenadas — não aceite cidades sem coords
      const utils = require('./utils.js');
      const coords = utils.getCoords(novaCidade);

      if (!coords || !coords.latitude || !coords.longitude) {
        return res.json({ ok:false, error:'cidade_sem_coordenadas' });
      }

      // Leitura de perfis.json e manifest
      const perfisArr = fileStore.loadPerfisJson();
      const idx = perfisArr.findIndex(p => p && p.nome === nome);

      if (idx < 0) return res.json({ ok:false, error:'perfil inexistente' });

      const oldCidade = perfisArr[idx].cidade || '';

      if (oldCidade === novaCidade) {
        await issues.append(nome, 'mil_action', `admin_update_city_noop old=${oldCidade||''}`);
        return res.json({ ok:true, changed:false });
      }

      // 1) Atualiza manifest primeiro (fonte de verdade para flows)
      await manifestStore.update(nome, (m) => {
        m = m || {};
        m.cidade = String(novaCidade);
        return m;
      });

      // 2) Atualiza perfis.json (baseline do status e UI)
      perfisArr[idx].cidade = String(novaCidade);
      fileStore.savePerfisJson(perfisArr);

      await issues.append(nome, 'mil_action', `admin_update_city from="${oldCidade||''}" to="${novaCidade}" by=${op}`);

      // 3) Se navegador está ativo, aplica geolocalização imediatamente
      let applied = false;
      try {
        const st = await workerClient.sendWorkerCommand('apply-city', { nome }, { timeoutMs: 12000 });
        applied = !!(st && st.ok);
        if (applied) await issues.append(nome, 'mil_action', `admin_update_city_apply_runtime coords=${coords.latitude},${coords.longitude}`);
        else await issues.append(nome, 'mil_action', `admin_update_city_apply_runtime_failed`);
      } catch (e) {
        await issues.append(nome, 'mil_action', `admin_update_city_apply_runtime_error ${e && e.message || e}`);
      }

      return res.json({ ok:true, changed:true, applied });

    } catch (e) {
      await issues.append(nome || 'system', 'mil_action', `admin_update_city_ERROR ${e && e.message || e}`);
      return res.json({ ok:false, error: e && e.message || String(e) });
    }
  });
};