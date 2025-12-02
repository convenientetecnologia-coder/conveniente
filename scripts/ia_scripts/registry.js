// scripts/ia_scripts/registry.js

// Mapa para registrar os handlers por step/version
const map = new Map();

/**
 * Registra um handler de step (ex: telefone, itens...) pela chave id@version
 * @param {Object} step - handler { id, version, ... }
 */
function register(step) {
  const key = `${step.id}@${step.version}`;
  map.set(key, step);
}

/**
 * Obtém o handler registrado pela id e versão (default: 1)
 * @param {String} id - step id (ex: telefone)
 * @param {Number} version 
 * @returns {Object} handler
 */
function get(id, version = 1) {
  return map.get(`${id}@${version}`);
}

/**
 * (Opcional) Expor os steps registrados (para debug/QA)
 * @returns {Array}
 */
function list() {
  return Array.from(map.keys());
}

module.exports = {
  register,
  get,
  list
};