// scripts/exportProjetoAtendimento.js
//
// Gera o arquivo "projeto atendimento.txt" na raiz, contendo apenas os arquivos
// relacionados ao sistema de atendimento/Virtus:
// - virtus.js, promptFretes.js, iaExtractors.js, inteligenciaArtificial.js
// 
// Isso é pensado para trabalhar apenas com a parte de atendimento, sem o resto do projeto.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_FILE = path.join(ROOT, "projeto atendimento.txt");

// Arquivos específicos do atendimento - Virtus V2 + Core
const ATENDIMENTO_FILES = [
  // Core - Inicialização e orquestração
  "index.js",
  "scripts/worker.js",
  
  // Virtus V2 - Arquitetura em estágios separados
  "scripts/virtusCollector.js",      // Estágio 1: Coleta de mensagens do DOM
  "scripts/virtusMessenger.js",       // Interface com Messenger (abrir chats, navegação)
  "scripts/virtusLLMWorker.js",       // Estágio 2: Processamento LLM (processo separado)
  "scripts/virtusSender.js",          // Estágio 3: Envio de respostas
  "scripts/virtusDiskQueue.js",       // Fila em disco (persistência)
  "scripts/virtusV2Paths.js",         // Caminhos do sistema V2
  "scripts/virtusIds.js",             // Utilitários de IDs/hashes
  
  // Virtus Legacy (para referência/comparação)
  "scripts/virtus_legacy.js",
  
  // Browser e controle de navegação
  "scripts/browser.js",
  
  // Inteligência Artificial e prompts
  "scripts/inteligenciaArtificial.js",
  "scripts/promptFretes.js",
  
  // Concorrência e locks
  "scripts/chatLock.js",
  
  // Logging e observabilidade
  "scripts/logger.js",
  "scripts/stepLog.js",
  
  // Infraestrutura e suporte
  "scripts/issues.js",                // Sistema de issues
  "scripts/utils.js",                 // Utilitários gerais
  "scripts/api_issues.js",            // API de issues
  "scripts/api_perfis.js",            // API de perfis
  "scripts/manifestStore.js",         // Armazenamento de manifestos
  "scripts/fileStore.js",             // Armazenamento de arquivos
];

/**
 * Remove comentários e linhas totalmente vazias em modo "somente export",
 * SEM alterar a ordem das linhas de código reais.
 */
function stripCommentsForExport(relPath, content) {
  const ext = path.extname(relPath).toLowerCase();

  const collapseBlankLines = (lines) => {
    const out = [];
    let lastBlank = false;
    for (const line of lines) {
      const blank = line.trim().length === 0;
      if (blank && lastBlank) continue;
      out.push(line);
      lastBlank = blank;
    }
    return out;
  };

  // JS / Node
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    let txt = content.replace(/\r\n/g, "\n");
    txt = txt.replace(/\/\*[\s\S]*?\*\//g, "");
    const lines = txt.split("\n");
    const cleaned = [];
    for (const line of lines) {
      if (/^\s*\/\/.*$/.test(line)) continue;
      cleaned.push(line);
    }
    return collapseBlankLines(cleaned).join("\n");
  }

  // HTML
  if (ext === ".html" || ext === ".htm") {
    let txt = content.replace(/\r\n/g, "\n");
    txt = txt.replace(/<!--[\s\S]*?-->/g, "");
    const lines = txt.split("\n");
    return collapseBlankLines(lines).join("\n");
  }

  // Outros tipos: retorna como está
  return content.replace(/\r\n/g, "\n");
}

function main() {
  const files = ATENDIMENTO_FILES.filter(f => {
    const full = path.join(ROOT, f);
    return fs.existsSync(full);
  });
  
  let out = "";

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    let content = "";
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch (e) {
      content = `// ERRO AO LER ${rel}: ${e && e.message || String(e)}`;
    }
    // Aplica modo "enxuto" apenas para o arquivo de exportação
    const trimmed = stripCommentsForExport(rel, content);
    out += `==== FILE: ${rel} ====\n`;
    out += trimmed;
    if (!out.endsWith("\n")) out += "\n";
    out += "\n";
  }

  fs.writeFileSync(OUT_FILE, out, "utf8");
  console.log(`[exportProjetoAtendimento] Gerado ${OUT_FILE} com ${files.length} arquivos.`);
}

if (require.main === module) {
  main();
}

module.exports = { main };

