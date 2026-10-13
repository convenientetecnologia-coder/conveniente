'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  flagsForToday,
  shouldMarkRobePostError,
  shouldMarkRenewError,
  shouldClearRenewError
} = require('./flowAlertFlags.js');

test('postagem so marca erro depois que o criar item comecou', () => {
  assert.equal(shouldMarkRobePostError({ started: false, error: 'Sem foto disponível para esta conta (no-photo-available).' }), false);
  assert.equal(shouldMarkRobePostError({ started: false, error: 'cooldown_until_x' }), false);
  assert.equal(shouldMarkRobePostError({ started: true, limitPosting: true }), false);
  assert.equal(shouldMarkRobePostError({ started: true, loginRequired: true }), false);
  assert.equal(shouldMarkRobePostError({ started: true, marketplaceDisabled: true }), false);
  assert.equal(shouldMarkRobePostError({ started: true, rateLimit: true }), false);
  assert.equal(shouldMarkRobePostError({ started: true, noPhoto: true }), false);
  assert.equal(shouldMarkRobePostError({ started: true, published: true }), false);
  assert.equal(shouldMarkRobePostError({ started: true }), true);
});

test('renovacao marca erro so quando o fluxo entrou e nao concluiu', () => {
  assert.equal(shouldMarkRenewError({ ok: true, skipped: true, reason: 'not_due' }), false);
  assert.equal(shouldMarkRenewError({ ok: true, skipped: false, reason: 'none_renewable' }), false);
  assert.equal(shouldMarkRenewError({ ok: false, reason: 'robe_in_flight' }), false);
  assert.equal(shouldMarkRenewError({ ok: false, error: 'no_page' }), false);
  assert.equal(shouldMarkRenewError({ ok: false, started: false, error: 'plan_read_failed' }), false);
  assert.equal(shouldMarkRenewError({ ok: false, error: 'manage_listings_not_found' }), true);
  assert.equal(shouldMarkRenewError({ ok: false, error: 'renew_hard_timeout' }), true);
  assert.equal(shouldClearRenewError({ ok: true, skipped: false, reason: 'none_renewable' }), true);
  assert.equal(shouldClearRenewError({ ok: true, skipped: false, reason: 'renewed' }), true);
  assert.equal(shouldClearRenewError({ ok: true, skipped: true, reason: 'not_due' }), false);
  assert.equal(shouldClearRenewError({ ok: false, error: 'actions_not_found' }), false);
});

test('erro de robe e de renovacao saem na virada do dia de SP', () => {
  const beforeMidnight = Date.parse('2026-10-13T02:30:00Z');
  const afterMidnight = Date.parse('2026-10-13T03:30:00Z');
  const stored = {
    robePostError: true,
    robePostErrorAt: beforeMidnight,
    renewError: true,
    renewErrorAt: beforeMidnight
  };
  const today = flagsForToday(stored, beforeMidnight);
  assert.equal(today.robePostError, true);
  assert.equal(today.renewError, true);
  assert.equal(today.staleRobePostError, false);
  const nextDay = flagsForToday(stored, afterMidnight);
  assert.equal(nextDay.robePostError, false);
  assert.equal(nextDay.renewError, false);
  assert.equal(nextDay.staleRobePostError, true);
  assert.equal(nextDay.staleRenewError, true);
  const legacy = flagsForToday({ robePostError: true, renewError: true }, afterMidnight);
  assert.equal(legacy.robePostError, false);
  assert.equal(legacy.staleRobePostError, true);
  assert.equal(legacy.renewError, false);
});
