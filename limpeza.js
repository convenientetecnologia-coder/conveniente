// scripts/admin_clear_fbblock.js

// Script de limpeza de bloqueios FB (pauseReason, cooldowns) para todos os perfis.
// Como usar: node scripts/admin_clear_fbblock.js

const fs = require('fs');
const path = require('path');

// Utilidades locais de IO
function readJsonSafe(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } }
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try { fs.unlinkSync(file); } catch {}
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
}

// Caminhos principais
const dadosDir = path.join(__dirname, '..', 'dados');
const perfisPath = path.join(dadosDir, 'perfis.json');
const statusPath = path.join(dadosDir, 'status.json');

(function main(){
  const perfis = readJsonSafe(perfisPath, []);
  if (!Array.isArray(perfis) || perfis.length === 0) {
    console.log('[CLEAR] Nenhum perfil encontrado.');
    process.exit(0);
  }

  const now = Date.now();
  let changedManifests = 0;
  for (const p of perfis) {
    if (!p || !p.nome || !p.userDataDir) continue;
    const manifestPath = path.join(p.userDataDir, 'manifest.json');
    const man = readJsonSafe(manifestPath, null);
    if (!man) continue;
    let changed = false;

    if (man.robeCooldownUntil !== now) { man.robeCooldownUntil = now; changed = true; }
    if (man.robeCooldownRemainingMs !== 0) { man.robeCooldownRemainingMs = 0; changed = true; }
    if ('pauseReason' in man) { delete man.pauseReason; changed = true; }
    if ('lastRobeBlockAt' in man) { delete man.lastRobeBlockAt; changed = true; }

    if (changed) { writeJsonAtomic(manifestPath, man); changedManifests++; console.log(`[CLEAR][manifest] ${p.nome}`); }
  }

  // Limpeza em status.json (cosmético até o worker sobrescrever)
  let st = readJsonSafe(statusPath, null);
  if (st && st.robes && typeof st.robes === 'object') {
    let changedStatus = 0;
    for (const nome of Object.keys(st.robes)) {
      const r = st.robes[nome] || {};
      let dirty = false;
      if ('pauseReason' in r) { delete r.pauseReason; dirty = true; }
      if ('lastRobeBlockAt' in r) { delete r.lastRobeBlockAt; dirty = true; }
      if (dirty) { st.robes[nome] = r; changedStatus++; console.log(`[CLEAR][status] ${nome}`); }
    }
    if (changedStatus > 0) writeJsonAtomic(statusPath, st);
  }

  console.log(`[CLEAR] Manifests atualizados: ${changedManifests}. Concluído.`);
})();