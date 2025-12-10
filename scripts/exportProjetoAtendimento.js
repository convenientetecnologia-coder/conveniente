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

// Arquivos específicos do atendimento
const ATENDIMENTO_FILES = [
  "index.js",
  "scripts/api_perfis.js",
  "scripts/api_issues.js",
  "scripts/browser.js",
  "scripts/chatLock.js",
  "scripts/chatStore.js",
  "scripts/inteligenciaArtificial.js",
  "scripts/issues.js",
  "scripts/logger.js",
  "scripts/manifestStore.js",
  "scripts/promptFretes.js",
  "scripts/stepLog.js",
  "scripts/utils.js",
  "scripts/virtus.js",
  "scripts/worker.js",
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

