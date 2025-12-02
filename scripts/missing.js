// scripts/missing.js
// Função única para cálculo dos campos críticos faltantes no funil

// Validação específica para WhatsApp (só aceita 11 dígitos começando com 9 após DDD)
function isValidPhoneBR(d) {
  const s = String(d || '').replace(/\D/g, '');
  // Só aceita celular WhatsApp: DDD (2 dígitos) + 9 (celular) + 8 dígitos = 11 dígitos
  if (s.length === 11) return /^[1-9]{2}9\d{8}$/.test(s);
  // Telefone fixo (10 dígitos) NUNCA é considerado válido - o FSM vai perguntar WhatsApp
  return false;
}

function isNonEmpty(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'boolean') return v; // presença booleana é considerada preenchida
  return true; // outros tipos não vazios
}

function computeMissing(data) {
  const d = data || {};
  const missing = [];

  // Ordem obrigatória do funil
  if (!isValidPhoneBR(d.telefone)) missing.push('telefone');
  if (!isNonEmpty(d.itens)) missing.push('itens');
  if (!isNonEmpty(d.endereco_saida)) missing.push('endereco_saida');
  if (!isNonEmpty(d.endereco_destino)) missing.push('endereco_destino');

  return missing;
}

module.exports = { computeMissing };

