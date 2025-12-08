// scripts/virtus.js
/**
 * Bootstrapper do Virtus: Mantém uma aba do Messenger aberta/ativa/logada
 * e integra com o Orquestrador Central de Atendimento (VirtusOrchestrator).
 * 
 * Responsabilidades:
 * - Garantir que a aba principal (marketplace) está aberta
 * - Instalar o watcher de novos chats na UI (MutationObserver/DOM Observer)
 * - Enviar cada chatId detectado para o método onNewChatDetected() do VirtusOrchestrator
 * - Chamar orch.start() no boot e orch.stop() no stop
 */

const { VirtusOrchestrator } = require('./virtusAtendimento.js');
const dom = require('./virtusDom.js');
const commitClient = require('./commitClient.js');
const logger = require('./logger.js');
const stepLog = require('./stepLog.js');

// Helper para obter browser a partir de page
function getBrowserFromPage(p) {
  try {
    return typeof p.browser === 'function' ? p.browser() : null;
  } catch {
    return null;
  }
}

async function startVirtus(browser, nome, robeMeta = {}) {
  let running = true;
  let page = null;
  const orch = new VirtusOrchestrator(browser, nome, { commitClient });

  async function ensurePage() {
    if (!running) return null;
    try {
      const pages = await browser.pages();
      page = pages && pages[0] ? pages[0] : page;
      if (!page) {
        page = await browser.newPage();
      }
      await dom.garantirMarketplace(page);
      return page;
    } catch (e) {
      logger.warn('[VIRTUS] ensurePage falhou', { nome, error: e && e.message || e });
      return null;
    }
  }

  // Instala watcher de novos chats (MutationObserver no grid de conversas)
  async function installNewChatObserver(p) {
    await p.exposeFunction('__virtusOnNewChat', async (id) => {
      try {
        await orch.onNewChatDetected(String(id));
      } catch {}
    });
    await p.evaluateOnNewDocument(() => {
      window.__virtusSeen = new Set();
      function extractIdFromHref(href) {
        try {
          const pos = href.indexOf('/marketplace/t/');
          if (pos < 0) return null;
          const rest = href.slice(pos + '/marketplace/t/'.length);
          return rest.split(/[/?#]/)[0];
        } catch {
          return null;
        }
      }
      function scan() {
        const anchors = Array.from(document.querySelectorAll('a[href^="/marketplace/t/"]'));
        for (const a of anchors) {
          const id = extractIdFromHref(a.getAttribute('href') || a.href || '');
          if (!id) continue;
          if (!window.__virtusSeen.has(id)) {
            window.__virtusSeen.add(id);
            try {
              window.__virtusOnNewChat && window.__virtusOnNewChat(id);
            } catch {}
          }
        }
      }
      document.addEventListener('DOMContentLoaded', () => {
        scan();
        const grid = document.querySelector('div[role="grid"]') || document.body;
        const obs = new MutationObserver(() => scan());
        obs.observe(grid, { childList: true, subtree: true });
        setInterval(scan, 5000);
      });
    });
  }

  // bootstrap
  await ensurePage();
  if (page) {
    await installNewChatObserver(page).catch(() => {});
  }
  await orch.start();

  return {
    stop: async () => {
      running = false;
      await orch.stop();
    }
  };
}

module.exports = { startVirtus };
