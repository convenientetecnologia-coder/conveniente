"use strict";

const orchestratorRuntime = require("./runtime.js");

function noopEnd() {}

function defaultResultFromError(error) {
  return {
    ok: false,
    error: error && error.message ? String(error.message) : String(error || "action_runner_error")
  };
}

async function runAction({
  profileId,
  actionKind,
  actor = "",
  actorData = {},
  requestData = {},
  gateData = {},
  run,
  lock = null,
  onGateDenied = null,
  donePayload = null,
  gateEndPayload = null,
  actorEndPayload = null,
  onError = null,
  onFinally = null
} = {}) {
  if (typeof run !== "function") {
    throw new Error("action_runner_missing_run");
  }

  const actorSpan = actor
    ? orchestratorRuntime.actorBegin(actor, actorData)
    : { end: noopEnd };

  orchestratorRuntime.actionRequested(profileId, actionKind, requestData);

  const ticket = orchestratorRuntime.gateBegin(profileId, actionKind, gateData);
  let result = null;
  let thrown = null;

  if (ticket && ticket.allow === false) {
    result = onGateDenied
      ? await onGateDenied(ticket)
      : orchestratorRuntime.gateDeniedResult(ticket, { ok: false });
  } else {
    try {
      result = lock ? await lock(run) : await run();
    } catch (error) {
      thrown = error;
      result = onError ? await onError(error) : defaultResultFromError(error);
    }
  }

  const safeResult = result || (thrown ? defaultResultFromError(thrown) : { ok: false, error: "empty_action_result" });

  try {
    const doneData = typeof donePayload === "function" ? donePayload(safeResult, ticket) : safeResult;
    orchestratorRuntime.actionDone(profileId, actionKind, doneData || safeResult);
  } catch {}

  try {
    const gateDataOut = typeof gateEndPayload === "function" ? gateEndPayload(safeResult, ticket) : safeResult;
    orchestratorRuntime.gateEnd(ticket, gateDataOut || safeResult);
  } catch {}

  try {
    const actorDataOut = typeof actorEndPayload === "function" ? actorEndPayload(safeResult, ticket) : safeResult;
    actorSpan.end(actorDataOut || safeResult);
  } catch {}

  try {
    if (typeof onFinally === "function") {
      await onFinally({ result: safeResult, ticket, error: thrown });
    }
  } catch {}

  return safeResult;
}

module.exports = {
  runAction
};
