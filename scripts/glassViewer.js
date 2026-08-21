'use strict';

/**
 * CONTRATO VIDRO/VISOR (identidade intocada)
 *
 * 1) Identidade: page.setViewport(preset) permanece. innerWidth/innerHeight/DPR
 *    nao mudam aqui.
 * 2) Vidro: janela maximizada na MAE (cobre os outros Chromes).
 * 3) Visor: se o preset cabe no vidro, zoom=1 (1:1, conteudo menor).
 *    Se nao cabe, zoom=fit < 1 (encolhe so o desenho). Zoom do operador
 *    (Ctrl +/- / roda com Ctrl) pode passar do vidro; ai pan com barras
 *    e com a roda (sem Ctrl).
 * 4) Cliques: com transform no html, getBoundingClientRect e o mouse do
 *    Puppeteer falam o mesmo espaco visual. Nao converter coordenadas.
 * 5) Overlay humano: ancora no vidro visivel, nao no innerWidth virtual.
 *
 * Prova empirica (Chrome headful): setPageScaleFactor nao encolhe;
 * DeviceMetricsOverride recorta o canto superior esquerdo; transform/scale
 * no html encaixa compositor + TR.
 */

const logger = require('./logger.js');

const CHROME_TOOLBAR_DIP = 90;
const CHROME_INFOBAR_DIP = 40;
const CHROME_SAFE_DIP = 6;
const CHROME_UI_DIP = CHROME_TOOLBAR_DIP + CHROME_INFOBAR_DIP + CHROME_SAFE_DIP;
const WIN_MAX_CHROME_DIP = 16;
const MIN_FIT = 0.12;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.12;
const HUD_ID = 'ct-glass-viewer-hud';

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function snapZoomToPixels(z, presetW, presetH, glassW, glassH) {
  let z0 = num(z, 1);
  if (z0 >= 0.999) return 1;
  const pw = Math.max(1, num(presetW, 1));
  const ph = Math.max(1, num(presetH, 1));
  const gw = Math.max(1, num(glassW, pw));
  const gh = Math.max(1, num(glassH, ph));
  z0 = Math.min(1, z0, gw / pw, gh / ph);
  const w = Math.max(1, Math.floor(pw * z0 + 1e-9));
  z0 = w / pw;
  const h = Math.max(1, Math.floor(ph * z0 + 1e-9));
  z0 = Math.min(z0, h / ph);
  if (!Number.isFinite(z0) || z0 <= 0) return 1;
  return Math.max(MIN_FIT, z0);
}

function computeFitZoom(presetW, presetH, glassW, glassH) {
  const pw = Math.max(1, num(presetW, 1));
  const ph = Math.max(1, num(presetH, 1));
  const gw = Math.max(1, num(glassW, 1));
  const gh = Math.max(1, num(glassH, 1));
  const z = Math.min(1, gw / pw, gh / ph);
  if (!Number.isFinite(z) || z <= 0) return 1;
  return snapZoomToPixels(z, pw, ph, gw, gh);
}

function toLayoutCoords(visualX, visualY, zoom, panX, panY) {
  const z = num(zoom, 1) > 0 ? num(zoom, 1) : 1;
  return {
    x: num(visualX, 0) / z + num(panX, 0),
    y: num(visualY, 0) / z + num(panY, 0)
  };
}

function clampPan(panX, panY, zoom, presetW, presetH, glassW, glassH) {
  const z = num(zoom, 1) > 0 ? num(zoom, 1) : 1;
  const visW = num(glassW, 1) / z;
  const visH = num(glassH, 1) / z;
  const maxX = Math.max(0, num(presetW, 1) - visW);
  const maxY = Math.max(0, num(presetH, 1) - visH);
  return {
    panX: Math.min(maxX, Math.max(0, num(panX, 0))),
    panY: Math.min(maxY, Math.max(0, num(panY, 0)))
  };
}

function visibleNeedsPan(zoom, presetW, presetH, glassW, glassH) {
  const pan = panAxes(zoom, presetW, presetH, glassW, glassH);
  return pan.x || pan.y;
}

function panAxes(zoom, presetW, presetH, glassW, glassH) {
  const z = num(zoom, 1) > 0 ? num(zoom, 1) : 1;
  return {
    x: (num(presetW, 1) * z - num(glassW, 1) > 1),
    y: (num(presetH, 1) * z - num(glassH, 1) > 1)
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

function pageClosed(page) {
  try {
    return !!(page && page.isClosed && page.isClosed());
  } catch {
    return true;
  }
}

function readState(page) {
  return page && page._ctGlassViewer && typeof page._ctGlassViewer === 'object'
    ? page._ctGlassViewer
    : null;
}

function writeState(page, patch) {
  const prev = readState(page) || {
    zoom: 1,
    panX: 0,
    panY: 0,
    fitZoom: 1,
    glassW: 0,
    glassH: 0,
    presetW: 0,
    presetH: 0,
    userZoom: false
  };
  page._ctGlassViewer = Object.assign({}, prev, patch || {});
  return page._ctGlassViewer;
}

async function isAuxiliaryWindow(page) {
  try {
    const opener = await page.opener();
    if (opener) return true;
  } catch {}
  try {
    const browser = typeof page.browser === 'function' ? page.browser() : null;
    if (!browser || typeof browser.pages !== 'function') return false;
    const pages = await browser.pages();
    const main = pages && pages[0];
    if (!main || main === page) return false;
    const client = await page.target().createCDPSession();
    try {
      const wPage = await client.send('Browser.getWindowForTarget');
      const client0 = await main.target().createCDPSession();
      try {
        const wMain = await client0.send('Browser.getWindowForTarget');
        return Number(wPage && wPage.windowId) !== Number(wMain && wMain.windowId);
      } finally {
        try { await client0.detach(); } catch {}
      }
    } finally {
      try { await client.detach(); } catch {}
    }
  } catch {}
  return false;
}

async function maximizeWindow(page) {
  if (await isAuxiliaryWindow(page)) return null;
  const client = await page.target().createCDPSession();
  try {
    const { windowId } = await client.send('Browser.getWindowForTarget');
    let info = await client.send('Browser.getWindowBounds', { windowId });
    const state = String((info && info.bounds && info.bounds.windowState) || '');
    if (state !== 'maximized') {
      await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
      await sleep(150);
      info = await client.send('Browser.getWindowBounds', { windowId });
    }
    return (info && info.bounds) || null;
  } finally {
    try { await client.detach(); } catch {}
  }
}

async function measureGlass(page, bounds) {
  const js = await page.evaluate(() => ({
    innerW: window.innerWidth || 0,
    innerH: window.innerHeight || 0,
    outerW: window.outerWidth || 0,
    outerH: window.outerHeight || 0
  }));
  const vp = (typeof page.viewport === 'function' ? page.viewport() : null) || {};
  const presetW = Math.max(1, num(vp.width, 0) || num(js.innerW, 1));
  const presetH = Math.max(1, num(vp.height, 0) || num(js.innerH, 1));
  let glassW = num(js.outerW, 0);
  let glassH = num(js.outerH, 0) - CHROME_UI_DIP;
  if (bounds && num(bounds.width, 0) >= 400 && num(bounds.height, 0) >= 300) {
    glassW = Math.max(glassW, num(bounds.width, 0) - WIN_MAX_CHROME_DIP);
    const fromBounds = num(bounds.height, 0) - WIN_MAX_CHROME_DIP - CHROME_UI_DIP;
    if (fromBounds >= 200) glassH = fromBounds;
  }
  glassW = Math.max(320, glassW);
  glassH = Math.max(240, glassH);
  return { presetW, presetH, glassW, glassH, innerW: js.innerW, innerH: js.innerH, outerW: js.outerW, outerH: js.outerH };
}

function paintScript(st) {
  const z = num(st.zoom, 1);
  const px = num(st.panX, 0);
  const py = num(st.panY, 0);
  const gw = num(st.glassW, 0);
  const gh = num(st.glassH, 0);
  const pw = num(st.presetW, 0);
  const ph = num(st.presetH, 0);
  const fit = num(st.fitZoom, 1);
  const axes = panAxes(z, pw, ph, gw, gh);
  const needPan = axes.x || axes.y;
  return `(function(){
    var z = ${z};
    var px = ${px};
    var py = ${py};
    var html = document.documentElement;
    if (!html) return;
    var none = (z === 1 && px === 0 && py === 0);
    html.style.transformOrigin = '0 0';
    html.style.backfaceVisibility = none ? '' : 'hidden';
    html.style.transform = none ? 'none' : ('translateZ(0) scale(' + z + ') translate(' + (-px) + 'px,' + (-py) + 'px)');
    window.__ctGlassViewerState = {
      zoom: z, panX: px, panY: py,
      glassW: ${gw}, glassH: ${gh},
      presetW: ${pw}, presetH: ${ph},
      fitZoom: ${fit},
      needPan: ${needPan ? 'true' : 'false'},
      needPanX: ${axes.x ? 'true' : 'false'},
      needPanY: ${axes.y ? 'true' : 'false'}
    };
    try { window.dispatchEvent(new CustomEvent('ct-glass-viewer', { detail: window.__ctGlassViewerState })); } catch (e) {}
  })()`;
}

async function paint(page) {
  if (pageClosed(page)) return;
  const st = readState(page);
  if (!st) return;
  await page.evaluate(paintScript(st)).catch(() => {});
}

function pageInstallRuntime() {
  try {
    if (window.__ctGlassRuntimeWatch) return;
    window.__ctGlassRuntimeWatch = true;
    const restore = () => {
      try {
        const st = window.__ctGlassViewerState;
        if (!st) return;
        const html = document.documentElement;
        if (!html) return;
        const z = Number(st.zoom) || 1;
        const px = Number(st.panX) || 0;
        const py = Number(st.panY) || 0;
          const none = (z === 1 && px === 0 && py === 0);
          const want = none ? 'none' : ('translateZ(0) scale(' + z + ') translate(' + (-px) + 'px,' + (-py) + 'px)');
          if (html.style.transform !== want) {
            html.style.transformOrigin = '0 0';
            html.style.backfaceVisibility = none ? '' : 'hidden';
            html.style.transform = want;
          }
      } catch (e) {}
    };
    try {
      new MutationObserver(restore).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style']
      });
    } catch (e) {}
    window.addEventListener('keydown', (ev) => {
      try {
        if (!(ev.ctrlKey || ev.metaKey)) return;
        if (ev.key === '+' || ev.key === '=' || ev.code === 'NumpadAdd') {
          ev.preventDefault();
          window.__ctGlassViewerCmd && window.__ctGlassViewerCmd({ op: 'zoomBy', delta: 1 });
        } else if (ev.key === '-' || ev.code === 'NumpadSubtract') {
          ev.preventDefault();
          window.__ctGlassViewerCmd && window.__ctGlassViewerCmd({ op: 'zoomBy', delta: -1 });
        } else if (ev.key === '0') {
          ev.preventDefault();
          window.__ctGlassViewerCmd && window.__ctGlassViewerCmd({ op: 'fit' });
        }
      } catch (e) {}
    }, true);
    window.addEventListener('wheel', (ev) => {
      try {
        const st = window.__ctGlassViewerState;
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          window.__ctGlassViewerCmd && window.__ctGlassViewerCmd({
            op: 'zoomBy',
            delta: ev.deltaY < 0 ? 1 : -1
          });
          return;
        }
        if (!st || st.needPan !== true) return;
        ev.preventDefault();
        const z = Number(st.zoom) > 0 ? Number(st.zoom) : 1;
        let dx = Number(ev.deltaX) || 0;
        let dy = Number(ev.deltaY) || 0;
        if (ev.deltaMode === 1) { dx *= 24; dy *= 24; }
        if (ev.shiftKey && !dx) { dx = dy; dy = 0; }
        window.__ctGlassViewerCmd && window.__ctGlassViewerCmd({
          op: 'panBy',
          dx: dx / z,
          dy: dy / z
        });
      } catch (e) {}
    }, { capture: true, passive: false });
  } catch (e) {}
}

async function installRuntime(page) {
  if (!page._ctGlassRuntimeInstalled) {
    page._ctGlassRuntimeInstalled = true;
    try {
      await page.exposeFunction('__ctGlassViewerCmd', async (cmd) => {
        try {
          await handleHudCommand(page, cmd || {});
        } catch {}
      });
    } catch {}
    try { await page.evaluateOnNewDocument(pageInstallRuntime); } catch {}
  }
  // Documento novo (goto/SPA reload) perde o watch. Reinstala sempre; a funcao e idempotente.
  try { await page.evaluate(pageInstallRuntime); } catch {}
}

function hudScript() {
  return `(function(){
    var ID = '${HUD_ID}';
    var st = window.__ctGlassViewerState || {};
    var z = Number(st.zoom) || 1;
    if (z <= 0) z = 1;
    var panX = Number(st.panX) || 0;
    var panY = Number(st.panY) || 0;
    var gw = Number(st.glassW) || 0;
    var gh = Number(st.glassH) || 0;
    var needPan = st.needPan === true;
    var needPanX = st.needPanX === true;
    var needPanY = st.needPanY === true;
    var host = document.getElementById(ID);
    if (host && host.getAttribute('data-ct-hud') !== '2') {
      try { host.remove(); } catch (e) {}
      host = null;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = ID;
      host.setAttribute('data-ct-hud', '2');
      host.style.zIndex = '2147483646';
      host.style.pointerEvents = 'none';
      host.style.userSelect = 'none';
      (document.documentElement || document.body).appendChild(host);
      var shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = ''
        + '<style>'
        + '.hbar,.vbar{position:absolute;background:rgba(11,18,32,.55);pointer-events:auto;border-radius:6px;}'
        + '.hthumb,.vthumb{position:absolute;background:#93c5fd;border-radius:6px;}'
        + '</style>'
        + '<div class="hbar" id="hbar"><div class="hthumb" id="hthumb"></div></div>'
        + '<div class="vbar" id="vbar"><div class="vthumb" id="vthumb"></div></div>';
      var panFromPointer = function(kind, ev){
        var s = window.__ctGlassViewerState || {};
        var zz = Number(s.zoom) || 1;
        if (zz <= 0) zz = 1;
        var visW = (Number(s.glassW) || 0) / zz;
        var visH = (Number(s.glassH) || 0) / zz;
        var maxX = Math.max(1, (Number(s.presetW) || visW) - visW);
        var maxY = Math.max(1, (Number(s.presetH) || visH) - visH);
        if (kind === 'v') {
          var br = shadow.getElementById('vbar').getBoundingClientRect();
          var th = shadow.getElementById('vthumb').getBoundingClientRect().height;
          var travel = Math.max(1, br.height - th);
          var t = (ev.clientY - br.top - th / 2) / travel;
          if (t < 0) t = 0; if (t > 1) t = 1;
          window.__ctGlassViewerCmd && window.__ctGlassViewerCmd({ op: 'panTo', panY: t * maxY });
        } else {
          var brh = shadow.getElementById('hbar').getBoundingClientRect();
          var tw = shadow.getElementById('hthumb').getBoundingClientRect().width;
          var travelh = Math.max(1, brh.width - tw);
          var thz = (ev.clientX - brh.left - tw / 2) / travelh;
          if (thz < 0) thz = 0; if (thz > 1) thz = 1;
          window.__ctGlassViewerCmd && window.__ctGlassViewerCmd({ op: 'panTo', panX: thz * maxX });
        }
      };
      var startDrag = function(kind, ev){
        drag = { kind: kind };
        ev.preventDefault();
        panFromPointer(kind, ev);
      };
      shadow.getElementById('hbar').addEventListener('mousedown', function(ev){ startDrag('h', ev); });
      shadow.getElementById('vbar').addEventListener('mousedown', function(ev){ startDrag('v', ev); });
      shadow.getElementById('hthumb').addEventListener('mousedown', function(ev){ startDrag('h', ev); });
      shadow.getElementById('vthumb').addEventListener('mousedown', function(ev){ startDrag('v', ev); });
      window.addEventListener('mousemove', function(ev){
        if (!drag) return;
        panFromPointer(drag.kind, ev);
      });
      window.addEventListener('mouseup', function(){ drag = null; });
    }
    if (!gw || !gh) return;
    host.style.position = 'absolute';
    host.style.left = '0';
    host.style.top = '0';
    host.style.width = '0';
    host.style.height = '0';
    var shadow = host.shadowRoot;
    if (!shadow) return;
    var hbar = shadow.getElementById('hbar');
    var vbar = shadow.getElementById('vbar');
    var hthumb = shadow.getElementById('hthumb');
    var vthumb = shadow.getElementById('vthumb');
    var visW = gw / z;
    var visH = gh / z;
    var bar = 12 / z;
    if (!needPan) {
      hbar.style.display = 'none';
      vbar.style.display = 'none';
      return;
    }
    hbar.style.display = needPanX ? 'block' : 'none';
    vbar.style.display = needPanY ? 'block' : 'none';
    hbar.style.left = panX + 'px';
    hbar.style.top = (panY + visH - bar) + 'px';
    hbar.style.width = visW + 'px';
    hbar.style.height = bar + 'px';
    vbar.style.left = (panX + visW - bar) + 'px';
    vbar.style.top = panY + 'px';
    vbar.style.width = bar + 'px';
    vbar.style.height = visH + 'px';
    var maxX = Math.max(1, (Number(st.presetW) || visW) - visW);
    var maxY = Math.max(1, (Number(st.presetH) || visH) - visH);
    var hRatio = visW / Math.max(visW, Number(st.presetW) || visW);
    var vRatio = visH / Math.max(visH, Number(st.presetH) || visH);
    hthumb.style.left = ((panX / maxX) * (visW - visW * hRatio)) + 'px';
    hthumb.style.top = '0';
    hthumb.style.width = Math.max(24 / z, visW * hRatio) + 'px';
    hthumb.style.height = bar + 'px';
    vthumb.style.left = '0';
    vthumb.style.top = ((panY / maxY) * (visH - visH * vRatio)) + 'px';
    vthumb.style.width = bar + 'px';
    vthumb.style.height = Math.max(24 / z, visH * vRatio) + 'px';
  })()`;
}

async function paintHud(page) {
  if (pageClosed(page)) return;
  await page.evaluate(hudScript()).catch(() => {});
}

async function refreshGeometry(page, { light = false } = {}) {
  const bounds = light ? null : await maximizeWindow(page);
  const geo = await measureGlass(page, bounds);
  const fitZoom = computeFitZoom(geo.presetW, geo.presetH, geo.glassW, geo.glassH);
  const prev = readState(page);
  let zoom = fitZoom;
  if (prev && prev.userZoom === true) {
    zoom = snapZoomToPixels(
      Math.min(MAX_ZOOM, Math.max(fitZoom, num(prev.zoom, fitZoom))),
      geo.presetW,
      geo.presetH,
      geo.glassW,
      geo.glassH
    );
  }
  const pan = clampPan(
    prev ? prev.panX : 0,
    prev ? prev.panY : 0,
    zoom,
    geo.presetW,
    geo.presetH,
    geo.glassW,
    geo.glassH
  );
  return writeState(page, {
    zoom,
    panX: pan.panX,
    panY: pan.panY,
    fitZoom,
    glassW: geo.glassW,
    glassH: geo.glassH,
    presetW: geo.presetW,
    presetH: geo.presetH
  });
}

async function handleHudCommand(page, cmd) {
  if (pageClosed(page)) return;
  page._ctGlassHudTail = Promise.resolve(page._ctGlassHudTail).then(async () => {
    if (pageClosed(page)) return;
    const op = String((cmd && cmd.op) || '');
    let st = readState(page) || await refreshGeometry(page);
    if (op === 'zoomBy') {
      const delta = num(cmd.delta, 0);
      const raw = Math.min(MAX_ZOOM, Math.max(st.fitZoom, num(st.zoom, 1) + (delta > 0 ? ZOOM_STEP : -ZOOM_STEP)));
      const next = snapZoomToPixels(raw, st.presetW, st.presetH, st.glassW, st.glassH);
      st = writeState(page, { zoom: next, userZoom: Math.abs(next - st.fitZoom) > 0.001 });
    } else if (op === 'fit') {
      st = writeState(page, { zoom: st.fitZoom, panX: 0, panY: 0, userZoom: false });
    } else if (op === 'panBy') {
      st = writeState(page, {
        panX: num(st.panX, 0) + num(cmd.dx, 0),
        panY: num(st.panY, 0) + num(cmd.dy, 0)
      });
    } else if (op === 'panTo') {
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(cmd, 'panX')) patch.panX = num(cmd.panX, 0);
      if (Object.prototype.hasOwnProperty.call(cmd, 'panY')) patch.panY = num(cmd.panY, 0);
      st = writeState(page, patch);
    } else {
      return;
    }
    const pan = clampPan(st.panX, st.panY, st.zoom, st.presetW, st.presetH, st.glassW, st.glassH);
    writeState(page, pan);
    await paint(page);
    await paintHud(page);
  }).catch(() => {});
  return page._ctGlassHudTail;
}

async function applyGlassViewerOnce(page, opts = {}) {
  const source = String((opts && opts.source) || 'apply').slice(0, 80);
  const light = source === 'framenavigated';
  await installRuntime(page);
  if (!page._ctGlassNavHook) {
    page._ctGlassNavHook = true;
    page.on('framenavigated', (frame) => {
      try {
        if (!frame || frame !== page.mainFrame()) return;
        try { clearTimeout(page._ctGlassNavTimer); } catch {}
        page._ctGlassNavTimer = setTimeout(() => {
          applyGlassViewer(page, { source: 'framenavigated' }).catch(() => {});
        }, 220);
      } catch {}
    });
  }
  const st = await refreshGeometry(page, { light });
  await paint(page);
  await paintHud(page);
  if (process.env.BROWSER_DEBUG === '1') {
    logger.debug('[GLASS] visor aplicado', {
      source,
      zoom: st.zoom,
      fit: st.fitZoom,
      glass: `${Math.round(st.glassW)}x${Math.round(st.glassH)}`,
      preset: `${Math.round(st.presetW)}x${Math.round(st.presetH)}`
    });
  }
  return st;
}

async function applyGlassViewer(page, opts = {}) {
  if (!page || pageClosed(page)) return null;
  const source = String((opts && opts.source) || 'apply').slice(0, 80);
  if (page._ctGlassApplyInflight) {
    page._ctGlassApplyQueued = source;
    try { return await page._ctGlassApplyInflight; } catch { return readState(page); }
  }
  page._ctGlassApplyInflight = (async () => {
    try {
      return await applyGlassViewerOnce(page, opts);
    } catch (e) {
      try {
        logger.warn('[GLASS] falha ao aplicar visor (seguindo)', {
          source,
          err: String((e && e.message) || e).slice(0, 180)
        });
      } catch {}
      return null;
    } finally {
      page._ctGlassApplyInflight = null;
      const queued = page._ctGlassApplyQueued;
      page._ctGlassApplyQueued = '';
      if (queued && !pageClosed(page)) {
        try { await applyGlassViewer(page, { source: queued }); } catch {}
      }
    }
  })();
  return page._ctGlassApplyInflight;
}

module.exports = {
  applyGlassViewer,
  computeFitZoom,
  toLayoutCoords,
  clampPan,
  visibleNeedsPan,
  panAxes,
  CHROME_UI_DIP
};
