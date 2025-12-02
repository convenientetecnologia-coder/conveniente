// scripts/exportProjetoCompleto.js
//
// Gera o arquivo "projeto completo.txt" na raiz, contendo os principais
// arquivos do projeto (index.js, public/, scripts/), concatenados em um
// formato simples:
//
// ==== FILE: caminho/arquivo ====
// <conteúdo>
//
// Isso é pensado para ser enviado a outro modelo (ex.: GPT-5) para auditoria.
//

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_FILE = path.join(ROOT, "projeto completo.txt");

// Diretórios/arquivos que queremos incluir na exportação
const INCLUDE_PATHS = [
  "index.js",
  "public",
  "scripts",
];

// Pastas a ignorar durante o walk
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".idea",
  ".vscode",
]);

// Arquivos a ignorar (próprio arquivo de saída, instaladores, etc.)
const IGNORE_FILES = new Set([
  "projeto completo.txt",
  "PainelConta.bat",
  "instalar_conveniente.ps1",
  "bibliotecas.txt",
  "package-lock.json",
]);

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
      if (IGNORE_DIRS.has(ent.name)) continue;
      result.push(...walkFiles(baseDir, relPath));
    } else if (ent.isFile()) {
      if (IGNORE_FILES.has(ent.name)) continue;
      result.push(relPath.replace(/\\/g, "/"));
    }
  }
  return result;
}

function collectFileList() {
  const files = [];
  for (const p of INCLUDE_PATHS) {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isFile()) {
      if (!IGNORE_FILES.has(path.basename(p))) {
        files.push(p.replace(/\\/g, "/"));
      }
    } else if (stat.isDirectory()) {
      files.push(...walkFiles(full).map(f => path.join(p, f).replace(/\\/g, "/")));
    }
  }
  // Ordena por caminho para ficar determinístico
  files.sort();
  return files;
}

/**
 * Remove comentários e linhas totalmente vazias em modo "somente export",
 * SEM alterar a ordem das linhas de código reais.
 *
 * - Para .js/.mjs/.cjs: remove blocos /* ... *\/ e linhas que são apenas // comentário.
 * - Para .html/.htm: remove <!-- ... --> e linhas vazias extras.
 * - Para outros tipos, retorna o conteúdo original.
 *
 * OBS: isso NÃO modifica os arquivos reais, apenas o texto escrito no
 * "projeto completo.txt", preservando 100% a lógica do sistema em disco.
 */
function stripCommentsForExport(relPath, content) {
  const ext = path.extname(relPath).toLowerCase();

  // Helpers para colapsar múltiplas linhas em branco
  const collapseBlankLines = (lines) => {
    const out = [];
    let lastBlank = false;
    for (const line of lines) {
      const blank = line.trim().length === 0;
      if (blank && lastBlank) continue; // evita duas ou mais em sequência
      out.push(line);
      lastBlank = blank;
    }
    return out;
  };

  // JS / Node
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    let txt = content.replace(/\r\n/g, "\n");

    // Remove blocos /* ... */ de forma ampla (comentários de instrução grandes).
    // Mantém o restante da linha onde o bloco estava para não bagunçar estrutura.
    txt = txt.replace(/\/\*[\s\S]*?\*\//g, "");

    const lines = txt.split("\n");
    const cleaned = [];
    for (const line of lines) {
      // Remove linhas que são apenas comentários de linha // ...
      if (/^\s*\/\/.*$/.test(line)) continue;
      cleaned.push(line);
    }
    return collapseBlankLines(cleaned).join("\n");
  }

  // HTML
  if (ext === ".html" || ext === ".htm") {
    let txt = content.replace(/\r\n/g, "\n");
    // Remove comentários HTML <!-- ... -->
    txt = txt.replace(/<!--[\s\S]*?-->/g, "");
    const lines = txt.split("\n");
    return collapseBlankLines(lines).join("\n");
  }

  // Outros tipos: retorna como está
  return content.replace(/\r\n/g, "\n");
}

function main() {
  const files = collectFileList();
  // Remove arquivos JSON de ia_json da lista inicial (serão adicionados no final)
  const filesFiltered = files.filter(f => !f.startsWith("scripts/ia_json/"));
  let out = "";

  for (const rel of filesFiltered) {
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

  // Adiciona arquivos JSON da pasta ia_json no final
  const iaJsonDir = path.join(ROOT, "scripts", "ia_json");
  if (fs.existsSync(iaJsonDir)) {
    try {
      const jsonFiles = fs.readdirSync(iaJsonDir)
        .filter(f => f.endsWith(".json"))
        .sort();
      
      for (const jsonFile of jsonFiles) {
        const jsonPath = path.join(iaJsonDir, jsonFile);
        const relPath = `scripts/ia_json/${jsonFile}`;
        let content = "";
        try {
          content = fs.readFileSync(jsonPath, "utf8");
        } catch (e) {
          content = `// ERRO AO LER ${relPath}: ${e && e.message || String(e)}`;
        }
        out += `==== FILE: ${relPath} ====\n`;
        out += content;
        if (!out.endsWith("\n")) out += "\n";
        out += "\n";
      }
    } catch (e) {
      out += `// ERRO AO PROCESSAR ia_json: ${e && e.message || String(e)}\n\n`;
    }
  }

  fs.writeFileSync(OUT_FILE, out, "utf8");
  // Log simples no console para facilitar debug quando rodar manualmente
  // (não afeta o servidor, é apenas uma ferramenta auxiliar)
  const totalFiles = filesFiltered.length + (fs.existsSync(iaJsonDir) ? fs.readdirSync(iaJsonDir).filter(f => f.endsWith(".json")).length : 0);
  console.log(`[exportProjetoCompleto] Gerado ${OUT_FILE} com ${totalFiles} arquivos.`);
}

if (require.main === module) {
  main();
}


