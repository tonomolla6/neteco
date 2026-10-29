# Transactional delivery (local implementation)

`order.created` and the separately enabled `invoice.issued` have native renderers. Checkout commits its immutable
order event and the PII-free outbox reference in the same D1 batch. Queue messages
contain only type/version/eventId. Receipt insertion atomically creates one
`transactional_email_deliveries` job through migration 0031; the receipt's legacy
`blocked_provider` label is not the current delivery state. Existing receipts are
backfilled. Queue acknowledgement is safe once the receipt is durable; scheduled
dispatch runs provider work independently in Cron. The Queue consumer stores
receipt/work only; it does not invoke the provider synchronously.

Inject the Cloudflare Email Service binding as `TransactionalEmailSender` into
`dispatchTransactionalEmails(DB, sender, {enabled, from, now, limit})`. Its contract
is `send({to, from, subject, html, text}) => {messageId}`. Map
`TRANSACTIONAL_EMAIL_ENABLED === 'true'` to `enabled`, and read `from` from
`TRANSACTIONAL_EMAIL_FROM`. Enable only after binding/sender/UAT verification;
omitted/false is default off. The generated `SendEmail` type supports this object
through its `EmailMessageBuilder` overload; do not construct a legacy raw-MIME
`EmailMessage`. A Wrangler `send_email` binding named `EMAIL` must be provisioned
with the authorised transactional sender. The separate `NEWSLETTER_EMAIL`
binding/sender is not the transactional binding.
Scoped unit tests use real SQLite and fake senders, not real email or network. No SMTP, Node
template runtime, marketing subscription, newsletter suppression or access token
is involved. Recipient and amounts come from the immutable order contract, joined
to the exact persisted `order.created` source event. This email says received,
pending payment: it does not claim payment acceptance or shipment.

## Ordinary fiscal executor and invoice notices

`dispatchFiscalRuntime({database, storage?, providerResolver?}, configuration)`
executes only durable, explicitly queued fiscal intents. Configuration contains
`appEnvironment`, `now`, optional `limit` (1–100), a server-owned `policyIds`
allowlist (maximum 10), and `flags: {enabled, localValidationEnabled}`. Only
boolean `true` or exact string `'true'` enables a flag; false, `'false'` and
omission keep it off. Missing policy selection never enables work. A local
synthetic policy also requires local validation opt-in and `APP_ENV=local`;
preview only admits sandbox policies and production only production policies.
No provider is constructed by default. An injected server adapter must match
the current approved policy's provider, environment and mapping fingerprint.
Policy withdrawal is rechecked after resolution and in the issuing batch.
Separate policy sweeps cannot claim another policy's candidates. Expired issuing
markers become uncertain even with issuance disabled; they are never reissued.
This callable executor does not itself provision Cron/Queue or authorise real
Beply traffic. Beply lookup support and real/legal acceptance remain outstanding.
The root Worker mounts governed fiscal dispatch in its scheduled handler and
after a valid/replayed fiscal transport receipt; wiring alone does not establish
positive execution or external acceptance through either entrypoint.

`dispatchTransactionalEmails` additionally accepts `invoiceEmailEnabled`,
`invoiceValidationEmailEnabled` and `appEnvironment`. Invoice delivery requires
its own boolean opt-in in addition to the existing global `enabled`; omission
preserves pending invoice work without claiming it. Synthetic delivery requires
both invoice opt-ins and local environment. It uses the exact durable source
event, frozen fiscal contract, matching provider receipt, completed fiscal
ledger and confirmed private PDF document—not current prices or customer profiles.
The subject/text distinguish `issued` from `fiscal_pending`. Synthetic documents
are explicitly non-fiscal local validation and retain the simulated status.
No attachment, storage key, bearer URL, guest token or access-extension promise
is included. The customer needs their existing current private access.

Migration 0047 records an immutable preparation manifest containing only renderer
version, source SHA-256, message SHA-256 and preparation time. It does **not** copy
the body or recipient into D1. The `invoice.issued.v1` renderer registry preserves
v1 reconstruction from immutable historical facts. A changed source, sender,
body/hash or unknown version fails closed before the sender; an upgrade must add
a renderer version, never silently replace v1. Manifest, current source/lease
proof and durable sending marker commit atomically. Subject/text/HTML are bounded
to 1 KiB/512 KiB/1 MiB respectively. Hash fidelity is preparation evidence, not
proof of provider acceptance or inbox delivery. Ambiguous sends and failed
acknowledgements retain the existing non-retryable manual-review semantics.
No current policy approval, flag or synthetic receipt constitutes BEP-002/legal
acceptance, and real sender/provider delivery/UAT still require separate approval.

## Governed renderer extensions and financial resolution

The optional fourth argument of `dispatchTransactionalEmails` is server-owned
`{renderers: readonly TransactionalEmailRenderer[]}`. No event payload, HTTP body,
environment string or Queue message registers a renderer or SQL predicate.
Each immutable registration names a key/version, event/source kind, a bounded
static source predicate, a preparation callback and at least one atomic source
authority guard. The dispatcher owns the manifest, live lease fence and durable
sending marker. `rendererOptIns` is a separate explicit key allowlist (absent
means none); local synthetic notices also require `rendererValidationEnabled`
and local environment. The root runtime selects only its server-owned registry
through `TRANSACTIONAL_EMAIL_RENDERER_KEYS` (default `[]`), with a separate
`TRANSACTIONAL_EMAIL_RENDERER_VALIDATION_ENABLED` opt-in (default off).
`TRANSACTIONAL_EMAIL_ENABLED` remains the global sender gate. The ordinary
`INVOICE_EMAIL_ENABLED` flag alone does not enable refund or credit notices;
their registered renderer keys are independent of that ordinary-invoice flag.
Fresh legitimate refund/support/credit notices without their opt-in remain
pending, unclaimed. Existing ambiguous sending leases still require quarantine
even when new sends are off. Unknown or ambiguous registrations, manifest
versions, source drift and message drift fail closed before the sender.

`refund.succeeded.v1` and `invoice.credit.v1` reconstruct from the immutable
0048 historical refund/credit contracts, exact provider receipt, correlated
order event, confirmed workflow and (for credit) private PDF document. The
original invoice remains immutable. No price/profile lookup, body/recipient
copy into the manifest, attachment, public object key or guest access grant is
introduced. Subjects distinguish synthetic validation, confirmed refund and
issued versus pending fiscal correction. Hash fidelity does not prove remote
delivery, bank settlement or legal fiscal acceptance. Existing v1 renderers are
retained; changing implementation under an existing version is not supported.

0048 budgets include awaiting confirmation, queued, pending and uncertain
refunds; only an audited safe pre-submission cancellation releases a hold.
Refund success atomically creates a corrective obligation and refund email
obligation. Credit issuance still needs a separate audited request and explicit
approved policy; it is not enabled by a payment/refund flag. Root financial
dispatch requires `REFUNDS_ENABLED`, separate `REFUND_DISPATCH_ENABLED` or
`CREDIT_DISPATCH_ENABLED`, and the corresponding explicit `REFUND_POLICY_IDS`
or `CREDIT_POLICY_IDS` allowlist. Flags default off and allowlists default empty;
approval of an unselected policy never enables dispatch. Local fake providers
additionally require `APP_ENV=local` and the respective refund/credit local
validation opt-in.

The Worker-compatible Redsys refund adapter exists in `workers/refunds/redsys-provider.ts`.
`WorkerRedsysRefundProvider.create(configuration, approvedPolicy, fetcher)`
validates the approved policy fingerprint and server configuration offline; it
does not contact the bank. The runtime factory separately requires explicit
Redsys activation and matching preview/sandbox or production/production mappings.
Execution uses the captured historical `merchant_order`, integer EUR cents,
refund operation `3` and the maintained Redsys signature implementation. Only
a signed `0900` response matching operation, order, amount, currency, merchant,
terminal and contract correlation can become a succeeded receipt. Correlation
is not bank-side idempotency; its local proof-address is not a bank-issued refund
identifier or settlement evidence. There is no authoritative external-key
lookup or automatic resend after an ambiguous result. Supervised merchant/bank
acceptance and production settlement evidence remain external prerequisites.

The Beply corrective port still rejects before any customer/provider network I/O:
the legacy response does not confirm corrective kind, original source and signed
total. Primary corrective protocol validation and external Beply/fiscal and
transactional email acceptance/delivery remain open. No policy, flag or locally
validated adapter establishes those external approvals.
Local fake provider receipts explicitly attest validation only, never actual
money movement or real fiscal issuance. RMA custody never restocks implicitly.

Local evidence must distinguish the executor host from the runtime entrypoint.
The native fiscal/refund/credit helpers accept host callbacks for dispatchers
against native D1/R2 and a request callback for private HTTP routes in workerd;
their financial providers and email sender remain explicit local simulations.
Such checks establish neither a positive financial execution through Cron/Queue
nor real Redsys/Beply/email acceptance. The root scheduled handler wires financial
and email dispatch; the email Queue consumer stores/replays durable transport
receipts only, without invoking refund, corrective issuance or the email sender.
Neither transport acknowledgement nor a prepared email manifest is delivery proof.

## Duplicate safety and manual review

Pending/preparation leases may retry with backoff (maximum 10 attempts). Durable
`sending` is written **before** invoking the provider. Only preparation leases
can be reclaimed. A thrown provider call, invalid receipt or failed D1 sent
acknowledgement is ambiguous and is never automatically retried. Crashed or
unacknowledged `sending` jobs go to `manual_review` after 15 minutes, including
when new sends are disabled. This intentionally favours duplicate prevention
over automatic recovery: it is not a promise of exactly-once provider delivery.

An operator must correlate the event/source references and send time with
authoritative provider delivery evidence in an authorised environment. A stored
opaque `provider_message_id` is evidence of acceptance, not final inbox delivery.
Do not change `manual_review` or `sending` back to pending simply because a Queue
message retries. If acceptance cannot be ruled out, retain manual review. If the
provider confirms acceptance, reconcile the ledger with the confirmed opaque
receipt. Only after proving non-acceptance may an operator explicitly authorise
a recovery send; record that decision in the operational audit. There is no
automatic/manual reset API here. Never paste tokens, recipients or full messages
into Queue payloads, logs or error codes.

Unsupported event types and missing/invalid source contracts also require manual
review before implementing and authorising the appropriate recipient/renderer.
Configuration, a verified sender, actual provider acceptance/delivery and UAT
remain deployment prerequisites; local tests do not establish production readiness.

## Identity lifecycle delivery

Migration 0032 adds a separate token/job ledger for registration verification,
password recovery and reauthenticated email changes. Token issuance and its
pending delivery commit together. `dispatchIdentityEmailDeliveries()` uses the
same `EMAIL` sender contract, but requires both `AUTH_ENABLED` and the separate
`AUTH_EMAIL_ENABLED` opt-in. `AUTH_EMAIL_FROM`, `AUTH_ORIGIN`,
`AUTH_TOKEN_PEPPER` and `AUTH_ENCRYPTION_KEY` remain server-owned. All generated
local/preproduction configurations keep sending off. No real send is performed
by local checks; a verified sender and provider acceptance remain release gates.

Tokens are random, HMAC-hashed for lookup and AES-GCM-encrypted for delayed
delivery; plaintext exists only while rendering the link. Verification expires
after 24 hours, recovery/email change after 30 minutes, and consumption is
single-use. The dispatcher rechecks current identity/customer status, session
version, expiry and recipient before sending. Email changes also require the
original live session and unchanged MFA state. Revoked/consumed/ineligible links
are cancelled. Password recovery rotates all sessions and replaces the
verification link atomically if the account is still unverified; it does not
activate the account or subscribe it to marketing.

Preparation failures retry with bounded backoff. A durable `sending` lease is
written before provider invocation: ambiguous acceptance goes to `manual_review`
without blind resend, including expired sending leases after 15 minutes. There
is no additional provider-promise timeout or automatic recovery-send API. Logs
contain counts only, never token, recipient, name or rendered message. Invalid
legacy names/recipients fail closed and need an explicit correction, not a
relaxed renderer. Key rotation, token/job retention, legacy token migration and
real provider delivery evidence remain operational work.
