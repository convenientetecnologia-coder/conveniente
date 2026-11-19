'use strict';

// Uma decisão comercial do Facebook não impede a conferência do ID pendente.
async function run({ page, nome, titulo, attId }) {
  const stepLog = require('./stepLog');
  const id = require('./robePostPublishId');
  let result;
  try {
    result = await id.runRobeAutoId({ page, nome, titulo, deadlineAt: Date.now() + id.BUDGET_TOTAL_MS });
  } catch (e) { result = { ok: false, marked: false, error: String(e.message || e) }; }
  stepLog.appendJSONL(nome, 'robe', {
    attempt: attId, step: 'post_publish_id', source: 'post_attempt',
    ok: result?.ok === true, skipped: result?.skipped === true,
    marked: result?.marked === true, reason: result?.reason || result?.error || null
  });
  if (result?.ok === false || result?.humanRequired || result?.marketplacePhoneConfirm) {
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'post_publish_renew', skipped: true, reason: 'id_not_completed' });
  } else {
    await require('./robePostPublishRenew').runRobeAutoRenewSafe({ page, nome, attId });
  }
  return result;
}

module.exports = { run };
