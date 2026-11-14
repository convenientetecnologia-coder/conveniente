// utils.js

const fs = require('fs');
const path = require('path');
const os = require('os');
// Removido: execSync não é mais necessário (WMI removido)
// const { execSync } = require('child_process');
const logger = require('./logger.js');

function slugify(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function readJsonSafe(file, fallback = []) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, obj) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.unlinkSync(file); } catch {}
    try { fs.renameSync(tmp, file); }
    catch {
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Ultra-normalização robusta de cookies.
 */
function normalizeCookies(cookiesInput) {
  try {
    // O jar inteiro passa. Não recorta para cinco nomes e não inventa valor, domínio nem validade.
    const keyReplacements = {
      dominio: 'domain', domnio: 'domain', 'domínio': 'domain', domain: 'domain',
      nome: 'name', name: 'name',
      valor: 'value', value: 'value',
      caminho: 'path', path: 'path',
      expiracao: 'expires', expira: 'expires', expirationdate: 'expires',
      expires: 'expires', datadeexpiracao: 'expires', datadeexpiração: 'expires',
      datadevalidade: 'expires', 'data de validade': 'expires', data_de_validade: 'expires',
      expiration: 'expires', 'expiration date': 'expires',
      'expiration_date': 'expires', 'expiry': 'expires', validade: 'expires',
      validadeate: 'expires', // variação comum de typo
      seguro: 'secure', secure: 'secure', 'seguro?': 'secure',
      httponly: 'httpOnly', httpOnly: 'httpOnly', 'somente httponly': 'httpOnly', 'somente_httponly': 'httpOnly',
      samesite: 'sameSite', sameSite: 'sameSite', 'samesitepolicy': 'sameSite', 'siteigual': 'sameSite'
    };
    // Ultra normalização de chaves
    function normalizeKey(k) {
      return String(k || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove diacríticos
        .replace(/[^\x00-\x7F]/g, '') // remove não-ascii
        .replace(/[^a-z0-9 ]/g, '') // remove qualquer símbolo não alfanumérico/espaco
        .replace(/\s+/g, '');
    }
    // Limpeza profunda de nomes/valores ASCII puros
    function cleanObj(o) {
      let out = {};
      for (let k in o) {
        let nk = normalizeKey(k);
        let std = keyReplacements[nk] || nk;
        out[std] = o[k];
      }
      return out;
    }
    // Parse do input em array bruto
    let arr = [];
    if (!cookiesInput) return [];
    if (typeof cookiesInput === 'string') {
      try {
        arr = JSON.parse(cookiesInput);
      } catch {
        arr = cookiesInput.split(';').map(pair => {
          const i = pair.indexOf('=');
          if (i < 1) return null;
          return { name: pair.slice(0, i).trim(), value: pair.slice(i+1).trim(), path: '/' };
        }).filter(Boolean);
      }
    } else if (Array.isArray(cookiesInput)) {
      arr = cookiesInput;
    } else if (typeof cookiesInput === 'object' && cookiesInput.cookies) {
      arr = cookiesInput.cookies;
    }

    // Normalização ultra-robusta de campos e valores, converte .expires/.expirationDate para segundos unix
    arr = arr.map(cleanObj).map((c) => {
      const name = String(c.name || '').trim();
      const value = c.value == null ? '' : String(c.value);
      if (!name || !value) return null;
      const cookie = { name, value };
      const domain = c.domain != null ? String(c.domain).trim() : '';
      if (domain) cookie.domain = domain;
      const path = c.path != null ? String(c.path).trim() : '';
      if (path) cookie.path = path;
      let expiresNum;
      const expiresRaw = c.expires != null ? c.expires : c.expirationDate;
      if (typeof expiresRaw === 'number') expiresNum = expiresRaw;
      else if (typeof expiresRaw === 'string' && expiresRaw.trim()) expiresNum = Number(expiresRaw);
      if (Number.isFinite(expiresNum) && expiresNum > 9999999999) expiresNum = Math.floor(expiresNum / 1000);
      if (Number.isFinite(expiresNum) && expiresNum > 0) cookie.expires = Math.floor(expiresNum);
      if (c.httpOnly === true || c.httpOnly === false || c.httpOnly === 1 || c.httpOnly === 0 || c.httpOnly === 'true' || c.httpOnly === 'false') {
        cookie.httpOnly = c.httpOnly === true || c.httpOnly === 1 || c.httpOnly === 'true';
      }
      if (c.secure === true || c.secure === false || c.secure === 1 || c.secure === 0 || c.secure === 'true' || c.secure === 'false') {
        cookie.secure = c.secure === true || c.secure === 1 || c.secure === 'true';
      }
      if (c.sameSite != null && String(c.sameSite).trim()) cookie.sameSite = String(c.sameSite).trim();
      return cookie;
    }).filter(Boolean);

    return arr;
  } catch(e) {
    logger.error('[normalizeCookies][ERROR]', {}, e);
    return [];
  }
}

function getCoords(cidade, opts) {
  try {
    return require('./countryGeo.js').getCoords(cidade, opts);
  } catch {
    return null;
  }
}

/**
 * Retorna a quantidade de memória realmente disponível (MB) para novas aberturas/processos.
 *
 * Objetivo principal: ser LEVE e ESTÁVEL em todos os hosts.
 *
 * - Linux: usa MemAvailable em /proc/meminfo (sem WMI, custo muito baixo).
 * - Windows: usa diretamente os.freemem() (API nativa do kernel, sem WMI / PowerShell).
 * - REMOVIDO: WMI completamente (causava consumo de CPU desnecessário).
 */
function getAvailableMB() {
  // Linux (via /proc/meminfo)
  if (process.platform === 'linux') {
    try {
      const txt = fs.readFileSync('/proc/meminfo','utf8');
      const m = /MemAvailable:\s+(\d+)\s+kB/i.exec(txt);
      if (m) return Math.round(parseInt(m[1],10)/1024);
    } catch {}
  }

  // Windows e demais plataformas: usa os.freemem() como fonte principal
  try {
    const mb = Math.round(os.freemem()/(1024*1024));
    if (mb > 0) return mb;
  } catch {}

  // Fallback final extremamente defensivo
  try {
    return Math.round(os.freemem()/(1024*1024));
  } catch {
    return 0;
  }
}

module.exports = {
  slugify,
  readJsonSafe,
  writeJsonSafe,
  normalizeCookies,
  getCoords,
  getAvailableMB,
};