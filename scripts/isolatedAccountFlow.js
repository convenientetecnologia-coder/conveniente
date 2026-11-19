'use strict';

// A página recebida serve somente como fonte da sessão. Nunca navega o Virtus.
async function run({ page, nome, kind, deadlineAt = 0 }, action) {
  if (!page || typeof page.browser !== 'function') throw new Error('isolated_source_page_missing');
  const manifest = await require('./manifestStore').read(nome);
  const proxyRequired = require('./serverConfig').readServerConfigEffective().robe.publishWithProxy === true;
  let rail;
  try {
    rail = await require('./robeRail').openRobeRail({
      nome, purpose: kind, cookies: manifest.cookies || [], liveBrowser: page.browser(),
      proxyRequired, deadlineAt
    });
    const pages = await rail.browser.pages();
    if (!pages[0]) throw new Error('isolated_flow_no_page');
    return await require('./carrierV2/clock').run(async()=>{
      const result=await action(pages[0], rail);
      if(kind==='id'&&result?.ok&&(result.marked||result.alreadySubmitted||result.marketplacePhoneVerified||result.identityFlowConfirmed))rail.confirmIdentity?.();
      return result;
    });
  } finally {
    if (rail) await rail.destroy();
  }
}

function context(page, kind) {
  try {
    const value = page.browser().__ctIsolatedFlow;
    return value && value.kind === kind ? value : null;
  } catch { return null; }
}

async function armIdentity(page) {
  const value = context(page, 'id');
  if (!value) throw new Error('identity_isolation_required');
  if (!value.proxyRequired) return;
  const result = await value.rail.armAndProve(page);
  if (!result || !result.ok || !value.rail.isProxyArmed) throw new Error('identity_proxy_unavailable');
  await value.rail.markIdentityStart?.();
}

module.exports = { run, context, armIdentity };
