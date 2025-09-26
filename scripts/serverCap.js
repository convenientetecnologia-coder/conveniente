//serverCap.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CAP_PATH = path.join(__dirname, '..', 'dados', 'server_cap.json');

function readJson(file, fb){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fb; } }
function writeJson(file, obj){
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj,null,2));
  try { fs.unlinkSync(file); } catch {}
  try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
  return true;
}

async function ping(host='1.1.1.1', attempts=4, timeoutMs=1200) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const args = process.platform === 'win32'
      ? ['-n', String(attempts), '-w', String(timeoutMs), host]
      : ['-c', String(attempts), '-W', String(Math.ceil(timeoutMs/1000)), host];
    const p = spawn('ping', args, { stdio: ['ignore','pipe','ignore'] });
    let out=''; p.stdout.on('data', b=> out += b.toString());
    p.on('close', ()=> {
      const ms = out.match(/time[=<]?\s?(\d+\.?\d*)\s?ms/gi) || [];
      const vals = ms.map(s => Number((s.match(/(\d+\.?\d*)/)||[])[1])).filter(x=>Number.isFinite(x));
      const avg = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
      resolve({ avgMs: avg, samples: vals.length });
    });
    setTimeout(()=>{ try{p.kill('SIGKILL')}catch{}; resolve({ avgMs: null, samples: 0 }); }, attempts*timeoutMs + 800);
  });
}

async function cpuBenchMs(ms=600) {
  const end = Date.now()+ms;
  let it=0;
  while (Date.now()<end) {
    crypto.createHash('sha256').update(String(Math.random())).digest('hex');
    it++;
  }
  const cores = Math.max(1,(os.cpus()||[]).length);
  return Math.round((it/(ms/1000))/cores);
}

function diskBenchSeq(tmpFile, totalMB=64){
  try {
    const buf = Buffer.alloc(1024*1024, 0xab);
    const t0 = Date.now();
    const fd = fs.openSync(tmpFile, 'w');
    for (let i=0;i<totalMB;i++) fs.writeSync(fd, buf);
    fs.fsyncSync(fd); fs.closeSync(fd);
    const t1 = Date.now();
    const writeMBps = Math.round((totalMB)/((t1-t0)/1000));

    const t2 = Date.now();
    const fd2 = fs.openSync(tmpFile, 'r');
    for (let i=0;i<totalMB;i++) fs.readSync(fd2, buf, 0, buf.length, i*buf.length);
    fs.closeSync(fd2);
    const t3 = Date.now();
    const readMBps = Math.round((totalMB)/((t3-t2)/1000));

    try { fs.unlinkSync(tmpFile); } catch {}
    return { writeMBps, readMBps };
  } catch { try { fs.unlinkSync(tmpFile); } catch {} ; return { writeMBps:null, readMBps:null }; }
}

function computeCapFrom(hw, bench) {
  const reserveMB = 2048;
  const totalMB = Math.round(os.totalmem()/(1024*1024));
  const threads = (os.cpus()||[]).length;

  let perBrowserMB = 500;
  let penalty = 1.0;
  if (bench.disk.readMBps != null && bench.disk.readMBps < 80) penalty *= 0.7;
  if (bench.cpuIters != null && bench.cpuIters < 4000) penalty *= 0.85;
  if (bench.latencyMs != null && bench.latencyMs > 60) penalty *= 0.9;

  // Trecho alterado conforme instrução:
  const maxByThreads = Math.max(1, Math.floor(threads * 2)); // permite usar mais o hardware se aguentar
  const byMem = Math.max(1, Math.floor((totalMB - reserveMB) / perBrowserMB));
  let base = Math.max(1, Math.floor(Math.min(byMem, maxByThreads) * penalty));

  // Novo teto: deixa abrir até 64, mas ainda depende de RAM/threads
  const hardCeil = Math.min(byMem, maxByThreads, 64); // máximo absoluto 64
  base = Math.min(base, hardCeil);

  return { perBrowserMB, reserveMB, base, hardCeil };
}

async function calibrateIfNeeded({ force=false } = {}) {
  let cap = readJson(CAP_PATH, null);
  const now = Date.now();
  const TTL = 7*24*3600*1000;
  if (!cap || force || (now - (cap.calibratedAt||0)) > TTL) {
    const tmpFile = path.join(os.tmpdir(), 'cap_bench_'+process.pid+'.bin');
    const cpuIters = await cpuBenchMs(600);
    const disk = diskBenchSeq(tmpFile, 64);
    const net = await ping('1.1.1.1', 4, 1200);
    const hw = {
      platform: process.platform,
      arch: process.arch,
      cpuModel: (os.cpus()||[])[0]?.model || 'unknown',
      cores: (os.cpus()||[]).length,
      totalMB: Math.round(os.totalmem()/(1024*1024))
    };
    const cap0 = computeCapFrom(hw, { cpuIters, disk, latencyMs: net.avgMs });

    // Log conforme recomendado na instrução:
    console.log(`[SERVERCAP] CALC cap0: perBrowserMB=${cap0.perBrowserMB} reserveMB=${cap0.reserveMB} base=${cap0.base} hardCeil=${cap0.hardCeil}`);

    cap = {
      calibratedAt: now,
      hw, bench: { cpuIters, disk, latencyMs: net.avgMs },
      perBrowserMB: cap0.perBrowserMB,
      reserveMB: cap0.reserveMB,
      safeMaxBrowsers: cap0.base,
      hardCeil: cap0.hardCeil,
      openRatePerMin: 6,
      minOpenSpacingMs: 9000,
      dynamic: { floor: 1, ceiling: cap0.hardCeil, lastDownAt: 0, lastUpAt: 0 }
    };
    writeJson(CAP_PATH, cap);
  }
  return cap;
}

function getCap() { return readJson(CAP_PATH, null); }
function saveCap(obj){ writeJson(CAP_PATH, obj); }

function recordRuntimeSample({ perBrowserMBAvg, overload=false, reason='' }) {
  const cap = getCap(); if (!cap) return;
  if (Number.isFinite(perBrowserMBAvg) && perBrowserMBAvg > 200) {
    cap.perBrowserMB = Math.round(0.8*cap.perBrowserMB + 0.2*perBrowserMBAvg);
  }
  if (overload) {
    if (cap.safeMaxBrowsers > (cap.dynamic.floor||1)) {
      cap.safeMaxBrowsers -= 1;
      cap.dynamic.lastDownAt = Date.now();
      cap.dynamic.lastDownReason = reason || 'overload';
    }
  }
  saveCap(cap);
}

function bumpDown(reason='manual'){
  const cap = getCap(); if (!cap) return;
  if (cap.safeMaxBrowsers > (cap.dynamic.floor||1)) {
    cap.safeMaxBrowsers -= 1;
    cap.dynamic.lastDownAt = Date.now();
    cap.dynamic.lastDownReason = reason;
    saveCap(cap);
  }
}
function bumpUp(reason='manual'){
  const cap = getCap(); if (!cap) return;
  const ceil = cap.dynamic?.ceiling || cap.hardCeil || 999;
  if (cap.safeMaxBrowsers < ceil) {
    cap.safeMaxBrowsers += 1;
    cap.dynamic.lastUpAt = Date.now();
    cap.dynamic.lastUpReason = reason;
    saveCap(cap);
  }
}

module.exports = { calibrateIfNeeded, getCap, recordRuntimeSample, bumpDown, bumpUp };