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
    textVerifiedApiUsername: "convenientemailing@gmail.com",
    antiCaptchaApiKey: "captcha-key"
  });
  assert.equal(patch.ctBaseUrl, "https://api.convenientetecnologia.com");
  assert.equal(patch.textVerifiedApiKey, "abc");
  assert.equal(patch.textVerifiedApiUsername, "convenientemailing@gmail.com");
  assert.equal(patch.antiCaptchaApiKey, "captcha-key");
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "textVerifiedBaseUrl"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "textVerifiedServiceName"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "antiCaptchaBaseUrl"), false);
});

test("configuracao so fica completa com endereco, textverified e anti-captcha", () => {
  assert.equal(ctConfigIsComplete({
    ctBaseUrl: "https://api.convenientetecnologia.com",
    textVerifiedApiKey: "abc",
    textVerifiedApiUsername: "convenientemailing@gmail.com",
    antiCaptchaApiKey: "captcha-key"
  }), true);
  assert.equal(ctConfigIsComplete({
    ctBaseUrl: "https://api.convenientetecnologia.com",
    textVerifiedApiKey: "abc",
    antiCaptchaApiKey: "captcha-key"
  }), false);
  assert.equal(ctConfigIsComplete({
    ctBaseUrl: "https://api.convenientetecnologia.com",
    textVerifiedApiKey: "abc",
    textVerifiedApiUsername: "convenientemailing@gmail.com"
  }), false);
});
