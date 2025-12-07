module.exports = async function collectClientMessagesFromMessenger(page) {

  return await page.evaluate(() => {

    function norm(s){ try { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); } catch { return String(s||'').toLowerCase().trim(); } }

    function parseAbbrToTs(el) {

      try {

        const raw = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();

        const d = Date.parse(raw);

        return Number.isFinite(d) ? d : Date.now();

      } catch { return Date.now(); }

    }

    function isNoise(t) {

      const s = norm(t).replace(/[.,;:!?\u200B-\u200D\uFEFF]/g,'').trim();

      if (!s) return true;

      if (/\b(inserir|carregando|mensagem\s+nao\s+lida|hoje|ontem)\b/.test(s)) return true;

      if (/^\d{1,2}:\d{2}$/.test(s)) return true;

      if (/\b(enviado|enviada|sent|delivered|visto|visualizado|lida|seen)\b/.test(s)) return true;

      if (/[·•]/.test(s)) return true;

      if (/\b(voce:|você:|you:)\b/.test(s)) return true;

      if (/\b(voce\s+enviou|você\s+enviou|you\s+sent)\b/.test(s)) return true;

      if (/^\W+$/.test(s)) return true;

      return false;

    }

    function isUiMine(row, textNorm) {

      try { if (row.querySelector('[data-testid*="outgoing"]')) return true; } catch {}

      if (/\b(voce:|você:|you:)\b/.test(textNorm)) return true;

      if (/\b(voce\s+enviou|você\s+enviou|you\s+sent)\b/.test(textNorm)) return true;

      try {

        const wrap = row.closest('[data-testid*="message"], [data-pagelet*="thread"]') || row;

        const st = window.getComputedStyle(wrap);

        if (st && (st.justifyContent === 'flex-end' || st.textAlign === 'right')) return true;

      } catch {}

      return false;

    }

    const composer = document.querySelector('div[contenteditable="true"][role="textbox"], div[role="combobox"][contenteditable="true"], div[contenteditable="true"][aria-label]');

    const convoRoot = composer?.closest('div[role="main"]') || composer?.closest('section') || composer?.parentElement || document;

    const grid = convoRoot?.querySelector('div[role="grid"][aria-label*="Mensagens na conversa"], div[aria-label*="Mensagens na conversa"][role="grid"], div[role="grid"][aria-label*="Messages"], div[aria-label*="Messages"][role="grid"]')

              || document.querySelector('div[role="grid"][aria-label*="Mensagens na conversa"], div[role="grid"][aria-label*="Messages"]');

    if (!grid) return [];

    const rows = Array.from(grid.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-220);

    const out = [];

    for (const row of rows) {

      const rawTxt = (row.innerText || row.textContent || '').trim();

      if (!rawTxt) continue;

      if (isNoise(rawTxt)) continue;

      if (row.getAttribute && row.getAttribute('role') === 'heading') continue;

      if (!grid.contains(row)) continue;

      const nraw = norm(rawTxt);

      if (isUiMine(row, nraw)) continue; // só cliente

      let ts = 0;

      try {

        const ab = row.querySelector('abbr[aria-label]') || row.closest('*:has(abbr[aria-label])')?.querySelector('abbr[aria-label]');

        if (ab) ts = parseAbbrToTs(ab);

      } catch {}

      if (!ts) ts = Date.now();

      out.push({ texto: rawTxt.trim(), autor: 'cliente', timestamp: ts });

    }

    out.sort((a,b) => (a.timestamp||0) - (b.timestamp||0));

    for (let i=1;i<out.length;i++){

      const prev = Number(out[i-1].timestamp||0);

      const cur  = Number(out[i].timestamp||0);

      if (cur <= prev) out[i].timestamp = prev + 1;

    }

    return out;

  });

};
