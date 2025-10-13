// workerHandlers.js

'use strict';
const core = require('./workerCore.js');
const log = require('./logger.js');
const browserHelper = require('./browser.js');
const virtusHelper = require('./virtus.js');
const robeHelper = require('./robe.js');
const manifestStore = require('./manifestStore.js');
const robeQueue = require('./robeQueue.js');
// ...demais módulos necessários
const path = require('path');
const fs = require('fs');
const utils = require('./utils.js');

const handlers = {
async ['criar-perfil']({ cidade, cookies }) {
if (!cidade || !cookies) return { ok: false, error: 'Cidade e cookies obrigatórios.' };

// Garante diretório de perfis
const perfisDir = path.join(__dirname, '../dados', 'perfis');
if (!fs.existsSync(perfisDir)) fs.mkdirSync(perfisDir, { recursive: true });

let nome = utils.slugify(cidade) + '-' + Date.now();
while (fs.existsSync(path.join(perfisDir, nome))) nome += Math.floor(Math.random() * 100);

const preset = (typeof core.pickUaPreset === 'function') ? core.pickUaPreset() : null;
if (!preset) return { ok: false, error: 'UA preset esgotado.' };

const cookiesArr = utils.normalizeCookies(cookies);
if (!cookiesArr.length || !cookiesArr.find(c => c.name === 'c_user') || !cookiesArr.find(c => c.name === 'xs')) {
  return { ok: false, error: 'Cookies inválidos ou ausentes: precisa de c_user e xs!' };
}

const resolveRoot = (typeof core.resolveChromeUserDataRoot === 'function') ? core.resolveChromeUserDataRoot() : null;
if (!resolveRoot) return { ok: false, error: 'Chrome user-data root indisponível (core.resolveChromeUserDataRoot)' };

const perfilObj = {
  nome,
  cidade,
  uaPresetId: preset.id,
  uaString: preset.uaString,
  uaCh: preset.uaCh,
  fp: {
    viewport: preset.viewport || (preset.fp && preset.fp.viewport) || { width: 1366, height: 768 },
    dpr: preset.dpr || (preset.fp && preset.fp.dpr) || 1,
    hardwareConcurrency: preset.hardwareConcurrency || (preset.fp && preset.fp.hardwareConcurrency) || 4
  },
  cookies: cookiesArr,
  robeCooldownUntil: 0,
  configuredAt: null,
  userDataDir: path.join(resolveRoot, 'Conveniente', nome)
};

try { fs.mkdirSync(perfilObj.userDataDir, { recursive: true }); } catch {}

const loadPerfisJson = (typeof core.loadPerfisJson === 'function') ? core.loadPerfisJson : null;
const savePerfisJson = (typeof core.savePerfisJson === 'function') ? core.savePerfisJson : null;

if (!loadPerfisJson || !savePerfisJson) {
  return { ok: false, error: 'Core não expôs loadPerfisJson/savePerfisJson' };
}

const perfisArr = loadPerfisJson() || [];
perfisArr.push(perfilObj);
savePerfisJson(perfisArr);

try {
  await manifestStore.update(nome, (m) => {
    m = m || {};
    return Object.assign({}, m, perfilObj);
  });
} catch {}

return { ok: true, perfil: perfilObj };

},

async activate({ nome }) {
if (typeof core.activateOnce !== 'function') {
return { ok: false, error: 'Core não expôs activateOnce' };
}
return await core.activateOnce(nome, 'message');
},

async deactivate({ nome, reason, policy }) {
if (typeof core.deactivate !== 'function') {
return { ok: false, error: 'Core não expôs deactivate' };
}
return await core.deactivate({ nome, reason, policy });
},

async configure({ nome }) {
if (typeof core.configure !== 'function') {
return { ok: false, error: 'Core não expôs configure' };
}
return await core.configure({ nome });
},

async start_work({ nome }) {
if (typeof core.start_work !== 'function') {
return { ok: false, error: 'Core não expôs start_work' };
}
return await core.start_work({ nome });
},

async invoke_human({ nome }) {
if (typeof core.invokeHuman !== 'function') {
return { ok: false, error: 'Core não expôs invokeHuman' };
}
return await core.invokeHuman({ nome });
},

async ['human-resume']({ nome }) {
if (typeof core.humanResume !== 'function') {
return { ok: false, error: 'Core não expôs humanResume' };
}
return await core.humanResume({ nome });
},

async ['robe-play']({ nome }) {
if (typeof core.robePlay !== 'function') {
return { ok: false, error: 'Core não expôs robePlay' };
}
return await core.robePlay({ nome });
},

async 'robes-release-all' {
if (typeof core.robesReleaseAll !== 'function') {
return { ok: false, error: 'Core não expôs robesReleaseAll' };
}
return await core.robesReleaseAll();
},

async 'get-status' {
if (typeof core.getStatus !== 'function') {
return { ok: false, error: 'Core não expôs getStatus' };
}
return await core.getStatus();
},

async unfreeze({ nome, setBy }) {
if (typeof core.unfreeze !== 'function') {
return { ok: false, error: 'Core não expôs unfreeze' };
}
return await core.unfreeze({ nome, setBy });
},

async 'unfreeze-all' {
if (typeof core.unfreezeAll !== 'function') {
return { ok: false, error: 'Core não expôs unfreezeAll' };
}
return await core.unfreezeAll();
}
};

module.exports = handlers;