"use strict";

/**
 * Transporte da caixa-preta: fatia de arquivo, lote de ingest e merge no CT.
 * Um POST grande nao pode matar o lote; um chunk nao pode apagar o item anterior.
 */

const fs = require("fs");

const INGEST_TIMEOUT_MS = 45_000;
const INGEST_CHUNK_CHARS = 350_000;
const INGEST_ONE_SHOT_CHARS = 500_000;
const SLICE_MAX_BYTES = 2_000_000;
const SLICE_MIN_BYTES = 20_000;
const DEFAULT_SLICE_BYTES = 1_200_000;
const FETCH_KEYS_MAX = 16;
const INGEST_ITEMS_MAX = 40;
const INGEST_STORE_MAX = 80;

function clampMaxBytes(n) {
  const x = Number(n || DEFAULT_SLICE_BYTES) || DEFAULT_SLICE_BYTES;
  return Math.max(SLICE_MIN_BYTES, Math.min(SLICE_MAX_BYTES, x));
}

function dropPartialFirstLine(txt, startByte) {
  if (!txt || !startByte) return txt;
  const i = String(txt).indexOf("\n");
  if (i < 0) return String(txt);
  return String(txt).slice(i + 1);
}

function sliceLogFile(filePath, opts) {
  const maxLines = Math.max(1, Math.min(50_000, Number(opts && opts.maxLines || 2000) || 2000));
  const maxBytes = clampMaxBytes(opts && opts.maxBytes);
  const fromStart = !!(opts && opts.fromStart);
  const byteOffsetRaw = opts && opts.byteOffset;
  const byteOffset = Number.isFinite(Number(byteOffsetRaw)) && Number(byteOffsetRaw) >= 0
    ? Math.floor(Number(byteOffsetRaw))
    : null;
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: "not_found", filePath: filePath || null };
    }
    const st = fs.statSync(filePath);
    const size = Number(st.size || 0) || 0;
    let start = 0;
    let readBytes = 0;
    if (fromStart) {
      start = Math.min(size, byteOffset == null ? 0 : byteOffset);
      readBytes = Math.min(maxBytes, Math.max(0, size - start));
    } else {
      readBytes = Math.min(maxBytes, size);
      start = Math.max(0, size - readBytes);
    }
    const buf = Buffer.alloc(readBytes);
    if (readBytes > 0) {
      const fd = fs.openSync(filePath, "r");
      try { fs.readSync(fd, buf, 0, readBytes, start); }
      finally { try { fs.closeSync(fd); } catch {} }
    }
    let txt = buf.toString("utf8");
    txt = dropPartialFirstLine(txt, start);
    const lines = txt.split(/\r?\n/);
    let tail = lines;
    let lineCapped = false;
    if (!fromStart && lines.length > maxLines) {
      tail = lines.slice(lines.length - maxLines);
      lineCapped = true;
    }
    const text = tail.join("\n");
    const endByte = start + readBytes;
    const eof = endByte >= size;
    return {
      ok: true,
      filePath,
      bytes: Buffer.byteLength(text, "utf8"),
      lines: tail.length,
      truncated: !eof || lineCapped || start > 0,
      text,
      fileBytes: size,
      startByte: start,
      endByte,
      nextByte: eof ? size : endByte,
      eof,
      fromStart,
      lineCapped
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), filePath };
  }
}

function tailFileLines(filePath, maxLines, maxBytes) {
  return sliceLogFile(filePath, {
    maxLines: maxLines == null ? 2000 : maxLines,
    maxBytes: maxBytes == null ? DEFAULT_SLICE_BYTES : maxBytes,
    fromStart: false
  });
}

function chunkTextByLines(text, maxChars) {
  const cap = Math.max(8_000, Number(maxChars || INGEST_CHUNK_CHARS) || INGEST_CHUNK_CHARS);
  const raw = text == null ? "" : String(text);
  if (raw.length <= cap) return raw ? [raw] : [""];
  const lines = raw.split(/\r?\n/);
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  for (const line of lines) {
    if (line.length > cap) {
      flush();
      for (let i = 0; i < line.length; i += cap) out.push(line.slice(i, i + cap));
      continue;
    }
    const next = buf ? buf + "\n" + line : line;
    if (buf && next.length > cap) {
      flush();
      buf = line;
    } else {
      buf = next;
    }
  }
  flush();
  return out.length ? out : [""];
}

function normalizeIngestItem(it) {
  const row = {
    key: String((it && it.key) || ""),
    ok: !!(it && it.ok),
    error: it && it.error ? String(it.error) : null,
    filePath: it && it.filePath ? String(it.filePath) : null,
    bytes: Number((it && it.bytes) || 0) || 0,
    lines: Number((it && it.lines) || 0) || 0,
    truncated: !!(it && it.truncated),
    text: (it && typeof it.text === "string") ? it.text : null
  };
  const copyNum = (name) => {
    const n = Number(it && it[name]);
    row[name] = Number.isFinite(n) ? n : null;
  };
  copyNum("fileBytes");
  copyNum("startByte");
  copyNum("endByte");
  copyNum("nextByte");
  copyNum("chunkIndex");
  copyNum("chunkTotal");
  copyNum("chunksReceived");
  if (it && it.eof != null) row.eof = !!it.eof;
  if (it && it.fromStart != null) row.fromStart = !!it.fromStart;
  if (it && it.lineCapped != null) row.lineCapped = !!it.lineCapped;
  return row;
}

function mergeIngestItems(prevItems, incomingItems) {
  const map = new Map();
  const prev = Array.isArray(prevItems) ? prevItems : [];
  const incoming = Array.isArray(incomingItems) ? incomingItems : [];
  for (const it of prev) {
    const row = normalizeIngestItem(it);
    if (!row.key) continue;
    map.set(row.key, row);
  }
  for (const raw of incoming) {
    const it = normalizeIngestItem(raw);
    if (!it.key) continue;
    const isChunk = Number.isFinite(it.chunkIndex) || (raw && raw.merge === true);
    const old = map.get(it.key);
    if (
      old &&
      isChunk &&
      old.ok &&
      it.ok &&
      typeof old.text === "string" &&
      typeof it.text === "string"
    ) {
      const join = (old.text && it.text) ? "\n" : "";
      old.text = old.text + join + it.text;
      old.bytes = (Number(old.bytes || 0) || 0) + (Number(it.bytes || 0) || 0);
      old.lines = (Number(old.lines || 0) || 0) + (Number(it.lines || 0) || 0);
      old.chunksReceived = (Number(old.chunksReceived || 1) || 1) + 1;
      if (Number.isFinite(it.chunkTotal)) old.chunkTotal = it.chunkTotal;
      old.truncated = !!(old.truncated || it.truncated);
      if (it.fileBytes != null) old.fileBytes = it.fileBytes;
      if (it.nextByte != null) old.nextByte = it.nextByte;
      if (it.endByte != null) old.endByte = it.endByte;
      if (it.eof != null) old.eof = it.eof;
      map.set(it.key, old);
    } else {
      if (isChunk && it.chunksReceived == null) it.chunksReceived = 1;
      map.set(it.key, it);
    }
  }
  return Array.from(map.values()).slice(0, INGEST_STORE_MAX);
}

function buildIngestPackets(items) {
  const list = Array.isArray(items) ? items : [];
  const packets = [];
  const small = [];
  for (const it of list) {
    const text = it && typeof it.text === "string" ? it.text : "";
    if (text.length > INGEST_CHUNK_CHARS) {
      const chunks = chunkTextByLines(text, INGEST_CHUNK_CHARS);
      for (let i = 0; i < chunks.length; i += 1) {
        const part = chunks[i];
        packets.push([{
          ...it,
          text: part,
          lines: part.split(/\r?\n/).length,
          bytes: Buffer.byteLength(part, "utf8"),
          chunkIndex: i,
          chunkTotal: chunks.length,
          chunksReceived: 1
        }]);
      }
    } else {
      small.push(it);
    }
  }
  if (small.length) {
    const joinedLen = JSON.stringify(small).length;
    if (joinedLen <= INGEST_ONE_SHOT_CHARS) packets.unshift(small);
    else {
      for (const it of small) packets.push([it]);
    }
  }
  if (!packets.length) packets.push(list.slice(0, INGEST_ITEMS_MAX));
  return packets.map((p) => p.slice(0, INGEST_ITEMS_MAX));
}

module.exports = {
  INGEST_TIMEOUT_MS,
  INGEST_CHUNK_CHARS,
  INGEST_ONE_SHOT_CHARS,
  SLICE_MAX_BYTES,
  SLICE_MIN_BYTES,
  DEFAULT_SLICE_BYTES,
  FETCH_KEYS_MAX,
  INGEST_ITEMS_MAX,
  INGEST_STORE_MAX,
  clampMaxBytes,
  dropPartialFirstLine,
  sliceLogFile,
  tailFileLines,
  chunkTextByLines,
  normalizeIngestItem,
  mergeIngestItems,
  buildIngestPackets
};
