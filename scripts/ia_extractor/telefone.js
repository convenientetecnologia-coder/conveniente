// scripts/ia_extractor/telefone.js

/**
 * Extrai um telefone de 11 dígitos (celular com DDD, padrão Brasil) das mensagens recentes do cliente.
 * Estratégia: regex busca pelo padrão, pega o mais recente.
 * @param {Array} historico 
 * @returns {Object} - { telefone: string|null }
 */
function onlyDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

function isValidBRPhone(s) {
  const num = onlyDigits(s);
  return num.length === 11 && /^([1-9]{2})9\d{8}$/.test(num); // DDD + celular
}

function extract(historico = []) {
  const PHONE_REGEX = /(?:\+?55\s*)?\b([1-9]{2})\D*?9\d{4}\D*?\d{4}\b/g;
  for (let i = historico.length - 1; i >= 0; i--) {
    const texto = (historico[i].texto || '').trim();
    let match;
    PHONE_REGEX.lastIndex = 0;
    while ((match = PHONE_REGEX.exec(texto)) !== null) {
      const ddd = match[1];
      const full = onlyDigits(match[0]);
      if (isValidBRPhone(full)) {
        return { telefone: full };
      }
    }
  }
  return {};
}

module.exports = { extract, isValidBRPhone };