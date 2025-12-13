'use strict';

/**
 * Virtus V2 - Disk Queue Core
 * 
 * Módulo base para filas persistentes em disco com operações atômicas.
 * Garante que nenhuma operação de fila se perde em caso de crash.
 * 
 * Características:
 * - Write atômico (tmp -> rename)
 * - fsync obrigatório (garante persistência)
 * - Claim por rename (um worker por arquivo)
 * - Stale requeue (itens presos voltam para inbox)
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Garante que o diretório existe (cria recursivamente se necessário)
 */
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Lê JSON de forma segura (retorna fallback em caso de erro)
 */
async function readJsonSafe(file, fallback = null) {
  try {
    const content = await fsp.readFile(file, 'utf8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

/**
 * Escreve JSON de forma atômica com fsync obrigatório
 * 
 * Processo:
 * 1. Cria arquivo temporário único
 * 2. Escreve conteúdo com fsync
 * 3. Rename atômico para arquivo final
 * 
 * Garante que mesmo em crash, o arquivo antigo permanece íntegro.
 */
async function writeJsonAtomic(file, obj) {
  await ensureDir(path.dirname(file));
  
  // Arquivo temporário único por processo e timestamp
  const tmp = file + `.tmp.${process.pid}.${Date.now()}`;
  
  const fd = await fsp.open(tmp, 'w');
  try {
    const content = JSON.stringify(obj, null, 2);
    await fd.writeFile(content, 'utf8');
    await fd.sync();  // <<< fsync militar - força write no disco
  } finally {
    await fd.close();
  }
  
  try {
    // Rename atômico (mesmo filesystem)
    await fsp.rename(tmp, file);
  } catch {
    // Fallback: copy + delete (cross-filesystem)
    await fsp.copyFile(tmp, file);
    await fsp.unlink(tmp).catch(() => {});
  }
}

/**
 * Append em arquivo JSONL (JSON Lines) com fsync obrigatório
 * 
 * Formato: uma linha JSON por evento, append-only.
 * Usado para ledgers (rastreio imutável de eventos).
 */
async function appendJsonl(file, obj) {
  await ensureDir(path.dirname(file));
  
  const line = JSON.stringify({ ts: Date.now(), ...obj }) + '\n';
  
  const fd = await fsp.open(file, 'a');
  try {
    await fd.writeFile(line, 'utf8');
    await fd.sync();  // <<< fsync militar - força write no disco
  } finally {
    await fd.close();
  }
}

/**
 * Remove sufixo de claim de um nome de arquivo
 * 
 * Formato: <id>.json.claim-<pid>-<timestamp>
 * Retorna: <id>.json
 */
function stripClaimSuffix(name) {
  return String(name).replace(/\.claim-[^.]+$/, '');
}

/**
 * Faz claim atômico de um arquivo movendo-o para processing
 * 
 * Processo:
 * 1. Rename atômico para processing com sufixo único
 * 2. Retorna caminho do arquivo claimed
 * 
 * Garante que apenas um worker processa cada arquivo.
 */
async function claimFile(srcFile, processingDir) {
  await ensureDir(processingDir);
  
  const base = path.basename(srcFile);
  const claimed = base + `.claim-${process.pid}-${Date.now()}`;
  const dst = path.join(processingDir, claimed);
  
  // Rename atômico (move para processing)
  await fsp.rename(srcFile, dst);
  
  // CRÍTICO: em Windows, rename preserva mtime; sem isso requeueStale pode
  // re-enfileirar imediatamente backlog antigo como "stale".
  try {
    const now = new Date();
    await fsp.utimes(dst, now, now);
  } catch {}
  
  return dst;
}

/**
 * Move arquivo de forma segura (rename ou copy+delete)
 */
async function moveFile(src, dst) {
  await ensureDir(path.dirname(dst));
  
  try {
    // Tenta rename primeiro (mais rápido, atômico no mesmo FS)
    await fsp.rename(src, dst);
  } catch {
    // Fallback: copy + delete (cross-filesystem)
    await fsp.copyFile(src, dst);
    await fsp.unlink(src).catch(() => {});
  }
}

/**
 * Lista todos os arquivos JSON de um diretório (inclui .json.claim-*)
 */
async function listJsonFiles(dir) {
  let list = [];
  
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    list = entries;
  } catch {
    return [];
  }
  
  // Aceita arquivos .json e .json.claim-*
  const isJsonLike = (name) => /\.json(\.claim-[^.]+)?$/i.test(String(name || ''));
  
  return list
    .filter(ent => ent.isFile() && isJsonLike(ent.name))
    .map(ent => path.join(dir, ent.name));
}

/**
 * Requeue itens stale (presos em processing há muito tempo)
 * 
 * Processo:
 * 1. Lista arquivos em processing
 * 2. Verifica mtime (modification time)
 * 3. Se mais antigo que staleMs, move de volta para inbox
 * 
 * Isso previne deadlock quando um worker cai no meio do processamento.
 */
async function requeueStale(processingDir, inboxDir, staleMs) {
  let list = [];
  
  try {
    const entries = await fsp.readdir(processingDir, { withFileTypes: true });
    list = entries;
  } catch {
    return 0;
  }
  
  const now = Date.now();
  let moved = 0;
  
  for (const ent of list) {
    if (!ent.isFile()) continue;
    
    const fp = path.join(processingDir, ent.name);
    
    let st = null;
    try {
      st = await fsp.stat(fp);
    } catch {
      continue;
    }
    
    // Se arquivo foi modificado recentemente, não é stale
    if ((now - st.mtimeMs) < staleMs) continue;
    
    // Remove sufixo de claim e move de volta para inbox
    const orig = stripClaimSuffix(ent.name);
    const dst = path.join(inboxDir, orig);
    
    await moveFile(fp, dst).catch(() => {});
    moved++;
  }
  
  return moved;
}

module.exports = {
  ensureDir,
  readJsonSafe,
  writeJsonAtomic,
  appendJsonl,
  claimFile,
  moveFile,
  listJsonFiles,
  requeueStale,
  stripClaimSuffix
};

