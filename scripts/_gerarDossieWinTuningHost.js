"use strict";
/**
 * Dossie de auditoria — tuning do host Windows + adendo de registro.
 * Le arquivos do clone C:\conveniente. Gera HTML+PDF. Copia para C:\sitechatbot\dados.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dados");
const CT = "C:/sitechatbot/dados";
const TAG = "DOSSIE_WIN_TUNING_HOST_ADENDO_2026-09-03";

const FILES = [
  ["scripts/winTuningMaster.ps1", path.join(ROOT, "scripts", "winTuningMaster.ps1")],
  ["scripts/iniciarSistema.ps1", path.join(ROOT, "scripts", "iniciarSistema.ps1")],
  ["porteiro/kit/manutencao.ps1", path.join(ROOT, "porteiro", "kit", "manutencao.ps1")],
  ["porteiro/kit/install.ps1", path.join(ROOT, "porteiro", "kit", "install.ps1")],
  ["scripts/dashboard.js", path.join(ROOT, "scripts", "dashboard.js")],
  ["scripts/diag_olhos_deus.js", path.join(ROOT, "scripts", "diag_olhos_deus.js")],
  ["dados/_verify_win_tuning.js", path.join(ROOT, "dados", "_verify_win_tuning.js")],
  ["scripts/forensicSentinel.ps1", path.join(ROOT, "scripts", "forensicSentinel.ps1")]
];

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function sha256(abs) {
  try {
    const b = fs.readFileSync(abs);
    return { ok: true, bytes: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex"), md5: crypto.createHash("md5").update(b).digest("hex") };
  } catch (e) {
    return { ok: false, err: String(e && e.message || e) };
  }
}
function numbered(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  return lines.map((l, i) => String(i + 1).padStart(4, " ") + "|" + l).join("\n");
}
function sliceNum(text, a, b) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  return lines.slice(a - 1, b).map((l, i) => String(a + i).padStart(4, " ") + "|" + l).join("\n");
}
function hits(text, re) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) out.push({ line: i + 1, text: lines[i] });
  }
  return out;
}
function table(headers, rows) {
  let h = "<table><tr>" + headers.map((x) => "<th>" + esc(x) + "</th>").join("") + "</tr>";
  for (const r of rows) h += "<tr>" + r.map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>";
  return h + "</table>";
}
function pre(title, text, meta) {
  return "<h3>" + esc(title) + "</h3>" +
    (meta ? "<p class=\"meta\">" + esc(meta) + "</p>" : "") +
    "<pre>" + esc(text) + "</pre>";
}
function run(cmd, args, timeoutMs) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: timeoutMs || 120000 });
  return {
    status: r.status,
    stdout: String(r.stdout || "").trim(),
    stderr: String(r.stderr || "").trim()
  };
}

(async () => {
  const generatedAt = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour12: false });
  const loaded = FILES.map(([rel, abs]) => {
    const h = sha256(abs);
    const raw = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "AUSENTE: " + abs;
    return { rel, abs, hash: h, raw, numbered: numbered(raw) };
  });
  const tune = loaded[0].raw;
  const iniciar = loaded[1].raw;
  const kit = loaded[2].raw;
  const install = loaded[3].raw;
  const dash = loaded[4].raw;
  const olhos = loaded[5].raw;

  const verify = run(process.execPath, [path.join(ROOT, "dados", "_verify_win_tuning.js")], 60000);
  const parsePs1 = path.join(OUT, "_tmp_parse_tune.ps1");
  fs.writeFileSync(parsePs1, [
    "$e = $null",
    "$t = $null",
    "[void][System.Management.Automation.Language.Parser]::ParseFile('C:\\conveniente\\scripts\\winTuningMaster.ps1', [ref]$t, [ref]$e)",
    "if ($e -and $e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }",
    "Write-Output ('PARSE_OK tokens=' + $t.Count)"
  ].join("\n"), "utf8");
  const parse = run("powershell.exe", ["-NoProfile", "-File", parsePs1], 30000);
  try { fs.unlinkSync(parsePs1); } catch {}
  const dry = run("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", "C:\\conveniente\\scripts\\winTuningMaster.ps1",
    "-Apply", "-DryRun"
  ], 60000);

  let dryState = "";
  let dryFore = "";
  try { dryState = fs.readFileSync(path.join(OUT, "logs", "windows_tuning.state.json"), "utf8"); } catch {}
  try {
    const fore = fs.readFileSync(path.join(OUT, "logs", "windows_tuning.forensic.jsonl"), "utf8");
    const lines = fore.split(/\r?\n/).filter(Boolean);
    dryFore = lines.slice(-16).join("\n");
  } catch {}

  const hitRows = [];
  const re = /TUNING_|VisualFX|MinAnimate|Win32Priority|Write-Forensic|windows_tuning|WerSvc|SharedSection|Invoke-WinTuningSilent|-Boot|-Apply/;
  for (const f of loaded) {
    for (const hit of hits(f.raw, re)) {
      if (f.rel === "scripts/dashboard.js" && !/windows_tuning/.test(hit.text)) continue;
      if (f.rel === "scripts/diag_olhos_deus.js" && !/windows_tuning|windowsTuning|TUNE_/.test(hit.text)) continue;
      hitRows.push([f.rel, String(hit.line), hit.text.trim().slice(0, 220)]);
    }
  }

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(TAG)}</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;font-size:11px;line-height:1.35;color:#111;margin:0}
h1{font-size:16px;margin:0 0 8px}
h2{font-size:13px;margin:14px 0 6px;border-bottom:1px solid #999;padding-bottom:2px}
h2.first{margin-top:0}
h3{font-size:11px;margin:10px 0 4px}
.meta{color:#444;font-size:9.5px;margin:0 0 8px}
.crit{background:#fff4cc;border:1px solid #c9a227;padding:7px 9px;margin:8px 0}
.ok{background:#e8f6e8;border:1px solid #3a7a3a;padding:7px 9px;margin:8px 0}
.no{background:#fdecea;border:1px solid #a33;padding:7px 9px;margin:8px 0}
pre{background:#111;color:#f2f2f2;padding:6px;font-size:6.8px;line-height:1.22;white-space:pre-wrap;word-break:break-word}
table{border-collapse:collapse;width:100%;font-size:8.2px;margin:6px 0}
th,td{border:1px solid #333;padding:3px 4px;vertical-align:top;text-align:left}
th{background:#eee}
code{font-size:10px}
</style></head><body>

<h1>Dossie — Tuning do host Windows + adendo de registro</h1>
<p class="meta">Gerado ${esc(generatedAt)} BRT · auditoria do que foi feito e do que foi recusado de proposito · arquivos lidos de C:\\conveniente</p>

<div class="crit"><b>LEITURA OBRIGATORIA.</b> Este dossie registra o contrato real do <code>scripts/winTuningMaster.ps1</code>. Tuning afina o host (servicos, energia, heap, prioridade, registro). Nao afirma cura de FastFail 0xC0000409. Nao pede UAC no Iniciar. Nao atrasa o Node. Cada passo grava before/after/motivo em JSONL forense puxavel pelo CT.</div>

<h2 class="first">0. Indice SHA256 dos arquivos desta peca</h2>
${table(["arquivo", "bytes", "md5", "sha256"], loaded.map((f) => [f.rel, String(f.hash.bytes || f.hash.err || ""), f.hash.md5 || "", f.hash.sha256 || ""]))}

<h2>1. O que FOI feito (codigo no disco)</h2>
<div class="ok">Implementado e acoplado. Vale em todos os hosts com o mesmo Windows quando o script rodar (Iniciar = HKCU; Setup elevado = HKLM/servicos/heap).</div>
${table(["item", "como", "quando vale", "log"], [
  ["Disparo no Iniciar", "iniciarSistema.ps1 Start-Process Hidden -Boot, sem Wait, sem RunAs", "todo clique Iniciar, sessao do usuario", "windows_tuning.log + forensic.jsonl"],
  ["Disparo no porteiro", "manutencao.ps1 Invoke-WinTuningSilent no Do-Start (e loop AUTO_BOOT)", "start do Conveniente pelo dest", "mesmo par de logs"],
  ["Disparo no Setup", "install.ps1 -Apply (elevado, sem -Boot/-Watch)", "instalacao/rearm do porteiro como admin", "HKLM + servicos entram aqui"],
  ["DiagTrack + SysMain", "Stop + Disabled se admin", "so token elevado", "passo diagtrack / sysmain"],
  ["WerSvc", "Stop + Manual se admin. Nunca Disabled", "admin; sentinel tambem forca Manual", "passo wersvc"],
  ["Plano de energia", "Ultimate e9a42b02-... senão High Performance; disco/standby/hibernate 0; PROCTHROTTLE min/max 100", "admin no Setup; best-effort sem admin", "passo power / power_best_effort"],
  ["Desktop Heap", "sobe so o 2o numero de SharedSection (piso 30720, teto 65536), backup Unicode, recusa replace cego", "admin + reboot para valer", "passo desktop_heap"],
  ["Prioridade High continua", "node Conveniente (index.js / worker.js), chrome com C:\\\\conveniente, mstsc/rdpclip/TermService. Poll 5s + mutex", "Iniciar -Boot sobe Apply+Watch", "passo priority_once + WATCH"],
  ["Adendo VisualFXSetting", "HKCU:...\\\\Explorer\\\\VisualEffects VisualFXSetting DWORD=2", "Iniciar (sem admin). Logoff pode ser preciso para o DWM fechar 100%", "passo reg_visualfx"],
  ["Adendo MinAnimate", "HKCU:...\\\\WindowMetrics MinAnimate REG_SZ \"0\" (nao DWORD)", "Iniciar (sem admin). Nao mata explorer", "passo reg_minanimate"],
  ["Adendo Win32PrioritySeparation", "HKLM:...\\\\PriorityControl DWORD=24 (0x18) perfil Background Services. Backup forense do valor anterior", "so Setup/admin", "passo reg_win32priority + event priority_backup"],
  ["Log ASCII", "dados/logs/windows_tuning.log + rotacao .prev.log 1.5MB", "toda execucao", "stamps [TUNING_OK] / [TUNING_PARTIAL]"],
  ["Estado JSON", "dados/logs/windows_tuning.state.json com os, runId, stamp, adendoStamp, steps[]", "toda execucao", "chave fetch_logs windows_tuning_state"],
  ["Forense JSONL", "dados/logs/windows_tuning.forensic.jsonl — begin/step/adendo/end/priority_backup/watch com before, after, want, reason, options, error", "toda execucao", "chave fetch_logs windows_tuning_forensic"],
  ["Olhos de Deus", "diag_olhos_deus.js inclui windowsTuning + vereditos de stamp/adendo/passos recusados", "POST olhos-deus_secret", "nao marca FAIL so porque o arquivo ainda nao existe"],
  ["Allowlist CT", "dashboard.js: windows_tuning, _prev, _state, _forensic, _forensic_prev", "fetch_logs no host", "sem chave nova no sitechatbot"]
])}

<h2>2. O que NAO foi feito (recusa contratual, nao esquecimento)</h2>
<div class="no">Estas linhas foram recusadas de proposito. Nao sao remendo futuro automatico. Mexer nisso quebra forense, UAC ou mente sobre o Windows.</div>
${table(["pedido / tentacao", "status", "motivo"], [
  ["WerSvc = Disabled", "NAO FEITO", "WER reporta FastFail 0xC0000409; Disabled apaga dump. forensicSentinel.ps1 ja forca Manual."],
  ["UAC / Verb RunAs no Iniciar", "NAO FEITO", "Contrato do porteiro: Iniciar Hidden sem admin. HKLM fica para o Setup."],
  ["Start-Process -Wait no Iniciar", "NAO FEITO", "Node nao pode esperar o tuning. Fire-and-forget."],
  ["Loop 1 ms de prioridade", "NAO FEITO", "Queima CPU. Poll 5s + mutex Local\\\\ConvenienteWinTuningWatch."],
  ["Afirmar que tuning elimina FastFail", "NAO FEITO", "FastFail e do processo (stack/GS). Tuning reduz pressao (DWM/heap/scheduler), nao saca o bug."],
  ["Afirmar que forca CPU 2.5 → 3.0 GHz", "NAO FEITO", "Frequencia e BIOS/firmware. Script so trava PROCTHROTTLE 100% se o Windows aceitar o scheme."],
  ["Reescrever a string Windows do Session Manager no escuro", "NAO FEITO", "Se SharedSection nao casar 3 numeros, skip + replace_refused. Nunca inventa a linha."],
  ["Encolher Desktop Heap", "NAO FEITO", "So sobe o 2o numero. Se ja >= 30720, skipped already."],
  ["High em sitechatbot / iniciar / manutencao / watcher", "NAO FEITO", "Allowlist: so C:\\\\conveniente\\\\index.js, scripts\\\\worker.js e chrome desse caminho + RDP."],
  ["Matar explorer.exe apos VisualFX", "NAO FEITO", "Sessao do operador/RDP nao pode cair. MinAnimate/VisualFX podem pedir logoff para efeito total."],
  ["MinAnimate como DWORD", "NAO FEITO", "Windows guarda REG_SZ \"0\"/\"1\". Tipo errado o Windows ignora ou corrompe a chave."],
  ["Watch rodando como SYSTEM no Setup", "NAO FEITO", "install.ps1 so -Apply. Watch nasce no Iniciar/porteiro na sessao do usuario."],
  ["DryRun neste PC CT aplicar de verdade", "NAO FEITO nesta geracao", "Verify usa -Apply -DryRun. MAE1 aplica no proximo Iniciar (HKCU) e no proximo Setup (HKLM)."]
])}

<h2>3. Adendo de registro (socio) — chaves, tipos, alvos</h2>
${table(["chave", "nome", "tipo", "alvo", "hive", "admin?", "efeito real"], [
  ["HKCU:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\VisualEffects", "VisualFXSetting", "REG_DWORD", "2", "HKCU", "nao", "Modo Ajustar para melhor desempenho. Alivia DWM (dwm.exe) sob muitos Chromes. Pode precisar logoff."],
  ["HKCU:\\\\Control Panel\\\\Desktop\\\\WindowMetrics", "MinAnimate", "REG_SZ", "0", "HKCU", "nao", "Desliga animacao de minimizar/maximizar. Tipo string e o que o Windows aceita."],
  ["HKLM:\\\\SYSTEM\\\\CurrentControlSet\\\\Control\\\\PriorityControl", "Win32PrioritySeparation", "REG_DWORD", "24 (0x18)", "HKLM", "sim", "Perfil Background Services. Quantum longo/estavel. RDP/desktop pode parecer menos na frente. Nao e cura de FastFail."]
])}
<p class="meta">Valores conhecidos de Win32PrioritySeparation gravados no event priority_backup: 2 = Programs (workstation); 24 = Background 0x18 (alvo); 26 = Programs 0x1A; 38 = visto em alguns servidores. O valor anterior e sempre lido antes de escrever.</p>
<p class="meta">Stamp pedido pela diretoria, so quando os 3 passos do adendo estao no alvo (escritos ou already=): <code>[TUNING_ADENDO_OK] Efeitos visuais mitigados e Prioridade de Background injetada via Registro com sucesso.</code> Sem admin no Iniciar: VisualFX+MinAnimate podem ir; Win32 fica skip sem_admin → <code>[TUNING_ADENDO_PARTIAL]</code>. DryRun → <code>[TUNING_ADENDO_DRYRUN]</code>.</p>

<h2>4. Como dispara (nao muda o Node)</h2>
${pre("iniciarSistema.ps1 — primeiro efeito, fire-and-forget", sliceNum(iniciar, 9, 17))}
${pre("manutencao.ps1 — Invoke-WinTuningSilent + Do-Start", sliceNum(kit, 533, 547))}
${pre("install.ps1 — Setup elevado so -Apply", sliceNum(install, 81, 89))}

<h2>5. Schema do log forense (olhos de deus do tuning)</h2>
<p>Arquivo: <code>C:\\conveniente\\dados\\logs\\windows_tuning.forensic.jsonl</code> (UTF-8, uma linha JSON por evento, rotacao 2MB → .prev.jsonl).</p>
${table(["campo", "quando", "para que serve"], [
  ["ts / iso / runId / host / user / pid / admin / dryRun", "todo evento", "amarrar a tentativa"],
  ["event=begin + options.os", "inicio do Apply", "caption/build/RAM/scheme ativo antes de mexer"],
  ["event=step + step + ok + skipped + before + after + want + reason + options + error + hive/path/name", "cada Invoke-Step", "o que o Windows tinha, o que pedimos, o que ficou, por que pulou ou recusou"],
  ["event=priority_backup", "antes de Win32PrioritySeparation", "valor antigo + dicionario 2/24/26/38"],
  ["event=adendo", "depois dos 3 passos de registro", "stamp consolidado"],
  ["event=end", "fim do Apply", "TUNING_OK vs PARTIAL"],
  ["event=watch", "mutex/poll", "ja existia outro watch?"]
])}
<p>ASCII paralelo: <code>windows_tuning.log</code> linha <code>STEP nome ok= skip= before= after= want= detalhe</code>. Estado compacto: <code>windows_tuning.state.json</code>.</p>
<p><b>Puxar do CT (MAE viva):</b> command-bus <code>fetch_logs</code> com as chaves <code>windows_tuning</code>, <code>windows_tuning_state</code>, <code>windows_tuning_forensic</code>. Olhos de Deus (<code>POST /api/forensic/olhos-deus_secret</code>) agora devolve <code>windowsTuning</code> com stamp, adendo, steps e ultimos eventos JSONL. Nao precisa chave nova no sitechatbot: a allowlist mora no edge <code>scripts/dashboard.js</code>.</p>

<h2>6. Como ler um passo recusado</h2>
${table(["ok", "skipped", "leitura"], [
  ["true", "false", "Windows aceitou e o readback bateu no alvo"],
  ["true", "true + already=", "ja estava no alvo; nao reescreveu"],
  ["true", "true + sem_admin", "certo no Iniciar: HKLM/servicos/heap ficam para o Setup"],
  ["true", "true + dryrun", "simulado; disco Windows intocado"],
  ["true", "true + servico_ausente", "SKU sem esse servico"],
  ["false", "false", "Windows recusou ou readback_mismatch — ver error/options (ACL, dominio, GUID de energia ausente, replace_refused)"]
])}

<h2>7. Verify + parse + DryRun desta geracao</h2>
${pre("_verify_win_tuning.js exit=" + String(verify.status), [verify.stdout, verify.stderr].filter(Boolean).join("\n\n"))}
${pre("Parser PowerShell 5.1", [parse.stdout, parse.stderr].filter(Boolean).join("\n\n") || "(sem saida)")}
${pre("DryRun -Apply neste PC (nao e a MAE 1)", [dry.stdout, dry.stderr].filter(Boolean).join("\n\n"))}
${pre("state.json apos DryRun", dryState || "(ausente)")}
${pre("tail forensic.jsonl apos DryRun", dryFore || "(ausente)")}

<h2>8. Indice de ocorrencias (tuning / adendo / logs)</h2>
${table(["arquivo", "linha", "texto"], hitRows)}

<h2>9. Excertos do master</h2>
${pre("cabecalho + contrato", sliceNum(tune, 1, 36))}
${pre("Invoke-Step + Write-Forensic", sliceNum(tune, hits(tune, /function Invoke-Step/)[0] ? hits(tune, /function Invoke-Step/)[0].line : 150, (hits(tune, /function Invoke-Step/)[0] ? hits(tune, /function Invoke-Step/)[0].line : 150) + 50))}
${pre("adendo VisualFX / MinAnimate / Win32", sliceNum(tune, hits(tune, /function Set-VisualFXSetting/)[0] ? hits(tune, /function Set-VisualFXSetting/)[0].line : 300, (hits(tune, /function Set-VisualFXSetting/)[0] ? hits(tune, /function Set-VisualFXSetting/)[0].line : 300) + 40))}
${pre("bloco Apply + stamps", sliceNum(tune, hits(tune, /\$steps = @\(\)/)[0] ? hits(tune, /\$steps = @\(\)/)[0].line : 600, (hits(tune, /\$steps = @\(\)/)[0] ? hits(tune, /\$steps = @\(\)/)[0].line : 600) + 80))}

<h2>10. Allowlist e Olhos de Deus</h2>
${pre("dashboard.js — chaves windows_tuning*", dash.split("\n").filter((l) => /windows_tuning/.test(l)).join("\n"))}
${pre("diag_olhos_deus.js — windowsTuning", olhos.split("\n").filter((l, i) => /TUNE_|windowsTuning|windows_tuning/.test(l)).map((l, idx, arr) => l).join("\n"))}

<h2>11. winTuningMaster.ps1 integral numerado</h2>
${pre(loaded[0].abs + " INTEGRAL", loaded[0].numbered, "bytes=" + String(loaded[0].hash.bytes || "") + " sha256=" + (loaded[0].hash.sha256 || ""))}

<p class="meta">Fim. ${esc(TAG)} · se o Windows recusar uma chave na MAE, o JSONL diz qual, o valor antigo, o pedido e o erro. Ajuste em cima disso — nao no escuro.</p>
</body></html>`;

  fs.mkdirSync(OUT, { recursive: true });
  try { fs.mkdirSync(CT, { recursive: true }); } catch {}
  const htmlPath = path.join(OUT, TAG + ".html");
  const pdfPath = path.join(OUT, TAG + ".pdf");
  fs.writeFileSync(htmlPath, html, "utf8");
  console.log("HTML", htmlPath, fs.statSync(htmlPath).size);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"]
  });
  try {
    const page = await browser.newPage();
    await page.goto("file:///" + htmlPath.replace(/\\/g, "/"), { waitUntil: "load", timeout: 180000 });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:8px;width:100%;padding:0 12mm;color:#444;">Tuning host Windows + adendo registro — 2026-09-03 — dossie auditoria</div>`,
      footerTemplate: `<div style="font-size:8px;width:100%;padding:0 12mm;color:#444;display:flex;justify-content:space-between;"><span>feito vs nao feito</span><span><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`,
      margin: { top: "16mm", bottom: "16mm", left: "10mm", right: "10mm" },
      timeout: 600000
    });
  } finally {
    await browser.close();
  }
  try { fs.copyFileSync(pdfPath, path.join(CT, path.basename(pdfPath))); } catch (e) { console.warn("copy pdf ct", e.message); }
  try { fs.copyFileSync(htmlPath, path.join(CT, path.basename(htmlPath))); } catch (e) { console.warn("copy html ct", e.message); }
  console.log("PDF", pdfPath, fs.statSync(pdfPath).size);
  if (verify.status !== 0) process.exitCode = 1;
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
