// scripts/robe.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { patchPage/*, ensureMinimizedWindowForPage*/ } = require('./browser.js');
const utils = require('./utils.js');
const fotos = require('./fotos.js');       // autoridade central de fotos
const locais = require('./locais.js');     // controlador de rotação de localizações
const manifestStore = require('./manifestStore.js');

// Log de issues (robusto; falha silenciosa se não existir)
let issues = null;
try { issues = require('./issues.js'); } catch { issues = null; }

// Helpers básicos
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Adicionar helper local para logar issues (assíncrono e silencioso)
async function logIssue(nome, type, message) {
  try {
    if (issues && typeof issues.append === 'function') {
      await issues.append(nome, type, message);
    }
  } catch {
    // silencioso
  }
}

// Polyfill de XPath para garantir compatibilidade total
async function ensureXPathPolyfill(page) {
  if (typeof page.$x === 'function') return;
  page.$x = async function(xpath) {
    const arrHandle = await page.evaluateHandle((xp) => {
      const res = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < res.snapshotLength; i++) {
        out.push(res.snapshotItem(i));
      }
      return out;
    }, xpath);
    const props = await arrHandle.getProperties();
    const result = [];
    for (const handle of props.values()) {
      const el = handle.asElement ? handle.asElement() : null;
      if (el) result.push(el);
      else { try { handle.dispose && handle.dispose(); } catch {} }
    }
    try { arrHandle.dispose && arrHandle.dispose(); } catch {}
    return result;
  };
}

// IO seguro
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, dataObj) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dataObj, null, 2));
    try { fs.unlinkSync(file); } catch {}
    try { fs.renameSync(tmp, file); }
    catch {
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch { return false; }
}

// Busca robusta por input com rótulo visível
async function findInputByLabel(page, labelText, timeout = 8000) {
  const xpaths = [
    `//label[.//span[normalize-space()="${labelText}"]]//input`,
    `//span[normalize-space()="${labelText}"]/ancestor::*[self::label or self::div][1]//input`,
    `//label[.="${labelText}"]//input`,
    `//input[@aria-label="${labelText}"]`,
    `//input[@placeholder="${labelText}"]`
  ];
  const started = Date.now();
  while (Date.now() - started < timeout) {
    for (const xp of xpaths) {
      const handles = await page.$x(xp);
      if (handles && handles[0]) return handles[0];
    }
    await sleep(180);
  }
  return null;
}

// Busca robusta por combobox (role=combobox) a partir do rótulo
async function findComboboxByLabel(page, labelText, timeout = 8000) {
  const xp = `//label[@role="combobox" and .//span[normalize-space()="${labelText}"]]`;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const handles = await page.$x(xp);
    if (handles && handles[0]) return handles[0];
    await sleep(180);
  }
  return null;
}

// Clicar em um item por texto (fallback)
async function clickItemByText(page, text, timeout = 5000) {
  const xp = `//*[normalize-space()="${text}"]`;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const els = await page.$x(xp);
    if (els && els[0]) {
      await els[0].click();
      return true;
    }
    await sleep(120);
  }
  return false;
}

// Botão habilitado por texto
async function findEnabledButton(page, label, timeout = 3000) {
  const start = Date.now();
  const xp = `//span[normalize-space()="${label}"]`;
  while (Date.now() - start < timeout) {
    const spans = await page.$x(xp);
    for (const sp of spans) {
      const btn = await page.evaluateHandle(el => {
        let p = el;
        for (let i = 0; i < 5 && p; i++) {
          if (p.getAttribute && (p.getAttribute('role') === 'button' || p.tagName === 'BUTTON')) return p;
          p = p.parentElement;
        }
        return el;
      }, sp);
      const enabled = await page.evaluate(el => {
        const st = window.getComputedStyle(el);
        const ariaDisabled = el.getAttribute('aria-disabled');
        const tabIndex = el.getAttribute('tabindex');
        const visible = st && st.visibility !== 'hidden' && st.display !== 'none' && el.offsetParent !== null;
        const disabledAttr = (ariaDisabled === 'true') || (tabIndex === '-1');
        const disabledProp = (el.disabled === true);
        return visible && !disabledAttr && !disabledProp;
      }, btn);
      if (enabled) return btn;
    }
    await sleep(150);
  }
  return null;
}

// Fonte de localizações (JSON)
function listLocalizacoesPorCidade(cidade) {
  try {
    const localPath = path.join(__dirname, '..', 'dados', 'localizacoes.json');
    const raw = readJsonSafe(localPath, null);
    if (!raw) return [];
    const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();

    if (Array.isArray(raw)) {
      const hit = raw.find(ent =>
        norm(ent?.cidade) === norm(cidade) ||
        norm(ent?.nome) === norm(cidade) ||
        norm(ent?.id) === norm(cidade)
      );
      if (hit && Array.isArray(hit.localizacoes)) return hit.localizacoes.slice(0);
      return [];
    }

    const key = Object.keys(raw).find(k => norm(k) === norm(cidade));
    if (key && Array.isArray(raw[key])) return raw[key].slice(0);
    return Array.isArray(raw['default']) ? raw['default'].slice(0) : [];
  } catch {
    return [];
  }
}

// Fallback aleatório
function pickLocalizacaoAleatoria(cidade) {
  const lista = listLocalizacoesPorCidade(cidade);
  if (!lista.length) return 'São Paulo';
  return lista[Math.floor(Math.random() * lista.length)];
}

// Preenche Título e confere (timings otimizados)
async function preencherTitulo(page, titulo) {
  const inp = await findInputByLabel(page, 'Título', 7000);
  if (!inp) throw new Error('Campo Título não localizado.');
  await inp.click({ clickCount: 3 });
  await sleep(jitter(120, 220));
  await inp.type(titulo, { delay: jitter(12, 20) });
  await sleep(jitter(120, 200));
  const val = await page.evaluate(el => el.value, inp);
  if (!val || !String(val).trim()) throw new Error('Falha ao preencher Título (value vazio).');
}

// Preenche Preço 0, Enter e confere (timings otimizados)
async function preencherPreco(page) {
  const inp = await findInputByLabel(page, 'Preço', 7000);
  if (!inp) throw new Error('Campo Preço não localizado.');
  await inp.click({ clickCount: 3 });
  await sleep(jitter(120, 220));
  await inp.type('0', { delay: jitter(8, 15) });
  await sleep(jitter(100, 180));
  await inp.press('Enter');
  await sleep(jitter(200, 320));
  const val = await page.evaluate(el => el.value, inp);
  const ok = val && (val.trim() === '0' || /(^R\$?\s*0(,00)?$)/.test(val.trim()));
  if (!ok) throw new Error(`Preço não ficou "0" (value="${val}").`);
}

// Categoria: Móveis (timings otimizados)
async function selecionarCategoriaMoveis(page) {
  const combo = await findComboboxByLabel(page, 'Categoria', 7000);
  if (!combo) throw new Error('Combobox "Categoria" não localizado.');
  await combo.click();
  await sleep(jitter(220, 380));
  try {
    await page.keyboard.press('Tab');
    await sleep(jitter(120, 200));
    await page.keyboard.press('Enter');
    await sleep(jitter(220, 360));
  } catch {}
  const ok1 = await page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('label[role="combobox"]'))
      .find(l => l.textContent && l.textContent.includes('Categoria'));
    if (!lab) return false;
    const box = lab.querySelector('.xjyslct, [class*="xjyslct"]');
    if (!box) return false;
    return /Móveis/.test(box.innerText || '');
  });
  if (ok1) return;
  await combo.click();
  await sleep(jitter(180, 300));
  const clicked = await clickItemByText(page, 'Móveis', 2500);
  if (!clicked) {
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('ArrowDown');
      await sleep(60);
      const focusedIsMoveis = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active) return false;
        const t = (active.innerText || active.textContent || '').trim();
        return t === 'Móveis';
      });
      if (focusedIsMoveis) {
        await page.keyboard.press('Enter');
        break;
      }
    }
  }
  await sleep(jitter(250, 380));
  const ok2 = await page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('label[role="combobox"]'))
      .find(l => l.textContent && l.textContent.includes('Categoria'));
    if (!lab) return false;
    const box = lab.querySelector('.xjyslct, [class*="xjyslct"]');
    if (!box) return false;
    return /Móveis/.test(box.innerText || '');
  });
  if (!ok2) throw new Error('Falha ao selecionar a categoria "Móveis".');
}

// Condição: Novo (timings otimizados)
async function selecionarCondicaoNovo(page) {
  const combo = await findComboboxByLabel(page, 'Condição', 7000);
  if (!combo) throw new Error('Combobox "Condição" não localizado.');
  await combo.click();
  await sleep(jitter(200, 320));
  await page.keyboard.press('Enter');
  await sleep(jitter(180, 260));
  await page.keyboard.press('ArrowDown');
  await sleep(60);
  await page.keyboard.press('Enter');
  await sleep(jitter(220, 360));
  const ok = await page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('label[role="combobox"]'))
      .find(l => l.textContent && l.textContent.includes('Condição'));
    if (!lab) return false;
    const box = lab.querySelector('.xjyslct, [class*="xjyslct"]');
    if (!box) return false;
    return /Novo/.test(box.innerText || '');
  });
  if (!ok) throw new Error('Falha ao selecionar a condição "Novo".');
}

// Garantir “Mais detalhes” aberto
async function ensureMaisDetalhesAberto(page, timeout = 8000) {
  const start = Date.now();
  while ((Date.now() - start) < timeout) {
    const expanded = await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll('div[role="button"] span'))
        .find(s => (s.textContent || '').trim() === 'Mais detalhes');
      if (!span) return 'notfound';
      const host = span.closest('div[role="button"]');
      if (!host) return 'notfound';
      return host.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed';
    });

    if (expanded === 'open') return true;

    if (expanded === 'notfound') {
      await page.evaluate(() => window.scrollBy(0, Math.max(250, window.innerHeight * 0.4)));
      await sleep(150);
    }

    if (expanded === 'closed') {
      await page.evaluate(() => {
        const span = Array.from(document.querySelectorAll('div[role="button"] span'))
          .find(s => (s.textContent || '').trim() === 'Mais detalhes');
        if (!span) return;
        const host = span.closest('div[role="button"]');
        if (!host) return;
        host.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      await sleep(250);
    }
  }
  return false;
}

// Validação de localização
async function isLocalizacaoValida(page) {
  return await page.evaluate(() => {
    const inp = document.querySelector('input[aria-label="Localização"]');
    if (!inp) return false;
    const val = (inp.value || '').trim();
    const invalid = inp.getAttribute('aria-invalid') === 'true';
    let ok = !!val && !invalid;
    try {
      const label = inp.closest('label');
      const siblingWrap = label ? label.nextElementSibling : null;
      const okIcon = siblingWrap && siblingWrap.querySelector('i[aria-label*="válida"]');
      if (okIcon) ok = true;
    } catch {}
    return ok;
  });
}

// ————————— FAST-LANE: readiness da página “Criar item” —————————
// Timeout reduzido a 3500ms e fallback curto.
async function waitForCreateItemReady(page, { timeout = 3500 } = {}) {
  const start = Date.now();
  async function check() {
    // Presença (não exige “visível”), pois janela minimizada pode alterar métricas de visibilidade
    return await page.evaluate(() => {
      const file = document.querySelector('input[type="file"][accept*="image"], input[type="file"]');
      const titulo = Array.from(document.querySelectorAll('input')).find(i => i.getAttribute('aria-label') === 'Título' || i.getAttribute('placeholder') === 'Título');
      const catLbl = Array.from(document.querySelectorAll('label[role="combobox"] span')).find(s => (s.textContent || '').includes('Categoria'));
      return !!file && (!!titulo || !!catLbl);
    });
  }
  while ((Date.now() - start) < timeout) {
    try { if (await check()) return true; } catch {}
    await sleep(100);
  }
  return false;
}

// Preenche Localização via ciclo global (locais.js) e retorna a localização usada
async function preencherLocalizacao(page, cidade) {
  const okMaisDetalhes = await ensureMaisDetalhesAberto(page, 8000);
  if (!okMaisDetalhes) throw new Error('Não foi possível expandir “Mais detalhes”.');

  let inp = await findInputByLabel(page, 'Localização', 6000);
  if (!inp) inp = await page.$('input[aria-label="Localização"]');
  if (!inp) {
    await page.evaluate(() => window.scrollBy(0, Math.max(300, window.innerHeight * 0.5)));
    await sleep(300);
    inp = await findInputByLabel(page, 'Localização', 3500) || await page.$('input[aria-label="Localização"]');
  }
  if (!inp) throw new Error('Campo Localização não localizado.');

  // Tenta até 20 candidatos do ciclo
  for (let tent = 0; tent < 20; tent++) {
    const sug = await locais.nextLocationForCity(cidade);
    if (!sug.ok) throw new Error('Sem localizações disponíveis para esta cidade.');
    const cand = sug.location;

    try { await inp.click({ clickCount: 3 }); } catch {}
    await sleep(jitter(100, 180));
    try { await page.keyboard.press('Backspace'); } catch {}
    await sleep(jitter(100, 160));
    await inp.type(cand, { delay: jitter(10, 18) });
    await sleep(jitter(600, 900));

    for (let idx = 0; idx < 2; idx++) {
      try { await inp.focus(); } catch {}
      await sleep(80);
      try { await page.keyboard.press('ArrowDown'); } catch {}
      await sleep(jitter(80, 140));
      try { await page.keyboard.press('Enter'); } catch {}
      await sleep(jitter(350, 550));

      if (await isLocalizacaoValida(page)) {
        return cand;
      }
    }

    // Candidato não validou neste ciclo — marca inválido e tenta outro
    await locais.reportInvalid(cidade, cand, 'not_valid_on_fb');
    await sleep(120);
  }

  throw new Error('Localização não ficou válida após múltiplas tentativas (ciclo consumido).');
}

// Fechamento seguro da aba (anti-trava)
async function safeClosePage(page) {
  if (!page) return;
  try {
    await page.evaluate(() => {
      try { window.onbeforeunload = null; } catch {}
      try {
        window.addEventListener('beforeunload', (e) => {
          e.stopImmediatePropagation();
        }, true);
      } catch {}
    }).catch(()=>{});
  } catch {}
  try {
    const client = await page.target().createCDPSession();
    await client.send('Page.stopLoading').catch(()=>{});
  } catch {}
  try { await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 1200 }).catch(()=>{}); } catch {}
  try { await page.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
}

// —————— NOVO: Rotina publicação e fechamento 5s como solicitado ——————
// *** SUBSTITUÍDA PELO NOVO FLUXO ABAIXO ***

// ——— NOVO: Pós-publicação ultra-rápido com detecção de “painel/listagem” ———
async function isSellerListOrDashboard(page) {
  try {
    const url = page.url() || '';
    if (/\/marketplace\/you\b|\/marketplace\/\?ref=marketplace_page_selling_chip/.test(url)) return true;
    const hit = await page.evaluate(() => {
      const txt = (sel) => {
        const el = document.querySelector(sel);
        return (el && (el.innerText || el.textContent || '') || '').trim().toLowerCase();
      };
      const h1 = txt('h1');
      const h2 = txt('h2');
      const nav = document.querySelector('a[href*="/marketplace/you/selling/"], a[href*="/marketplace/you/dashboard/"]');
      const seller = /venda|seus classificados|painel do vendedor|seller|dashboard/i;
      return seller.test(h1) || seller.test(h2) || !!nav;
    });
    return !!hit;
  } catch { return false; }
}

// Espera curta pós-publicação com heurística “painel/listagem” + popup
async function waitAndCloseAfterPublishSmart(page, { hardMaxMs = 3000, popupExtraMs = 2500, sawPopupRef = { value: false } } = {}) {
  const start = Date.now();
  while ((Date.now() - start) < hardMaxMs) {
    if (sawPopupRef.value) {
      await sleep(popupExtraMs);
      break;
    }
    if (await isSellerListOrDashboard(page)) break;
    await sleep(100);
  }
  await safeClosePage(page);
}

// --------- SUBSTITUÍDA PELO NOVO FLUXO SINGLE SUBMIT BOOT MILITAR ---------
async function publicarEFechar5s(page) {
  let submitted = false;
  let steps = 0;

  // 1) Avança etapas até aparecer “Publicar”
  for (let i = 0; i < 12; i++) {
    steps++;
    const btnPub = await findEnabledButton(page, 'Publicar', 500);
    if (btnPub) {
      try {
        await btnPub.click();
        submitted = true;
      } catch {}
      break; // NUNCA clica "Publicar" mais de uma vez
    }
    const btnAv = await findEnabledButton(page, 'Avançar', 500);
    if (btnAv) {
      try { await btnAv.click(); } catch {}
      await sleep(400);
      continue;
    }
    // Nem Avançar nem Publicar => pequena espera e revalida mais uma vez
    await sleep(250);
  }

  if (!submitted) return false;

  // 2) Espera o “sumiço”/desabilitação de "Publicar" (até 15s)
  const hidden = await page.waitForFunction(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const btnSpan = spans.find(s => (s.innerText || '').trim() === 'Publicar');
    if (!btnSpan) return true;
    const host = btnSpan.closest('div[role="button"],button');
    if (!host) return true;
    const disabled = host.getAttribute('aria-disabled') === 'true' || host.getAttribute('tabindex') === '-1';
    const style = window.getComputedStyle(host);
    const visible = style && style.visibility !== 'hidden' && style.display !== 'none';
    return (!visible) || disabled;
  }, { timeout: 15000 }).catch(() => false);

  // 3) Espera heurística de conclusão (dashboard/lista) e fecha
  // Se dashboard detectado, fecha em seguida; se não, aguarda até 3s e fecha.
  try {
    const sawPopupRef = { value: false };
    await waitAndCloseAfterPublishSmart(page, { hardMaxMs: 3000, popupExtraMs: 2500, sawPopupRef });
  } catch {
    try { await safeClosePage(page); } catch {}
  }

  return true;
}

// --------------------------------------------------
// GUARD: Armezenamento RAM/Status/Antiflood Backoff/FROZEN/Logging guard rails
// (Removido: robeMeta e população a partir do manifest; controle de estado local não é mais utilizado)

// --------------------------------------------------

/**
 * Start Robe — rápido e robusto:
 * - Fast-lane readiness (3.5s) + fallback curto.
 * - Espera curta se restar <5s de cooldown; aborta sem mexer no cooldown se faltar mais.
 * - Pause 15–30min apenas no sucesso, 60s em erro técnico, nada no abort por cooldown.
 * - Pós-publicação: se detectar “painel/listagem” fecha imediatamente; senão fecha em até 3s (sem popup).
 *   Se houver popup, aceita e espera ~2.5s, depois fecha.
 * - Minimização suave apenas desta aba (após anti-detect).
 */
async function startRobe(browser, nome, robePauseMs = 0, workingNames = []) {
  let page = null;
  let published = false;
  let sawBeforeUnloadDialog = false;
  let abortedByCooldown = false;
  const stepLog = [];

  console.log(`[ROBE][startRobe] INÍCIO para ${nome}, pauseMS=${robePauseMs}, horário=${new Date().toLocaleString()}`);

  let perfilPath, manifest;

  try {
    // Leitura do manifest via manifestStore (com lock)
    manifest = await manifestStore.read(nome);

    // NOVO: Não congelar localmente — apenas detectar, logar e retornar para o worker decidir
    if (!manifest) {
      try { await logIssue(nome, 'robe_error', 'manifest ausente; flow deve congelar via worker'); } catch {}
      return { ok: false, error: 'no_manifest' };
    }
    if (!manifest.cookies || !manifest.fp) {
      try { await logIssue(nome, 'robe_error', 'manifest incompleto (cookies/fp); flow deve congelar via worker'); } catch {}
      return { ok: false, error: 'incomplete_manifest' };
    }

    // Cooldown: espera curto se faltar pouco; aborta sem mexer no cooldown se faltar muito
    const now = Date.now();
    const leftMs = (manifest.robeCooldownUntil || 0) - now;
    if (leftMs > 0) {
      if (leftMs <= 5000) {
        await sleep(leftMs + 300);
      } else {
        const ate = new Date(manifest.robeCooldownUntil).toLocaleString();
        stepLog.push(`[${nome}] Cooldown ainda ativo por ${Math.ceil(leftMs/1000)}s (até ${ate}). Abortando sem atualizar pause.`);
        abortedByCooldown = true;
        // NÃO criar mensagens para “abortedByCooldown”
        return { ok: false, error: `cooldown_until_${ate}`, log: stepLog };
      }
    }

    // Nova aba + patchPage (sem minimizar/off-screen)
    page = await browser.newPage();
    await ensureXPathPolyfill(page);
    const coords = utils.getCoords(manifest.cidade || '');
    // ALTERAÇÃO AQUI: patchPage recebe nome (string), não manifest
    await patchPage(nome, page, coords);
    stepLog.push(`[${nome}] Nova aba criada para Robe`);

    // Captura possíveis diálogos
    page.on('dialog', async dlg => {
      try {
        const t = dlg.type && dlg.type();
        const m = (dlg.message && dlg.message()) || '';
        if (t === 'beforeunload' || /sair|deixar|leave this page|continuar/i.test(m)) {
          sawBeforeUnloadDialog = true;
          await dlg.accept().catch(()=>{});
        } else {
          await dlg.dismiss().catch(()=>{});
        }
      } catch {}
    });

    // Interceptação de recursos — NUNCA bloquear assets nem usar setRequestInterception
    // Marketplace create/posting: NÃO bloquear NENHUM asset. Mantém patchPage limpo.

    // Navegação rápida + readiness rápido
    await page.goto('https://www.facebook.com/marketplace/create/item', {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });

    // Fast-lane readiness (3.5s). Se não ficar pronto, fallback com seletor (8s).
    const readyFast = await waitForCreateItemReady(page, { timeout: 3500 });
    if (!readyFast) {
      await page.waitForSelector('input[type="file"][accept*="image"], input[type="file"]', {
        timeout: 8000
      }).catch(() => {});
    }

    // Micro settle (2 frames + 100–220 ms); substituído por sleep apenas (alteração)
    await sleep(jitter(100, 220));
    stepLog.push(`[${nome}] Tela de criar item pronta (fast-lane)`);

    // FOTO — via fotos.js
    const pick = await fotos.pickPhotoForAccount(nome, workingNames);
    if (!pick.ok) {
      const reason = pick.error || 'no-photo-available';
      throw new Error(`Sem foto disponível para esta conta (${reason}).`);
    }
    const fotoPath = pick.absPath;
    const fotoNome = pick.file;

    // Upload
    let inputFoto = await page.$('input[type="file"][accept*="image"]');
    if (!inputFoto) inputFoto = await page.$('input[type="file"]');
    if (!inputFoto) throw new Error('Campo para upload de foto não localizado.');
    await inputFoto.uploadFile(fotoPath);
    await sleep(jitter(250, 450));

    // TÍTULO
    const titulos = readJsonSafe(path.join(__dirname, '..', 'dados', 'titulos.json'), []);
    const titulo = titulos.length ? titulos[Math.floor(Math.random()*titulos.length)] : 'Título padrão';
    await preencherTitulo(page, titulo);
    await sleep(jitter(120, 220));

    // PREÇO
    await preencherPreco(page);

    // CATEGORIA
    await selecionarCategoriaMoveis(page);

    // CONDIÇÃO
    await selecionarCondicaoNovo(page);

    // LOCALIZAÇÃO
    const cidadePerfil = manifest.cidade || manifest.localizacao || manifest['localização'] || 'São Paulo';
    const localUsada = await preencherLocalizacao(page, cidadePerfil);

    // —————— ALTERAÇÃO APLICADA: Rotina publicarEFechar5s no lugar do pós-publicação anterior ——————

    // PUBLICAR e FECHAR (novo fluxo militar)
    const okPub = await publicarEFechar5s(page);
    if (!okPub) throw new Error('Falha ao publicar (nenhum clique efetivo em Publicar/Avançar).');
    published = true;
    stepLog.push(`[${nome}] Publicação concluída; aguardado rotina militar e aba fechada.`);

    // Confirmar localização usada (após publicar — mantém)
    try { await locais.confirmUsed(cidadePerfil, localUsada); } catch {}

    // Aba já foi fechada pela publicarEFechar5s; solta a referência
    page = null;

    // Registrar e possivelmente excluir a foto via fotos.js
    try {
      const res = await fotos.markPostedAndMaybeDelete(nome, fotoNome, workingNames);
      if (res && res.ok) {
        if (res.deleted) {
          stepLog.push(`[${nome}] Foto "${fotoNome}" removida (todas as contas trabalhando já usaram).`);
        } else {
          stepLog.push(`[${nome}] Foto "${fotoNome}" registrada (ainda ativa para outras contas).`);
        }
      } else {
        stepLog.push(`[${nome}] AVISO: falha ao registrar foto "${fotoNome}": ${(res && res.error) || 'desconhecido'}`);
      }
    } catch (e) {
      stepLog.push(`[${nome}] AVISO: exceção ao registrar/excluir foto "${fotoNome}": ${e && e.message || e}`);
    }

    // IMPORTANTE: Grava ultimaPostagemRobe via manifestStore
    await manifestStore.update(nome, m => {
      m.ultimaPostagemRobe = Date.now();
      return m;
    });

    // LOG: evento de sucesso (uma mensagem por account/turno já é suficiente)
    try { await logIssue(nome, 'robe_success', 'Publicação concluída com sucesso.'); } catch {}

  } catch (e) {
    const errMsg = (e && e.message) ? e.message : String(e);
    stepLog.push(`[${nome}] ERRO: ${errMsg}`);

    // Tipo de issue (no-photo vs erro geral)
    const isNoPhoto = /sem foto dispon[ií]vel/i.test(errMsg);
    const issueType = isNoPhoto ? 'robe_no_photo' : 'robe_error';

    // Registra issue (silencioso)
    try { await logIssue(nome, issueType, errMsg); } catch {}

    // Cooldown militar para erro técnico (60–300s)
    try {
      const cooldownRand = jitter(60000, 300000);
      await manifestStore.update(nome, m => {
        m.robeCooldownUntil = Date.now() + cooldownRand;
        return m;
      });
      try { await logIssue(nome, 'robe_error', `Erro técnico/backoff, cooldown ${Math.ceil(cooldownRand/1000)}s: ${errMsg}`); } catch {}
    } catch {}

    return { ok: false, error: errMsg, log: stepLog };

  } finally {
    // Cooldown nível militar:
    // - published=true: 15–30min.
    // - abortedByCooldown=true: não mexe.
    // - erro técnico: backoff curto 60–300s (já tratado no catch acima).

    try {
      if (published) {
        const rndPause = (15 + Math.floor(Math.random() * 16)) * 60 * 1000;
        const pause = (robePauseMs > 0 ? robePauseMs : rndPause);
        await manifestStore.update(nome, m => {
          m.robeCooldownUntil = Date.now() + pause;
          return m;
        });
        // Evento de sucesso já logado acima
      }
      // Se abortedByCooldown === true, não altera nada
    } catch (err) {
      stepLog.push(`[${nome}] ERRO ao atualizar cooldown: ${err && err.message || err}`);
    }

    // OPCIONAL RECOMENDADO: logging do beforeunload dialog
    try { 
      if (sawBeforeUnloadDialog) 
        await logIssue(nome, 'robe_error', 'beforeunload dialog detectado; fechamento forçado'); 
    } catch {}

    if (page) {
      try { await safeClosePage(page); console.log(`[ROBE] ${nome}: aba fechada no finally`); } catch {}
    }
    console.log(`[ROBE][startRobe] FIM: ${published ? 'success' : 'fail'} | logs:`, stepLog);
  }

  return { ok: published, log: stepLog };
}

// --------------------------------------------------
// Filtragem de fila/fila global militar
function robeQueueFilter(nome) {
  // Sem estado local; worker decide sobre frozen/controle de fila
  return true;
}

// --------------------------------------------------

module.exports = {
  startRobe,
  robeQueueFilter
};