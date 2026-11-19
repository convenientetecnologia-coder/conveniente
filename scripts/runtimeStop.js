'use strict';

// Cadastro não pode aguardar indefinidamente um runtime ainda em inicialização.
// Se o prazo acabar, falha antes de injetar cookies. Um runner tardio é parado.
async function stopForConfigure(candidates, timeoutMs = 10000) {
  let timer;
  const work = Promise.all([...new Set(candidates.filter(Boolean))].map(async candidate => {
    const runtime = await candidate;
    if (runtime && typeof runtime.stop === 'function') await runtime.stop();
  }));
  try {
    await Promise.race([
      work,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('configure_virtus_stop_timeout')), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { stopForConfigure };
