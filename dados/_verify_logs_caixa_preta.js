"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const core = require("../scripts/logsFetchCore.js");

let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log("OK  " + name);
  else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

const dashSrc = fs.readFileSync(path.join(root, "scripts", "dashboard.js"), "utf8");
const lifeSrc = fs.readFileSync(path.join(root, "scripts", "indexLifecycle.js"), "utf8");
const ctSrc = fs.readFileSync("C:/sitechatbot/index.js", "utf8");

check("src_core_exists", fs.existsSync(path.join(root, "scripts", "logsFetchCore.js")));
check("src_life_append_pulse", lifeSrc.includes("function appendPulse") && lifeSrc.includes("append: appendPulse"));
check("src_life_no_pulse_in_append_life", !/appendTo\(LIFE_PATH[\s\S]{0,80}handle_pulse/.test(lifeSrc));
check("src_life_prev_path", lifeSrc.includes("index_lifecycle.prev.jsonl") && lifeSrc.includes("index_handle_pulse.jsonl"));
check("src_life_archive", lifeSrc.includes("archiveBeforeOverwrite") && lifeSrc.includes("KEEP_ARCH"));
check("src_dash_allow_prev", dashSrc.includes("index_lifecycle_prev") && dashSrc.includes("index_handle_pulse"));
check("src_dash_timeout_45s", dashSrc.includes("INGEST_TIMEOUT_MS") && !/setTimeout\(\(\) => \{ try \{ controller\.abort\(\); \} catch \{\} \}, 8000\)/.test(dashSrc));
check("src_dash_slice", dashSrc.includes("sliceLogFile") && dashSrc.includes("fromStart") && dashSrc.includes("byteOffset"));
check("src_dash_packets", dashSrc.includes("buildIngestPackets") && dashSrc.includes("postLogsIngestOnce"));
check("src_ct_merge", ctSrc.includes("mergeLogIngestItems") && ctSrc.includes("parseLogsFetchRequestBody"));
check("src_ct_keys_16", ctSrc.includes("if (keys.length > 16)"));
check("src_ct_ingest_no_slice12", !/items\.slice\(0, 12\)\.map\(it => \(\{[\s\S]{0,120}key: String\(it\?\.key/.test(ctSrc));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caixa-preta-"));
process.env.CONVENIENTE_DADOS_DIR = tmp;
const lifeAbs = require.resolve("../scripts/indexLifecycle.js");
delete require.cache[lifeAbs];
const life = require("../scripts/indexLifecycle.js");

life.append("boot", { probe: 1 });
life.appendPulse("handle_pulse", { win32HandleCount: 9, uvHandleCount: 3 });
life.append("worker_drop_reap", { code: 3221226505 });

const lifeTxt = fs.existsSync(life.LIFE_PATH) ? fs.readFileSync(life.LIFE_PATH, "utf8") : "";
const pulseTxt = fs.existsSync(life.PULSE_PATH) ? fs.readFileSync(life.PULSE_PATH, "utf8") : "";
check("split_life_has_boot", /"event":"boot"/.test(lifeTxt));
check("split_life_has_drop", /"event":"worker_drop_reap"/.test(lifeTxt));
check("split_life_no_pulse", !/"event":"handle_pulse"/.test(lifeTxt));
check("split_pulse_has_pulse", /"event":"handle_pulse"/.test(pulseTxt));
check("split_pulse_no_boot", !/"event":"boot"/.test(pulseTxt));

const fat = path.join(tmp, "fat.jsonl");
const lines = [];
for (let i = 0; i < 80; i += 1) lines.push(JSON.stringify({ i, pad: "x".repeat(200) }));
fs.writeFileSync(fat, lines.join("\n") + "\n", "utf8");
const fatSize = fs.statSync(fat).size;
const page1 = core.sliceLogFile(fat, { fromStart: true, byteOffset: 0, maxBytes: 4000, maxLines: 8000 });
const page2 = core.sliceLogFile(fat, { fromStart: true, byteOffset: page1.nextByte, maxBytes: 4000, maxLines: 8000 });
const rebuilt = [page1.text, page2.text].filter(Boolean).join("\n");
check("slice_page1_ok", page1.ok === true && page1.fromStart === true && page1.startByte === 0);
check("slice_has_cursor", Number.isFinite(page1.nextByte) && page1.fileBytes === fatSize);
check("slice_page2_continues", page2.ok === true && page2.startByte === page1.nextByte);
check("slice_rebuilt_has_rows", rebuilt.includes('"i":0') && rebuilt.includes('"i":79'));

const chunks = core.chunkTextByLines("a\n" + "b".repeat(20_000) + "\n" + "c".repeat(20), 8_000);
check("chunk_splits_long_line", chunks.length >= 3);
check("chunk_keeps_short", chunks[0] === "a");

const merged = core.mergeIngestItems(
  [{ key: "git_main_ref", ok: true, text: "abc", bytes: 3, lines: 1 }],
  [{ key: "index_lifecycle", ok: true, text: "L1", bytes: 2, lines: 1, chunkIndex: 0, chunkTotal: 2 }]
);
const merged2 = core.mergeIngestItems(merged, [
  { key: "index_lifecycle", ok: true, text: "L2", bytes: 2, lines: 1, chunkIndex: 1, chunkTotal: 2 }
]);
const git = merged2.find((x) => x.key === "git_main_ref");
const lc = merged2.find((x) => x.key === "index_lifecycle");
check("merge_keeps_small_key", git && git.text === "abc");
check("merge_appends_chunks", lc && lc.text === "L1\nL2" && lc.chunksReceived === 2);

const packets = core.buildIngestPackets([
  { key: "git_main_ref", ok: true, text: "deadbeef", bytes: 8, lines: 1 },
  { key: "index_lifecycle", ok: true, text: "Z".repeat(400_000), bytes: 400_000, lines: 1 }
]);
check("packets_small_first_or_alone", packets.length >= 2);
check("packets_chunk_lifecycle", packets.some((p) => p[0] && p[0].key === "index_lifecycle" && Number(p[0].chunkTotal) >= 2));

fs.writeFileSync(life.LIFE_PATH, "L".repeat(life.MAX_LIFE_BYTES + 100), "utf8");
life.append("boot", { afterRotate: true });
check("rotate_writes_prev", fs.existsSync(life.LIFE_PREV_PATH));
check("rotate_current_has_boot", fs.existsSync(life.LIFE_PATH) && fs.readFileSync(life.LIFE_PATH, "utf8").includes("afterRotate"));
const archDir = path.join(tmp, "logs");
const archs = fs.existsSync(archDir)
  ? fs.readdirSync(archDir).filter((n) => /^index_lifecycle\.\d{8}-\d{6}\.jsonl$/.test(n))
  : [];
check("rotate_archive_optional_or_prev", fs.existsSync(life.LIFE_PREV_PATH) || archs.length >= 1);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

if (failed) {
  console.log("FAIL_COUNT " + failed);
  process.exit(1);
}
console.log("ALL_OK");
