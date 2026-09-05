'use strict';

/**
 * CONTRATO VIDRO/VISOR 2026-09-04_glass_human_only_v2
 *
 * Trabalho (Abrir Tudo / Robe / Virtus / configure):
 *   - Identidade: page.setViewport(preset) — uns maiores, outros menores.
 *   - Janela fisica = tamanho do preset. SEM maximize, SEM scale, SEM HUD,
 *     SEM hook de navegacao, SEM DeviceMetricsOverride de visor.
 *   - applyGlassViewer sem arma humana e no-op (zero CDP).
 *
 * Humano (invocar humano / enterHumanMode):
 *   - enableGlassForHuman arma a page e so ai monta o vidro:
 *     janela maximizada + scale/letterbox + zoom Ctrl+/- + HUD.
 *
 * Retomar trabalho:
 *   - disableGlassForWork desarma PRIMEIRO, tira o hook, apaga paint/HUD,
 *     volta a janela para o tamanho do preset, relock do setViewport.
 *
 * 1) Identidade: page.setViewport(preset) permanece. innerWidth/innerHeight/DPR
 *    nao mudam aqui.
 * 2) Vidro: janela maximizada na MAE — SOMENTE com arma humana.
 * 3) Visor: encaixa o preset no vidro (scale up ou down, contain). Se a
 *    proporcao nao fecha, letterbox centralizado — nao recorta o canto
 *    superior esquerdo. Zoom do operador (Ctrl +/- / roda com Ctrl) pode
 *    passar do vidro; ai pan com barras e com a roda (sem Ctrl). Snap de
 *    pixel nao pode capar o zoom do operador no fit/vidro.
 * 4) Cliques: com transform no html, getBoundingClientRect e o mouse do
 *    Puppeteer falam o mesmo espaco visual. Nao converter coordenadas.
 * 5) Overlay humano: ancora no vidro visivel, nao no innerWidth virtual.
 *    Sem vidro, o overlay cai no inner/outer (ja e o fallback).
 *
 * Prova empirica (Chrome headful): setPageScaleFactor nao encolhe;
 * DeviceMetricsOverride recorta o canto superior esquerdo quando tambem
 * trava o visible size no preset. Depois do setViewport, o visor reenvia
 * as mesmas metricas com dontSetVisibleSize=true para o desenho acompanhar
 * a janela. Sem isso a pagina vira uma telinha no canto. Transform/scale
 * no html encaixa compositor + TR.
 *
 * Geometria colapsada (fit < 0.40 ou vidro minusculo) nao aplica scale.
 *
 * GLASS_VIEWER=0: kill-switch ate no humano (nao pinta). Default 1 = vidro
 * disponivel para humano, nao "ligado o tempo todo".
 */

const logger = require('./logger.js');

const CHROME_TOOLBAR_DIP = 90;
const CHROME_INFOBAR_DIP = 40;
const CHROME_SAFE_DIP = 6;
const CHROME_UI_DIP = CHROME_TOOLBAR_DIP + CHROME_INFOBAR_DIP + CHROME_SAFE_DIP;
const WIN_MAX_CHROME_DIP = 16;
const MIN_FIT = 0.12;
const MIN_SANE_FIT = 0.40;
const MIN_SANE_GLASS_W = 500;
const MIN_SANE_GLASS_H = 400;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.12;
const HUD_ID = 'ct-glass-viewer-hud';
const HUD_MARK = '3';

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const GLASS_VIEWER_ACTIVE = String(process.env.GLASS_VIEWER || '1').trim() !== '0';

function isGlassViewerEnabled() {
  return GLASS_VIEWER_ACTIVE === true;
}

function isGlassArmed(page) {
  return !!(page && page._ctGlassHumanArmed === true);
}

function isGlassReady(page) {
  if (!isGlassArmed(page)) return false;
  if (page._ctGlassPainted === true) return true;
  const st = readState(page);
  return !!(st && st.disabled === true);
}

function snapshotIdentityViewport(page) {
  if (page && page._ctGlassIdentityVp && page._ctGlassIdentityVp.width >= 800 && page._ctGlassIdentityVp.height >= 600) {
    return page._ctGlassIdentityVp;
  }
  if (!page || typeof page.viewport !== 'function') return null;
  const vp = page.viewport() || {};
  const width = Math.floor(num(vp.width, 0));
  const height = Math.floor(num(vp.height, 0));
  if (width < 800 || height < 600) return null;
  const dprRaw = num(vp.deviceScaleFactor, 1);
  const snap = {
    width,
    height,
    deviceScaleFactor: (dprRaw >= 1 && dprRaw <= 3) ? dprRaw : 1,
    isMobile: vp.isMobile === true,
    hasTouch: vp.hasTouch === true,
    isLandscape: vp.isLandscape === true
  };
  page._ctGlassIdentityVp = snap;
  return snap;
}

function armGlass(page) {
  if (page) page._ctGlassHumanArmed = true;
}

function disarmGlass(page) {
  if (!page) return;
  page._ctGlassHumanArmed = false;
  page._ctGlassPainted = false;
  page._ctGlassApplyQueued = '';
  try { clearTimeout(page._ctGlassNavTimer); } catch {}
  page._ctGlassNavTimer = null;
}

function geometryLooksCollapsed(st) {
  if (!st) return false;
  const fit = num(st.fitZoom, 1);
  const gw = num(st.glassW, 0);
  const gh = num(st.glassH, 0);
  return (fit + 1e-9) < MIN_SANE_FIT || gw < MIN_SANE_GLASS_W || gh < MIN_SANE_GLASS_H;
}

function snapZoomToPixels(z, presetW, presetH) {
  const z0 = num(z, 1);
  if (!Number.isFinite(z0) || z0 <= 0) return 1;
  if (Math.abs(z0 - 1) < 0.0005) return 1;
  const pw = Math.max(1, num(presetW, 1));
  const w = Math.max(1, Math.round(pw * z0));
  const snapped = w / pw;
  if (!Number.isFinite(snapped) || snapped <= 0) {
    return Math.max(MIN_FIT, Math.min(MAX_ZOOM, z0));
  }
  return Math.max(MIN_FIT, Math.min(MAX_ZOOM, snapped));
}

function computeFitZoom(presetW, presetH, glassW, glassH, opts = {}) {
  const pw = Math.max(1, num(presetW, 1));
  const ph = Math.max(1, num(presetH, 1));
  const gw = Math.max(1, num(glassW, 1));
  const gh = Math.max(1, num(glassH, 1));
  const allowUpscale = opts.allowUpscale !== false;
  let z = Math.min(gw / pw, gh / ph);
  if (!Number.isFinite(z) || z <= 0) return 1;
  if (!allowUpscale) z = Math.min(1, z);
  if (z >= 0.999 && z <= 1.001) return 1;
  const w = Math.max(1, Math.floor(pw * z + 1e-9));
  const zSnap = w / pw;
  const snapped = Number.isFinite(zSnap) && zSnap > 0 ? Math.min(z, zSnap) : z;
  return Math.max(MIN_FIT, Math.min(MAX_ZOOM, snapped));
}

function computeLetterbox(presetW, presetH, glassW, glassH, zoom) {
  const z = num(zoom, 1) > 0 ? num(zoom, 1) : 1;
  const visW = Math.max(1, num(presetW, 1) * z);
  const visH = Math.max(1, num(presetH, 1) * z);
  return {
    offsetX: Math.max(0, (num(glassW, 1) - visW) / 2),
    offsetY: Math.max(0, (num(glassH, 1) - visH) / 2)
  };
}

function stepOperatorZoom(currentZoom, delta, fitZoom, presetW, presetH) {
  const fit = num(fitZoom, 1);
  const cur = num(currentZoom, 1);
  const raw = Math.min(MAX_ZOOM, Math.max(fit, cur + (delta > 0 ? ZOOM_STEP : -ZOOM_STEP)));
  let next = snapZoomToPixels(raw, presetW, presetH);
  if (delta > 0 && next <= cur + 1e-9 && raw > cur + 1e-9) next = raw;
  if (delta < 0 && next >= cur - 1e-9 && raw < cur - 1e-9) next = raw;
  return Math.max(fit, Math.min(MAX_ZOOM, next));
}

function toLayoutCoords(visualX, visualY, zoom, panX, panY, offsetX, offsetY) {
  const z = num(zoom, 1) > 0 ? num(zoom, 1) : 1;
  return {
    x: (num(visualX, 0) - num(offsetX, 0)) / z + num(panX, 0),
    y: (num(visualY, 0) - num(offsetY, 0)) / z + num(panY, 0)
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

function emptyState() {
  return {
    zoom: 1,
    panX: 0,
    panY: 0,
    fitZoom: 1,
    glassW: 0,
    glassH: 0,
    presetW: 0,
    presetH: 0,
    offsetX: 0,
    offsetY: 0,
    userZoom: false,
    unlocked: false,
    locked: false
  };
}

function readState(page) {
  return page && page._ctGlassViewer && typeof page._ctGlassViewer === 'object'
    ? page._ctGlassViewer
    : null;
}

function writeState(page, patch) {
  const prev = readState(page) || emptyState();
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

async function maximizeWindow(page, { skipMaximize = false } = {}) {
  const auxiliary = await isAuxiliaryWindow(page);
  const client = await page.target().createCDPSession();
  try {
    const { windowId } = await client.send('Browser.getWindowForTarget');
    let info = await client.send('Browser.getWindowBounds', { windowId });
    const state = String((info && info.bounds && info.bounds.windowState) || '');
    if (!skipMaximize && !auxiliary && state !== 'maximized') {
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

function resolveGlassDimensions({
  boundsW = 0,
  boundsH = 0,
  outerW = 0,
  outerH = 0,
  visualW = 0,
  visualH = 0,
  presetW = 0,
  presetH = 0
} = {}) {
  const bw = num(boundsW, 0);
  const bh = num(boundsH, 0);
  const ow = num(outerW, 0);
  const oh = num(outerH, 0);
  const vw = num(visualW, 0);
  const vh = num(visualH, 0);
  const pw = Math.max(1, num(presetW, 1));
  const ph = Math.max(1, num(presetH, 1));
  let glassW = 0;
  let glassH = 0;
  let source = 'preset_fallback';

  // Browser.getWindowBounds é a medida física do vidro. O viewport emulado
  // pode continuar devolvendo exatamente o preset mesmo quando metade dele
  // está fora da tela; nesse caso usar visualViewport recria o recorte.
  if (bw >= 400 && bh >= 300) {
    glassW = Math.max(320, bw - WIN_MAX_CHROME_DIP);
    glassH = Math.max(240, bh - WIN_MAX_CHROME_DIP - CHROME_UI_DIP);
    source = 'window_bounds';
  } else if (ow >= 400 && oh >= 300) {
    glassW = Math.max(320, ow - WIN_MAX_CHROME_DIP);
    glassH = Math.max(240, oh - CHROME_UI_DIP);
    source = 'outer_window';
  } else if (vw >= 400 && vh >= 300) {
    glassW = vw;
    glassH = vh;
    source = 'visual_viewport';
  } else {
    glassW = Math.max(320, vw || pw);
    glassH = Math.max(240, vh || ph);
  }

  const visualLooksPreset = vw > 0 && vh > 0
    && Math.abs(vw - pw) <= 4
    && Math.abs(vh - ph) <= 4;
  const visualDiffersFromGlass = vw > 0 && vh > 0
    && (Math.abs(vw - glassW) > 8 || Math.abs(vh - glassH) > 8);

  return {
    glassW,
    glassH,
    source,
    locked: visualLooksPreset && visualDiffersFromGlass
  };
}

async function unlockVisibleSize(page) {
  if (pageClosed(page)) return false;
  const vp = (typeof page.viewport === 'function' ? page.viewport() : null) || {};
  const width = Math.floor(num(vp.width, 0));
  const height = Math.floor(num(vp.height, 0));
  if (width < 800 || height < 600) return false;
  const dprRaw = num(vp.deviceScaleFactor, 1);
  const deviceScaleFactor = (dprRaw >= 1 && dprRaw <= 3) ? dprRaw : 1;
  try {
    const client = await page.target().createCDPSession();
    try {
      await client.send('Emulation.setDeviceMetricsOverride', {
        mobile: vp.isMobile === true,
        width,
        height,
        deviceScaleFactor,
        screenOrientation: vp.isLandscape
          ? { angle: 90, type: 'landscapePrimary' }
          : { angle: 0, type: 'portraitPrimary' },
        dontSetVisibleSize: true
      });
      return true;
    } finally {
      try { await client.detach(); } catch {}
    }
  } catch {
    return false;
  }
}

async function readCssVisualViewport(page) {
  try {
    const client = await page.target().createCDPSession();
    try {
      const metrics = await client.send('Page.getLayoutMetrics');
      return (metrics && (metrics.cssVisualViewport || metrics.visualViewport)) || {};
    } finally {
      try { await client.detach(); } catch {}
    }
  } catch {
    return {};
  }
}

async function measureGlass(page, bounds) {
  const cssVis = await readCssVisualViewport(page);
  const js = await page.evaluate(() => ({
    innerW: window.innerWidth || 0,
    innerH: window.innerHeight || 0,
    outerW: window.outerWidth || 0,
    outerH: window.outerHeight || 0,
    vvW: (window.visualViewport && window.visualViewport.width) || 0,
    vvH: (window.visualViewport && window.visualViewport.height) || 0
  }));
  const vp = (typeof page.viewport === 'function' ? page.viewport() : null) || {};
  const presetW = Math.max(1, num(vp.width, 0) || num(js.innerW, 1));
  const presetH = Math.max(1, num(vp.height, 0) || num(js.innerH, 1));
  const visW = num(cssVis.clientWidth, 0) || num(cssVis.width, 0) || num(js.vvW, 0);
  const visH = num(cssVis.clientHeight, 0) || num(cssVis.height, 0) || num(js.vvH, 0);
  const boundsW = num(bounds && bounds.width, 0);
  const boundsH = num(bounds && bounds.height, 0);
  const resolved = resolveGlassDimensions({
    boundsW,
    boundsH,
    outerW: js.outerW,
    outerH: js.outerH,
    visualW: visW,
    visualH: visH,
    presetW,
    presetH
  });
  return {
    presetW,
    presetH,
    glassW: resolved.glassW,
    glassH: resolved.glassH,
    innerW: js.innerW,
    innerH: js.innerH,
    outerW: js.outerW,
    outerH: js.outerH,
    visualW: visW,
    visualH: visH,
    boundsW,
    boundsH,
    glassSource: resolved.source,
    locked: resolved.locked
  };
}

function paintScript(st) {
  const z = num(st.zoom, 1);
  const px = num(st.panX, 0);
  const py = num(st.panY, 0);
  const ox = num(st.offsetX, 0);
  const oy = num(st.offsetY, 0);
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
    var ox = ${ox};
    var oy = ${oy};
    var html = document.documentElement;
    if (!html) return;
    var none = (z === 1 && px === 0 && py === 0 && ox === 0 && oy === 0);
    html.style.transformOrigin = '0 0';
    html.style.backfaceVisibility = none ? '' : 'hidden';
    html.style.overflow = none ? '' : 'hidden';
    html.style.transform = none ? 'none' : ('translateZ(0) translate(' + ox + 'px,' + oy + 'px) scale(' + z + ') translate(' + (-px) + 'px,' + (-py) + 'px)');
    window.__ctGlassViewerState = {
      zoom: z, panX: px, panY: py,
      offsetX: ox, offsetY: oy,
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

async function clearGlassPaint(page) {
  if (pageClosed(page)) return;
  await page.evaluate(() => {
    try {
      const html = document.documentElement;
      if (html) {
        html.style.transform = 'none';
        html.style.transformOrigin = '';
        html.style.backfaceVisibility = '';
        html.style.overflow = '';
      }
      const hud = document.getElementById('ct-glass-viewer-hud');
      if (hud) hud.remove();
      window.__ctGlassViewerState = null;
    } catch (e) {}
  }).catch(() => {});
}

async function paint(page) {
  if (pageClosed(page)) return;
  if (!isGlassArmed(page) || !isGlassViewerEnabled()) {
    await clearGlassPaint(page);
    return;
  }
  const st = readState(page);
  if (!st || st.collapsed || st.disabled || geometryLooksCollapsed(st)) {
    await clearGlassPaint(page);
    return;
  }
  await page.evaluate(paintScript(st)).catch(() => {});
}

function pageInstallRuntime() {
  try {
    if (window.__ctGlassRuntimeWatch) return;
    window.__ctGlassRuntimeWatch = true;
    const restore = () => {
      try {
        const st = window.__ctGlassViewerState;
        const html = document.documentElement;
        if (!st) {
          if (html && html.style.transform && html.style.transform !== 'none') {
            html.style.transform = 'none';
            html.style.transformOrigin = '';
            html.style.backfaceVisibility = '';
            html.style.overflow = '';
          }
          try {
            const hud = document.getElementById('ct-glass-viewer-hud');
            if (hud) hud.remove();
          } catch (e2) {}
          return;
        }
        if (!html) return;
        const z = Number(st.zoom) || 1;
        const px = Number(st.panX) || 0;
        const py = Number(st.panY) || 0;
        const ox = Number(st.offsetX) || 0;
        const oy = Number(st.offsetY) || 0;
        const none = (z === 1 && px === 0 && py === 0 && ox === 0 && oy === 0);
        const want = none ? 'none' : ('translateZ(0) translate(' + ox + 'px,' + oy + 'px) scale(' + z + ') translate(' + (-px) + 'px,' + (-py) + 'px)');
        if (html.style.transform !== want) {
          html.style.transformOrigin = '0 0';
          html.style.backfaceVisibility = none ? '' : 'hidden';
          html.style.overflow = none ? '' : 'hidden';
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
        if (!window.__ctGlassViewerState) return;
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
        if (!st) return;
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          window.__ctGlassViewerCmd && window.__ctGlassViewerCmd({
            op: 'zoomBy',
            delta: ev.deltaY < 0 ? 1 : -1
          });
          return;
        }
        if (st.needPan !== true) return;
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
  try { await page.evaluate(pageInstallRuntime); } catch {}
}

function hudScript() {
  return `(function(){
    var ID = '${HUD_ID}';
    var MARK = '${HUD_MARK}';
    var st = window.__ctGlassViewerState || {};
    var z = Number(st.zoom) || 1;
    if (z <= 0) z = 1;
    var panX = Number(st.panX) || 0;
    var panY = Number(st.panY) || 0;
    var ox = Number(st.offsetX) || 0;
    var oy = Number(st.offsetY) || 0;
    var gw = Number(st.glassW) || 0;
    var gh = Number(st.glassH) || 0;
    var needPan = st.needPan === true;
    var needPanX = st.needPanX === true;
    var needPanY = st.needPanY === true;
    var host = document.getElementById(ID);
    if (host && host.getAttribute('data-ct-hud') !== MARK) {
      try { host.remove(); } catch (e) {}
      host = null;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = ID;
      host.setAttribute('data-ct-hud', MARK);
      host.style.zIndex = '2147483646';
      host.style.pointerEvents = 'none';
      host.style.userSelect = 'none';
      (document.documentElement || document.body).appendChild(host);
      var shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = ''
        + '<style>'
        + '.hbar,.vbar{position:absolute;background:rgba(15,23,42,.58);pointer-events:auto;border-radius:7px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);}'
        + '.hthumb,.vthumb{position:absolute;background:#93c5fd;border-radius:7px;box-shadow:0 0 0 1px rgba(15,23,42,.25);}'
        + '.hbar:hover .hthumb,.vbar:hover .vthumb{background:#bfdbfe;}'
        + '.chip{position:absolute;pointer-events:none;background:rgba(15,23,42,.72);color:#e2e8f0;font:600 11px/1.2 "Segoe UI",system-ui,sans-serif;padding:4px 8px;border-radius:999px;letter-spacing:.02em;box-shadow:0 6px 16px rgba(0,0,0,.28);}'
        + '</style>'
        + '<div class="hbar" id="hbar"><div class="hthumb" id="hthumb"></div></div>'
        + '<div class="vbar" id="vbar"><div class="vthumb" id="vthumb"></div></div>'
        + '<div class="chip" id="chip"></div>';
      var drag = null;
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
    var chip = shadow.getElementById('chip');
    var visW = gw / z;
    var visH = gh / z;
    var bar = 12 / z;
    var originX = panX - (ox / z);
    var originY = panY - (oy / z);
    var pct = Math.round(z * 100);
    if (chip) {
      chip.style.display = 'block';
      chip.textContent = pct + '%  ·  Ctrl+0';
      chip.style.left = (originX + visW - (92 / z)) + 'px';
      chip.style.top = (originY + visH - (28 / z)) + 'px';
      chip.style.fontSize = (11 / z) + 'px';
      chip.style.padding = (4 / z) + 'px ' + (8 / z) + 'px';
    }
    if (!needPan) {
      hbar.style.display = 'none';
      vbar.style.display = 'none';
      return;
    }
    hbar.style.display = needPanX ? 'block' : 'none';
    vbar.style.display = needPanY ? 'block' : 'none';
    hbar.style.left = originX + 'px';
    hbar.style.top = (originY + visH - bar) + 'px';
    hbar.style.width = visW + 'px';
    hbar.style.height = bar + 'px';
    vbar.style.left = (originX + visW - bar) + 'px';
    vbar.style.top = originY + 'px';
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
  if (!isGlassArmed(page) || !isGlassViewerEnabled()) {
    await clearGlassPaint(page);
    return;
  }
  const st = readState(page);
  if (!st || st.collapsed || st.disabled || geometryLooksCollapsed(st)) {
    await page.evaluate(() => {
      const hud = document.getElementById('ct-glass-viewer-hud');
      if (hud) try { hud.remove(); } catch (e) {}
    }).catch(() => {});
    return;
  }
  await page.evaluate(hudScript()).catch(() => {});
}

async function refreshGeometry(page, { light = false } = {}) {
  // Mesmo em navegação leve precisamos reler o vidro físico; usar apenas o
  // visualViewport emulado faz o fit voltar para 1 e recorta a página.
  const bounds = await maximizeWindow(page, { skipMaximize: light });
  const unlocked = await unlockVisibleSize(page);
  if (unlocked && !light) await sleep(80);
  const geo = await measureGlass(page, bounds);
  const allowUpscale = unlocked === true && geo.locked !== true;
  const fitZoom = computeFitZoom(geo.presetW, geo.presetH, geo.glassW, geo.glassH, { allowUpscale });
  const prev = readState(page);
  let zoom = fitZoom;
  if (prev && prev.userZoom === true) {
    zoom = snapZoomToPixels(
      Math.min(MAX_ZOOM, Math.max(fitZoom, num(prev.zoom, fitZoom))),
      geo.presetW,
      geo.presetH
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
  const box = computeLetterbox(geo.presetW, geo.presetH, geo.glassW, geo.glassH, zoom);
  return writeState(page, {
    zoom,
    panX: pan.panX,
    panY: pan.panY,
    fitZoom,
    glassW: geo.glassW,
    glassH: geo.glassH,
    presetW: geo.presetW,
    presetH: geo.presetH,
    offsetX: box.offsetX,
    offsetY: box.offsetY,
    unlocked: allowUpscale,
    locked: geo.locked === true,
    visualW: geo.visualW,
    visualH: geo.visualH,
    boundsW: geo.boundsW,
    boundsH: geo.boundsH,
    glassSource: geo.glassSource
  });
}

async function handleHudCommand(page, cmd) {
  if (pageClosed(page)) return;
  if (!isGlassArmed(page) || !isGlassViewerEnabled()) {
    await clearGlassPaint(page);
    return;
  }
  page._ctGlassHudTail = Promise.resolve(page._ctGlassHudTail).then(async () => {
    if (pageClosed(page)) return;
    const op = String((cmd && cmd.op) || '');
    let st = readState(page) || await refreshGeometry(page);
    if (op === 'zoomBy') {
      const next = stepOperatorZoom(st.zoom, num(cmd.delta, 0), st.fitZoom, st.presetW, st.presetH);
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
    const box = computeLetterbox(st.presetW, st.presetH, st.glassW, st.glassH, st.zoom);
    writeState(page, Object.assign({}, pan, box));
    await paint(page);
    await paintHud(page);
  }).catch(() => {});
  return page._ctGlassHudTail;
}

function attachNavHookIfArmed(page) {
  if (!isGlassArmed(page)) return;
  if (page._ctGlassNavHook) return;
  const onNav = (frame) => {
    try {
      if (!isGlassArmed(page)) return;
      if (!frame || frame !== page.mainFrame()) return;
      try { clearTimeout(page._ctGlassNavTimer); } catch {}
      page._ctGlassNavTimer = setTimeout(() => {
        if (!isGlassArmed(page)) return;
        applyGlassViewer(page, { source: 'framenavigated' }).catch(() => {});
      }, 220);
    } catch {}
  };
  page._ctGlassNavHookFn = onNav;
  page._ctGlassNavHook = true;
  page.on('framenavigated', onNav);
}

function detachNavHook(page) {
  if (!page) return;
  try { clearTimeout(page._ctGlassNavTimer); } catch {}
  page._ctGlassNavTimer = null;
  if (page._ctGlassNavHookFn) {
    try { page.off('framenavigated', page._ctGlassNavHookFn); } catch {}
    page._ctGlassNavHookFn = null;
  }
  page._ctGlassNavHook = false;
}

async function applyGlassViewerOnce(page, opts = {}) {
  const source = String((opts && opts.source) || 'apply').slice(0, 80);
  const light = source === 'framenavigated';
  if (!isGlassArmed(page)) {
    return readState(page);
  }
  if (!isGlassViewerEnabled()) {
    await clearGlassPaint(page);
    page._ctGlassPainted = false;
    return writeState(page, {
      zoom: 1, panX: 0, panY: 0, offsetX: 0, offsetY: 0,
      userZoom: false, disabled: true, collapsed: false
    });
  }
  attachNavHookIfArmed(page);
  await installRuntime(page);
  if (!isGlassArmed(page)) {
    await clearGlassPaint(page);
    return readState(page);
  }
  let st = await refreshGeometry(page, { light });
  if (!isGlassArmed(page)) {
    await clearGlassPaint(page);
    return readState(page);
  }
  if (geometryLooksCollapsed(st) && !light) {
    await sleep(180);
    if (!isGlassArmed(page)) {
      await clearGlassPaint(page);
      return readState(page);
    }
    st = await refreshGeometry(page, { light: false });
  }
  if (!isGlassArmed(page)) {
    await clearGlassPaint(page);
    return readState(page);
  }
  if (geometryLooksCollapsed(st)) {
    const next = writeState(page, {
      zoom: 1, panX: 0, panY: 0, offsetX: 0, offsetY: 0,
      userZoom: false, collapsed: true, disabled: false
    });
    await clearGlassPaint(page);
    page._ctGlassPainted = false;
    if (!page._ctGlassCollapsedLogged) {
      page._ctGlassCollapsedLogged = true;
      try {
        logger.warn('[GLASS] geometria colapsada — visor nao aplicado', {
          source,
          fit: st.fitZoom,
          glass: `${Math.round(st.glassW)}x${Math.round(st.glassH)}`,
          preset: `${Math.round(st.presetW)}x${Math.round(st.presetH)}`
        });
      } catch {}
    }
    return next;
  }
  writeState(page, { collapsed: false, disabled: false });
  await paint(page);
  await paintHud(page);
  if (isGlassArmed(page)) page._ctGlassPainted = true;
  const logSig = [
    Math.round(st.zoom * 10000),
    Math.round(st.glassW),
    Math.round(st.glassH),
    Math.round(st.presetW),
    Math.round(st.presetH),
    st.glassSource,
    st.locked ? 1 : 0
  ].join(':');
  if (page._ctGlassGeometryLogSig !== logSig) {
    page._ctGlassGeometryLogSig = logSig;
    try {
      logger.info('[GLASS] visor aplicado', {
        source,
        nome: String(page._convenientePatchedNome || '').slice(0, 120) || null,
        zoom: st.zoom,
        fit: st.fitZoom,
        glass: `${Math.round(st.glassW)}x${Math.round(st.glassH)}`,
        preset: `${Math.round(st.presetW)}x${Math.round(st.presetH)}`,
        bounds: `${Math.round(st.boundsW || 0)}x${Math.round(st.boundsH || 0)}`,
        visual: `${Math.round(st.visualW || 0)}x${Math.round(st.visualH || 0)}`,
        glassSource: st.glassSource || null,
        metricsLocked: st.locked === true,
        unlocked: st.unlocked === true
      });
    } catch {}
  }
  return st;
}

async function applyGlassViewer(page, opts = {}) {
  if (!page || pageClosed(page)) return null;
  if (!isGlassArmed(page)) return readState(page);
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
      if (queued && !pageClosed(page) && isGlassArmed(page)) {
        try { await applyGlassViewer(page, { source: queued }); } catch {}
      }
    }
  })();
  return page._ctGlassApplyInflight;
}

async function restoreWindowToWork(page, size) {
  if (pageClosed(page)) return false;
  const wantW = Math.floor(num(size && size.width, 0));
  const wantH = Math.floor(num(size && size.height, 0));
  try {
    const auxiliary = await isAuxiliaryWindow(page);
    if (auxiliary) return false;
    const client = await page.target().createCDPSession();
    try {
      const { windowId } = await client.send('Browser.getWindowForTarget');
      await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await sleep(80);
      const info = await client.send('Browser.getWindowBounds', { windowId });
      const cur = (info && info.bounds) || {};
      const curW = num(cur.width, 0);
      const curH = num(cur.height, 0);
      const stillHuge = wantW >= 800 && wantH >= 600 && (curW > wantW + 80 || curH > wantH + 80);
      if (stillHuge) {
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: {
            windowState: 'normal',
            left: Math.floor(num(cur.left, 0)),
            top: Math.floor(num(cur.top, 0)),
            width: wantW,
            height: wantH
          }
        });
      }
      return true;
    } finally {
      try { await client.detach(); } catch {}
    }
  } catch {
    return false;
  }
}

async function relockViewportIdentity(page, identity) {
  if (pageClosed(page)) return false;
  const snap = (identity && identity.width >= 800 && identity.height >= 600)
    ? identity
    : (page._ctGlassIdentityVp || snapshotIdentityViewport(page));
  if (!snap || snap.width < 800 || snap.height < 600) return false;
  try {
    await page.setViewport({
      width: snap.width,
      height: snap.height,
      deviceScaleFactor: snap.deviceScaleFactor,
      isMobile: snap.isMobile === true,
      hasTouch: snap.hasTouch === true,
      isLandscape: snap.isLandscape === true
    });
    return true;
  } catch {
    return false;
  }
}

async function enableGlassForHuman(page, opts = {}) {
  if (!page || pageClosed(page)) return null;
  snapshotIdentityViewport(page);
  armGlass(page);
  writeState(page, { disabled: false, collapsed: false });
  try { await page.bringToFront(); } catch {}
  const st = await applyGlassViewer(page, { source: String((opts && opts.source) || 'human').slice(0, 80) });
  if (st && st.disabled !== true && st.collapsed !== true && isGlassArmed(page)) {
    page._ctGlassPainted = true;
  }
  return st;
}

async function scrubIdleGlassPaint(page) {
  if (!page || pageClosed(page) || isGlassArmed(page)) return false;
  await clearGlassPaint(page);
  return true;
}

async function disableGlassForWork(page, opts = {}) {
  if (!page || pageClosed(page)) return null;
  const identity = page._ctGlassIdentityVp || snapshotIdentityViewport(page);
  disarmGlass(page);
  detachNavHook(page);
  if (page._ctGlassApplyInflight) {
    try { await page._ctGlassApplyInflight; } catch {}
  }
  disarmGlass(page);
  detachNavHook(page);
  await clearGlassPaint(page);
  await sleep(40);
  await clearGlassPaint(page);
  writeState(page, {
    zoom: 1, panX: 0, panY: 0, offsetX: 0, offsetY: 0,
    userZoom: false, disabled: true, collapsed: false
  });
  const winSize = (identity && identity.width >= 800)
    ? { width: identity.width, height: identity.height }
    : (opts && opts.windowSize);
  await restoreWindowToWork(page, winSize);
  await relockViewportIdentity(page, identity);
  return readState(page);
}

module.exports = {
  applyGlassViewer,
  enableGlassForHuman,
  disableGlassForWork,
  scrubIdleGlassPaint,
  snapshotIdentityViewport,
  isGlassArmed,
  isGlassReady,
  isGlassViewerEnabled,
  geometryLooksCollapsed,
  computeFitZoom,
  computeLetterbox,
  resolveGlassDimensions,
  snapZoomToPixels,
  stepOperatorZoom,
  toLayoutCoords,
  clampPan,
  visibleNeedsPan,
  panAxes,
  CHROME_UI_DIP,
  ZOOM_STEP,
  MAX_ZOOM
};
