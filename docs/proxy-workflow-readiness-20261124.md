# Proxy workflow readiness — 2026-11-24

## Observed defects

The live seven-server audit found actual successful publications and Messenger sends, together with incomplete browser documents, missing upload controls, identity Continue failures and renewal menu failures. A working proxy and an open Chrome do not prove a completed task.

The previous composer fallback could fall through after failed readiness. A second issue reloaded a slow document after a 15-second body wait. Identity/renewal used two different target selectors: readiness selected one element, while the action could select another hidden duplicate. The shared readiness selector did not include menuitem controls. Asynchronous recovery also needed to recheck ownership immediately before navigating.

## Resulting behavior

- Local lease checks reject interactions in an offline Virtus turn or an unhealthy isolated/cadastro operation. They do not acquire chairs or make network calls. Network mode is unchanged.
- ID and renewal now click the exact stable, enabled, unobscured control handle. Hidden/covered duplicate controls cannot starve a visible one. Menu items and input buttons are supported. No arbitrary event-dispatch fallback is used.
- Item and vehicle composers share a stable document/form check. Styles, the file input and a mounted title/category/vehicle control must exist before upload. The initial navigation/body wait has a coherent bounded budget; a slow body is not automatically reloaded after 15 seconds. Blank-page suppression covers that navigation budget.
- Virtus document checks, inbox snapshots, scoped Marketplace activation, route restoration and document repair recheck the current lease. A late recovery cannot navigate after losing its chair.
- Business confirmation remains separate: clicking does not confirm a publication, identity submission, renewal or Messenger delivery. Existing response evidence remains required.

## Deployment

These changes are worker-side modules. Update files, stop/restart workers and invoke the canonical Open All path once. No Index, CT, executor or phone restart is required for this package. Keep accounts, credentials, journals and delivery evidence intact.

## Validation boundary

Regression tests include real headless Chrome with delayed controls/styles, overlays, hidden duplicates, DOM replacement, role=menuitem and loss of the chair during a wait. Carrier/Index and delivery tests remain separate from DOM tests. Passing tests does not prove every live Facebook UI or every account is healthy; after deployment verify the new build and task outcomes from live records.

## Follow-up: authentication and PIN ownership

Proxy-enabled account re-login uses the existing cadastro authentication browser/lease, including for previously provisioned profiles. It follows cookies, saved-profile Continue, password and existing security gates, then verifies identity/session before confirming and saving cookies. It does not use an offline Virtus browser as an authentication transport.

The saved-profile chooser uses the exact enabled Continue control and never chooses another profile. A Messenger PIN input is classified separately from the account password. PIN typing checks the current lease, focused official input and already-entered prefix before each digit. Lost focus/transport stops typing and is classified as a technical retry rather than invalid credentials. The proxy PIN handler runs in the account turn; the older background nurse PIN handler is reserved for network mode. No operational PIN value is recorded in new PIN attempt diagnostics.

The opening batch retains the first completed startup outcome even if later visits restart the runtime. A terminal batch result cannot regress to waiting. Progress is scoped to the current queue; explicit deferred outcomes do not masquerade as ready. This permits the verified accounts to resume work once every initial attempt has a recorded outcome, while incomplete accounts remain eligible for recovery.

The twelve-hour inbound policy and historical-message baseline are unchanged. This package does not replay historical replies or clear uncertain business results.

Runtime initialization has one turn owner. The nurse delegates directly to the runtime startup wrapper; it must not surround that wrapper with another session.run(), which would queue initialization behind itself. A regression test executes the worker nurse startup expression against a real session instance to detect this self-wait.
