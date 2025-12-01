// scripts/missing.js
// Função única para cálculo dos campos críticos faltantes no funil

function isValidPhoneBR(d) {
  const s = String(d || '').replace(/\D/g, '');
  if (s.length === 11) return /^[1-9]{2}9\d{8}$/.test(s);       // Celular: DDD + 9 + 8 dígitos
  if (s.length === 10) return /^[1-9]{2}[2-9]\d{7}$/.test(s);  // Fixo: DDD + 8 dígitos, 1º de 2–9
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

