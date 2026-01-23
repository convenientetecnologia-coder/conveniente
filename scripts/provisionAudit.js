const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '..', 'dados', 'provision_audit.jsonl');

function append(obj) {
  try {
    const line = JSON.stringify({ ts: Date.now(), ...obj }) + '\n';
    fs.appendFileSync(FILE_PATH, line, 'utf8');
  } catch {
    // never throw (audit must not break production)
  }
}

module.exports = {
  FILE_PATH,
  append
};

