// collector.js
module.exports = async function collectClientMessagesFromMessenger(page) {
  // Garante que está dentro de um chat thread aberto!
  return await page.evaluate(() => {
    function norm(s){ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); }

    function isNoise(txt) {
      const t = norm(txt);
      // Adicione mais regras aqui conforme encontrar ruído
      return (
        !t ||
        /^\d{1,2}:\d{2}$/.test(t) ||
        /\b(inserir|carregando|mensagem\s+nao\s+lida|hoje|ontem|enviado|seen|visualizado|lida|delivered)\b/.test(t) ||
        /\b(voce:|você:|you:)\b/.test(t) ||
        /\b(voce\s+enviou|você\s+enviou|you\s+sent)\b/.test(t) ||
        /^[\W_]+$/.test(t) // só sinais
      );
    }

    // BUSCA todas "bubbles" de mensagem real no grid do chat
    const mainThread = document.querySelector('div[role=grid][aria-label*="Mensagens"]')
      || document.querySelector('div[role=grid][aria-label*="Messages"]');
    if (!mainThread) return [];

    const rows = Array.from(mainThread.querySelectorAll('div[role=row],div[data-testid]'));
    const out = [];
    for (const row of rows) {
      // Pode precisar refinar para garantir que só pega "cliente"
      let txt = (row.innerText || row.textContent || '').trim();
      if (!txt) continue;
      if (isNoise(txt)) continue;
      // Checagem anti-eco: se a mensagem é do cliente (não do robô)
      // Opcional: checagem por classe do bubble, mas pro experimento, filtra pelo texto
      out.push({ 
        texto: txt,
        autor: 'cliente',
        // Tenta pegar timestamp
        timestamp: (() => {
          let abbr = row.querySelector('abbr[aria-label]');
          if(!abbr) return Date.now();
          let raw = abbr.getAttribute('aria-label') || abbr.innerText || abbr.textContent || '';
          let d = Date.parse(raw);
          return Number.isFinite(d) ? d : Date.now();
        })(),
      });
    }
    return out;
  });
};