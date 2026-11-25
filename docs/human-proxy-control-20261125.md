# Human proxy control — 2026-11-25

The operator's human request was queued locally while other accounts received seats. CT had no human operation for that account and had an old publish operation in terminal `unknown`. Local priority already placed human work alongside replies, but the account exclusion barrier could outlive unhealthy transport: worker polling refreshed ownership indefinitely without surrendering the unusable lease.

The worker lease client now asks Index to close a known unhealthy or expired lease. Index continues owning reconciliation and does not offer the same account another chair until authoritative closure is observed. No database state or delivery outcome is reset by this recovery. The Robe start wrapper also refuses a start once human hold is active.

Human sessions expose queue/online/expiry state and remaining time. Five minutes start at the proved grant, not at the request. Renewal extends only within the carrier's existing absolute deadline; near that deadline it releases and requests a new human chair. Expiry leaves the browser in human mode. The overlay polls a local exposed function and does not consume mobile proxy traffic for its timer.

Resume validates the account and Marketplace inbox before clearing human hold. It reuses a healthy human chair for validation; without one it cancels the old pending human request and obtains a fresh human turn. Existing Messages navigation is reused. Incomplete loading or an account restriction keeps human mode and reports failure instead of claiming success. `trabalhando` is not set from a remembered pre-human value: the normal nurse must restart the runner.

Tests cover cancellation before grant, duplicate requests, hard-deadline rollover, same-chair resume, resume without a chair, failed validation retaining hold, unhealthy-lease reconciliation and the real Chrome overlay countdown/actions. No test sends customer messages or publishes listings.
