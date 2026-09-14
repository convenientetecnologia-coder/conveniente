const path = require('path');
const { appendLine } = require('./auditAppend.js');

const FILE_PATH = path.join(__dirname, '..', 'dados', 'provision_audit.jsonl');

function append(obj) {
  try {
    appendLine(FILE_PATH, obj && typeof obj === 'object' ? obj : { event: String(obj || '') });
  } catch {
    // never throw (audit must not break production)
  }
}

module.exports = {
  FILE_PATH,
  append
};
