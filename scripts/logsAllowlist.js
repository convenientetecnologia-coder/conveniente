'use strict';

const fsSync = require('fs');
const path = require('path');

function addArchivedLogKeys(allow, dir, filePrefix, keyPrefix, maxN) {
  try {
    if (!allow || !dir || !fsSync.existsSync(dir)) return;
    const re = new RegExp(
      '^' + String(filePrefix || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.\\d{8}-\\d{6}\\.jsonl$'
    );
    const cap = Math.max(1, Math.min(32, Number(maxN || 16) || 16));
    const hits = fsSync.readdirSync(dir)
      .filter((n) => re.test(String(n || '')))
      .map((name) => {
        const full = path.join(dir, name);
        let mtimeMs = 0;
        try { mtimeMs = Number(fsSync.statSync(full).mtimeMs || 0) || 0; } catch {}
        return { name, full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, cap);
    for (const row of hits) {
      const stamp = String(row.name || '').replace(/^.*\.(\d{8}-\d{6})\.jsonl$/i, '$1');
      const key = `${keyPrefix}_${stamp}`;
      if (!allow[key]) allow[key] = row.full;
    }
  } catch {}
}

function logsAllowlist() {
  const base = path.join(__dirname, '..', 'dados');
  const repo = path.join(__dirname, '..');
  const perfisDir = path.join(base, 'perfis');
  function safeKey(v) {
    return String(v || '')
      .trim()
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 180);
  }
  function collectProfileNames() {
    const set = new Set();
    try {
      const desiredPath = path.join(base, 'desired.json');
      if (fsSync.existsSync(desiredPath)) {
        const desired = JSON.parse(fsSync.readFileSync(desiredPath, 'utf8'));
        const perfisObj = (desired && typeof desired === 'object' && desired.perfis && typeof desired.perfis === 'object')
          ? desired.perfis
          : null;
        if (perfisObj) {
          for (const nome of Object.keys(perfisObj)) {
            const n = String(nome || '').trim();
            if (n) set.add(n);
          }
        }
      }
    } catch {}
    try {
      if (fsSync.existsSync(perfisDir)) {
        const ents = fsSync.readdirSync(perfisDir, { withFileTypes: true });
        for (const ent of ents) {
          if (!ent || !ent.isDirectory || !ent.isDirectory()) continue;
          const n = String(ent.name || '').trim();
          if (n) set.add(n);
        }
      }
    } catch {}
    return Array.from(set);
  }
  const allow = {
    logger: path.join(base, 'logger.log'),
    issues_fallback: path.join(base, 'issues_fallback.log'),
    desired: path.join(base, 'desired.json'),
    perfis: path.join(base, 'perfis.json'),
    status: path.join(base, 'status.json'),
    provision_audit: path.join(base, 'provision_audit.jsonl'),
    connect_lane_events: path.join(base, 'connect_lane_events.jsonl'),
    connect_lane_fail: path.join(base, 'connect_lane_fail.json'),
    server_runtime_config: path.join(base, 'server_runtime_config.json'),
    ct_config: path.join(base, 'ct_config.json'),
    delta_thread_state: path.join(base, 'delta_thread_state.json'),
    delta_queue: path.join(base, 'mensagens_pendentes.jsonl'),
    delta_queue_cursor: path.join(base, 'mensagens_pendentes.cursor.json'),
    delta_deadletter: path.join(base, 'mensagens_pendentes.deadletter.jsonl'),
    delta_deadletter_cursor: path.join(base, 'mensagens_pendentes.deadletter.cursor.json'),
    forensic_triagem: path.join(base, 'forensic_triagem.log'),
    forensic_edge: path.join(base, 'forensic_edge.log'),
    login_required_events: path.join(base, 'login_required_events.jsonl'),
    login_remediate_evidence: path.join(base, 'login_remediate_evidence.jsonl'),
    messenger_pin: path.join(base, 'messenger_pin.jsonl'),
    governor_snapshots: path.join(base, 'governor_snapshots.jsonl'),
    standby_sweep: path.join(base, 'logs', 'standby_sweep.jsonl'),
    standby_sweep_last: path.join(base, 'standby_sweep_last.json'),
    migrations: path.join(base, 'migrations.jsonl'),
    updates: path.join(base, 'updates.jsonl'),
    git_head: path.join(repo, '.git', 'HEAD'),
    git_main_ref: path.join(repo, '.git', 'refs', 'heads', 'main'),
    provision_lock: path.join(base, 'provision_lock.json'),
    commands: path.join(base, 'commands.log'),
    robe_v2_queue: path.join(base, 'robe_v2_queue.json'),
    service_stdout: path.join(base, 'service_stdout.log'),
    service_stderr: path.join(base, 'service_stderr.log'),
    index_lifecycle: path.join(base, 'index_lifecycle.jsonl'),
    index_lifecycle_prev: path.join(base, 'index_lifecycle.prev.jsonl'),
    index_handle_pulse: path.join(base, 'index_handle_pulse.jsonl'),
    index_handle_pulse_prev: path.join(base, 'index_handle_pulse.prev.jsonl'),
    index_heartbeat: path.join(base, 'index_heartbeat.json'),
    index_boot_context: path.join(base, 'index_boot_context.json'),
    node_runtime_last: path.join(base, 'node_runtime_last.json'),
    node_runtime_events: path.join(base, 'node_runtime_events.jsonl'),
    windows_forensic_last: path.join(base, 'windows_forensic_last.json'),
    windows_forensic_deep_last: path.join(base, 'windows_forensic_deep_last.json'),
    windows_tuning: path.join(base, 'logs', 'windows_tuning.log'),
    windows_tuning_prev: path.join(base, 'logs', 'windows_tuning.prev.log'),
    windows_tuning_state: path.join(base, 'logs', 'windows_tuning.state.json'),
    windows_tuning_forensic: path.join(base, 'logs', 'windows_tuning.forensic.jsonl'),
    windows_tuning_forensic_prev: path.join(base, 'logs', 'windows_tuning.forensic.prev.jsonl'),
    porteiro_log: 'C:\\auto_vigia\\logs\\porteiro.log',
    porteiro_ensure_log: 'C:\\auto_vigia\\logs\\porteiro_ensure.log',
    process_sentinel: path.join(base, 'process_sentinel.jsonl'),
    process_sentinel_state: path.join(base, 'process_sentinel_state.json'),
    process_sentinel_incident: path.join(base, 'process_sentinel_last_incident.json'),
    process_sentinel_install: path.join(base, 'process_sentinel_install.json'),
    crash_hammer: path.join(base, 'crash_hammer.jsonl'),
    crash_hammer_last: path.join(base, 'crash_hammer_last.json'),
    index_host_exit: path.join(base, 'index_host_exit.jsonl'),
    multi_engine_last: path.join(base, 'multi_engine_last.json'),
    multi_engine_log: path.join(base, 'logs', 'multi_engine.log')
  };
  try {
    const nomes = collectProfileNames();
    for (const nome of nomes) {
      const sk = safeKey(nome);
      if (!sk) continue;
      allow[`virtus_step_${sk}`] = path.join(perfisDir, nome, 'virtus-step.log');
      allow[`chats_respondidos_${sk}`] = path.join(perfisDir, nome, 'chats_respondidos.json');
    }
  } catch {}
  const statusNodeMax = Math.max(6, parseInt(process.env.STATUS_NODE_ALLOWLIST_MAX || '16', 10) || 16);
  for (let i = 1; i <= statusNodeMax; i += 1) {
    allow[`status_node_${i}`] = path.join(base, `status_node_${i}.json`);
  }
  addArchivedLogKeys(allow, path.join(base, 'logs'), 'index_lifecycle', 'life_arch', 16);
  addArchivedLogKeys(allow, path.join(base, 'logs'), 'index_handle_pulse', 'pulse_arch', 16);
  return allow;
}

module.exports = { logsAllowlist, addArchivedLogKeys };
