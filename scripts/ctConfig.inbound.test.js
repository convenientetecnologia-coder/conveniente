"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pickInboundCtConfig, ctConfigIsComplete } = require("./ctConfig");

test("pacote vazio nao vira gravacao", () => {
  assert.equal(pickInboundCtConfig(null), null);
  assert.equal(pickInboundCtConfig({ ctBaseUrl: "  ", textVerifiedApiKey: "" }), null);
});

test("campo ausente fica de fora para nao apagar o que ja existe", () => {
  const patch = pickInboundCtConfig({
    ctBaseUrl: "https://api.convenientetecnologia.com",
    textVerifiedApiKey: "abc",
    textVerifiedApiUsername: "convenientemailing@gmail.com"
  });
  assert.equal(patch.ctBaseUrl, "https://api.convenientetecnologia.com");
  assert.equal(patch.textVerifiedApiKey, "abc");
  assert.equal(patch.textVerifiedApiUsername, "convenientemailing@gmail.com");
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "textVerifiedBaseUrl"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "textVerifiedServiceName"), false);
});

test("configuracao so fica completa com endereco, chave e usuario", () => {
  assert.equal(ctConfigIsComplete({
    ctBaseUrl: "https://api.convenientetecnologia.com",
    textVerifiedApiKey: "abc",
    textVerifiedApiUsername: "convenientemailing@gmail.com"
  }), true);
  assert.equal(ctConfigIsComplete({
    ctBaseUrl: "https://api.convenientetecnologia.com",
    textVerifiedApiKey: "abc"
  }), false);
  assert.equal(ctConfigIsComplete({
    ctBaseUrl: "https://api.convenientetecnologia.com"
  }), false);
});
