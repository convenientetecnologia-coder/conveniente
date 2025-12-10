'use strict';
const fs = require('fs');
const path = require('path');

// Diretório base de chats do perfil
function chatDir(perfil){
  return path.join(__dirname, '..', 'dados', 'perfis', perfil, 'chats');
}

// Garante que o diretório existe
function ensureDir(p){
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

// Lê JSON com fallback
function readJsonSafe(file, fb){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; }
}

// Salva JSON de modo atômico (ideal para concorrência e crash-safe)
function writeJsonAtomic(file, obj){
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try{
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.unlinkSync(file); } catch {}
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
}

// Caminho para o JSON de um chat específico
function getChatPath(perfil, chatId){
  return path.join(chatDir(perfil), `${chatId}.json`);
}

// Carrega o estado de um chat (ou null se não existe)
function loadChat(perfil, chatId){
  return readJsonSafe(getChatPath(perfil, chatId), null);
}

// Salva o estado de um chat (atualiza updatedAt)
function saveChat(perfil, chatId, state){
  state.updatedAt = Date.now();
  writeJsonAtomic(getChatPath(perfil, chatId), state);
  return state;
}

// Adiciona uma entrada de log incremental ao JSON do chat
function appendLog(perfil, chatId, entry){
  const p = getChatPath(perfil, chatId);
  const st = readJsonSafe(p, null) || {};
  st.logs = st.logs || [];
  st.logs.push({ ts: Date.now(), ...entry });
  writeJsonAtomic(p, st);
}

// Lista todos os chats ativos do perfil (lendo todos os arquivos JSON)
function listChats(perfil){
  const dir = chatDir(perfil);
  ensureDir(dir);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files){
    const st = readJsonSafe(path.join(dir, f), null);
    if (st) out.push(st);
  }
  return out;
}

module.exports = { loadChat, saveChat, appendLog, listChats, getChatPath };