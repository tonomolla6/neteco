# Programmed chaos and recovery

`TST-039` runs a deterministic, isolated fault profile with
`npm run test:chaos`. The governed scenarios live in
[`chaos-policy.json`](./chaos-policy.json); the runner refuses missing tests,
runbook sections or a non-blocking workflow, executes only PostgreSQL, Redis and
loopback providers, and publishes `test-results/chaos.xml` plus
`test-results/chaos.json`. No production endpoint, credential or customer data
is allowed.

The same command is scheduled every Monday at 03:17 UTC and is manually
dispatchable. A fault is considered passed only when its detection, durable
business invariant and recovery assertions all pass. Injected failures are
handled inside tests; the workflow never uses `continue-on-error`.

## Provider latency

- Detection: a loopback Beply response delayed beyond its real 1,000 ms timeout
  becomes a retryable transport error.
- Containment: the request is bounded and cannot escape the loopback harness.
- Recovery: latency is removed and the same adapter completes successfully.
- Escalation: persistent transport ambiguity follows the Beply/fiscal incident
  runbook and requires reconciliation before any blind reissue.

## Duplicate provider events

- Detection: the repeated provider event ID is marked as duplicate.
- Containment: PostgreSQL uniqueness and idempotency keys preserve one payment
  transition, allocation and invoice request.
- Recovery: the original captured event remains canonical; repeated delivery is
  acknowledged without replaying effects.

## Reordered provider events

- Detection: a failure is deliberately delivered after a successful capture.
- Containment: the later stale failure cannot downgrade the terminal payment or
  undo inventory allocation.
- Recovery: no mutation is required; reconciliation confirms the captured state
  and exact-once side effects.

## Worker loss and stale leases

- Detection: `npm run alerts:check` exits `2` with
  `stale_worker_leases` when a `processing` lease is older than 15 minutes.
- Containment: the abandoned owner cannot complete a lease it no longer owns;
  each worker only reclaims its own event type.
- Recovery: a replacement worker resets the lease to `retry`, processes one
  durable effect, clears its locks and makes the alert return to `clear`/exit 0.
- Verification: the executable recovery is exercised for email delivery, while
  a source contract locks the same lease policy for invoice, refund and credit
  note workers.

## Redis and cache loss

- Detection: connection to the injected unavailable Redis endpoint fails.
- Containment: PostgreSQL remains authoritative for checkout, payment and
  inventory; Redis is not treated as a durable business store.
- Recovery: after restoring the configured endpoint, a fresh client reconnects
  and returns `PONG`; payment and allocation remain exact-once.
- Scope: NETECO currently uses Redis for ephemeral coordination/rate limiting,
  not for a durable catalog cache. The exercise does not claim a nonexistent
  cache invalidation mechanism.

## External provider limits

- Detection: the loopback Beply provider returns HTTP 503 and then 429; the job
  records `beply_provider`, increments attempts and schedules future durable
  availability.
- Containment: no tight retry loop or second invoice is created while the limit
  remains active.
- Recovery: after the provider clears the limit, the same idempotent job issues
  exactly one invoice and one domain event.

## Operator close-out

For any real incident, follow
[`incident-runbooks.md`](../operations/incident-runbooks.md): assign commander
and scribe, preserve correlation IDs, inspect queue age/DLQ/leases, run
`npm run alerts:check`, reconcile with `npm run reconcile`, replay only the
original idempotency key, verify exact-once effects, clear the alert and record
follow-up owner/date. Destructive recovery and provider-side reconciliation
remain human-authorized.
