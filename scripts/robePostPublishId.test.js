"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractMarketplacePhoneConfirmInfoFromText, isUnitedStatesDialOption, classifyIdToday, idFlagsForToday, phoneAlertFlagsForToday } = require("./robePostPublishId.js");

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
