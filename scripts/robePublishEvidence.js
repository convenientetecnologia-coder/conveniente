'use strict';

const { isPublishMarked, operationName } = require('./mobilePublishProxy');

function summarizeResponse(text) {
  const out = { parsed: false, hasErrors: false, listingIds: [], dataFields: [], completedFields: [], operationError: false, creationError: false };
  const clean = String(text || '').replace(/^for\s*\(;;\);\s*/, '').trim();
  let documents;
  try { documents = [JSON.parse(clean)]; } catch {
    documents = clean.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  }
  const ids = new Set();
  let visited = 0;
  function visit(node, key, depth) {
    if (!node || typeof node !== 'object' || depth > 18 || ++visited > 15000) return;
    if (Array.isArray(node.errors) && node.errors.length) out.hasErrors = true;
    if ((/listing/i.test(key) || /Marketplace.*Listing/i.test(String(node.__typename || ''))) && /^\d{5,}$/.test(String(node.id || ''))) ids.add(String(node.id));
    for (const [childKey, value] of Object.entries(node)) visit(value, childKey, depth + 1);
  }
  for (const doc of documents) {
    out.parsed = true;
    if (doc.data && typeof doc.data === 'object') {
      out.dataFields.push(...Object.keys(doc.data).slice(0, 10));
      for (const [key, value] of Object.entries(doc.data)) {
        if (/listing.*create|create.*listing/i.test(key) && value && typeof value === 'object' && (value.success === false || value.ok === false || value.error || value.error_message)) out.creationError = true;
        if (/renew|relist|bump/i.test(key) && value && typeof value === 'object' && (value.success === false || value.ok === false || value.error || value.error_message)) out.operationError = true;
        if (value === true || (value && typeof value === 'object' && Object.keys(value).length > 0)) out.completedFields.push(key);
      }
    }
    visit(doc, '', 0);
  }
  out.listingIds = Array.from(ids).slice(0, 8);
  return out;
}

// Observação passiva. Não salva corpo, cookies nem cabeçalhos.
function watch(page, { operation = 'publish' } = {}) {
  const requests = new Map();
  let armed = false;
  function onRequest(req) {
    if (!armed) return;
    try {
      const url = new URL(req.url());
      if (!(url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))) return;
      if (!/api\/graphql|ajax\/bulk/.test(url.pathname) || req.method() !== 'POST') return;
      const body = req.postData() || '', headers = req.headers();
      if (operation === 'renew') {
        const name = operationName(body) || String(headers['x-fb-friendly-name'] || '');
        if (/query/i.test(name) || !/renew|relist|bump/i.test(name || body)) return;
      } else if (!isPublishMarked({ postData: body, headers })) return;
      requests.set(req, { finished: false, failed: false, status: null, bodyPending: false });
    } catch {}
  }
  async function onResponse(res) {
    try {
      const row = requests.get(res.request());
      if (!row) return;
      row.status = res.status();
      if (typeof res.text === 'function') {
        row.bodyPending = true;
        try { Object.assign(row, summarizeResponse(await res.text())); } catch { row.parsed = false; }
        finally { row.bodyPending = false; }
      }
    } catch {}
  }
  function onFinished(req) {
    if (requests.has(req)) requests.get(req).finished = true;
  }
  function onFailed(req) {
    if (requests.has(req)) requests.get(req).failed = true;
  }
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  return {
    arm() { armed = true; },
    snapshot() {
      const rows = Array.from(requests.values());
      const success = rows.find(row => row.finished && !row.failed && row.status >= 200 && row.status < 300);
      const confirmed = rows.find(row => row.finished && !row.failed && row.status >= 200 && row.status < 300 && row.parsed && !row.hasErrors && !row.creationError && row.listingIds?.length && row.completedFields?.some(key => /listing.*create|create.*listing/i.test(key)));
      const operationConfirmed = rows.some(row => row.finished && !row.failed && row.status >= 200 && row.status < 300 && row.parsed && !row.hasErrors && !row.operationError && row.completedFields?.some(key => /renew|relist|bump/i.test(key)));
      return {
        seen: rows.length > 0, finished: !!success || rows.some(row => row.finished),
        failed: rows.length > 0 && rows.every(row => row.failed), status: (confirmed || success || rows[0])?.status ?? null,
        bodyPending: rows.some(row => row.bodyPending), transportOk: !!success,
        creationConfirmed: !!confirmed, listingIds: confirmed?.listingIds || [],
        operationConfirmed,
        hasErrors: rows.some(row => row.hasErrors), dataFields: rows.flatMap(row => row.dataFields || []).slice(0, 10)
      };
    },
    cleanup() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
    }
  };
}

async function readSellerListingState(page, listingId) {
  return page.evaluate(id => {
    if (!/\/marketplace\/you\/selling/.test(location.pathname)) return { found: false, reason: 'not_selling' };
    let result = null, visited = 0;
    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 35 || ++visited > 80000 || result) return;
      if (String(node.id || '') === id && node.is_viewer_seller === true) {
        const duplicate = node.is_duplicate === true;
        const rejected = node.listing_is_rejected === true;
        const statusText = String(node.listing_status_indicator?.content || node.integrity_status_indicator?.content || '').slice(0, 500);
        const normalizedStatus = statusText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const underReview = /sendo analisad|em analise|sob analise|em revisao|under review|being reviewed|pending review/.test(normalizedStatus);
        const pending = node.is_pending === true || node.mi_vh_idv_pending_review === true || underReview;
        result = {
          found: true, listingId: id, ownListing: true, duplicate, rejected, pending, underReview,
          active: node.is_live === true && !duplicate && !rejected && !pending && node.is_sold !== true,
          statusText,
          source: 'seller_listing_data'
        };
        return;
      }
      for (const value of Object.values(node)) walk(value, depth + 1);
    }
    for (const script of document.scripts) {
      if (!(script.textContent || '').includes(id)) continue;
      try { walk(JSON.parse(script.textContent), 0); } catch {}
      if (result) break;
    }
    return result || { found: false, listingId: id };
  }, String(listingId));
}

module.exports = { watch, summarizeResponse, readSellerListingState };
