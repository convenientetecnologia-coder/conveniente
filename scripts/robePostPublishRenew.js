'use strict';

/**
 * ROBE pós-publicação — renovação de classificados (desacoplada do fechar/abrir).
 *
 * Contrato:
 * - Só roda após publish_ok, depois do ID.
 * - Falha/timeout NUNCA invalida publish_ok.
 * - Auto: config enabled + plano due + ainda não renovou hoje.
 * - Marca doneToday quando o fluxo concluir ok (mesmo se none_renewable).
 */

const marketplaceRenewListings = require('./marketplaceRenewListings.js');
const marketplaceRenewPlan = require('./marketplaceRenewPlan.js');
const provisionAudit = require('./provisionAudit.js');
const stepLog = require('./stepLog.js');
const logger = require('./logger.js');

const BUDGET_TOTAL_MS = 35 * 60 * 1000;

function audit(nome, step, extra) {
  const payload = Object.assign(
    {
      ts: Date.now(),
      event: `robe_post_publish_renew_${step}`,
      nome: String(nome || ''),
      day: marketplaceRenewPlan.todaySaoPaulo()
    },
    extra || {}
  );
  try { provisionAudit.append(payload); } catch {}
  try { logger.info('[ROBE_POST_PUBLISH_RENEW]', Object.assign({ nome }, payload)); } catch {}
  return payload;
}

async function runRobeAutoRenew({
  page,
  nome,
  deadlineAt = 0,
  scrollStopAgeDays = null,
  decisionHint = null
} = {}) {
  const profileName = String(nome || '').trim();
  const startedAt = Date.now();
  const hardDeadline = Number(deadlineAt || 0) > 0
    ? Number(deadlineAt)
    : (startedAt + BUDGET_TOTAL_MS);

  try {
    const decision = decisionHint || await marketplaceRenewPlan.shouldAutoRenewAfterPublish(profileName);
    if (!decision || decision.shouldRun !== true) {
      audit(profileName, 'skip', {
        reason: (decision && decision.reason) || 'not_due',
        enabled: !!(decision && decision.enabled),
        dueLabel: decision && decision.plan ? decision.plan.dueLabel : null,
        scrollDays: decision && decision.plan ? decision.plan.scrollDays : null
      });
      return {
        ok: true,
        skipped: true,
        marked: false,
        reason: (decision && decision.reason) || 'not_due',
        renewedCount: 0
      };
    }

    if (!page) {
      audit(profileName, 'skip', { reason: 'page_gone' });
      return { ok: true, skipped: true, marked: false, reason: 'page_gone', renewedCount: 0 };
    }

    const scrollDays = Math.max(
      1,
      Number(scrollStopAgeDays != null ? scrollStopAgeDays : decision.scrollDays) || 0
    ) || Number(decision.scrollDays || 0) || 7;

    audit(profileName, 'begin', {
      scrollDays,
      dueLabel: decision.plan ? decision.plan.dueLabel : null
    });

    const r = await marketplaceRenewListings.runMarketplaceRenewListings({
      page,
      nome: profileName,
      mode: 'auto',
      deadlineAt: hardDeadline,
      scrollStopAgeDays: scrollDays,
      onAudit: (evt) => {
        try { provisionAudit.append({ ts: Date.now(), ...evt, source: 'robe_post_publish_renew' }); } catch {}
      }
    });

    const renewedCount = Math.max(0, Number(r && r.renewedCount || 0) || 0);
    const flowOk = !!(r && r.ok === true);
    if (flowOk) {
      try {
        await marketplaceRenewPlan.markDoneToday(profileName, {
          count: renewedCount,
          source: 'robe_post_publish_auto'
        });
      } catch {}
      audit(profileName, 'done', {
        renewedCount,
        reason: (r && r.reason) || 'renewed',
        durationMs: Date.now() - startedAt
      });
      return {
        ok: true,
        skipped: false,
        marked: true,
        renewedCount,
        reason: (r && r.reason) || 'renewed'
      };
    }

    audit(profileName, 'fail', {
      renewedCount,
      error: (r && r.error) ? String(r.error).slice(0, 180) : 'renew_failed',
      durationMs: Date.now() - startedAt
    });
    return {
      ok: false,
      skipped: false,
      marked: false,
      renewedCount: 0,
      error: (r && r.error) ? String(r.error) : 'renew_failed',
      reason: (r && r.reason) || null
    };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    audit(profileName, 'exception', { error: msg.slice(0, 220), durationMs: Date.now() - startedAt });
    return { ok: false, skipped: false, marked: false, renewedCount: 0, error: msg.slice(0, 220) };
  }
}

async function runRobeAutoRenewSafe(opts = {}) {
  const nome = String((opts && opts.nome) || '').trim();
  const attId = opts && opts.attId != null ? opts.attId : 0;
  try {
    const r = await runRobeAutoRenew(opts);
    try {
      stepLog.appendJSONL(nome, 'robe', {
        attempt: attId,
        step: 'post_publish_renew',
        ok: !!(r && r.ok),
        skipped: !!(r && r.skipped),
        marked: !!(r && r.marked),
        renewedCount: Number(r && r.renewedCount || 0) || 0,
        reason: (r && (r.reason || r.error)) || null
      });
    } catch {}
    return r && typeof r === 'object'
      ? r
      : { ok: true, skipped: true, marked: false, renewedCount: 0, reason: 'empty_result' };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    try {
      stepLog.appendJSONL(nome, 'robe', {
        attempt: attId,
        step: 'post_publish_renew_err',
        err: msg.slice(0, 220)
      });
    } catch {}
    return { ok: false, skipped: false, marked: false, renewedCount: 0, error: msg.slice(0, 220) };
  }
}

module.exports = {
  BUDGET_TOTAL_MS,
  runRobeAutoRenew,
  runRobeAutoRenewSafe
};
