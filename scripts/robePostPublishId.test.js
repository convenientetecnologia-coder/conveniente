"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractMarketplacePhoneConfirmInfoFromText } = require("./robePostPublishId.js");

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

test("nao confunde confirmacao generica de identidade com celular no MKT", () => {
  const sample = `
    Confirme sua identidade
    Continuar para a verificacao de identidade
    Carregar documento de identidade
  `;
  const info = extractMarketplacePhoneConfirmInfoFromText(sample);
  assert.equal(info.detected, false);
});
