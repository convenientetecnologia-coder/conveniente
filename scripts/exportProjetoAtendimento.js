// scripts/exportProjetoAtendimento.js
//
// Gera o arquivo "projeto atendimento.txt" na raiz, contendo apenas os arquivos
// relacionados ao sistema de atendimento/Virtus:
// - virtus.js, virtusFSM.js, promptFretes.js, inteligenciaArtificial.js, iaExtractors.js
// - ia_extractor/*, ia_json/*, ia_scripts/*
//
// Isso é pensado para trabalhar apenas com a parte de atendimento, sem o resto do projeto.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_FILE = path.join(ROOT, "projeto atendimento.txt");

// Arquivos específicos do atendimento
const ATENDIMENTO_FILES = [
  "scripts/virtus.js",
  "scripts/virtusFSM.js",
  "scripts/promptFretes.js",
  "scripts/inteligenciaArtificial.js",
  "scripts/iaExtractors.js",
  "scripts/missing.js",
  "scripts/fsmFlow.js"
];

// Diretórios específicos do atendimento
const ATENDIMENTO_DIRS = [
  "scripts/ia_extractor",
  "scripts/ia_json",
  "scripts/ia_scripts"
];

function walkFiles(baseDir, relDir = "") {
  const result = [];
  const dirPath = path.join(baseDir, relDir);
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const ent of entries) {
    const relPath = path.join(relDir, ent.name);
    if (ent.isDirectory()) {
      result.push(...walkFiles(baseDir, relPath));
    } else if (ent.isFile()) {
      result.push(relPath.replace(/\\/g, "/"));
    }
  }
  return result;
}

function collectFileList() {
  const files = [];
  
  // Adiciona arquivos específicos
  for (const file of ATENDIMENTO_FILES) {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) {
      files.push(file.replace(/\\/g, "/"));
    }
  }
  
  // Adiciona arquivos dos diretórios
  for (const dir of ATENDIMENTO_DIRS) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) {
      files.push(...walkFiles(full).map(f => path.join(dir, f).replace(/\\/g, "/")));
    }
  }
  
  // Ordena por caminho para ficar determinístico
  files.sort();
  return files;
}

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
  const files = collectFileList();
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

