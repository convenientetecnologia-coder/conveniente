// scripts/generateVeiculoTitulos.js
// Gera/atualiza arquivos em dados/veiculos/*.json com títulos de veículos.
// Padrão compatível com o uso em scripts/robeVeiculos.js: arquivo = `${modeloKey.toLowerCase()}.json`
//
// Uso:
//   node scripts/generateVeiculoTitulos.js
//
// Observação: por padrão, NÃO sobrescreve arquivos já existentes (ex.: corolla.json/gol.json/kwid.json).
// Para sobrescrever também os existentes:
//   OVERWRITE=1 node scripts/generateVeiculoTitulos.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dados', 'veiculos');

const OVERWRITE = process.env.OVERWRITE === '1';

function writeJsonPretty(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = String(s || '').trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function titleCaseWordsKeepBranding(s) {
  // Mantém o input como o usuário forneceu (ex.: "HR-V", "HB20S", "Up!", "C3")
  return String(s || '').trim();
}

function buildTitles({ brand, model }) {
  const M = titleCaseWordsKeepBranding(model);
  const BM = brand ? `${brand} ${M}` : M;

  // Frases base (mesma pegada dos existentes: oferta, condição, financiamento, documentação, revisões, conforto, etc.)
  const introsWithBrand = [
    `${BM} Oferta Especial Imperdível`,
    `${BM} com Condição Exclusiva Hoje`,
    `${BM} Disponível para Retirar Já`,
    `${BM} com Financiamento Facilitado`,
    `${BM} com Garantia e Procedência`,
    `${BM} com Revisões em Dia`,
    `${BM} com Documentação Liberada`,
    `${BM} com Aprovação Fácil`,
    `${BM} com Visual Moderno`,
    `${BM} com Tecnologia Atual`,
    `${BM} com Conectividade Bluetooth`,
    `${BM} com Multimídia e Conectividade`,
    `${BM} com Ar Gelado e Conforto`,
    `${BM} com Direção Suave`,
    `${BM} com Baixo Custo de Manutenção`,
    `${BM} com Ótimo Custo-Benefício`,
  ];

  const introsModelOnly = [
    `${M} Oferta Especial Hoje`,
    `${M} com Condição Especial`,
    `${M} Pronto para Retirar Hoje`,
    `${M} com Financiamento Imediato`,
    `${M} com Documentação OK`,
    `${M} com Revisões Atualizadas`,
    `${M} com Ar e Conforto`,
    `${M} com Direção Leve`,
    `${M} Econômico e Completo`,
    `${M} com Conectividade e Multimídia`,
    `${M} Ideal para o Dia a Dia`,
    `${M} Perfeito para Família`,
    `${M} Perfeito para Viagens`,
    `${M} Excelente para Cidade`,
    `${M} com Seguro Acessível`,
    `${M} com Espaço Interno Confortável`,
  ];

  const suffixes = [
    'Preço Abaixo da Média',
    'Preço Imbatível',
    'Oferta Limitada Hoje',
    'Pronta Entrega',
    'Baixa Km e Procedência',
    'Documentação Pronta',
    'Revisões em Dia',
    'Conforto e Economia',
    'Conectividade Completa',
    'Pacote Completo',
    'Itens Essenciais Completos',
    'Volante Multifuncional',
    'Sensor de Estacionamento',
    'Assistente de Partida em Rampa',
    'Controle de Estabilidade',
    'Som Integrado',
    'Excelente Acabamento',
    'Cabine Confortável',
    'Espaço para Bagagens',
    'Pronto para Rodar',
  ];

  const mids = [
    'com',
    'para',
    'ideal para',
    'perfeito para',
  ];

  const focuses = [
    'Família',
    'Trabalho',
    'Aplicativos',
    'Cidade',
    'Viagens',
    'Quem Busca Qualidade',
    'Primeiro Carro',
    'Baixo Consumo',
    'Conforto Premium',
    'Uso Urbano',
  ];

  const titles = [];

  // 1) Base (como nos arquivos existentes)
  titles.push(...introsWithBrand);
  titles.push(...introsModelOnly);

  // 2) Combinações ricas
  for (const sfx of suffixes) {
    titles.push(`${BM} ${sfx}`);
    titles.push(`${M} ${sfx}`);
  }

  for (const focus of focuses) {
    for (const mid of mids) {
      titles.push(`${BM} ${mid} ${focus}`);
      titles.push(`${M} ${mid} ${focus}`);
    }
  }

  // 3) Ajustes finais para ficar no mesmo “tom” dos modelos existentes
  titles.push(
    `${BM} com Condição Facilitada`,
    `${M} com Condição Facilitada`,
    `${BM} com Procedência Garantida`,
    `${M} com Procedência Garantida`,
    `${BM} com Conforto e Segurança`,
    `${M} com Conforto e Segurança`
  );

  const out = uniq(titles);

  // Limita para não explodir o tamanho, mas mantém bastante opções (padrão ~50 nos atuais).
  // Preferência: primeiro as frases mais “humanas” (já montadas), depois combinações.
  const MAX = 60;
  return out.slice(0, MAX);
}

// Lista do usuário (modelos) + marcas correspondentes
const MODELS = [
  { model: '208', brand: 'Peugeot' },
  { model: 'Argo', brand: 'Fiat' },
  { model: 'C3', brand: 'Citroën' },
  { model: 'Celta', brand: 'Chevrolet' },
  { model: 'City', brand: 'Honda' },
  { model: 'Civic', brand: 'Honda' },
  { model: 'Classic', brand: 'Chevrolet' },
  { model: 'Compass', brand: 'Jeep' },
  { model: 'Corolla', brand: 'Toyota' },
  { model: 'Corolla Cross', brand: 'Toyota' },
  { model: 'Creta', brand: 'Hyundai' },
  { model: 'Cronos', brand: 'Fiat' },
  { model: 'Duster', brand: 'Renault' },
  { model: 'Etios', brand: 'Toyota' },
  { model: 'Fiesta', brand: 'Ford' },
  { model: 'Fit', brand: 'Honda' },
  { model: 'Fox', brand: 'Volkswagen' },
  { model: 'Gol', brand: 'Volkswagen' },
  { model: 'HB20', brand: 'Hyundai' },
  { model: 'HB20S', brand: 'Hyundai' },
  { model: 'Hilux', brand: 'Toyota' },
  { model: 'HR-V', brand: 'Honda' },
  { model: 'Ka', brand: 'Ford' },
  { model: 'Kicks', brand: 'Nissan' },
  { model: 'Kwid', brand: 'Renault' },
  { model: 'L200 Triton', brand: 'Mitsubishi' },
  { model: 'Logan', brand: 'Renault' },
  { model: 'March', brand: 'Nissan' },
  { model: 'Mobi', brand: 'Fiat' },
  { model: 'Montana', brand: 'Chevrolet' },
  { model: 'Nivus', brand: 'Volkswagen' },
  { model: 'Onix', brand: 'Chevrolet' },
  { model: 'Palio', brand: 'Fiat' },
  { model: 'Polo', brand: 'Volkswagen' },
  { model: 'Ranger', brand: 'Ford' },
  { model: 'Renegade', brand: 'Jeep' },
  { model: 'S10', brand: 'Chevrolet' },
  { model: 'Sandero', brand: 'Renault' },
  { model: 'Saveiro', brand: 'Volkswagen' },
  { model: 'Siena', brand: 'Fiat' },
  { model: 'Spin', brand: 'Chevrolet' },
  { model: 'Sportage', brand: 'Kia' },
  { model: 'Strada', brand: 'Fiat' },
  { model: 'Toro', brand: 'Fiat' },
  { model: 'Tracker', brand: 'Chevrolet' },
  { model: 'Uno', brand: 'Fiat' },
  { model: 'Up!', brand: 'Volkswagen' },
  { model: 'Virtus', brand: 'Volkswagen' },
  { model: 'Yaris', brand: 'Toyota' },
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let created = 0;
  let skipped = 0;
  let updated = 0;

  for (const { brand, model } of MODELS) {
    const fileName = `${String(model).toLowerCase()}.json`;
    const outFile = path.join(OUT_DIR, fileName);
    const exists = fs.existsSync(outFile);

    if (exists && !OVERWRITE) {
      skipped++;
      continue;
    }

    const titles = buildTitles({ brand, model });
    writeJsonPretty(outFile, titles);
    if (exists) updated++;
    else created++;
  }

  const files = fs.readdirSync(OUT_DIR).filter(f => f.toLowerCase().endsWith('.json'));
  console.log(`[generateVeiculoTitulos] done. created=${created} updated=${updated} skipped=${skipped} total_files_in_dir=${files.length}`);
}

if (require.main === module) {
  main();
}


