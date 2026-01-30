// scripts/api_perfis.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const issues = require('./issues.js');
const { getAvailableMB } = require('./utils.js'); // <<< ADICIONADO CONFORME INSTRUÇÃO
const logger = require('./logger.js');
const provisionAudit = require('./provisionAudit.js');

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
const opsState = require('./opsState.js');
const provisionLock = require('./provisionLock.js');

module.exports = (app, workerClient, fileStore) => {
  // ===== Maintenance: provision lock =====
  // GET status do lock (para diagnosticar maintenance_provision)
  app.get('/api/maintenance/provision-lock', (req, res) => {
    try {
      const cur = provisionLock.get();
      return res.json({ ok: true, active: !!(cur && cur.active), lock: cur && cur.lock ? cur.lock : null, lockPath: provisionLock.LOCK_PATH });
    } catch (e) {
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // POST force-release do lock (uso pós-crash). Seguro: lock é local ao host.
  app.post('/api/maintenance/provision-lock/release', (req, res) => {
    try {
      const cur = provisionLock.get();
      const owner = cur && cur.lock && cur.lock.owner ? String(cur.lock.owner) : '';
      const rr = provisionLock.release({ owner, force: true });
      try {
        provisionAudit.append({ ts: Date.now(), event: 'maintenance_force_release_provision_lock', ok: !!(rr && rr.ok), released: !!(rr && rr.released), owner: owner || null });
      } catch {}
      return res.json({ ok: true, released: !!(rr && rr.released), prevOwner: owner || null });
    } catch (e) {
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // ===== Admin: restart do worker (hot reload pos self_update) =====
  // Motivacao: self_update faz git pull no disco; sem restart, o worker continua rodando codigo antigo.
  function _isLocal(req) {
    try {
      const ip = String(req.ip || (req.connection && req.connection.remoteAddress) || (req.socket && req.socket.remoteAddress) || '').trim();
      return ip === '127.0.0.1' || ip === '::1' || ip.includes('::ffff:127.0.0.1');
    } catch { return false; }
  }
  app.post('/api/admin/restart-worker', (req, res) => {
    try {
      if (!_isLocal(req)) return res.status(403).json({ ok: false, error: 'forbidden_not_local' });
      if (!workerClient || typeof workerClient.forceRestartWorker !== 'function') {
        return res.json({ ok: false, error: 'workerClient_no_forceRestartWorker' });
      }
      const reason = String((req.body && req.body.reason) || req.headers['x-operator'] || 'api_admin_restart_worker').slice(0, 180);
      const r = workerClient.forceRestartWorker({ reason });
      try { provisionAudit.append({ ts: Date.now(), event: 'admin_restart_worker', ok: !!(r && r.ok), reason }); } catch {}
      return res.json({ ok: true, result: r || null });
    } catch (e) {
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

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

  // Criar perfil (POST) { cidade, cookies, login?, password? }
  app.post('/api/perfis', async (req, res) => {
    logger.info('POST /api/perfis chamada', {});
    try {
      // Segurança enterprise: criação local manual está desativada.
      // Perfis só podem ser criados via Estoque (stock_provision).
      // Enterprise: permite operador com batchId (ex.: stock_provision:<uuid>) para integrar com lock owner.
      const op = String(req.headers['x-operator'] || '').trim();
      if (!op || !op.toLowerCase().startsWith('stock_provision')) {
        return res.json({ ok: false, error: 'criar_perfil_somente_estoque' });
      }

      const { cidade, cookies, login, password, stockAccountId } = req.body || {};
      if (!cidade || !cookies) {
        logger.warn('Tentativa de criação de perfil sem cidade ou cookies', { cidade });
        return res.json({ ok: false, error: 'Cidade e cookies obrigatórios.' });
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

      // Atualiza perfis.json (serializado e atômico; evita corrida em cluster)
      const wr = fileStore.withPerfisFileLockUpdate((arr) => {
        const next = Array.isArray(arr) ? arr.slice() : [];
        next.push(perfilObj);
        return next;
      }, { caller: 'api_perfis_create', reason: `create:${nome}` });
      if (!wr || wr.ok === false) {
        return res.json({ ok: false, error: (wr && wr.error) ? String(wr.error) : 'perfis_write_failed' });
      }

      // Grava manifest.json SOMENTE no userDataDir externo
      // Ultra enterprise: gravar credenciais no manifest para permitir fluxo automático
      // "cookies -> login+senha" (sem clique manual), mas NÃO devolver password na resposta.
      const manifestObj = { ...perfilObj };
      try {
        const l = String(login || '').trim();
        const p = String(password || '').trim();
        if (l) manifestObj.login = l;
        if (p) manifestObj.password = p;
        const sid = Number(stockAccountId || 0) || 0;
        if (sid) manifestObj.stockAccountId = sid;
      } catch {}
      fs.writeFileSync(path.join(userDataDir, 'manifest.json'), JSON.stringify(manifestObj, null, 2), 'utf8');

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
    // Ultra enterprise: se UI não mandar x-operator, tratar como manual (para pós-probe/identidade).
    const opRaw = String(req.headers['x-operator'] || 'unknown');
    const op = (!opRaw || opRaw === 'unknown') ? 'ui' : opRaw;
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
    const r = await workerClient.sendWorkerCommand('activate', { nome, operator: op }, { timeoutMs: 60000 }).catch(e => {
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

    // Hardening: permitir "preserveDesired" para o fluxo stock_provision (sem desligar desired.active),
    // para que o servidor possa liberar RAM temporariamente sem alterar o estado declarativo do usuário.
    const reqPolicy = String(req?.body?.policy || '').trim() || null; // ex.: 'preserveDesired'
    const reqReason = String(req?.body?.reason || '').trim() || null;
    const allowPolicy = (op && String(op).toLowerCase().startsWith('stock_provision'));
    const policy = (allowPolicy && reqPolicy) ? reqPolicy : null;
    const reason = (allowPolicy && reqReason) ? reqReason : 'admin';

    // Default (admin): desativa declarativo (active:false, virtus:off).
    // preserveDesired (stock_provision): NÃO altera desired; apenas fecha runtime via worker.
    if (policy !== 'preserveDesired') {
      try {
        await fileStore.withDesiredFileLockUpdate(desired => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), active: false, virtus: 'off' };
          return desired;
        });
      } catch (e) {
        logger.error('Erro ao patchDesired durante desativação', { nome, rota: '/api/perfis/:nome/deactivate', error: e && e.message }, e);
      }
    }
    // Chama worker para desativar imediatamente e propaga resultado real para o frontend
    try {
      const resp = await workerClient.sendWorkerCommand('deactivate', { nome, reason, policy }, { timeoutMs: 60000 });
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
      // Enterprise hardening (sem achismo):
      // Quando o configure é manual (UI/admin), isole o servidor para evitar:
      // - nurseTick reabrir perfis (desired.active) no meio da injeção
      // - swap_open (fechar outros perfis) causado por tentativa de abrir perfis enquanto RAM oscila
      // - Robe iniciar execução no meio do configure
      //
      // Obs: stock_provision já possui lock global próprio em scripts/dashboard.js.
      const opTrim = String(op || '').trim();
      const isStockProvision = opTrim.toLowerCase().startsWith('stock_provision');
      const lockOwner = `admin_configure:${nome}:${Date.now()}`;
      let gotLock = false;
      if (!isStockProvision) {
        try {
          const lk = provisionLock.tryAcquire({ owner: lockOwner, ttlMs: 4 * 60 * 1000, meta: { op: 'admin_configure', nome, by: opTrim || null } });
          if (!lk || !lk.ok) {
            const curOwner = lk && lk.lock && lk.lock.owner ? String(lk.lock.owner) : '';
            return res.json({ ok: false, error: `configure_lock_busy${curOwner ? ` owner=${curOwner}` : ''}` });
          }
          gotLock = true;
        } catch (e) {
          return res.json({ ok: false, error: `configure_lock_error ${(e && e.message) || String(e)}` });
        }
      }
      // Passa operador para o worker decidir se deixa em modo humano (admin) ou segue fluxo automático (stock_provision)
      const resp = await workerClient.sendWorkerCommand('configure', { nome, operator: (isStockProvision ? opTrim : lockOwner) }, { timeoutMs: 180000 });
      logger.info('Perfil configurado por API', { nome });
      return res.json(resp);
    } catch (e) {
      logger.error('Erro fatal na rota configurar perfil', { nome, rota: '/api/perfis/:nome/configure', error: e && e.message }, e);
      return res.json({ ok: false, error: (e && e.message) || 'configure_failed' });
    } finally {
      try {
        // best-effort: libera lock manual (se adquirido)
        const opTrim = String(op || '').trim();
        const isStockProvision = opTrim.toLowerCase().startsWith('stock_provision');
        if (!isStockProvision) {
          // lockOwner foi gerado acima; recomputa com mesmo formato usando "nome" + janela curta
          // Para robustez, só force release se o lock atual for admin_configure:<nome>:*
          const cur = provisionLock.get();
          const curOwner = String(cur && cur.lock && cur.lock.owner || '').trim();
          if (cur && cur.active && curOwner.startsWith(`admin_configure:${nome}:`)) {
            provisionLock.release({ owner: curOwner, force: true });
          }
        }
      } catch {}
    }
  });

  // ===== NOVO: login_remediate via API (para stock_provision usar o mesmo motor do login_required) =====
  app.post('/api/perfis/:nome/login-remediate', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/login-remediate chamada', { nome });
    try {
      const op = String(req.headers['x-operator'] || '').trim();
      const operator = op || `admin_login_remediate:${nome}:${Date.now()}`;
      const options = (req.body && typeof req.body === 'object') ? (req.body.options || req.body) : {};
      // Timeout alto: fluxo pode levar até ~8min (cookies + login FB + login Msg + cookies)
      const timeoutMs = Math.max(120_000, Number(options && options.timeoutMs || 0) || (9 * 60 * 1000));
      const resp = await workerClient.sendWorkerCommand(
        'login_remediate',
        { nome, operator, options: options && typeof options === 'object' ? options : {} },
        { timeoutMs }
      ).catch(e => {
        logger.error('Erro ao enviar login_remediate p/ worker', { nome, error: e && e.message }, e);
        return { ok: false, error: (e && e.message) || String(e) };
      });
      if (!resp || resp.ok === false) {
        return res.json({ ok: false, error: (resp && resp.error) ? String(resp.error) : 'login_remediate_failed', details: resp || null });
      }
      return res.json({ ok: true, result: resp });
    } catch (e) {
      logger.error('Erro fatal na rota login-remediate', { nome, rota: '/api/perfis/:nome/login-remediate', error: e && e.message }, e);
      return res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // ===== NOVO: login_remediate via API (cluster-safe) =====
  // Motivação enterprise: evitar "dois workers" (workerClient.js) abrindo Chrome fora do cluster,
  // o que faz o dashboard mostrar active=0 mesmo com navegador aberto.
  //
  // POST /api/perfis/:nome/login-remediate
  // Body: { options?, timeoutMs? }
  app.post('/api/perfis/:nome/login-remediate', async (req, res) => {
    const nome = req.params.nome;
    const op = String(req.headers['x-operator'] || '').trim() || `api_login_remediate:${nome}:${Date.now()}`;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch (e) {
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
    const timeoutMs = Math.max(60_000, Number(req?.body?.timeoutMs || 0) || (6 * 60 * 1000));
    const options = (req && req.body && typeof req.body.options === 'object' && req.body.options) ? req.body.options : {};
    try { await issues.append(nome, 'mil_action', `login_remediate_api_request by=${op}`); } catch {}
    try {
      const resp = await workerClient.sendWorkerCommand(
        'login_remediate',
        { nome, operator: op, options },
        { timeoutMs }
      );
      return res.json(resp || { ok: false, error: 'login_remediate_no_response' });
    } catch (e) {
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // ===== NOVO: atualização vinda do Estoque (label/login/senha/cookies) =====
  // Usado pelo comando remoto stock_push_account_update.
  // Segurança: só aceita com header x-operator=stock_push (CT).
  app.post('/api/perfis/:nome/stock-update', async (req, res) => {
    const nome = req.params.nome;
    const op = String(req.headers['x-operator'] || '').trim();
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    if (op !== 'stock_push') return res.json({ ok: false, error: 'stock_update_forbidden' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      return res.json({ ok:false, error:e.message });
    }
    try {
      const label = (req.body && req.body.label != null) ? String(req.body.label || '').trim() : null;
      const login = (req.body && req.body.login != null) ? String(req.body.login || '').trim() : null;
      const password = (req.body && req.body.password != null) ? String(req.body.password || '') : null;
      const cookiesInput = (req.body && req.body.cookies != null) ? req.body.cookies : null;
      // Por padrão, NUNCA reinjetar cookies ao receber atualização do CT.
      // Reinjeção só acontece quando explicitamente solicitado (ação manual/operacional).
      const applyCookies = !!(req.body && (req.body.applyCookies === true || req.body.applyCookies === 1 || String(req.body.applyCookies || '').trim() === '1'));

      // Atualiza label no perfis.json (UI)
      if (label) {
        try { fileStore.updatePerfilLabel(nome, label); } catch {}
      }

      // Atualiza manifest (fonte de verdade do perfil)
      let cookiesUpdated = false;
      if (cookiesInput) {
        const cookiesArr = require('./utils').normalizeCookies(cookiesInput);
        if (
          !cookiesArr.length ||
          !cookiesArr.find(c => c.name === 'c_user') ||
          !cookiesArr.find(c => c.name === 'xs')
        ) {
          return res.json({ ok:false, error:'cookies_invalid' });
        }
        cookiesUpdated = true;
        await manifestStore.update(nome, (m) => {
          m = m || {};
          m.cookies = cookiesArr;
          if (label) m.label = label;
          if (login != null) m.login = login;
          if (password != null) m.password = password;
          return m;
        });
      } else {
        await manifestStore.update(nome, (m) => {
          m = m || {};
          if (label) m.label = label;
          if (login != null) m.login = login;
          if (password != null) m.password = password;
          return m;
        });
      }

      // Se cookies mudaram, SOMENTE reinjeta via configure (worker) quando explicitamente solicitado.
      if (cookiesUpdated && applyCookies) {
        try {
          const resp = await workerClient.sendWorkerCommand('configure', { nome }, { timeoutMs: 180000 });
          if (!resp || resp.ok !== true) {
            return res.json({ ok:false, error:(resp && resp.error) ? String(resp.error) : 'configure_failed' });
          }
        } catch (e) {
          return res.json({ ok:false, error:(e && e.message) || String(e) });
        }
      }

      return res.json({ ok: true, cookiesUpdated: !!cookiesUpdated, applied: !!(cookiesUpdated && applyCookies) });
    } catch (e) {
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // Iniciar atendimento/postagem
  app.post('/api/perfis/:nome/start-work', async (req, res) => {
    const nome = req.params.nome;
    logger.info('POST /api/perfis/:nome/start-work chamada', { nome });
    // Ultra enterprise: se UI não mandar x-operator, tratar como manual (para pós-probe/identidade).
    const opRaw = String(req.headers['x-operator'] || 'unknown');
    const op = (!opRaw || opRaw === 'unknown') ? 'ui' : opRaw;
    if (!nome) return res.json({ ok: false, error: 'nome ausente' });
    try { assertPerfilExists(fileStore, nome); } catch(e) {
      logger.warn('Tentativa de start_work perfil inexistente ou inválido', { nome, error: e && e.message });
      return res.json({ ok:false, error:e.message }); 
    }
    await issues.append(nome, 'admin_start_work_request', `by=${op}`);

    // Enterprise (produção): perfil recém-provisionado via Estoque deve entrar com
    // Robe pausado por 24h, mas Virtus ON imediatamente.
    // Regra do lead: conta nova = garantir 24h (mínimo) para não postar cedo.
    if (op && String(op).toLowerCase().startsWith('stock_provision')) {
      try {
        const manifestStore = require('./manifestStore.js');
        const plus24 = 24 * 60 * 60 * 1000;
        await manifestStore.update(nome, (m) => {
          const now = Date.now();
          m = m || {};
          const desiredUntil = now + plus24;
          const curUntil = Number(m.robeCooldownUntil || 0) || 0;
          // Garantia: pelo menos 24h a partir de agora (não encurta cooldown maior).
          m.robeCooldownUntil = Math.max(curUntil, desiredUntil);
          m.robeCooldownRemainingMs = 0;
          const r = String(m.robePauseReason || '');
          if (String(r).toLowerCase() !== 'limit_posting') {
            m.robePauseReason = 'new_account';
          }
          return m;
        });
      } catch (e) {
        try { await issues.append(nome, 'robe24h_failed', `auto_new_account:${(e && e.message) || String(e)}`); } catch {}
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
    const r1 = await workerClient.sendWorkerCommand('activate', { nome, operator: op }, { timeoutMs: 60000 }).catch(e => {
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
    const r2 = await workerClient.sendWorkerCommand('start_work', { nome, operator: op }, { timeoutMs: 60000 }).catch(e => {
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
      // Enterprise: DELETE precisa ser IDEMPOTENTE.
      // Se o perfil não existir localmente, isso já é "sucesso" — evita re-tries infinitos do CT (delete_perfis).
      // Mesmo assim, escrevemos tombstone para impedir ressuscitar via recovery/rebuild de userDataDir.
      try { assertPerfilExists(fileStore, nome); } catch (e) {
        logger.warn('Tentativa de delete perfil inexistente (idempotente)', { nome, error: e && e.message });
        try { fileStore.writeTombstone && fileStore.writeTombstone(nome, { reason: 'delete_missing_idempotent', by: String(op || '').slice(0, 120), stage: 'already_missing' }); } catch {}
        return res.json({ ok: true, alreadyDeleted: true, nome });
      }
      // Tombstone cedo (anti-ressurreição no boot/recovery)
      try { fileStore.writeTombstone && fileStore.writeTombstone(nome, { reason: 'manual_delete', by: String(op||'').slice(0, 120), stage: 'begin' }); } catch {}
      // Enterprise: delete deve ser robusto — se estiver ativo, fecha automaticamente (hard close) antes de excluir.
      if (fileStore.isPerfilAtivo(nome)) {
        logger.warn('Delete solicitado para perfil ativo — tentando fechar automaticamente', { nome });
        // 1) marca desired inactive (melhora reconciliação e evita reabrir)
        try {
          await fileStore.withDesiredFileLockUpdate(desired => {
            desired.perfis = desired.perfis || {};
            desired.perfis[nome] = { ...(desired.perfis[nome] || {}), active: false, virtus: 'off' };
            return desired;
          });
        } catch (e) {
          logger.warn('Falha ao patchDesired durante delete auto-close', { nome, error: e && e.message }, e);
        }
        // 2) chama worker deactivate (hard close) com retry
        let okDeactivate = false;
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const resp = await workerClient.sendWorkerCommand(
              'deactivate',
              { nome, reason: 'admin_delete', policy: null },
              { timeoutMs: 90000 }
            );
            okDeactivate = !!(resp && resp.ok);
            if (okDeactivate) break;
            lastErr = (resp && resp.error) ? String(resp.error) : 'deactivate_failed';
          } catch (e) {
            lastErr = (e && e.message) || String(e);
          }
          await new Promise(r => setTimeout(r, 1200));
        }
        // Política (2026-01-28): mesmo se falhar, NÃO manter perfil no servidor.
        // Tentamos kill por userDataDir e seguimos com purge local para impedir reabertura/open-all.
        if (!okDeactivate) {
          try {
            const perfisArr = fileStore.loadPerfisJson() || [];
            const perfil = perfisArr.find(p => p && p.nome === nome);
            const udir = perfil && perfil.userDataDir ? String(perfil.userDataDir) : '';
            if (udir) {
              const browserHelper = require('./browser.js');
              try { if (browserHelper && browserHelper.killChromeProfileProcesses) browserHelper.killChromeProfileProcesses(udir); } catch {}
              await new Promise(r => setTimeout(r, 900));
            }
          } catch {}
          logger.error('Delete auto-close falhou — seguindo com purge local (anti-fantasma no perfis.json)', { nome, error: lastErr || 'deactivate_failed' });
        }
      }
      await issues.append(nome, 'admin_delete_perfil', `by=${op}`);

      // ===== Enterprise 110%: enviar para CT (Estoque Excluídas) ANTES de deletar local =====
      // Motivação: evitar duplicidade (mesma conta em 2 servidores) e garantir rastreabilidade no CT.
      // Regra: se CT estiver fora, enfileirar em dados/ct_archive_queue/pending para retry pelo worker.
      let ct = { attempted: false, ok: false, queued: false, error: null };
      try {
        const fs = require('fs');
        const path = require('path');
        const crypto = require('crypto');
        const { readCtConfig } = require('./ctConfig');
        const HOSTID_PATH = path.join(__dirname, '..', 'dados', '.telemetry_hostid');
        const CTQ_PENDING = path.join(__dirname, '..', 'dados', 'ct_archive_queue', 'pending');
        const ensureDirSync = (p) => { try { fs.mkdirSync(p, { recursive: true }); } catch {} };
        const readHostId = () => { try { return fs.existsSync(HOSTID_PATH) ? String(fs.readFileSync(HOSTID_PATH, 'utf8') || '').trim() : ''; } catch { return ''; } };
        const hostId = readHostId();
        const cfg = (() => { try { return readCtConfig(); } catch { return null; } })();
        let base = String((cfg && cfg.ctBaseUrl) ? cfg.ctBaseUrl : (process.env.CT_BASE_URL || process.env.CT_URL || '')).trim();
        base = base.replace(/\/+$/, '');
        const secret = String((cfg && cfg.logIngestSecret) ? cfg.logIngestSecret : (process.env.LOG_INGEST_SECRET || '')).trim();
        if (!hostId || !base || !secret) {
          ct = { attempted: true, ok: false, queued: false, error: 'ct_config_missing' };
        } else {
          // Descobrir stockAccountId se existir (ajuda o CT a mapear)
          let stockAccountId = null;
          try {
            const man = await manifestStore.read(nome).catch(()=>null);
            if (man && (man.stockAccountId || man.stock_account_id)) stockAccountId = Number(man.stockAccountId || man.stock_account_id) || null;
          } catch {}

          ct.attempted = true;
          const reason = `manual_delete:${String(op || '').slice(0, 60)}`.slice(0, 120);
          try {
            const Aborter = global.AbortController || require('node-abort-controller');
            const ac = new Aborter();
            const t = setTimeout(() => { try { ac.abort(); } catch {} }, 12000);
            const resp = await fetch(`${base}/api/stock/assigned/archive_with_evidence_secret`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Log-Secret': secret },
              body: JSON.stringify({
                hostId,
                profileName: String(nome || '').trim(),
                stockAccountId: stockAccountId || null,
                reason,
                by: 'admin',
                evidenceB64: '',
                evidenceUrl: ''
              }),
              signal: ac.signal
            }).catch(e => ({ ok:false, _err: e }));
            clearTimeout(t);
            if (resp && resp.ok) {
              const j = await resp.json().catch(()=>null);
              if (j && j.ok === true) {
                ct.ok = true;
                ct.error = null;
              } else {
                ct.ok = false;
                ct.error = (j && j.error) ? String(j.error) : `http_${resp.status || 0}`;
              }
            } else {
              ct.ok = false;
              ct.error = (resp && resp._err && resp._err.message) ? String(resp._err.message) : 'ct_fetch_failed';
            }
          } catch (e) {
            ct.ok = false;
            ct.error = (e && e.message) ? String(e.message) : String(e);
          }

          if (!ct.ok) {
            // Queue para retry (worker processa ct_archive_queue)
            try {
              ensureDirSync(CTQ_PENDING);
              const flowId = (() => { try { return `manual_delete_${Date.now()}_${crypto.randomUUID()}`; } catch { return `manual_delete_${Date.now()}_${Math.random().toString(16).slice(2)}`; } })();
              const job = {
                createdAt: Date.now(),
                nextAttemptAt: 0,
                attempts: 0,
                stockAccountId: stockAccountId || null,
                profileName: String(nome || ''),
                reason,
                evidencePath: '',
                evidenceUrl: '',
                flowId
              };
              const fp = path.join(CTQ_PENDING, `${Date.now()}_${flowId}_profile_${String(nome||'').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,60)}.json`);
              fs.writeFileSync(fp, JSON.stringify(job, null, 2), 'utf8');
              ct.queued = true;
            } catch (e) {
              ct.queued = false;
              ct.error = `ct_queue_failed:${(e && e.message) ? String(e.message) : String(e)}`;
            }
          }
        }
      } catch (e) {
        ct = { attempted: true, ok: false, queued: false, error: (e && e.message) ? String(e.message) : String(e) };
      }

      // Política (2026-01-28): CT é registro; se falhar, seguimos com purge e deixamos rastreio no tombstone.
      if (ct && ct.attempted && ct.ok !== true && ct.queued !== true) {
        logger.error('CT falhou e queue falhou durante delete — seguindo com purge local', { nome, ctError: ct.error });
      }

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

      // Remove de perfis.json (serializado e atômico; evita corrida em cluster)
      const wr = fileStore.withPerfisFileLockUpdate((arr) => {
        return Array.isArray(arr) ? arr.filter(p => p && p.nome !== nome) : [];
      }, { caller: 'api_perfis_delete', reason: `delete:${nome}` });
      if (!wr || wr.ok === false) {
        return res.json({ ok: false, error: (wr && wr.error) ? String(wr.error) : 'perfis_write_failed' });
      }

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
      try {
        fileStore.writeTombstone && fileStore.writeTombstone(nome, {
          reason: 'manual_delete',
          by: String(op||'').slice(0, 120),
          stage: 'done',
          ctAttempted: !!(ct && ct.attempted),
          ctOk: !!(ct && ct.ok),
          ctQueued: !!(ct && ct.queued),
          ctError: ct && ct.error ? String(ct.error).slice(0, 180) : null
        });
      } catch {}
      res.json({ ok: true, ct, warning: (ct && ct.ok !== true) ? 'ct_pending_or_failed' : null });
    } catch (e) {
      logger.error('Erro fatal na rota delete perfil', { rota: '/api/perfis/:nome', nome: req.params && req.params.nome, error: e && e.message }, e);
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

// ========== ENDPOINT CANÔNICO: abrir todos 24h (identico ao local) ==========
  app.post('/api/perfis/open-all-24h', async (req, res) => {
    const issues = require('./issues.js');
    const op = String(req.headers['x-operator'] || 'bulk_open_all');
    let lockOwner = null;

    try {
      // 0) Lock global: pausa Virtus/Robe durante o mapeamento (open_all_map).
      // - Evita que login_remediate/virtus/robe rodem durante a abertura e baguncem o estado/ordem.
      // - O nurse continua abrindo/probando 1 por vez (owner atravessa o lock).
      lockOwner = `open_all_map:${Date.now()}`;
      try {
        // TTL curto e renovável: workers fazem keepalive enquanto houver perfis do shard a abrir.
        const ttl0 = Math.max(60_000, Number(process.env.OPEN_ALL_LOCK_TTL_MS || (2 * 60 * 1000)) || (2 * 60 * 1000));
        const lk = provisionLock.tryAcquire({ owner: lockOwner, ttlMs: ttl0, meta: { kind: 'open_all_map', by: op.slice(0, 120) } });
        if (!lk || !lk.ok) {
          const curOwner = lk && lk.lock && lk.lock.owner ? String(lk.lock.owner) : '';
          return res.json({ ok: false, error: `open_all_lock_busy${curOwner ? ` owner=${curOwner}` : ''}` });
        }
      } catch (e) {
        return res.json({ ok: false, error: `open_all_lock_error ${(e && e.message) || String(e)}` });
      }

      const perfisArr = fileStore.loadPerfisJson() || [];

      // 1) PASSO ATÔMICO: desired.active=true para todos.
      // Política (2026-01-28): abrir tudo NÃO usa flags antigas para decidir nada.
      // Cada perfil, ao abrir, limpa flags não-terminais e revalida do zero (worker).
      await fileStore.withDesiredFileLockUpdate(desired => {
        desired.perfis = desired.perfis || {};
        // Sequencer global de abertura (ordem do dashboard/perfis.json):
        // - um único perfil "inFlight" por vez, para o usuário acompanhar.
        // - workers coordenam via desired.json (cross-process).
        const names = perfisArr.map(p => p && p.nome).filter(Boolean);
        desired._openAll = {
          active: true,
          startedAt: Date.now(),
          idx: 0,
          queue: names,
          inFlight: null,
          inFlightAt: 0,
          inFlightBy: null,
          op: lockOwner,
          lockOwner,
          by: String(op || 'bulk_open_all').slice(0, 120)
        };
        for (const p of perfisArr) {
          if (!p || !p.nome) continue;
          const nome = p.nome;
          desired.perfis[nome] = {
            ...(desired.perfis[nome] || {}),
            active: true,
            // Durante mapeamento, manter Virtus pausado.
            // O probe decide quais ficam virtus='on' (ok), mas o provision_lock segura a execução até o fim.
            virtus: 'off',
            humanHold: false
          };
        }
        return desired;
      });

      // LOG por perfil: bulk open
      for (const p of perfisArr) {
        try {
          await issues.append(p.nome, 'mil_action', 'bulk_open_all');
        } catch {}
      }

      // 2) Ack rápido (ULTRA enterprise) + sequência estrita:
      // - Não manter o HTTP pendurado.
      // - NÃO iniciar activates em paralelo aqui.
      // A abertura real fica 100% a cargo do NURSE tick (que já tem MAX_OPEN_CONCURRENCY=1),
      // garantindo: Messenger OK -> Robe OK/erro -> próximo.
      return res.json({ ok: true, total: perfisArr.length, lockOwner });

    } catch (e) {
      // Se falhou após adquirir o lock, liberar (best-effort).
      try { if (lockOwner) provisionLock.release({ owner: String(lockOwner), force: true }); } catch {}
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // ========== ENDPOINT CANÔNICO: fechar todos (robusto) ==========
  // Fecha TODOS os navegadores (active=false) de forma sequencial, com retries leves.
  // Importante: isso é usado tanto pelo painel quanto por comandos remotos (`close_all`).
  app.post('/api/perfis/close-all/cancel', async (req, res) => {
    try {
      const by = String(req.headers && (req.headers['x-operator'] || req.headers['X-Operator']) || 'unknown').slice(0, 180);
      const rr = opsState.requestCancel('close_all', { reason: `ui_refresh_cancel:${by}` });
      try { provisionAudit.append({ ts: Date.now(), event: 'close_all_cancel_requested', by, ok: !!(rr && rr.ok), reason: rr && rr.cancelReason ? rr.cancelReason : null }); } catch {}
      return res.json({ ok: true, result: rr || null });
    } catch (e) {
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  app.post('/api/perfis/close-all', async (req, res) => {
    const issues = require('./issues.js');
    const lockOwner = `close_all:${Date.now()}`;
    try {
      const by = String(req.headers && (req.headers['x-operator'] || req.headers['X-Operator']) || 'unknown');
      try {
        provisionAudit.append({
          event: 'close_all_api_called',
          by,
          lockOwner,
          ip: (req && (req.ip || (req.socket && req.socket.remoteAddress))) ? String(req.ip || req.socket.remoteAddress) : null
        });
      } catch {}
      // Enterprise: durante close_all, bloquear reaberturas automáticas (nurseTick) e qualquer activate concorrente.
      // Reusa o provisionLock (cross-process) para garantir isolamento real.
      try {
        // Prioridade máxima: se existir lock ativo (ex.: open_all_map/login_remediate),
        // o close_all deve PREEMPTAR (o usuário quer “fechar agora”).
        try { provisionLock.release({ force: true }); } catch {}
        const lk = provisionLock.tryAcquire({ owner: lockOwner, ttlMs: 12 * 60 * 1000, meta: { kind: 'close_all', by: String(by || '').slice(0, 120) } });
        if (!lk || !lk.ok) {
          const curOwner = lk && lk.lock && lk.lock.owner ? String(lk.lock.owner) : '';
          return res.json({ ok: false, error: `close_all_lock_busy${curOwner ? ` owner=${curOwner}` : ''}` });
        }
      } catch (e) {
        return res.json({ ok: false, error: `close_all_lock_error ${(e && e.message) || String(e)}` });
      }

      const perfisArr = fileStore.loadPerfisJson() || [];
      try {
        provisionAudit.append({ event: 'close_all_targets', by, lockOwner, total: perfisArr.length, names: perfisArr.map(p => p && p.nome).filter(Boolean).slice(0, 300) });
      } catch {}
      opsState.begin('close_all', { total: perfisArr.length, done: 0, ok: 0, fail: 0, current: null });

      // 1) PASSO ATÔMICO: seta active:false e virtus:'off' em todos
      await fileStore.withDesiredFileLockUpdate(desired => {
        desired.perfis = desired.perfis || {};
        // Se houver sessão open-all pendurada, encerrar aqui (close_all tem prioridade).
        if (desired._openAll && desired._openAll.active === true) {
          desired._openAll = {
            ...(desired._openAll || {}),
            active: false,
            cancelledAt: Date.now(),
            cancelledReason: 'close_all'
          };
        }
        for (const p of perfisArr) {
          if (!p || !p.nome) continue;
          const nome = p.nome;
          desired.perfis[nome] = {
            ...(desired.perfis[nome] || {}),
            active: false,
            virtus: 'off'
          };
        }
        return desired;
      });

      // 2) Loop de fechamento (sequencial + retry) para garantir 110%
      const results = [];
      let okCount = 0;
      let failCount = 0;
      for (const p of perfisArr) {
        if (opsState.isCancelRequested('close_all')) {
          try { provisionAudit.append({ ts: Date.now(), event: 'close_all_cancelled_midway', by, lockOwner, done: results.length, ok: okCount, fail: failCount }); } catch {}
          break;
        }
        const nome = p && p.nome;
        if (!nome) continue;
        let okDeactivate = false;
        let err = null;
        opsState.update('close_all', { current: nome });
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const r = await workerClient.sendWorkerCommand('deactivate', { nome, reason: 'close_all' }, { timeoutMs: 90000 });
            okDeactivate = !!(r && r.ok);
            if (okDeactivate) break;
            err = (r && r.error) ? String(r.error) : 'deactivate_failed';
          } catch (e) {
            err = (e && e.message) || String(e);
          }
          // pequeno respiro para não estressar o Chrome/FB
          await new Promise(r => setTimeout(r, 1200));
        }
        if (okDeactivate) okCount++; else failCount++;
        results.push({ nome, deactivate: okDeactivate, error: err || null });
        opsState.update('close_all', { done: results.length, ok: okCount, fail: failCount });
        // respiro (reduz flapping/CPU)
        await new Promise(r => setTimeout(r, 500));
      }

      try { await issues.append('system', 'mil_action', `bulk_close_all total=${perfisArr.length} ok=${okCount} fail=${failCount}`); } catch {}
      const cancelled = opsState.isCancelRequested('close_all');
      opsState.finish('close_all', { total: perfisArr.length, done: results.length, ok: okCount, fail: failCount, current: null, success: (!cancelled && failCount === 0), cancelled: !!cancelled });
      return res.json({ ok: (!cancelled && failCount === 0), cancelled: !!cancelled, total: perfisArr.length, done: results.length, okCount, failCount, results });
    } catch (e) {
      try { opsState.finish('close_all', { success: false, error: (e && e.message) || String(e), current: null }); } catch {}
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    } finally {
      try { provisionLock.release({ owner: lockOwner }); } catch {}
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

      // 2) Atualiza perfis.json (baseline do status e UI) — serializado/atômico
      const wr2 = fileStore.withPerfisFileLockUpdate((arr) => {
        const next = Array.isArray(arr) ? arr.slice() : [];
        const i2 = next.findIndex(p => p && p.nome === nome);
        if (i2 >= 0) next[i2] = Object.assign({}, next[i2], { cidade: String(novaCidade) });
        return next;
      }, { caller: 'api_perfis_update_city', reason: `update_city:${nome}` });
      if (!wr2 || wr2.ok === false) {
        return res.json({ ok: false, error: (wr2 && wr2.error) ? String(wr2.error) : 'perfis_write_failed' });
      }

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