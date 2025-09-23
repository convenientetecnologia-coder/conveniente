const fs = require('fs');
const path = require('path');

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
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
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
    const ESSENCIAIS = ['c_user', 'xs', 'fr', 'sb', 'datr'];
    const now = Math.floor(Date.now() / 1000);
    const VENC = now + 180 * 24 * 60 * 60; // daqui 180 dias (em segundos)
    // Map de todas as possíveis variações de nomes de campo
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
    function cleanAscii(str) {
      return String(str || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x00-\x7F]+/g, '')
        .replace(/[\n\r\t\v\f\u200B\u200C\u200D\uFEFF]/g, '') // invisíveis e quebras
        .replace(/^\s+|\s+$/g, '')
        .replace(/\s+/g, '') // remove espaços
      ;
    }
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
          return { name: pair.slice(0, i).trim(), value: pair.slice(i+1).trim(), domain: '.facebook.com', path: '/' };
        }).filter(Boolean);
      }
    } else if (Array.isArray(cookiesInput)) {
      arr = cookiesInput;
    } else if (typeof cookiesInput === 'object' && cookiesInput.cookies) {
      arr = cookiesInput.cookies;
    }

    // Normalização ultra-robusta de campos e valores, converte .expires/.expirationDate para segundos unix
    arr = arr.map(cleanObj).map(c => {
      const cookie = {};
      // PATCH MILITAR: NUNCA value vazio/nulo/indefinido
      cookie.name = cleanAscii(c.name);
      let v = cleanAscii(c.value);
      if (v === undefined || v === null || v === '' || v.length === 0) {
        // Ajuste o valor padrão conforme sua política:
        // Para c_user/xs/fr/sb/datr, escolha um valor seguro, nunca vazio (ex: "default" ou "0")
        if (c.name === 'c_user' || c.name === 'xs' || c.name === 'fr') v = 'default'; // ou 'cookie'
        else if (c.name === 'sb' || c.name === 'datr') v = '0';
        else v = 'default';
      }
      cookie.value = v;

      // Apenas prepara expiracao (em segundos unix)
      let expiresRaw = c.expires || c.expirationDate;
      let expiresNum = undefined;
      if (typeof expiresRaw === 'string') {
        // tenta converter string para número:
        expiresNum = Number(expiresRaw.replace(/[^\d]/g, ''));
      } else if (typeof expiresRaw === 'number') {
        expiresNum = expiresRaw;
      }
      // Expiração para segundos unix
      if (expiresNum && expiresNum > 9999999999) {
        // Provavelmente ms, converte para segundos
        expiresNum = Math.floor(expiresNum / 1000);
      }
      if (expiresNum && expiresNum > now) {
        // OK, no futuro (manter)
        cookie.expires = expiresNum;
      }

      // Ajusta e padroniza outros campos essenciais
      cookie.domain = '.facebook.com';
      cookie.path = '/';
      cookie.secure = true;
      cookie.sameSite = 'None';

      // httpOnly: CUIDADO! Só c_user é false. Todos os outros essenciais true.
      if (cookie.name === 'c_user') {
        cookie.httpOnly = false;
      } else if (ESSENCIAIS.includes(cookie.name)) {
        cookie.httpOnly = true;
      }

      // Garantia de tipos boolean/samesite
      if (typeof cookie.secure !== 'boolean') cookie.secure = true;
      if (!cookie.sameSite || typeof cookie.sameSite !== 'string') cookie.sameSite = 'None';

      // Elimina quaisquer outros campos possíveis
      return cookie;
    });

    // Filtro para manter somente os cookies ESSENCIAIS
    arr = arr.filter(c => ESSENCIAIS.includes(c.name));

    // Pós-normalização final: valida atributos obrigatórios & segurança, inclui expiração para todos
    arr.forEach(cookie => {
      cookie.domain = '.facebook.com';
      cookie.path = '/';
      cookie.secure = true;
      cookie.sameSite = 'None';
      // Sanitize value de novo no pós-final (robustez extra)
      cookie.name = cleanAscii(cookie.name);

      // PATCH MILITAR: value nunca vazio, nunca nulo, nunca undefined
      if (cookie.value === undefined || cookie.value === null || cookie.value === '' || cookie.value.length === 0) {
        if (cookie.name === 'c_user' || cookie.name === 'xs' || cookie.name === 'fr') cookie.value = 'default';
        else if (cookie.name === 'sb' || cookie.name === 'datr') cookie.value = '0';
        else cookie.value = 'default';
        if (process.env.DEBUG_COOKIES === '1') {
          console.warn(`[normalizeCookies][PATCH] cookie "${cookie.name}" sem value, ajustado para "${cookie.value}"`);
        }
      }

      // expires: se não existir ou estiver no passado, seta para 180 dias à frente (em segundos)
      if (
        typeof cookie.expires !== 'number'
        || Number.isNaN(cookie.expires)
        || cookie.expires < now
      ) {
        cookie.expires = VENC;
      }
      // httpOnly já ajustado previamente, mas reforçando para robustez
      if (cookie.name === 'c_user') cookie.httpOnly = false;
      else cookie.httpOnly = true;
    });

    // Elimine completamente qualquer cookie cujo name esteja vazio ou ausente:
    arr = arr.filter(c => ESSENCIAIS.includes(c.name) && c.name && c.value);

    // (Opcional) LOGA WARNING se faltar algum essencial
    const foundEssenciais = new Set(arr.map(c => c.name));
    for (const nomeEss of ESSENCIAIS) {
      if (!foundEssenciais.has(nomeEss)) {
        if (process.env.DEBUG_COOKIES === '1') {
          console.warn(`[normalizeCookies][WARNING] Cookie essencial ausente ou estranho: ${nomeEss}`);
        }
      }
    }

    // DICA/robustez: log final do array retornado
    if (process.env.DEBUG_COOKIES === '1') {
      console.log('[normalizeCookies][FINAL]', arr);
    }

    // Final: retorna array ultra-limpo dos ESSENCIAIS normalizados
    return arr;
  } catch(e) {
    console.log('[normalizeCookies][ERROR]', e && e.message);
    return [];
  }
}

function getCoords(cidade) {
  try {
    if (!cidade) return null;
    const cidadesPath = path.join(__dirname, '..', 'dados', 'cidades_coords.json');
    const arr = readJsonSafe(cidadesPath, []);
    const norm = (s) => slugify(String(s||''));
    const cidadeNorm = norm(cidade);
    for (const ent of arr) {
      if (ent &&
          (norm(ent.nome) === cidadeNorm ||
           norm(ent.label) === cidadeNorm ||
           norm(ent.id) === cidadeNorm)) {
        return {
          latitude: Number(ent.lat || ent.latitude),
          longitude: Number(ent.lon || ent.lng || ent.longitude),
          accuracy: Number(ent.accuracy || 30)
        };
      }
    }
    return null;
  } catch { return null; }
}

module.exports = {
  slugify,
  readJsonSafe,
  writeJsonSafe,
  normalizeCookies,
  getCoords,
};