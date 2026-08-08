"use strict";

const RELEASE_AT_FIELD = "robeNewAccountPauseReleasedAt";
const RELEASE_VIA_FIELD = "robeNewAccountPauseReleasedVia";
const RELEASE_CREATED_AT_FIELD = "robeNewAccountPauseReleasedForCreatedAt";
const RELEASE_STOCK_ID_FIELD = "robeNewAccountPauseReleasedForStockAccountId";

function asTimestamp(value) {
  const number = Number(value || 0) || 0;
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function inferProfileCreatedAtMs(manifest, nome) {
  const explicit = asTimestamp(manifest && manifest.createdAt);
  if (explicit > 1e12) return explicit;
  const match = String(nome || "").match(/-(\d{12,})$/);
  const fromName = match ? asTimestamp(match[1]) : 0;
  return fromName > 1e12 ? fromName : 0;
}

function stockAccountKey(manifest) {
  const raw = manifest && (manifest.stockAccountId ?? manifest.stock_account_id);
  return raw == null ? "" : String(raw).trim();
}

function getNewAccountPauseManualRelease(manifest, nome) {
  const man = manifest && typeof manifest === "object" ? manifest : {};
  const releasedAt = asTimestamp(man[RELEASE_AT_FIELD]);
  if (!releasedAt) return null;

  const currentCreatedAt = inferProfileCreatedAtMs(man, nome);
  const boundCreatedAt = asTimestamp(man[RELEASE_CREATED_AT_FIELD]);
  if (
    currentCreatedAt &&
    boundCreatedAt &&
    Math.abs(currentCreatedAt - boundCreatedAt) > 1000
  ) {
    return null;
  }
  // Protege eventual reaproveitamento do manifest para outro cadastro.
  if (currentCreatedAt && releasedAt < (currentCreatedAt - 60_000)) return null;

  const currentStockId = stockAccountKey(man);
  const boundStockId = String(man[RELEASE_STOCK_ID_FIELD] ?? "").trim();
  if (currentStockId && boundStockId && currentStockId !== boundStockId) return null;

  return {
    releasedAt,
    via: String(man[RELEASE_VIA_FIELD] || "").slice(0, 80),
    createdAt: currentCreatedAt || boundCreatedAt || 0,
    stockAccountId: currentStockId || boundStockId || ""
  };
}

function markNewAccountPauseManualRelease(manifest, {
  nome = "",
  now = Date.now(),
  via = "manual"
} = {}) {
  const man = manifest && typeof manifest === "object" ? manifest : {};
  const releasedAt = asTimestamp(now) || Date.now();
  const createdAt = inferProfileCreatedAtMs(man, nome);
  const stockAccountId = stockAccountKey(man);

  man[RELEASE_AT_FIELD] = releasedAt;
  man[RELEASE_VIA_FIELD] = String(via || "manual").slice(0, 80);
  if (createdAt) man[RELEASE_CREATED_AT_FIELD] = createdAt;
  else delete man[RELEASE_CREATED_AT_FIELD];
  if (stockAccountId) man[RELEASE_STOCK_ID_FIELD] = stockAccountId;
  else delete man[RELEASE_STOCK_ID_FIELD];
  return man;
}

function isActiveLimitPosting(manifest, now = Date.now()) {
  const man = manifest && typeof manifest === "object" ? manifest : {};
  if (String(man.robePauseReason || "").trim().toLowerCase() !== "limit_posting") return false;
  return (
    asTimestamp(man.robeCooldownUntil) > asTimestamp(now) ||
    (Number(man.robeCooldownRemainingMs || 0) || 0) > 0
  );
}

/**
 * Contrato único das ações humanas Robe Play/Liberar Robe:
 * - libera cooldown comum/new_account;
 * - grava override persistente da pausa inicial de 24h;
 * - nunca remove o hard block limit_posting;
 * - opcionalmente arma enqueue posterior para conta fechada.
 */
function releaseRobeCooldownForOperator(manifest, {
  nome = "",
  now = Date.now(),
  via = "manual",
  awaitingEnqueue = false
} = {}) {
  const man = manifest && typeof manifest === "object" ? manifest : {};
  if (isActiveLimitPosting(man, now)) {
    return {
      manifest: man,
      released: false,
      blockedReason: "limit_posting"
    };
  }

  const releasedFromReason = String(man.robePauseReason || "").trim().toLowerCase() || null;
  markNewAccountPauseManualRelease(man, { nome, now, via });
  man.robeCooldownUntil = asTimestamp(now) || Date.now();
  man.robeCooldownRemainingMs = 0;
  if (man.robePauseReason) delete man.robePauseReason;

  if (awaitingEnqueue) {
    man.robeAwaitingEnqueue = true;
    man.robeAwaitingEnqueueAt = asTimestamp(now) || Date.now();
    man.robeAwaitingEnqueueReason = String(via || "manual").slice(0, 40);
  } else {
    if (man.robeAwaitingEnqueue) delete man.robeAwaitingEnqueue;
    if (man.robeAwaitingEnqueueAt) delete man.robeAwaitingEnqueueAt;
    if (man.robeAwaitingEnqueueReason) delete man.robeAwaitingEnqueueReason;
  }

  return {
    manifest: man,
    released: true,
    blockedReason: null,
    releasedAt: man[RELEASE_AT_FIELD],
    releasedFromReason
  };
}

module.exports = {
  inferProfileCreatedAtMs,
  getNewAccountPauseManualRelease,
  markNewAccountPauseManualRelease,
  isActiveLimitPosting,
  releaseRobeCooldownForOperator
};
