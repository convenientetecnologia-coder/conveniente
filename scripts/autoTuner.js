const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const DATA_FILE = path.join(__dirname, '..', 'dados', 'tuning.json');

function readJsonSafe(file, fb){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fb; } }
function writeJsonAtomic(file, obj){
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj,null,2), 'utf8');
    try{ fs.unlinkSync(file);}catch{}
    try{ fs.renameSync(tmp, file);}catch{ fs.copyFileSync(tmp,file); try{ fs.unlinkSync(tmp);}catch{}}
    return true;
  } catch { return false; }
}

function ema(prev, value, alpha){ return prev==null ? value : (alpha*value + (1-alpha)*prev); }

async function detectSwap() {
  try {
    if (process.platform === 'win32') {
      const out = await new Promise(res=>{
        exec('wmic OS get FreeVirtualMemory,TotalVirtualMemorySize /Value', {timeout:3000}, (_,stdout)=>res(stdout||''));
      });
      const m = out.match(/FreeVirtualMemory=(\d+)\s+TotalVirtualMemorySize=(\d+)/i) || out.match(/TotalVirtualMemorySize=(\d+)\s+FreeVirtualMemory=(\d+)/i);
      if (!m) return { ok:false, swapUsedMB:null, swapPct:null };
      const a = out.match(/FreeVirtualMemory=(\d+)/i);
      const b = out.match(/TotalVirtualMemorySize=(\d+)/i);
      if (!a||!b) return { ok:false, swapUsedMB:null, swapPct:null };
      const freeKB = Number(a[1]), totalKB = Number(b[1]);
      const usedKB = totalKB - freeKB;
      const freeMB = Math.round(os.freemem()/(1024*1024));
      const totalMB = Math.round(os.totalmem()/(1024*1024));
      const usedRamMB = totalMB - freeMB;
      const usedVirtMB = Math.round(usedKB/1024);
      const swapUsedMB = Math.max(0, usedVirtMB - usedRamMB);
      const swapPct = totalKB>0 ? Math.round((swapUsedMB*1024)/(totalKB)*100) : null;
      return { ok:true, swapUsedMB, swapPct };
    } else {
      const txt = fs.readFileSync('/proc/meminfo','utf8');
      const get = (k) => {
        const m = txt.match(new RegExp('^'+k+':\\s+(\\d+)\\s+kB','m'));
        return m ? Number(m[1]) : null;
      };
      const st = get('SwapTotal'), sf = get('SwapFree');
      if (!st || sf==null) return { ok:false, swapUsedMB:null, swapPct:null };
      const usedKB = st - sf; const swapUsedMB = Math.round(usedKB/1024);
      const swapPct = st>0 ? Math.round(usedKB*100/st) : null;
      return { ok:true, swapUsedMB, swapPct };
    }
  } catch {
    return { ok:false, swapUsedMB:null, swapPct:null };
  }
}

const autoTuner = {
  init(ctx) {
    this.ctx = ctx;
    this.state = readJsonSafe(DATA_FILE, null) || {
      since: Date.now(),
      cap: null,
      openSpacingMs: null,
      timers: { robeTickMs: 7000, nurseMs: 5000, healthMs: 10000, virtusPollSec: 30 },
      ema: { cpu: null, freeMB: null, openMs: null },
      hist: { openMs: [], robeDur: [], adjustments: [] },
      swap: { swapPctEma: null, lastSwapPct: null },
      policy: { last: 'boot', reason: '', lastChangeAt: 0 }
    };
    this.alpha = { cpu:0.3, mem:0.2, openMs:0.3, swap:0.3 };
    if (!this.state.cap) {
      const cap = ctx.serverCap.getCap();
      if (cap) {
        this.state.cap = cap.safeMaxBrowsers || 1;
        this.state.openSpacingMs = cap.minOpenSpacingMs || 9000;
      }
    }
    this.persist();
  },

  noteOpenEvent(ev){
    // ev = {nome, ok, durMs, freeBeforeMB, freeAfterMB, error}
    try {
      this.state.ema.openMs = ema(this.state.ema.openMs, Math.max(0, ev.durMs||0), this.alpha.openMs);
      this.state.hist.openMs.push({ t:Date.now(), ms: ev.durMs || 0, ok: !!ev.ok, freeA: ev.freeAfterMB||null });
      while (this.state.hist.openMs.length > 100) this.state.hist.openMs.shift();
      this.persistDebounced();
    } catch {}
  },

  noteRobeCycle(ev){
    // ev = {nome, ok, durMs}
    try {
      this.state.hist.robeDur.push({ t:Date.now(), ms: ev.durMs||0, ok: !!ev.ok });
      while (this.state.hist.robeDur.length > 100) this.state.hist.robeDur.shift();
      this.persistDebounced();
    } catch {}
  },

  async autoStressTestBoot({ maxRaise=6, observeMs=12000, minHeadroomAfterOpenMB=2048 } = {}) {
    const cap0 = this.ctx.serverCap.getCap() || {};
    let base = Math.max(1, cap0.safeMaxBrowsers || 1);
    let spacing = Math.max(4000, cap0.minOpenSpacingMs || 9000);
    this.state.cap = base;
    this.state.openSpacingMs = spacing;
    this.persist();

    for (let i=0; i<maxRaise; i++) {
      const nowActive = this.ctx.controllers.size;
      if (nowActive < this.state.cap) break;
      const cand = this._pickOneCandidate(); if (!cand) break;

      const beforeMB = Math.round(os.freemem()/(1024*1024));
      const t0 = Date.now();
      const gate = await this.ctx.openGate.trySchedule(cand, 'auto_stress_boot');
      if (!gate.now) break;

      const res = await this.ctx.activateOnce(cand, 'auto_stress_boot');
      if (!res || !res.ok) {
        this._recordAdjust('boot_stress_block', `falha abrir ${cand}: ${res && res.error || 'erro'}`);
        break;
      }
      await new Promise(r=>setTimeout(r, observeMs));
      const afterMB = Math.round(os.freemem()/(1024*1024));
      const openMs = Date.now()-t0;
      this.noteOpenEvent({ nome:cand, ok:true, durMs: openMs, freeBeforeMB: beforeMB, freeAfterMB: afterMB });
      if (afterMB < minHeadroomAfterOpenMB) {
        await this.ctx.handlers.deactivate({ nome:cand, reason:'boot_stress_headroom', policy:'preserveDesired' });
        this._recordAdjust('boot_stress_drop', `headroom ${afterMB}MB < ${minHeadroomAfterOpenMB}MB`);
        break;
      }
      this.state.cap++;
      spacing = Math.max(4000, Math.floor(spacing * 0.95));
      this.state.openSpacingMs = spacing;
      const sc = this.ctx.serverCap.getCap() || {};
      sc.safeMaxBrowsers = this.state.cap;
      sc.minOpenSpacingMs = this.state.openSpacingMs;
      this.ctx.serverCap.saveCap && this.ctx.serverCap.saveCap(sc);
      this._recordAdjust('boot_stress_raise', `cap=${this.state.cap} spacing=${this.state.openSpacingMs}ms; openMs=${openMs}ms headroom=${afterMB}MB`);
      this.persist();
    }
  },

  async runtimeSelfTuning({ reschedule } = {}) {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(async () => {
      try {
        const freeMB = Math.round(os.freemem()/(1024*1024));
        const cores = Math.max(1,(os.cpus()||[]).length);
        let cpuApprox = 0;
        try {
          const vals = Object.values(this.ctx.robeMeta || {}).map(m => (typeof m.cpuPercent === 'number') ? m.cpuPercent : 0);
          cpuApprox = Math.min(100, Math.round(vals.reduce((a,b)=>a+b,0) / cores));
        } catch {}
        const sw = await detectSwap();
        if (sw && sw.ok) {
          this.state.swap.swapPctEma = ema(this.state.swap.swapPctEma, sw.swapPct==null?0:sw.swapPct, this.alpha.swap);
          this.state.swap.lastSwapPct = sw.swapPct;
        }

        this.state.ema.cpu = ema(this.state.ema.cpu, cpuApprox, this.alpha.cpu);
        this.state.ema.freeMB = ema(this.state.ema.freeMB, freeMB, this.alpha.mem);

        const hot = (freeMB < 2048) || (this.state.ema.freeMB!=null && this.state.ema.freeMB<2048) || (cpuApprox > 85) || (this.state.ema.cpu!=null && this.state.ema.cpu>82) || ((this.state.swap.swapPctEma||0)>8);
        const cool = (freeMB > 3072) && (this.state.ema.freeMB!=null && this.state.ema.freeMB>3072) && (cpuApprox < 70) && (this.state.ema.cpu!=null && this.state.ema.cpu<70) && ((this.state.swap.swapPctEma||0)<5);

        const capObj = this.ctx.serverCap.getCap() || {};
        const ceiling = capObj.dynamic?.ceiling || capObj.hardCeil || 999;

        if (hot) {
          if (this.state.cap > 1) {
            this.state.cap -= 1;
            this._recordAdjust('runtime_drop', `cpu≈${cpuApprox}% free=${freeMB}MB swap≈${this.state.swap.swapPctEma||0}% -> cap=${this.state.cap}`);
            const sc = this.ctx.serverCap.getCap(); sc.safeMaxBrowsers = this.state.cap;
            sc.minOpenSpacingMs = Math.min(20000, Math.round((this.state.openSpacingMs||9000)*1.15));
            this.state.openSpacingMs = sc.minOpenSpacingMs;
            this.ctx.serverCap.saveCap && this.ctx.serverCap.saveCap(sc);
            if (reschedule) reschedule({
              robeTickMs: Math.min(16000, Math.round((this.state.timers.robeTickMs||7000)*1.2)),
              nurseMs: Math.min(9000, Math.round((this.state.timers.nurseMs||5000)*1.2)),
              healthMs: Math.min(20000, Math.round((this.state.timers.healthMs||10000)*1.2)),
            });
          }
        } else if (cool) {
          this._riseCoolCount = (this._riseCoolCount||0) + 1;
          if (this._riseCoolCount >= 2 && this.state.cap < ceiling) {
            this.state.cap += 1;
            this._recordAdjust('runtime_raise', `cpu≈${cpuApprox}% free=${freeMB}MB -> cap=${this.state.cap}`);
            const sc = this.ctx.serverCap.getCap(); sc.safeMaxBrowsers = this.state.cap;
            sc.minOpenSpacingMs = Math.max(4000, Math.round((this.state.openSpacingMs||9000)*0.95));
            this.state.openSpacingMs = sc.minOpenSpacingMs;
            this.ctx.serverCap.saveCap && this.ctx.serverCap.saveCap(sc);
            if (reschedule) reschedule({
              robeTickMs: Math.max(5000, Math.round((this.state.timers.robeTickMs||7000)*0.95)),
              nurseMs: Math.max(4000, Math.round((this.state.timers.nurseMs||5000)*0.95)),
              healthMs: Math.max(8000, Math.round((this.state.timers.healthMs||10000)*0.95)),
            });
            this._riseCoolCount = 0;
          }
        } else {
          this._riseCoolCount = 0;
        }

        this.persistDebounced();
      } catch (e) {}
    }, 4000);
  },

  getState(){ return this.state; },
  getHistory(){
    return {
      openMs: this.state.hist.openMs,
      robeDur: this.state.hist.robeDur,
      adjustments: this.state.hist.adjustments
    };
  },

  _recordAdjust(type, msg){
    const entry = { ts: Date.now(), type, msg };
    this.state.hist.adjustments.push(entry);
    while (this.state.hist.adjustments.length>200) this.state.hist.adjustments.shift();
    this.state.policy.last = type;
    this.state.policy.reason = msg;
    this.state.policy.lastChangeAt = Date.now();
    this.persistDebounced();
  },

  _pickOneCandidate(){
    try {
      const desired = this.ctx.readJsonFile(this.ctx.desiredPath, { perfis: {} }) || { perfis: {} };
      const arr = Object.entries(desired.perfis||{}).filter(([_,v]) => v && v.active===true).map(([n])=>n);
      const open = new Set(Array.from(this.ctx.controllers.keys()));
      const list = arr.filter(n => !open.has(n));
      list.sort(()=> Math.random()-0.5);
      return list[0] || null;
    } catch { return null; }
  },

  persist(){
    writeJsonAtomic(DATA_FILE, { ...this.state, ts: Date.now() });
  },
  persistDebounced(){
    clearTimeout(this._pd); this._pd = setTimeout(()=>this.persist(), 300);
  }
};

module.exports = autoTuner;