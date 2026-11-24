# Authentication recovery, 2026-11-24

Production evidence from all seven Robes Mae showed ordinary authentication screens stuck behind `kill_guard_until`, generic remediation failures and a previous `login_form_not_found` provisioning verdict. A planned switch to the cadastro browser closed the current browser, then its own anti-flap guard refused the replacement.

The planned network transition now has a specific reopening source. Unrelated crash guards remain active. Credential remediation preserves an existing Continue/password-only/full form instead of clearing the session twice and unconditionally opening another login page. Controls must be rendered, stable and enabled; mutations require a healthy proxy turn. Submission is recorded separately from verified authentication.

An unsubmitted attempt is refunded in both the persisted and in-memory password budget. Actual submissions remain counted. Technical errors do not exhaust the runtime failure counter. Old technical anti-loop flags are repaired without removing security restrictions or resetting actual password attempts. A version-four, one-time provisioning recovery requeues eligible technical failures; captcha, ban, identity, human holds and exhausted password budgets remain blocked.

Status includes one structured login stage per account, with evidence of cookie restoration and actual credential submission. Generic failures are not labelled rejected passwords. The local panel and CT server cards use this projection; CT retains a legacy fallback until updated workers report the new field.

The identity advance helper now clicks the exact stable enabled control and accepts visible text and tabindex -1, instead of reselecting an aria-only candidate after readiness succeeded.

Validation uses local Chrome fixtures for Continue to password, password-only, email/password, PIN separation, missing transport and identity advance. Regression suites cover provisioning, chair ownership, proxy reconnect, message-delivery ledger/guard/pump and final-screen confirmation. Real production logs also contained renewal-menu and identity Continue failures; these are not evidence of success and require fresh post-deployment observation. No claim is made that every possible failure or every production account has been validated.
