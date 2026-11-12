"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractMarketplacePhoneConfirmInfoFromText, isUnitedStatesDialOption, classifyIdToday, idFlagsForToday, phoneAlertFlagsForToday, shouldMarkDocError, isMarketplaceActionText, isIdentityConfirmLabel, isIdentityDocumentLabel, isIdentityReviewText, isIdentityRetryText, isAdvanceLabel } = require("./robePostPublishId.js");

test("o botao de identidade vale pelo sentido, nao pela frase exata", () => {
  assert.equal(isIdentityConfirmLabel("Confirmar identidade"), true);
  assert.equal(isIdentityConfirmLabel("Confirme sua identidade"), true);
  assert.equal(isIdentityConfirmLabel("Verificar identidade"), true);
  assert.equal(isIdentityConfirmLabel("Verify your identity"), true);
  assert.equal(isIdentityConfirmLabel("Confirm your identity"), true);
  assert.equal(isIdentityConfirmLabel("Turbinar classificado"), false);
  assert.equal(isIdentityConfirmLabel("Marcar como indisponível"), false);
  assert.equal(isIdentityConfirmLabel("Verificação de identidade"), false);
  assert.equal(isIdentityDocumentLabel("Carregar documento de identidade"), true);
  assert.equal(isIdentityDocumentLabel("Enviar documento de identidade"), true);
  assert.equal(isIdentityDocumentLabel("Upload identity document"), true);
  assert.equal(isIdentityDocumentLabel("Confirmar identidade"), false);
  assert.equal(isIdentityReviewText("Confirmação de identidade em andamento"), true);
  assert.equal(isIdentityReviewText("Análise de identidade em andamento"), true);
  assert.equal(isIdentityReviewText("Confirme sua identidade para publicar"), false);
  assert.equal(isIdentityRetryText("Não foi possível verificar sua identidade"), true);
  assert.equal(isIdentityRetryText("Não foi possível verificar sua identidade com as informações fornecidas. Tente novamente."), true);
  assert.equal(isIdentityRetryText("Confirmar identidade"), false);
  assert.equal(isAdvanceLabel("Avançar"), true);
  assert.equal(isAdvanceLabel("Next"), true);
  assert.equal(isAdvanceLabel("Confirmar identidade"), false);
});

test("reconhece o aviso novo de identidade e as frases antigas", () => {
  assert.equal(isMarketplaceActionText("Confirme sua identidade para publicar este e futuros classificados"), true);
  assert.equal(isMarketplaceActionText("Confirme sua identidade"), true);
  assert.equal(isMarketplaceActionText("Uma ação é necessária para esse classificado"), true);
  assert.equal(isMarketplaceActionText("Ação necessária"), true);
  assert.equal(isMarketplaceActionText("Verifique sua identidade para publicar"), true);
  assert.equal(isMarketplaceActionText("Verify your identity to publish"), true);
  assert.equal(isMarketplaceActionText("Action required"), true);
  assert.equal(isMarketplaceActionText("Se requiere una acción"), true);
  assert.equal(isMarketplaceActionText("Documento de identidade"), true);
  assert.equal(isMarketplaceActionText("Mudança valor imbatível, Carreto, Frete"), false);
  assert.equal(isMarketplaceActionText("Anunciado em 04/11"), false);
  assert.equal(isMarketplaceActionText("Turbinar classificado"), false);
  assert.equal(isMarketplaceActionText("Marcar como indisponível"), false);
});

test("detecta fluxo novo de confirmacao de celular no Marketplace", () => {
  const sample = `
    Confirme sua identidade no Marketplace
    Detectamos atividade incomum na sua conta.
    Confirme seu numero de celular
    Enviaremos um SMS com um codigo de confirmacao para o numero que voce inserir.
    Avancar
  `;
  const info = extractMarketplacePhoneConfirmInfoFromText(sample);
  assert.equal(info.detected, true);
  assert.equal(info.phonePrompt, true);
  assert.equal(info.smsPrompt, true);
});

test("erro de celular nao vira erro de documento", () => {
  assert.equal(shouldMarkDocError({ ok: false, marketplacePhoneError: true, error: 'marketplace_phone_try_later' }), false);
  assert.equal(shouldMarkDocError({ ok: false, marketplacePhoneNoBalance: true }), false);
  assert.equal(shouldMarkDocError({ ok: true, skipped: true, reason: 'no_action_needed_today' }), false);
  assert.equal(shouldMarkDocError({ ok: false, error: 'no_action_needed' }), false);
  assert.equal(shouldMarkDocError({ ok: false, error: 'open_listing_failed' }), true);
  assert.equal(shouldMarkDocError({ ok: false, error: 'cnh_not_selected' }), true);
  assert.equal(shouldMarkDocError({ ok: true, marketplacePhoneVerified: true }), false);
});

test("erro e sem saldo do celular saem na virada do dia de SP", () => {
  const beforeMidnight = Date.parse("2026-10-13T02:30:00Z");
  const afterMidnight = Date.parse("2026-10-13T03:30:00Z");
  const today = phoneAlertFlagsForToday({
    marketplacePhoneError: true,
    marketplacePhoneErrorAt: beforeMidnight,
    marketplacePhoneNoBalance: true,
    marketplacePhoneNoBalanceAt: beforeMidnight
  }, beforeMidnight);
  assert.equal(today.marketplacePhoneError, true);
  assert.equal(today.marketplacePhoneNoBalance, true);
  assert.equal(today.staleError, false);
  const nextDay = phoneAlertFlagsForToday({
    marketplacePhoneError: true,
    marketplacePhoneErrorAt: beforeMidnight,
    marketplacePhoneNoBalance: true,
    marketplacePhoneNoBalanceAt: beforeMidnight
  }, afterMidnight);
  assert.equal(nextDay.marketplacePhoneError, false);
  assert.equal(nextDay.marketplacePhoneNoBalance, false);
  assert.equal(nextDay.staleError, true);
  assert.equal(nextDay.staleNoBalance, true);
  const legacy = phoneAlertFlagsForToday({ marketplacePhoneError: true }, afterMidnight);
  assert.equal(legacy.marketplacePhoneError, false);
  assert.equal(legacy.staleError, true);
});

test("id do dia separa foto, celular e o pulo da verificacao", () => {
  const now = Date.parse("2026-10-12T22:00:00Z");
  assert.equal(classifyIdToday("2026-10-12", "", now), "doc");
  assert.equal(classifyIdToday("", "2026-10-12", now), "phone");
  assert.equal(classifyIdToday("2026-10-12", "2026-10-12", now), "phone");
  assert.equal(classifyIdToday("2026-10-11", "2026-10-11", now), "none");
  assert.equal(classifyIdToday("", "", now), "none");
  const phoneOnly = idFlagsForToday("2026-10-12", "2026-10-12", now);
  assert.equal(phoneOnly.skip, true);
  assert.equal(phoneOnly.robeIdPhoneDoneToday, true);
  assert.equal(phoneOnly.robeIdDocDoneToday, false);
  const docOnly = idFlagsForToday("2026-10-12", "", now);
  assert.equal(docOnly.robeIdDocDoneToday, true);
  assert.equal(docOnly.robeIdPhoneDoneToday, false);
  const none = idFlagsForToday("2026-10-11", "2026-10-11", now);
  assert.equal(none.skip, false);
  assert.equal(none.robeIdDocDoneToday, false);
  assert.equal(none.robeIdPhoneDoneToday, false);
});

test("so aceita United States (+1) no menu de pais", () => {
  assert.equal(isUnitedStatesDialOption("United States (+1)"), true);
  assert.equal(isUnitedStatesDialOption("Rotulo do menu suspenso United States (+1)"), true);
  assert.equal(isUnitedStatesDialOption("Brazil (+55)"), false);
  assert.equal(isUnitedStatesDialOption("British Virgin Islands (+1)"), false);
  assert.equal(isUnitedStatesDialOption("United States Minor Outlying Islands (+1)"), false);
});

test("nao confunde confirmacao generica de identidade com celular no MKT", () => {
  const sample = `
    Confirme sua identidade
    Continuar para a verificacao de identidade
    Carregar documento de identidade
  `;
  const info = extractMarketplacePhoneConfirmInfoFromText(sample);
  assert.equal(info.detected, false);
});
