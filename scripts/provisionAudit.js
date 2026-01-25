const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '..', 'dados', 'provision_audit.jsonl');
const DIR_PATH = path.dirname(FILE_PATH);

function append(obj) {
  try {
    try { if (!fs.existsSync(DIR_PATH)) fs.mkdirSync(DIR_PATH, { recursive: true }); } catch {}
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

