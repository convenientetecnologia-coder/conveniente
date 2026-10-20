"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { robeV2RegenClaimIsStale } = require("./robe.js");

const now = 1_800_000_000_000;

test("geracao marcada ha mais de 3 minutos esta morta e pode recomecar", () => {
  assert.equal(robeV2RegenClaimIsStale({
    regenPending: true,
    regenInFlightId: `123:${now - (4 * 60 * 1000)}:ab`
  }, now), true);
});

test("geracao sem id tambem esta morta", () => {
  assert.equal(robeV2RegenClaimIsStale({ regenPending: true, regenInFlightId: null }, now), true);
});

test("geracao recente continua dona da fila", () => {
  assert.equal(robeV2RegenClaimIsStale({
    regenPending: true,
    regenInFlightId: `123:${now - (20 * 1000)}:ab`
  }, now), false);
});

test("sem marca de geracao nao ha o que recuperar", () => {
  assert.equal(robeV2RegenClaimIsStale({ regenPending: false, regenInFlightId: null }, now), false);
});
