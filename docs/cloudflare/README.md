# Cloudflare migration lane

See [isolated preproduction configuration](preproduction.md) for the provisioned
resources, GitHub environment and release gates. No production cutover is implied.

## Cart recovery and resource hub — local implementation checkpoint (2026-10-10)

Cart/checkout recovery now requires separate explicit consent, live verified
ownership and exact cart possession/version. The configured scheduler has no
inferred business timing or sender. Resume rotates the same cart through its
actual Durable Object, returns possession only by HttpOnly cookie, and preserves
TTL, quantities and economic/inventory state. A final grant recheck rejects a
link rotated concurrently during the last content read. Actual-send cooldowns
cover delayed, concurrent and ambiguous reminders; editorial campaigns and
confirmed product signals respect recovery and durable editorial cooldowns while
explicit confirmation remains exempt. An in-flight non-confirmation product
signal also excludes recovery/editorial sends, both at the atomic claim and at
the final authority read. No cooldown for a completed watch is inferred; other
cross-marketing directions still need policy and acceptance evidence.

The resource hub reuses approved CMS releases, optional author/review metadata,
the existing draft editor and the original content renderer. Current related
catalog links, SSR initial content and a single `/recursos` sitemap canonical are
validated; legacy `/contenido` releases and the empty-shard contract remain intact.
Count, rows and final sitemap revalidation share the editorial review window.

The joint component band passes **137 cases / nine files**; **ten** causal
cross-email cases and **24** resource/legacy sitemap cases pass. Two clean actual
canary-source/workerd/D1 journeys pass: cart-cookie recovery plus a confirmed
price-drop signal, and price-locked commercial checkout/customer-context redaction.
The signal case verifies the real D1 expression-depth boundary: materialized
facts join the atomic claim, and a single final batch reads catalog and recipient
authority without dropping predicates. Only provider adapters are synthetic;
there are zero outbound calls. Traceability consistency passes **72 cases**.
The final selected unit regression band passes **415 cases / 32 files**, and the
two recovery components pass **17 cases** again after the final typed-fetch fix.
Affected formatting/lint and Worker, auditor and full Nuxt typechecks pass.
The directional-cap regression band subsequently passes **175 cases / 14 files**,
including the actual source/workerd/D1/CartDO journey. Its three new cases each
prove a positive receiver control in a fresh database at the same clock before
testing the prior/in-flight email. Explicit test fixtures apply migration 0087;
the generic 62-migration baseline is unchanged.

These are local implementation proofs, not launch acceptance. Six additional
requirements move from unstarted to partial `NOT_VERIFIED`, with empty verification
dates. Separately, the executed pagination criteria SEA-008 and SEO-011 now have
local repository evidence: totals are **136 REPO_EVIDENCE / 121 PARTIAL_EXTERNAL / 242 NOT_VERIFIED /
196 ROADMAP_NOT_STARTED / seven DISCARDED**, preserving 695 active requirements.
Only those two inventory rows changed at this checkpoint; all other rows remain
byte-equivalent after canonical CSV parsing. The repository-evidence ratio is
**19.57%**, not project completion. New
feature/delivery flags remain OFF. Approved policies/content, complete multichannel
coordination, consent-aware measurement, rebuilt browser acceptance, executed
Oracle CI and deployed UAT remain pending; no deployment, push or live provider
operation is claimed.

A fresh full UI/Nitro/Worker build now includes these sources and passes bundle
policy (**9,658 entries / 1,055 original Nitro sources**) and immutable artifact
verification in `.wrangler/shop-evidence-20261010-resources-pagination/`. The generated client
bundle registers all **21 dynamic administrative navigation SVGs**, checked
against the actual installed Iconify collection with alias resolution. This fixes
missing `contact-round` and `warehouse` assets without runtime icon fetching.
Worker SHA-256:
`674b4fd19d2e7a86da32928a3b1b56353a2096a6141e265b84afc9d363653e90`.
The migration inventory now strictly requires all 90 migrations. The final
transport/activity band passes **78 cases / three files**; affected lint and
Worker/auditor/Nuxt types pass. The admitted local build completes in a separate
4 GiB scope with swap disabled; the quarantined runner's limits remain unchanged.

Complete compiled browser acceptance is still **pending**. The latest full audit (17)
stopped after **363 completed scenarios**, now at a subsequent cancellation
journey's administrative cursor read (`403`). The desktop integral workbench
returned successfully before this failure. Source inspection identifies an audit
actor with a verified-session boolean but no MFA enrollment row; the cursor
correctly requires enrollment. Six focused real-SQLite/cursor cases reproduce
that missing fixture authority and pass after enrolling only the synthetic
global audit administrator; the 16 existing cursor cases also pass. No session,
role or authorization policy has been relaxed. The full audit has not yet been
rerun after that fixture correction. Missing icon assets
were an independently verified defect, not proof of earlier failures' causes. The
layout's automatic recent-activity request and global cart hydration are now
reproduced through their real component/plugin/store and both actual transport
policies. Genuine REDs led to exact same-origin `GET /api/admin/activity?limit=5`
and `GET /api/cart` (no query) exceptions, preserving original cookies and server
authorization; broader queries, HEAD, mutations and unrelated APIs remain
forbidden. The owned bridge also permits the actual logo/favicon. **42 component
cases / three files** and **78 unit cases / three files** pass. Global hydration
may create an unrelated empty cart, so it is not described as zero D1 writes;
the strengthened 15-table digest now checks the original contractual carts and
economic facts through foreign bootstrap and logout. That desktop integral
journey passed on the then-current `c35ff7ec…` artifact, but the full audit did not;
it is not claimed as acceptance of the new `674b4fd1…` build.
Checkout fixtures now prepare observed stock through the original governed
warehouse API, with receipt/ledger correlation, before creating test orders;
they do not write stock directly or restore revoked actors. All owned ephemeral
browser services and private SSH forwards were closed after the failed run.

A separate post-build `test:compiled` project exercises the actual compiled
Worker, its assets, all 90 migrations and the original Cart Durable Object.
Three contracts pass again on the current `674b4fd1…` build: governed resources
with initial SSR/metadata/review expiry;
consent-bound recovery with HttpOnly rotation, exact replay, live revocation and
unchanged economic facts; and pagination matching real D1 API pages to initial
SSR product links without JavaScript. The pagination contract subsequently
passes across **search, catalogue and category** using one 20-product fixture
(12 + 8 distinct products), preserving previous-page filters and route paths.
The same resource fixture now publishes 21 governed resources and proves actual
20 + 1 API/initial-SSR pages, disjoint links, filter-preserving adjacent anchors
and the unique unfiltered page-two canonical, with JavaScript disabled.
Genuine component and old-compiled-artifact REDs exposed resource button-only
pagination; real URL anchors and route-driven initial loading fix it.
Search/resource/recovery component controls pass **32 cases / three files**.
The final directed unit band passes **123 cases / seven files**, including
**74** inventory-consistency checks. Affected lint/format and Worker, auditor
and full Nuxt typechecks pass; the subsequent inventory edit also passes its
auditor typecheck. These are local checks, not an executed Oracle pipeline.
No HTTP API
or renderer is mocked. Provider adapters remain synthetic and outbound calls
are forbidden. Test clocks are anchored explicitly to an actual server-created
empty cart; this is not described as zero D1 writes. The compiled project runs
after the build in both the local gate and Oracle workflow, not as a clean-tree
pre-build unit suite. Actual Oracle execution is still unproven. These SSR/API
proofs do not establish deployed crawling or complete browser acceptance.

The isolated Chromium resource journey passed three desktop/mobile/no-JavaScript
contexts on the previous `c35ff7ec…` build. The recovery journey exposed a real
integrated-page defect: clearing the confirmed capability also cleared the success
notice. A page-owned, action-typed notice now survives secret purging, distinguishes
preference changes from actual resume and clears on session changes. A genuine
page-level RED precedes the fix. Neither current resource nor recovery browser
journey is yet accepted: the dedicated server's shared heavy-work lock is occupied
by another session, whose process is preserved. All owned browser services and
SSH forwards are closed. `test:compiled:browser` requires the approved private
browser with no local fallback, and `audit:shop:local` executes that gate before
the comprehensive audit. Unit transport/control-flow tests do not substitute for
connected Chromium, executed Oracle CI or production UAT.

## Functional batch — source checkpoint (2026-10-10)

Product watches, moderated reviews/questions, permission-redacted customer context
and approved commercial quotes now have Cloudflare service, HTTP and UI wiring.
Approved quotes keep their goods and shipping amounts even when public prices
cross the free-shipping threshold; private preparation still revalidates the
owner, current rates/calendar, publication, VAT, quantities and stock.
The checkout/shipping regression band passes **92 tests** and the joint component
band **49 tests**. A separate clean source-native workerd/D1 watch/review journey
passes with zero outbound requests and unchanged critical domain tables.

These are partial implementations, not launch acceptance. The six associated
requirements remain `NOT_VERIFIED`; new feature and delivery flags default OFF.
The compiled artifact documented below predates this batch. Joint rebuilt/browser
acceptance, complete Oracle CI, real provider/operational evidence and deployed UAT
remain pending; no deployment or live provider request was made for this batch.

## Real Durable Object recovery — local checkpoint (2026-10-10)

The new native persistence suite exercises the actual Cart/Inventory Durable
Objects and D1: concurrent cart CAS, competing reservations, exact replay after
runtime restart, rollback of a real UNIQUE failure, and automatic persisted
alarms observed exclusively through D1 reads. Together with the cart coordinator
regressions, **23 tests pass**. The alarm case exposed a real defect: Cloudflare
returns `null` from `getAlarm()` inside the running handler. Cart expiry now uses
its durable cart identity and the live D1 expiry gate, serializes with commands,
and re-arms from current data; early/stale wake-ups cannot expire renewed carts.
See the [official alarm contract](https://developers.cloudflare.com/durable-objects/api/alarms/#getalarm).

The compiled audit exposed a second real defect: an SSR `loading` navigation state
could survive hydration without a client request. The watcher now resumes only
orphaned loading states, preserving live-request deduplication and ready SSR data.
The navigation/context component band passes **46 tests**. A fresh UI/Worker build
passes bundle policy (**8,998 entries / 1,015 original Nitro sources**); the next
compiled audit confirms the inventory panel is visible and live capabilities are
ready (HTTP 200). Worker SHA-256:
`f03bbc462d19fe56ffe721dc94bcd424aa69d2714c37891d2d1b56b3b95fdfd6`.

Browser acceptance remains **pending**, not passed. The count-import, account and
inventory-alert bridges now correlate exactly one sealed session while forwarding
ordinary consent/cart cookies unchanged; **77 directed cases / seven files pass**.
The compiled audit advances from 65 to **363 completed scenarios**, including the
earlier blocked journeys. Its workbench stock fixture now uses a fresh warehouse
actor and separately proves that the previously revoked actor remains forbidden.
The compiled workbench also passes actual server pagination, saved-view reload and
the 26-order private CSV download. A real Chromium reproduction established that
Playwright's text-response representation strips the UTF-8 BOM (25 bytes become
22); the audit now verifies the actual user's download stream, with the same
byte/BOM/row limits, rather than repairing the response. Audit 11 independently
confirms the durable bulk POST and its receipt/D1 projection, then fails at real
Queue delivery: Miniflare's assets RPC proxy does not forward Queue events. A
minimal assets-enabled native regression reproduces that exception. The private
audit receiver now loads the identical compiled module without that proxy, shares
its data bindings, and retains durable classes on the original HTTP worker. Five
native transport cases pass, including real ACK/retry/producer delivery and assets;
three additional converter-backed tests preserve the original worker, shared data
bindings and explicit DO/Workflow owners. Auditor/Nuxt types, affected lint and
formatting pass. The complete compiled journey still requires a fresh successful run. The audit also
waits for confirmed uncertainty and an enabled manual-recovery control, rather than
mistaking the in-flight intent container for a finished response-loss proof.
Safe diagnostics omit PII; no unit or
component band substitutes for the complete journey. `UI-005` and `TST-009` are
not closed. Scope remains 695 active / seven discarded; no push, deployment, live
payment, Beply or external email operation occurred.

## Build evidence and infrastructure — local checkpoint (2026-10-10)

The actual installed npm lock-only CycloneDX producer now succeeds after aligning
the root Redis dependency with the existing Nitro-compatible `ioredis@5.11.1`.
Two real local RESP/HTTP compatibility cases pass without changing production
Redis code. The normalized SBOM contains **1,289 components**; the verified
manifest covers **1,195 artifacts / 67 reachable packages** and measures Worker
gzip at **2,262,555 bytes**. Manifest plus SBOM occupy **679,022 bytes**. The
artifact/CLI band passes **20 cases**, and the complete build/audit/verification
composition has five blocking wiring checks. Startup, reproducibility across
independent builds, vulnerability acceptance and executed Oracle CI remain
unproven: this does not close `CIC-006`.

The explicit preprod/production contract projects fresh IaC resources through the
existing complete shop generator without enabling traffic or providers. **19
directed environment cases pass**. OpenTofu 1.10.6 with the actual Cloudflare
5.25.0 ARM64 provider validates all five Terraform files offline, with zero errors
and zero validation warnings. See [ownership, private state, recovery and limits](../../infra/cloudflare/README.md).
The offline CI source gate has **16 passing unit cases**; its sealed toolchain and
user/network namespace support are not yet verified on the quarantined runner.
No plan, apply, resource adoption or remote recreation was performed; `CIC-007`
remains incomplete.

Gitleaks 8.24.3 passes all six synthetic policy scenarios, including the three
formerly documented paths and a secret removed from HEAD but retained in history.
The old global `[[allowlists]]` table was inert in this version, so this is **not**
evidence of a fixed bypass. The unused table was removed; CI now pins the version
and requires the real policy probe after its existing full-history scan. Seven
directed integration checks pass; the six real scans also pass after policy cleanup.
This does not prove rotation, deployed binding
isolation or production-secret acceptance, and does not close `SEC-003`.

The final directed source band passes **284 tests / ten files**. Traceability now
records `SEC-003`, `TST-009`, `CIC-006` and `CIC-007` as partial `NOT_VERIFIED`
implementation, not missing source or accepted requirements. Totals remain **695
active / seven discarded / 134 repository-evidence requirements**; repository
evidence is not a production-completion percentage.

## Cursor order queue and recoverable bulk preparation — local checkpoint (2026-10-09)

This checkpoint supersedes the bulk/cursor implementation gaps in the earlier
saved-view checkpoint. `GET /api/admin/orders?pagination=cursor` retains server
filters and all four ascending/descending sorts. Ten-minute encrypted keyset
cursors bind the full query, administrator and live session; no OFFSET or complete
browser dataset is used. Live-empty pages distinguish an empty page from empty
filters and retain a return cursor. The old non-cursor HTTP contract is unchanged.

Selection is explicit, limited to 25 visible confirmed orders and cleared on
context/authority changes. Bulk preview reads real readiness and versions in one
set-based query; confirmation freezes the reviewed intent in migration `0086`.
The immutable group/attempt/result ledgers preserve actor-bound idempotency,
canonical child receipts and honest applied/rejected/not-attempted/unknown states.
All six existing fulfillment actions reuse the canonical service and its evidence
rules; no bulk action changes prices, payments, invoices or inventory.

Queue processing executes one canonical order command per invocation, with live
MFA enrollment checked again inside its atomic commit. Successful continuation
publication precedes ACK; publication failures retain the retry obligation.
Batch overflow is strictly validated and republished without consuming the
normal transient retry budget. Cron republishes at most five durable pending
groups. Manual command/group GET recovery never automatically repeats a POST.
Authority loss pauses work and purges private interface state.

Directed bands pass **357 unique Node cases / 11 files** and **77 component cases
/ two files**, including all 86 migrations, seven upgrade cases, a 25-eligible-order
query-budget case, revocation at commit, and simultaneous duplicate deliveries
through actual canary SOURCE/workerd D1 with zero outbound calls. The measured
prepared-query bounds reserve at least ten of D1 Free's 50 queries for ingress
and runtime checks. Worker/auditor/Nuxt types and affected formatting/lint pass.

The joint Cloudflare UI/Nitro → Worker dry-run → bundle-policy build passes
(2026-10-09, **23:56 UTC**): **8,998 entries / 1,015 original Nitro sources**.

- Worker: **10,674,183 bytes**, SHA-256 `d9fb0ffe930a4f193e2ad8b03d7aa06e00e3ebfcd4e897ed2154eae999845d7f`.
- Metafile: **778,431 bytes**, SHA-256 `5034660752fc3c59a5ffc7f8711067c52bfd72c82a8529f847a40727bc64a713`.

This does not prove execution of the compiled Worker/browser journey, operational
scale, Oracle CI or deployed acceptance. `UI-005` remains `NOT_VERIFIED`; the next
integral browser gate needs 26 matching real test orders and the compiled queue.
The 695 active / seven discarded requirements and production restrictions remain.

## Private order views and governed product zoom — local checkpoint (2026-10-09)

Migration `0085` adds private saved order views inside `/admin/pedidos`.
Each administrator may keep at most 20 active views, with one to seven selectable
columns plus the always-visible order identifier. Definitions save only validated
filters/sorting/columns, never search text, selected orders or order snapshots.
Applying a view explicitly reads the current 25-row server page; it performs no
business mutation. Create/update/archive use CAS and immutable actor-bound receipts.
Uncertain writes recover through an explicit command GET and fresh detail/list
reads, without an automatic POST/PUT replay. Archived historical receipts remain
recoverable without resurrecting or applying the archived view. Live authorization,
verified email and enrolled MFA guard reads, commits and recovery; authority loss
purges local private state. SQL guards also reject `INSERT OR REPLACE` against
commands and projections, including when recursive triggers are disabled.

The governed product lightbox adds keyboard/focus handling, reduced-motion support
and high-resolution selection only while open; changing its variant/source closes
the viewer. Existing governed media boundaries and Node behavior are preserved.
These are local implementation proofs, not approval of real catalog/media content.

The joint source gate passes **357 Node cases / 12 files**, including **two native
canary-source/workerd D1 cases through all 85 migrations** and seven full-upgrade
cases. Component bands pass **245 cases / six files** (124 gallery/consumer and
121 saved-view/workbench cases). Worker, auditor and Nuxt types, affected formatting/
lint, read-only traceability and diff checks pass. The native migration run exposed
a Wrangler trigger-splitting whitespace incompatibility; the three `= CASE` fixes
preserve SQL behavior and the subsequent native cases pass.

The combined Cloudflare UI/Nitro → Worker dry-run → bundle-policy build passes
(2026-10-09, **23:13 UTC**): **8,913 entries / 1,009 original Nitro sources**.

- Worker: **10,566,283 bytes**, SHA-256 `d49d4c18c6a0477e89d35bfc71d6f6c29caaf1d0fbaefcd156cd669684c38f39`.
- Metafile: **771,638 bytes**, SHA-256 `f29dc8381f8cd9b2ad376ec92343edca738ec655d94860d6523f5ab7d5991493`.

This compilation does not prove execution of the compiled Worker, Chromium,
Oracle CI, provider acceptance or deployment.
`UI-005`, `PDP-004` and `MED-010` remain `NOT_VERIFIED`: full bulk/cursor acceptance,
compiled-browser/accessibility/media approval and deployment gates remain pending.
The 695 active / seven discarded scope and historical checkpoints below are intact.

## Central sensitive administrative audit — source checkpoint (2026-10-09)

`ADM-005` adds migration `0084` and `/admin/auditoria`, reusing the original
immutable domain ledgers rather than copying or editing business history. The
registry covers 38 administrative families with actor, resource, correlation,
recorded network metadata and strictly allowlisted before/after facts. Private
free-text remains redacted; missing historical session/IP metadata stays unknown.
Customer self-service, automated provider events, application logs and historical
cancellations without a proven administrative audience are explicitly excluded.
New cancellation records bind the actual request audience, verified session and
an HMAC of the trusted ingress IP; no raw IP or inferred historical role is exposed.

GET `/api/admin/audit` provides bounded filters and keyset pages of at most 25
events; exact event-detail GET exposes only safe recorded changes. Review commands
append a reason-bound, CAS-versioned decision without changing original events.
Export commands freeze the applied filters and a minimized CSV: at most 1000 rows
and 2,000,000 bytes, with SHA-256, exact byte/row counts and a 24-hour download-access
window. Expiry denies access; it does **not** claim physical deletion of the ledger
or CSV. Oversized results fail instead of silently truncating.

Every read, commit, replay/recovery and download requires live
`administration.manage`, verified email, enrolled MFA and current identity/session
authority. The UI requires explicit review/confirmation, correlates durable
receipts with fresh server evidence and recovers uncertain results by manual GET,
never an automatic POST replay. Download is a separate explicit action, actor-bound
and verified against receipt, headers, digest and CSV structure before creating a
temporary browser download. Authorization loss/unmount purges private local state.

Focused source evidence currently passes **15 core**, **nine HTTP**, **one native
canary-source/workerd D1 case over all 84 migrations**, and **22 component cases**
(20 panel + two parent). The 15 core cases include three RED→GREEN integrity
reproductions: cancellation now reports its actual `awaiting_payment` prior state,
and missing/mismatched paired audit evidence fails closed instead of disappearing
into an apparently valid empty list/export.

The final joint Node source gate passes **396 cases / 17 files**, including all
three export-boundary cases, core/integrity, HTTP/runtime/network, central
cancellation, seven full-upgrade cases through all 84 migrations and prior
invitation-native/authorization/session/navigation/tracing regressions. Worker,
auditor and Nuxt types pass. Formatting/lint passes for 32 affected files; two
subsequent type-only generic fixes also pass their focused formatting/lint.
The joint UI gate also passes **86 component cases / five files**, including the
22 audit cases and navigation/context/palette regressions. Read-only traceability
and diff checks pass without changing statuses or the 695 active / seven discarded
scope (status counts remain 134/121/4/228/208/7).

The combined Cloudflare UI/Nitro build, Worker dry-run and bundle policy pass
(2026-10-09, approximately 22:34 UTC): **8,761 entries / 1,004 original Nitro
sources**, with the 84-migration source batch compiled.

- Worker: **10,479,850 bytes**, SHA-256 `768024d53592c83574746b793a1e5ccc43c0c483628fc0785a90d0f004748989`.
- Metafile: **756,880 bytes**, SHA-256 `88588ed4af22548ec35282ec5e7537f05accb981cb35865e4ec09e9e209481c1`.

The native D1 proof uses actual canary source, not this compiled Worker. Compilation
does not certify compiled-Worker execution, Chromium, Oracle CI, providers or
deployed acceptance. No deployment or promotion is implied.
The `40d32792…` / `8009b82a…` hashes below belong to
ADM-004, not this source batch. `ADM-005` remains `NOT_VERIFIED`; scope stays
695 active requirements and seven discarded.

## Administrative invitations and first-admin bootstrap (2026-10-09)

Migrations `0082` and `0083` add secure delegation to existing accounts and a
separate, explicit first-administrator bootstrap. Neither migration creates
accounts, credentials, roles or permission-policy seeds. `ADM-004` remains
`NOT_VERIFIED`: local implementation is not production acceptance.

The Cloudflare-only `/admin/equipo` panel reads the current delegable roles and
requires live `administration.manage`, verified email and enrolled MFA. It
generates a 32-byte random secret in browser memory; creation submits only its
SHA-256. The one-time link uses the configured HTTPS origin and
`/cuenta/invitacion#token=…`, never a token query. There is no automatic email.
Only an exactly correlated receipt followed by a fresh invitation-detail GET
allows copying the link. An uncertain result stays pending and is recovered by
an explicit actor-bound GET, without another POST.

The invitation entry page deliberately has no redirecting auth middleware:
otherwise `fullPath` would copy its secret fragment into a login query. It
clears the fragment client-side and exposes private preview/acceptance only to
the intended verified active customer with a current MFA session. Anonymous
users authenticate and reopen the original link; secrets are not persisted
across navigation. Acceptance rechecks the current issuer identity/version,
MFA, permission subset and frozen role policy, then atomically consumes the
invitation, grants once, audits and revokes the recipient's sessions. Issuer
logout/session expiry alone does not shorten the invitation's 1–168-hour TTL.
Expired/revoked invitations and already-existing grants do not grant access.

The recipient must log in again with MFA after acceptance. Lost-response
recovery retains only command metadata in the original tab and uses a fresh
same-account MFA session plus explicit receipt GET; it never resends the secret
or invents local roles. Closing that tab loses its recovery metadata.

`npm run admin:provision:d1 -- --identity=<existing-identity-uuid>` is a
read-only local plan. Applying requires `--apply`, the exact
`--expected-plan-hash`, a `--command-id` UUID and a `--reason` of 10–500
characters. The preexisting account/customer must be active, email verified,
MFA enrolled and its session current; the reviewed D1 `admin` policy must
already exist. One SQL statement owns all checks, grant, immutable receipt and
session revocation. Any existing administrative grant blocks bootstrap;
after the first bootstrap its immutable ledger prevents reuse even if the
grant is later removed. Exact same-command recovery does not regrant access.
The CLI is pinned to local `DB` and rejects remote/config overrides. It is not
a production recovery backdoor and was not applied to shared or deployed data.

Native acceptance uses actual canary-source routing and disposable workerd D1
with all **83 migrations**, including bootstrap, issuer logout, acceptance,
old-session denial and fresh-MFA receipt recovery; its outbound count is zero.
The final focused source gate passes **440 Node tests / 14 files** and
**153 component tests / seven files**, plus Worker/auditor/Nuxt types,
affected-file formatting/lint, read-only requirements audit and diff checks.

The combined Cloudflare UI/server build, Worker dry-run and bundle policy also
pass (21:50 UTC): **8,672 entries / 997 original Nitro sources**.

- Worker SHA-256: `40d3279251715d452df11b8bc1c192eee79468071439ac66e08598813ba7dcf9`.
- Metafile SHA-256: `8009b82ad9b45a46bc734f24d498525bc559d21d78b098f17899ae5796444142`.

The native proof above uses source routing, not this compiled artifact. Neither
it nor compilation certifies compiled-Worker/Chromium, real account-policy
provisioning, Oracle CI, provider or deployed acceptance. Those gates remain open.

## Local compiled checkpoint (2026-10-09, 21:13 UTC)

This previous combined Cloudflare UI/server build, Worker dry-run and bundle policy passed:
8,574 entries and 990 original Nitro sources. The build includes the calendar,
support-escalation, contextual-promotion, communication-history and additive
analytics source batches; the current migration inventory is `0001`–`0081`.
Compiling does not apply those migrations to a deployed database.

- Worker SHA-256: `a68b47910f89ecdd4e6d1c87376c5fcd190a16127efb126c3294cdaf74a0cdeb`.
- Metafile SHA-256: `229f5650f65b8fb460459f761a107f88f084bf8434622068daf85283b5fcddbc`.

An isolated Nitro reproduction first exposed an unresolved relative shared-module
import in the communication panel. Its existing project-root alias fixes the
failure without changing runtime bundler policy. The full build then passed.
Search now distinguishes API failure, loading and confirmed empty results, with
an explicit single-flight GET retry preserving filters. Search remains noindex
without canonical/alternate links to a noindex destination; configured catalog,
category-pagination and product canonicals retain their existing behavior.

The final directed band passes 266 Node tests and 34 mounted-component tests,
alongside Nuxt/auditor type checks, affected-file format/lint, traceability and
diff checks. Earlier backend/native evidence remains scoped to its documented
source/runtime tests. This is not a new compiled-browser or deployed acceptance:
Oracle CI promotion, reviewed visual/accessibility journeys, actual-provider
contracts and operational acceptance remain outstanding. No deploy, provider
activation or production write occurred. The existing Node preview was untouched.

Outputs grew by 8,638,464 allocated bytes within the 2 GiB growth budget. The build
used one job with a 4 GiB memory cap, zero swap allowance and a fresh host gate;
root free space afterward was 27,084,980,224 bytes. Global free-space changes are
not attributed exclusively to this job. The full 695-active-requirement scope and
seven discarded requirements are unchanged; documentary coverage is not launch
completion.

## Contextual CMS promotions, communication history and address normalization (source integration, 2026-10-09)

Promotional banners, bars and cards extend the existing CMS JSON document; no
parallel CMS, page builder or legacy migration rewrite is introduced. Publication,
schedules, immutable versions, media approval and device-pinned preview grants
retain their existing authorities. An optional editor selects priority and public
home/catalog/category/product contexts. `GET /api/promotional-content` performs
bounded, set-based current-publication/media selection; drafts and private preview
tokens are not public targeting. The same renderer is mounted in the storefront
and private preview. Links use the existing canonical CTA policy, and trust copy
links to operating conditions without an unsupported fixed delivery promise.

Only visible, consented public impressions and explicit CTA clicks are measured.
The two Cloudflare event types accept strict UUID/version/placement properties,
not text, destinations, customer IDs or URLs. Private previews do not measure.
Migration `0081` adds a separate telemetry table and union read view; historical
`0052` rows and the Node eight-event endpoint contract are preserved. Event IDs
are globally unique across both tables. Retention freezes at most 100 IDs across
both families and deletes them with one quota/run and atomic guards. These are
client-reported observations, never evidence of publication, payment or sales.

Migration `0080` adds immutable human-requested preparation-recovery receipts.
`/api/admin/communications/history` exposes bounded operational metadata only,
with verified email/MFA and current `administration.manage`; support-only access
does not disclose global history. Recipient, body, provider identifiers and
authentication/security/marketing messages are excluded. Only proven pending
`preparation_failed` order-created/public-support work can have its availability
rearmed, with live source authority and attempts/availability CAS. The action
does not invoke a sender, reset attempts or create another outbox event. Existing
authorized dispatch may run later. Sending, sent, ambiguous, suppressed, exhausted
and unsupported sources are never blindly retried. The panel explicitly reads,
reviews and confirms, retains uncertain intentions, recovers exact receipts and
purges private state when authority/context changes. History remains observable
with email delivery disabled; no delivery feature is enabled by this work.

The Cloudflare address boundary normalizes single-line fields to NFC and rejects
controls before trimming, while preserving strict HTTP unknown-key rejection,
multiline instructions and legacy Node behavior. No historical address is rewritten.

These changes are covered by the newer local compiled checkpoint above; prior
browser evidence below does not represent migrations `0080`/`0081`. Compiled-browser, reviewed UI/accessibility,
real editorial/operational policy, provider delivery, Oracle CI promotion and
deployed acceptance remain pending; no broad requirement is promoted to complete.

## Shipping calendars, internal escalations and UI-state harness (source integration, 2026-10-09)

Migration `0078` keeps operating calendars initially unconfigured. A live
`administration.manage` operator with verified email/MFA explicitly reviews
Madrid cutoff, preparation days, operating weekdays and national/local/carrier
closures. The calendar panel lives in `/admin/operaciones`; it does not inherit
the legacy Node writer. Shipping combines the selected destination, method,
profile, zone and canonical supplier stock lead time. Unknown configuration or
lead time yields unknown ETA, not invented delivery dates. Dates and calendar
revision bind the option hash; checkout recalculates current eligibility and
guards the final batch against calendar drift or a crossed cutoff/date boundary.

Migration `0079` adds internal payment, stock, transport and Beply escalation
queues. Live `support.manage` operators assign eligible owners, severity, a
next action and an explicitly approved, unexpired internal runbook. Runbooks are
separate from customer-reply macros and start empty. Escalation resolution does
not resolve the customer ticket. Commands have independent ticket/escalation
versions, immutable actor-bound receipts and hash-bound manual recovery; they
do not charge, refund, change stock, issue invoices or send communications.

Both private panels retain uncertain intentions instead of automatically
reposting, reauthorize recovery and purge drafts on lost context/authority.
Real operational calendar/runbook approval is not supplied by test fixtures.
The actual canary handlers pass the directed integration band (28 tests in five
files) and an additional actual workerd D1 case with all 79 migrations, exact
receipt/replay, revoked MFA and unchanged economic/email records. No outbound
request occurs; the native runtime is disposed. These source checks are not a
compiled-browser or deployed acceptance claim.

UI-013 now has deterministic dense/empty/loading/error/stale/denied fixtures,
real admin/customer order component mounts and bounded opt-in Cloudflare-CSS
capture. Directed bands pass 5 harness, 12 component and 8 capture tests. The
48 visual comparisons and two real-route E2E cases are prepared, not executed;
no PNG baseline is approved. Static hashes do not establish compiled bundle
provenance or hydration. See [the harness instructions](../testing/ui-state-harness.md).
UI-013 moves from `MISSING` to partial `NOT_VERIFIED`, not completion. Shipping
and support statuses remain partial. The prior INV-010 build/REQUIRED51 result
below does not represent this newer source batch; no new browser or deployment
has been launched by this section.

## Reviewed inventory count imports (source validation, 2026-10-09)

INV-010 uses migration `0077` and the existing global inventory coordinator for
an explicit single-warehouse count workflow. In `/admin/inventario`, open the
count-import panel, preview a CSV, review every difference, then submit a reason
and operational reference. A different authorized operator discovers the lot in
the paginated list, reviews its current balances and explicitly approves it.
Proposal creation does not change stock. Approval applies all changed rows in one
atomic D1 batch; a stale row or failed movement aborts the entire batch. There is
no silent overwrite or new compensating-stock workflow.

CSV is UTF-8 with the exact header `sku,countedPhysicalQuantity`, 1–100 data rows
and at most 64 KiB. The JSON transport limit is 128 KiB to allow escaped CSV.
SKU input is trimmed/NFC-normalized and matched literally using catalog NOCASE,
not fuzzy matching. Unknown, ambiguous, duplicate or invalid quantities prevent
the whole proposal. Zero differences remain visible; an entirely unchanged lot
cannot be proposed. Preview hashes bind the unique location and canonical stock
facts/versions, and proposals revalidate them. Approval revalidates every balance,
ledger and reservation, including persisted reservations awaiting explicit expiry
release. A decrement cannot consume blocked or reserved quantities. No warehouse
selector, reservation creation, pricing, payment or external provider is involved.

The private API uses `GET /api/admin/inventory/count-imports` (`page`,
`perPage <= 25`), `POST /preview`, `POST` on the collection, `GET /:importId` and
`POST /:importId/approve` beneath that namespace. Reads and preview require live
`inventory.read`; proposal/approval require `inventory.write`. All require
verified email and MFA. `preview.canPropose` and `snapshot.capabilities.approve` are server-owned
action flags, not inferred navigation permissions. Sessions and grants are
checked initially, at mutation and before releasing private reads. Initial lot
version is 1; approval advances it to 2. Only nonzero differences increment stock
balance versions. History and receipts remain immutable and actor-bound.

Commands require a UUID `Idempotency-Key`. After an uncertain response, retain
the original intention and use manual `GET /commands/:key` with the exact
`X-Neteco-Command-Payload-Hash`, then a fresh lot/balance read before confirming
success. Unknown is not proof of failure and never causes automatic resubmission;
an explicit exact retry preserves the original key/body. Changed payloads conflict,
and replay still requires current authority. Recovery never reapplies a movement.
Private/no-store responses and scope-change purging protect count reasons and
references. Node behavior is preserved.

Local source evidence: 21 core tests, 20 HTTP tests, 22 component tests and six
legacy component checks pass. The 11 canary/coordinator integration checks pass
inside a 366-test inventory regression; two real API/DO/SQLite checks exercise
the six-scenario native helper. Two further source-based tests pass against the
actual workerd/D1/coordinator binding with all 77 migrations: 100-row atomic
approval/recovery, and a stale final row that leaves no partial adjustment.
No outbound requests occur and the disposable runtime is removed. The final
targeted integration band passes 329 tests; global lint/format and Worker,
auditor and Nuxt typechecks pass. The Cloudflare UI/Worker build and bundle policy
pass (8,357 entries / 972 original Nitro sources), shop hash `b3daaf28…`,
metadata hash `cfe1e00b…`.

The single bounded REQUIRED51/77 attempt on 2026-10-09 at 19:22 UTC returned
`not_run / global_lock_busy` before starting the auditor or browser: another task
held the shared E2E lock. All six local cleanup checks pass; no remote browser or
tunnel was created. This is neither a product failure nor browser acceptance,
and the consumed attempt is not automatically retried. Compiled-helper and
Chromium acceptance, Oracle CI and deployment remain pending; INV-010 is not
declared fully verified by this section.

## Reviewed directed product relations (local integration, 2026-10-09)

Migration `0076` adds manually reviewed substitute, compatible, accessory and
equivalent relations. Admin snapshots use live `catalog.write`, verified email
and MFA, optimistic versions, immutable revisions and actor-bound command
receipts. Reasons and review references are required; they are not public.
Receipt recovery uses GET and a matching payload hash, followed by a fresh
snapshot. An uncertain result never authorizes an automatic second POST.

The product editor consumes `/api/admin/products/:id/relations`; PDP, cart and
support context share the bounded `/api/product-relations?slugs=…` projection.
Only currently published, valid endpoints and canonical effective gross/net
prices are returned. Relations are directed: no reciprocal inference, automatic
cart addition, automatic substitution or chemical-compatibility certification.
Generic same-category recommendations remain separate. Node behavior is unchanged.

Core, HTTP, actual canary/workerd D1 and component checks pass locally. The compiled
shop regression passes 363 native scenarios with all 76 migrations and zero
outbound requests. REQUIRED49/76 stopped later at an obsolete synthetic company
fixture, after passing the previous RMA transport checkpoint; cleanup is confirmed.
The company fixture has been corrected against the real fiscal validator and HTTP
contract, but a new Chromium acceptance has not run. CAT-010 remains NOT_VERIFIED;
real catalog technical review, Oracle pipeline and deployed acceptance are pending.

## Saved carts and revocable sharing (local integration, 2026-10-09)

Migration `0075` saves the server-owned cart into existing named favorite lists,
including quantities. `POST /api/account/cart-snapshots` requires a live verified
account, original cart possession, expected version and matching
`X-Neteco-Cart-Id`. A private save does not create a public link. Actor-bound
commands preserve exact receipts; recovery does not recreate a subsequently
deleted list or make a revoked share live again.

Explicit sharing creates an immutable variant/quantity snapshot with a separate
24-hour HMAC capability. D1 stores only its digest. The capability is carried in
an ephemeral URL fragment and a bounded POST body, never an API query or client
storage. `/carrito/compartido` clears the fragment before requesting the preview;
responses are private/no-store and no-referrer. Owner revocation, expiry,
deletion of the saved list or loss of active owner authority invalidate access.

Public preview resolves current published products, effective prices, volume
tiers, tax, quantity rules and availability through the canonical cart resolver.
It exposes no customer data, private costs, coupon or original contractual price.
Saving, sharing and resolving do not change the source cart or inventory. Copying
selected references requires explicit confirmation and uses sequential existing
cart additions: an uncertain addition stops the batch and is not automatically
resent. Session changes purge private intentions. Node behavior is unchanged.

Directed SQLite, actual canary/workerd D1 and component checks provide local
evidence. Compiled-browser, Oracle pipeline and deployed acceptance remain
pending; this is not a production-readiness claim.

## Real basket and merchandise-margin simulation (local integration, 2026-10-09)

`POST /api/admin/promotions/basket-preview` is a private, explicit simulation, not
a checkout or promotion activation. It accepts variant identities/quantities,
destination, optional existing customer and the proposed rule. One consistent D1
read batch resolves the same effective prices, tiers and shipping rules used by
checkout, together with current tax, quantity rules, customer segment and usage.
No caller-supplied price, cost, tax, approval or counter is accepted.

The panel compares base, volume and the permitted proposed-rule result. The rule
is evaluated active only in memory, preserving its calendar and eligibility;
no cart, quote, reservation, redemption or campaign activation is written. HTTP
still consumes the existing security quota. Product `cost_net_cents = NULL`
remains unknown, while zero is a known cost. A missing line cost makes aggregate
merchandise cost, margin and loss unknown rather than understating them.

Customer shipping charges are shown separately. They are not carrier operating
costs: no such source exists yet, so operating shipping cost and total profit
remain unknown, even when merchandise margin is positive. The simulator does
not certify a profitable or approved campaign. Costs require the live atomic
intersection of `catalog.write` and `administration.manage`, verified email and
MFA before/after asynchronous reads. Responses are private/no-store; buyer,
guest and public APIs do not acquire cost fields. Node behavior is unchanged.

Variant search reuses the existing SKU/price administration endpoint. The optional
customer context accepts a known internal customer ID; there is no invented
customer lookup or substitution of a company ID. Editing context invalidates the
result, and session changes or authoritative denial purge private data.
The compiled shop regression passes 361 native scenarios with all 74 migrations
and zero outbound requests, including a real private simulation and unchanged
domain-state proof. Compiled-browser, Oracle pipeline and deployed acceptance
remain pending.

## Buyer purchase-order reference (local integration, 2026-10-09)

Migration `0074` adds optional immutable `orders.purchase_order_reference`.
Cloudflare checkout accepts `purchaseOrderReference` independently of the buyer's
tax identity, addresses and delivery instructions. The server validates raw
single-line text, trims and NFC-normalizes it, and bounds it to 120 UTF-16 units.
Empty omission retains the historical checkout payload and response contracts.

The reference belongs to the frozen checkout intent and accepted order: replay
with the same normalized value returns the same result; changing it under the
same key conflicts. It is visible in the authorized customer/guest order detail,
administrative detail and preparation snapshot, not public catalog/search/list
results. Existing initial/final authority gates remain required; failures are not
reported as an absent reference. UI renders it as text, never HTML.

Historical orders keep NULL and their original financial amounts. The reference
cannot be updated, deleted with its order or overwritten by replacement inserts.
It does not modify fiscal-provider payloads, stock or monetary calculations. Node
checkout remains unchanged. Compiled-browser and deployed acceptance are pending.

## Governed coupons (local integration, 2026-10-09)

Migrations `0072`–`0073` add immutable coupon revisions, private administration,
CAS/audit and actor-bound receipt recovery. Codes support UTC calendars, online
channel, product/category/all scopes, customer segments and global/customer limits.
No campaign is seeded or enabled automatically. Administration requires the
existing `administration.manage`, verified email and live MFA authority.

Checkout accepts only the code. Effective pricing, volume tiers and `money.ts`
remain authoritative; fixed/percentage discounts allocate exact integer cents.
The explicit volume matrix supports stacking, excluding tiered lines or choosing
the better whole-basket result. One coupon per quote is supported, not a complete
automatic/bundle/gift/free-shipping promotion system. The separate real-catalog
cost/margin simulator above is private and never activates a rule.

Quotes retain rule/hash/customer evidence. A use is recorded atomically with the
accepted order, not with preview or quote; competing last-use checkouts roll back
their entire losing order and compensate their reservation. Exact replay consumes
nothing again. Limits count accepted orders, including later abandoned unpaid
orders; cancellation/expiry does not automatically restore quota. Contractual
lines and evidence reject UPDATE, DELETE and replacement inserts. Migration of
populated historical orders/RMAs preserves amounts, foreign keys and budget guards.

Customer/admin displays separate original amounts, included discounts and the
exact charged amounts. Fiscal source retains pre-discount net and discount net
separately, while refunds allocate only the post-discount contractual net/tax/gross.
A zero payable order is rejected before reservation/use: a no-payment completion
flow is not implemented and Redsys cannot charge zero.

Directed SQLite, service, HTTP, component and actual canary/workerd D1/cart-DO
checks provide local evidence. The compiled shop regression passes 361 native
scenarios with all 74 migrations and zero outbound requests. Its browser gate
now contains 45 journeys, including two new coupon journeys; none ran in this
batch. Compiled-browser, Oracle pipeline, provider and deployed acceptance remain
pending; the existing production has not been changed.

## Fiscal validation and personal export (local integration, 2026-10-09)

Cloudflare professional submissions, administrative approval, address book and
checkout now reuse one normalization/checksum contract. Professional and approval
use require a nonempty normalized identifier; address tax ID remains optional.
Spanish DNI/NIE/CIF use the existing local checksum validator. Other countries
retain structural checks only: this is not VIES or tax-authority verification.
Account/address forms reject invalid data before transport; legacy Node behavior
is unchanged. Invalid professional/address HTTP requests return 400 without
company, address or security-outbox writes.

The personal JSON export includes required `securityNotices`, scoped to the
currently authorized identity rather than an email address. Only kind, historical
recipient, audience and timestamp are exported; no internal IDs or credentials.
Stable ordering, the 1000-row bound, 2 MiB cap and final live authority check remain
enforced. The existing browser bridge compares notices with the actual owner
ledger. Native canary/workerd D1 with 71 migrations verifies five real source
notices, historical recipients, foreign denial and revoked-session denial, using
only fake sends and zero outbound. This does not establish complete data-subject,
legal, real-mailbox, compiled-browser or production acceptance.

## Account-security notices (local implementation, 2026-10-09)

Migration `0071_account_security_notices.sql` extends the existing transport for
authenticated password changes, MFA activation, verified email changes and
owner fiscal submissions. Minimal immutable sources and outbox entries commit
with the actual mutations; attempts and MFA setup alone do not notify. Email
changes notify both the previous and verified new addresses, without retargeting
after a later change. Fiscal notices mean presented for review, never approved.
Secrets, recovery codes, NIF and legal-name payloads are excluded.

The populated outbox migration preserves pending deliveries and receipts. Its
explicit final foreign-key guard rejects real orphans before resetting deferred
bookkeeping; rollback/retry is exercised on SQLite and native D1. Historical
`0062` fixtures remain explicit; current security fixtures apply the whole chain.

The native acceptance compiles actual canary and dispatcher source with all 71
migrations: password/MFA/fiscal/email HTTP, five simulated sends, queue replay,
atomic rollback and unchanged domain snapshots, with zero outbound requests.
Live authority and source/recipient proofs are rechecked before the sending
marker. Transport remains disabled by default; opt-outs do not suppress security,
pre-send outages use bounded retry and unknown sends are not automatically retried.
Real provider/mailbox, compiled-browser and production acceptance remain pending.

### Password-reset notice

A completed password reset enqueues `identity.security.password_changed` in the
same D1 batch as password rotation, token consumption and its lifecycle event.
Reset requests alone do not authorize this notice. The registered renderer binds
the consumed token, immutable lifecycle/security events, live identity and exact
recipient, then revalidates them atomically at the pre-send marker. Passwords,
reset tokens and credentials never enter the email or queue payload.

Security notices ignore marketing suppression and operational delivery opt-outs.
The existing transactional transport remains disabled by default. A corrupted or
changed recipient is not redirected; it requires review. A pre-send D1 outage
uses bounded retry, whereas an unknown provider result is never automatically
resent. The security trail uses the same command timestamp as the identity update,
not an assumed equality between independent JavaScript and SQL clocks.

Ten directed SQLite/outbox/dispatcher cases and prior legacy regressions pass
using only a fake sender. One native test additionally compiles the real canary
and dispatcher into workerd with all 71 D1 migrations, exercises reset HTTP,
atomic rollback, queue replay and one send without outbound traffic. This does
not imply real mailbox/provider, compiled-browser or deployed acceptance.
The reset notice itself requires no extra enablement flag.

## Operational delivery email choices (local implementation, 2026-10-09)

Migration `0070_delivery_preferences.sql` separates preparation/delivery email
choices from marketing and newsletter consent. Registered customers manage them
under `/cuenta/comunicaciones` and the private
`GET/PUT /api/account/delivery-preferences` API. An absent choice preserves the
existing operational behavior; it is not commercial consent. Live ownership,
verified email, configured MFA, CAS and immutable commands govern changes.
Receipt recovery uses the original UUID and exact payload hash, never an automatic
second PUT. Private state is cleared when account/session authority changes.
The owner-only data export includes the actual recorded delivery choice.

The existing transactional dispatcher checks the confirmed choice at the atomic
pre-send boundary for fulfillment notices only. Opt-outs create an immutable
terminal suppression record, with no recipient/body/token and no fake provider
receipt. Duplicate queue delivery and later re-enabling cannot resend that event.
An already-started send cannot be recalled by changing a preference. Payment,
order receipt, cancellation, invoices, refunds, support and security messages are
not suppressed by this choice. A damaged preference history fails closed.

This does not enable email transport, change providers, extend guest grants or
authorize guest preference writes. The existing two account-browser journeys now
also exercise delivery opt-out and lost-response recovery; their compiled
Chromium gate, real policy approval and deployed acceptance remain pending.

## Optional customer satisfaction (local implementation, 2026-10-09)

Migration `0068_support_satisfaction.sql` records one optional 1–5 rating and
private comment per registered customer and confirmed support/delivery target.
Resolved/closed support and delivered orders are read from their governed sources;
rating never changes support access, stock, payment or fulfillment. Guest order
view tokens do not authorize feedback, and guest survey invitations are not built.

Private customer GET/POST and receipt recovery live under
`/api/account/satisfaction/{support|delivery}/{targetId}`. Writes require current
ownership, verified email/session, same-origin CSRF, a UUID idempotency key, source
version and the exact privacy-policy hash displayed to the customer. Same-key
replay returns the original receipt; recovery does not resend the write. Policy
changes cannot extend the original retention of existing feedback. Expired data
is excluded from reads; automatic physical comment erasure is not implemented.

`GET /api/admin/support/satisfaction` requires live `support.manage` and MFA.
Bounded source/category/shipping-method/score segments return aggregate scores and
minimal paginated targets, without customer names or emails. Comments are omitted
unless explicitly requested. Corrupt retained projections fail closed instead of
appearing as zero feedback. Every response is private/no-store.

Directed SQLite/HTTP checks and actual canary source with workerd D1 and all 68
migrations pass. The complete compiled-browser gate adds support/delivery journeys
in desktop and mobile, preserving all previous journeys: 41 required in total.
Compiled Chromium acceptance, real privacy policy/retention approval and deployed
operation remain pending; local evidence is not production or Oracle CI acceptance.

## Single-warehouse operating alerts (local implementation, 2026-10-09)

Migration `0067_inventory_alerts.sql` adds audited low-stock, out-of-stock and
inventory-anomaly episodes. Their facts reuse the inventory reconciliation and
sellable-stock expressions; alerts never receive, reserve or adjust stock. An
explicit per-variant threshold is independent of safety stock. At most one active
episode exists per variant: acknowledgement preserves it, recovery resolves it,
and a later decline can create a new episode. Repeated evaluation does not create
duplicate active alerts.

The private inventory panel provides state/type/SKU filters, paginated current
facts, threshold configuration from a confirmed SKU selection and acknowledgement.
Writes require current `inventory.write`, verified email/MFA, CSRF, a reason,
optimistic version and an immutable idempotency receipt. Reads use `inventory.read`;
command recovery requires write authority and the exact intent hash. Lost responses
retain the original intent for explicit receipt recovery and a fresh confirmed GET,
not an automatic second mutation. GETs never evaluate or change inventory.

The existing Cron invokes one bounded page only when both `AUTH_ENABLED` and
`INVENTORY_ALERTS_ENABLED` are `true`. The latter defaults to `false` in canary and
safe local/preproduction projections; the manual API remains separately available
under authentication. Its durable cursor advances through variants and independent
stage handling prevents a fiscal failure from starving alerts. No new scheduler,
warehouse, email transport or provider is introduced. Evaluation/audit retention
and real business thresholds require operational approval before activation.

Directed unit/component checks and actual canary source against workerd D1 with all
67 migrations pass, including a 100-position evaluation and unchanged stock digests.
Compiled Chromium journeys and deployed operation remain pending; these checks do
not certify production or Oracle CI.

## Public isolated Worker demo (2026-10-03)

The user explicitly authorized publishing `https://neteco.tonomolla.es` before
continuing development. The new `neteco-demo` Worker serves the complete compiled
Nuxt Cloudflare renderer and D1 APIs, not the old Node visual preview. Production
`neteco.es` remains on `neteco-landing`; its modification date is unchanged.

The previously provisioned **empty** `neteco-preprod` D1 and EU media bucket are
used exclusively for this synthetic demo. All 52 migrations were applied; the
one-shot bootstrap creates 20 governed products, 50 variants, one warehouse,
two dummy accounts, six genuine contractual **pending** orders, two published
noindex CMS pages, one draft and two support fixtures. Its original DEMO artwork
is actually stored in R2 with SHA-256. Synthetic scanner/policy fixtures are
labelled as such and are **not** commercial/legal/antivirus acceptance. Media and
catalog authority expire on **2026-10-10T18:20:25Z**, rather than bypassing expiry.
The populated demo refuses blind reseeding or stock/history overwrites.

Login has floating customer/admin buttons behind an explicit public demo flag.
POST `/api/demo/login` accepts only the selected role, checks the exact HTTPS
demo origin/preview/CSRF/native edge controls, and issues a real one-hour D1/Iron
session for one of two fixed dummy identities. Administrative MFA is simulated
**only** for the isolated dummy account; normal password/TOTP authentication is
unchanged. The browser must confirm the fresh role/identity/session before
navigating. This is a public shared demo: do not enter real personal data.

Session/encryption keys are independent random Cloudflare secrets, never copied
from production or put in source/public config. There are **no email transport,
queue/workflow dispatch or cron bindings**. Redsys, Beply, fiscal issuance,
refund/credit dispatch, newsletter sending and transactional email remain OFF.
Support public intake also remains OFF. Provider receipts and paid orders were
verified absent. This deployment does not complete the production roadmap.

Operator commands (remote writes require the user's deployment authorization):

```sh
npm run build:cloudflare-ui
npx tsx scripts/generate-demo-config.ts
npx tsx scripts/cloudflare-demo-remote.ts migrate
# First empty bootstrap only; never run this to overwrite a populated demo.
npx tsx scripts/cloudflare-demo-remote.ts seed
npx tsx scripts/cloudflare-demo-remote.ts deploy
npx tsx scripts/cloudflare-demo-remote.ts secrets
npx tsx scripts/cloudflare-demo-remote.ts attach
npx tsx scripts/audit-demo-browser.ts --run-demo
```

Credentials are read from `NETECO_DEMO_CLOUDFLARE_CREDENTIALS` (absolute path),
defaulting to `/root/.config/workspace/credentials/cloudflare.txt`; the token is
used only when the file's account equals `DEMO_ACCOUNT` and is never printed.

**Preproduction payments (2026-11-12).** The demo enables Redsys only against the
public test merchant (`999008881`, terminal `1`, `REDSYS_ENVIRONMENT=sandbox`,
redirect `https://sis-t.redsys.es:25443`); the deploy contract rejects any other
environment, merchant, terminal or Bizum, and `secrets` provisions only the public
Redsys test key when no `REDSYS_SECRET_KEY` exists. Beply, fiscal issuance,
refund/credit dispatch and every email transport stay OFF. The hostname is behind
Cloudflare Access, so Redsys' server-to-server notification cannot reach the
Worker: to receive it, exclude **only** `POST /api/payments/redsys/notification`
(and `/api/payments/redsys/preauth-notification` if pre-authorisations are used)
from Access with a bypass policy for that exact path. The notification is
authenticated by its HMAC_SHA512_V2 signature, not by Access. Until then a sandbox
payment returns the shopper to the shop but the order stays pending.

Deployment initially has no public target; `attach` binds only the exact demo
hostname after data/secrets are ready. Migration/seed use maintained native remote
D1/R2 bindings and dispose their temporary proxies. Wrangler's 4.124 SQL splitter
needs token whitespace around `END,`/`END)`; the transport shim preserves quoted
data, does not edit migrations and is tested against all 52 original schemas.
Focused demo gates pass **88 unit cases** and **32 component cases**, plus Worker
and Nuxt type checks and the full Cloudflare build. HTTPS login/catalog/robots
reads and exact Cloudflare domain/resource mapping have been checked.

Demo HTML is private/no-store/no-transform: the latter prevents Cloudflare's
automatic Web Analytics injection without relaxing CSP or changing zone-wide
settings ([Cloudflare documentation](https://developers.cloudflare.com/web-analytics/faq/)).
Real HTTPS API checks confirm both demo sessions and order reads; the customer is
denied administrative order access with 403. These checks do not assert provider
acceptance or completion of every screen in the application.

Real Chrome completes all four access scenarios: mobile and desktop login,
customer and admin buttons, exact synthetic identities and fresh sessions after
reload. Both account/dashboard screenshots were inspected. The strict browser
boundary nevertheless remains **RED** for one hydration console diagnostic in
`/_nuxt/B8Nn8YSB.js:0`; this is an open frontend finding, not silently waived.
There are no CSP failures, page exceptions, HTTP failures or external requests.
Three cancelled privacy-cookie DELETEs have independently confirmed 204 responses.
Catalog/order/stock UI are outside this bounded four-scenario browser acceptance.

The subsequent **local-only** hydration investigation reproduced the actual
operational-clock node after Nuxt finished hydrating: UTC SSR rendered `19:51`
while a Madrid browser rendered `21:51`. The dashboard now explicitly formats
that timestamp in `Europe/Madrid`; no SSR, CSP or diagnostic guard is disabled.
Four regressions execute the actual template expression across server timezones
and DST boundaries. Chrome against the newly paired compiled Worker/assets now
confirms identical server/client text in both UTC and Madrid contexts, completed
hydration, verified public runtime flags, zero diagnostics and zero external
requests. Its disposable fixture was removed. This corrects the local source,
**not the previously published demo**, and does not imply whole-site browser
acceptance.

The following checkpoint supersedes older transport notes below: the private favorites namespace now supports D1 lists, quantities and fresh
pre-cart preparation. Administrative order, detail, stats and operations reads
recheck live D1 administration permission and MFA. Unsupported carrier and
bank-reconciliation capabilities remain unavailable rather than fabricated.
Migration 0031 adds durable transactional email jobs and a Cron dispatcher for
`order.created`; the separately authorized `EMAIL` binding stays disabled.
See [delivery and manual-review semantics](../../workers/communications/README.md).

The Cloudflare build is isolated from the existing Nuxt/Node build. Its renderer
and migrated D1 APIs now run together in a real local Workers runtime; unported
APIs return an explicit failure, never fall back to PostgreSQL. This is a local
integration checkpoint, not permission to replace production.

## Financial resolution, support and editorial newsletter (2026-10-03)

This frozen local checkpoint supersedes the refund/support/editorial gaps in the
historical sections below. Migrations 0048–0051 add implementation evidence, not
production acceptance or completion of every requirement in those domains.

Refund/credit contracts preserve historical line/shipping money, captured and
RMA budgets, original invoice and stock. Uncertain provider outcomes retain
allocation without automatic resubmission. Admin actions keep ambiguous bodies
and keys through refresh; customer views are owned/read-only. Signed Redsys
type-3/0900 correlation passes offline, not bank acceptance/settlement. Real
Beply corrective execution refuses before I/O pending authoritative
document-kind/reference/signed-total evidence. Independent immutable refund,
credit and public support email renderers do not inherit ordinary-invoice opt-in.
See [financial transport boundaries](../../workers/communications/README.md).

Support adds contact, staff/customer timelines, redacted context, internal notes,
assignment, next action and explicit policy. Email/order claims grant no private
access. Private R2 attachments use dedicated signed scan receipts, not catalog
authority. Actual Turnstile proof checks hostname/action/time; only the contact
document permits the official script/frame origin. SPA navigation obtains that
document; case-insensitive UI aliases retain privacy/CSP and late/revoked SDK
callbacks cannot restore tokens. Fixtures are not real anti-spam/scanner proof.

Newsletter adds explicit double-opt-in preference access, topics/frequency/quiet
hours, governed CMS-backed campaigns, caps, paginated recipients, suppression and
signed unsubscribe. Current CMS/media authority is rechecked before dispatch;
acquisition OFF does not disable unsubscribe. A separately opted-in local sender
runs inside workerd, persisting only synthetic fingerprints/message IDs in 0051,
never recipient/body/token or an external request. The real newsletter binding
is separate from transactional email. New flags default OFF; empty financial
allowlists do not even sweep stale markers. Unsupported native namespaces fail
privately rather than falling back to Node.

The frozen combined suites pass **4940 unit tests in 179 files** and **1764
component tests in 48 files**. A Nuxt/Nitro shared-import rebase defect was fixed
using the existing root alias, without changing externalization/bundle policy;
the subsequent financial/static wiring regressions pass **32 cases**. The built
shop passes dependency policy for **6282 entries and 801 original Nitro sources**;
its main script is **7532290 bytes** (**1596936 gzip**).

Real disposable workerd passes **242 scenarios, 51 migrations, 20 synthetic
public products and zero outbound requests**, including the two calendar HTTP
cases and 95 additional phase-three checks. Four local HTTP checkouts use signed
synthetic bank callbacks and actual DO allocation. The financial fixture selects
a genuinely quoted pickup service and a distinct verified synthetic customer;
identity quotas are preserved, never cleared or raised. Runtime reload preserves
the D1 digest and exact owned R2 bytes/checksum.

Support/editorial HTTP, signed private-R2 scan fixtures and the persistent local
newsletter sender execute in workerd. Positive fiscal/refund/credit and
transactional-email execution instead uses host Worker-compatible dispatchers
with native D1/R2 and synthetic providers. This does **not** establish positive
workerd scheduled/Queue entrypoints, real scanning, bank settlement, Beply
rectification or external email delivery. Guest verification, physical erasure,
approved retention, macros/knowledge base, all templates, marketing automations,
tracking and full browser/business/provider acceptance remain open.

The following analytics checkpoint adds migration 0052; its current evidence
is separate from these historical 51-migration counts. Legacy capture records
lacking environment provenance cannot retrospectively become real revenue from
the current APP_ENV. Broad requirement states remain unchanged; no commit,
push, deploy or real provider call occurred.

## First-party measurement and authoritative analytics (2026-10-03)

Migration 0052 adds consented client events, immutable commerce facts and bounded
projection/retention ledgers. Acquisition, projection and retention have separate
OFF-by-default opt-ins. An explicit versioned policy binds purpose, consent,
environment and retention; there is no invented reviewer or approval. Anonymous
sessions use a dedicated 32-byte HMAC secret, never a newsletter/session key.
Withdrawal remains cookie-only and available when acquisition, its policy,
pepper or limiter is unavailable.

Captures require the actual winning intent, applied state, fulfillment claim,
completed recovery and one original verified authorization. The payment path
records only hashes and the server-owned bank environment on the first valid
authorization; recovery callbacks cannot relabel/backfill legacy provenance.
Production excludes known sandbox/synthetic sources; contradictory or absent
proof remains unconfirmed. Submitted uncertain refunds make money unknown;
unsent requests do not create financial effects. Fiscal issuance is a distinct
document metric, not a sale or bank settlement.

The private MFA/administration reader uses a consistent D1 snapshot with real
global coverage/counts and separate page slices. Missing proof/backlog yields
nullable metrics, not zeros. UTC periods are bounded to 31 days and expired
periods are unavailable. Final synchronous gates after all authorization/hash
awaits reject withdrawn or changed configuration; SQL and returned population
use the original checked snapshot. No GET projects, repairs or writes audit
rows. The `/admin/analitica` panel shows sources, policy, population, coverage,
definitions and exceptions; collection minus refunds is explicitly not net
sales, margin, conversion or settlement.

The browser boundary validates consent, own JSON, taxonomy, private/preview
routes and PII before dataLayer or its single retry-free POST. Search text is
omitted without changing the existing Node v1 input contract. A frozen/throwing
dataLayer does not break the storefront or cause retries. A late accepted POST
after consent withdrawal triggers another cookie clear in-page, not a guarantee
across unload. Server collection stores no raw cookie UUID, query, IP or UA.

Independent bounded retention removes only expired client telemetry, records
durable quota usage and rolls back on failed postconditions. Financial source
contracts, stock and immutable facts are not deleted. Extending policy retention
does not revive expired immutable facts; missing historical coverage stays
visible. Maintenance errors are unavailable, never a fabricated successful zero.

The focused frozen measurement/security suites pass **272 unit cases**,
including twenty real-SQLite post-authorization/hash configuration races. The
panel/privacy component suites pass **61 cases**. The previous native checkpoint
passed **264 scenarios/52 migrations**, including nineteen native analytics
HTTP/maintenance cases and actual compiled Chrome desktop/mobile rendering.
The rebuild and native rerun after the final race/dataLayer/keyboard fixes also
passed **264 scenarios/52 migrations**, with zero outbound requests. The frozen
global suites subsequently passed **5,227 unit cases** and **1,808 component cases**;
these precede the separate demo gates above.
Browser requests are forwarded only to real disposable workerd; no fake API
DTOs, deployment, DNS service or external browser provider is used.

Projection/retention positive cases still use host Worker-compatible callbacks
against native D1, not positive workerd scheduled/Queue acceptance. Browser
evidence uses only sealed synthetic sessions. Real policy approval, internal
traffic rules, full ecommerce funnel/attribution, commercial dashboards, legal
retention/exports, provider acceptance and bank settlement remain open. The
analytics skill's measurement/quality guidance informed the separation of
financial authority and browser activity and the explicit unavailable states;
no separate Sites/React app or analytics SDK was introduced.

## Complete and filtered native catalogue export (local, 2026-10-04)

`GET /api/admin/catalog/export/snapshot` provides the distinct read-only
`native_catalog_snapshot_v1` profile. Only `q`, category legacy ID and product
status are accepted: no pagination, injected timestamp, client snapshot ID or
write. Native/unmapped products and all their variants are included. Original
IDs, attributes, states and null/empty distinctions are preserved; inventory,
effective/historical prices, retained media relations and scoped references
share one consistent D1 batch. Private actor/command/quarantine object keys are
not exported. Media metadata and editorial states are not approval or live-sale
authority, and this profile is not an import or the legacy 71-column format.

Both `catalog.write` and `administration.manage` must exist simultaneously,
with current verified email/MFA/session. Joint authorization runs before the
read, after it and after SHA-256. HTTP uses private/no-store headers and
same-origin checks; errors/outages never become an empty successful download.
Server UUID/time, explicit filters, counts and checksum form the Manifest.
SHA-256 is an integrity checksum, not a signature or a permission grant.

The product page downloads all matching records, not just the displayed page.
CSV carries `sheet,row_index,record_json`, with Manifest and all six entities.
XLSX supplies Products, Variants, Inventory, Prices, Media and References plus
Manifest. Existing ExcelJS is loaded only after an explicit client download;
every cell is string/text and there are no emitted formulas or hyperlinks.
`record_json` retains typed original values where display cells are blank.
Context changes/logout/unmount discard pending private results and Blob URLs.

Limits are 1,000 products, 10,000 aggregate entity rows, 8,000,000 bytes and
20,000 characters per cell, including record JSON. Oversized output is rejected,
never silently truncated. D1 aggregates bounded candidate counts/raw bytes
before returning large text, followed by one cumulative own-JSON budget before
projection. Twelve candidate aggregates use four-term subgroups: the actual
local workerd runtime rejects a six-term compound SELECT. SQLite fixtures now
also enforce compound=5, expression=100, bind=100 and function-args=32 rather
than masking the runtime difference. Published platform limits are documented
in [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Frozen gates pass **5,521 units/200 files**, **1,922 components/52 files**,
Worker/Nuxt types, lint/format and paired Cloudflare build. Bundle policy passes
**6,608 entries/831 original Nitro sources** and explicitly rejects ExcelJS in
the Worker. The final actual workerd audit passes **278 scenarios/53 migrations**
with zero outbound requests; eight export scenarios include real compiled
Chrome CSV/XLSX downloads, desktop/mobile, exact records/hash, zero browser
exceptions and zero catalogue/financial/inventory/audit mutations. The final
41 server cases were also repeated under the observed five-term constraint.

Review fixed the aggregate memory budget before building sheets. Native D1
caught the compound-limit mismatch; limits were not increased. A component
test was corrected after tracing VTU's pre-setup getter traversal, without
changing source controls or weakening zero-getter/GET assertions.
CAT-015 now has repository evidence: **134/695 = 19.28%**, not production
completion. Full native catalogue/XLSX import remains open. No commit, push,
deployment, production/provider call or live demo probe was performed.

## Functional development batches and catalogue file preparation (local, 2026-10-04)

The user's faster-development workflow groups all 695 active requirements into
15 functional modules; seven discarded rows remain historical. The executable
manifest preserves each acceptance, phase, priority and evidence state. The
requirements matrix remains the evidence source, not a list of 695 build/commit
iterations. See [the functional route](../production/ruta-desarrollo-funcional.md).

`npm run development:plan` is read-only and prints real grouped counts.
`--module <id>` can be repeated for one delivery batch: tests are deduplicated
and `--run` explicitly runs each selected Vitest project once. `--gate` only
prints the serial local gate; `--gate --run` runs it. No Git, deploy, external
provider call or remote CI is implicit. Each batch prepares its tests first,
implements in up to three independent agent fronts, then freezes for root
review and one joint gate. Release/provider/manual-acceptance gates remain
separate and mandatory; registered regressions are not acceptance of future
features.

The catalogue page can now inspect a complete legacy 71-column CSV/XLSX in the
browser without uploading it. It reuses the pure schema and installed ExcelJS
(dynamic client-only import), preserving the 20 MB/25,000-row/20,000-character
format limits. The shared ZIP metadata guard rejects malformed/truncated,
encrypted, ZIP64, unsafe-path, duplicate-entry and over-budget archives before
ExcelJS. Its advertised expanded-byte budget is 100 MB/1,000 entries; the reader
also rejects an actual inflated-length mismatch. Formula/shared-formula,
hyperlink and unsupported rich cells are refused, and CSV structure is bounded
while scanning. The Node service keeps its public API and shares that guard.

The form requires a confirmed admin context, clears stale local reports on
actor/MFA/runtime/capability changes, bounds displayed errors and renders
untrusted text escaped. A local valid file does **not** establish live D1
references, permissions, prices/stock, asset rights or publication approval.
It neither applies imports nor impersonates the native six-entity export or
nine-column editorial profile. Full D1 import preview/apply/jobs/recovery remain
in the same functional batch, and CAT-014 is not marked complete.

The single frozen local gate passed **5,544 units/203 files**, **1,951
components/53 files**, Worker/Nuxt types, lint/format, paired Cloudflare build
and bundle policy (**6,609 entries/832 original Nitro sources**). Actual workerd
passed **280 scenarios/53 migrations**, including compiled Chrome's real file
inputs and both real CSV/XLSX codecs: 125 same-origin requests, zero page errors,
zero external requests and no catalogue/financial/inventory mutations. The
read-only requirements audit stays **134/695 = 19.28%**; production acceptance
and full native import application remain unproven. No deployment was performed.

## Full tabular native intake checkpoint (local, 2026-10-04)

Migration 0054 and the separate `/api/admin/catalog/native-import` namespace
implement the full existing 71-column CSV/XLSX intake contract for new records.
The browser keeps the guarded existing decoder; server previews validate every
record again, current references and identifier conflicts, including cross
EAN/GTIN collisions. A bounded batch accepts 500 records/900,000 JSON bytes,
with a private immutable thirty-minute manifest/hash. This is not an upsert or
the native snapshot export profile. The separate large-file job contract below
retains the complete input rather than truncating to this bounded preview.

Apply requires current `catalog.write`, `administration.manage`, `inventory.write`,
verified email and MFA, including at the transaction and before durable replay.
One D1 batch creates drafts only, initializes actor-attributed price versions,
single-warehouse balances and positive initial ledger entries, and advances the
existing native legacy-ID counters. Imported asset descriptors and associations
are pending evidence: no R2 fetch/write, scanner decision, rights grant or public
publication is inferred from file metadata. Publication and R2 verification
continue to require their existing governed workflows.

Revert refuses used or interveningly modified state. It compensates physical
stock to zero with new ledger entries, cancels the initial prices and discontinues
the drafts while retaining immutable command/preview/audit and original ledger
history. Full-row postconditions reject skipped writes and changes to retained
fields; balanced SQL predicates preserve the actual depth100, parameters100,
functionArgs32 and compoundSelect5 limits. Lost-response recovery is read-only;
an explicit same-key replay returns the original matching receipt.

The initial directed checkpoint passed 75 core cases, 11 HTTP cases, five contract
cases, nine decoder cases and 39 component cases. A subsequent actual workerd
checkpoint passed 287 scenarios with migrations 0001–0056, including the bounded
native import and inert 601-row staging, without browser checks or external calls.
These are historical checkpoints, not the final integrated whole-job gate.
Browser execution now uses the dedicated private SSH-forwarded Chromium runtime;
Windows/Pinggy is cancelled. See `docs/testing/neteco-e2e-server.md`.
No deployment, provider call or live demo change was performed. CAT-014 remains
open until the complete functional acceptance is demonstrated.

### Whole-file jobs (implementation checkpoint, 2026-10-07)

Migration 0055 persists immutable upload pages, rows, normalized identities and
a sealed hash/review for up to 25,000 records and 100 MB of expanded JSON. Each
page stays within the native 500-row/900,000-byte boundary. Review is explicitly
requested and paginated; staging and review do not mutate catalog, price or stock.

Migration 0056 preserves existing variant colors and children while replacing
the historical 67-byte color GLOB with an equivalent bounded pattern compatible
with D1's 50-byte LIKE/GLOB limit, including rejection of hidden NUL suffixes.

Migration 0057 and `workers/catalog/import-job-commands.ts` implement canonical
POST `/api/admin/catalog/import-jobs/:id/apply` and `/revert`: strict
`{previewHash,reason}`, mandatory idempotency key, live three-permission/email/MFA
authorization before replay and within the transaction. A single D1 batch creates
all sealed entries as drafts, initializes prices and single-warehouse stock, and
stores durable receipts plus immutable per-row snapshots. Full-row postconditions
roll back skipped or corrupted writes. Exact unused-row compensation retains
history, cancels initial prices and offsets inventory; no media/scanner/publication
authority is imported. Replay and compensation remain possible after preview TTL;
new application does not.

The dedicated `productImportJobCommands` capability enables explicit UI commands,
separately from preparation. Receipts never substitute for a live-state GET. Lost
responses preserve the original frozen action/body/key for an explicit retry, with
no automatic write retry. Directed HTTP suites passed 47 tests; the final service
and import-auditor regression passed 62 tests, including null-safe exact audit
predecessor checks. Six catalog component suites passed 313 tests at the initial
freeze; the final command/page integration suite passed 60 after receipt and
visual corrections (overlapping runs, not additive). Node
CSV/XLSX regressions passed 57 tests, including exact byte-window decoding, and
five browser-review comparison tests preserve JSON values without depending on
internal object prototypes. Worker/Nuxt and strict Node-auditor typechecks pass;
the full local build/bundle policy passes 6,755 entries and 845 Nitro sources.
The final actual workerd/compiled-browser audit passes 303 scenarios with 57
migrations and zero Worker outbound requests. Thirteen browser scenarios pass,
seven for native import: three upload pages, all 2,404 diff entries across 97
explicit review pages, lost-response GET recovery, exact original receipt replay
and compensation for both the 601-record whole job and the bounded batch. The
job retains 9,015 immutable audit snapshots. The page no longer clears bounded
receipt recovery through an implicit list refresh, retains no stale preparation
claim after a validated state read, and wraps the complete mobile hash without
relying on the main panel's clipping. Browser exceptions and external requests
are both zero; desktop/mobile screenshots were reviewed.
A 601-row proof does not certify 25,000-row throughput or real providers. The
separate maximum-volume result is recorded below; the complete quality gate and
operational acceptance remain open. CAT-014 and ADM-018 remain open. No deployment
or live demo change is implied.

### Maximum-volume local proof (2026-10-08)

`npm run audit:catalog-import:scale` passes the complete disposable actual
workerd/D1 cycle with 57 migrations, 25,000 synthetic products/variants/assets,
79 upload pages and 70,631,587 expanded JSON bytes. A deliberately late failure
rolls back all seven entity groups in 7.945 seconds. Apply passes in 15.623 seconds
and compensation in 17.084 seconds; exact same-key replays take 40/37 ms. The
proof checks 375,000 immutable snapshots, both receipts, unchanged ID counters
and a byte-identical staged-source digest. All 90 HTTP requests remain private;
there are zero Worker outbound requests and the temporary database is removed.
The entire cycle takes 217.739 seconds. These HTTP timings conservatively include
preflight work; they are not internal batch execution measurements.

Three query-plan regressions explain the fixes required to reach that result:
staging now scans the bounded incoming JSON before full-key lookups; full-row
apply checks resolve exact identity before comparing nullable fields; revert
usage guards perform full-key probes rather than rebuilding correlated identity
lists for every media row. All authorization, unchanged/unused checks, exact
snapshots and atomic rollback remain required. The earlier interrupted attempts
were cleaned up and are not represented as passing cycles.

This is explicitly local acceptance, not a deployed D1 limit/performance
certificate: `cloudLimitsAccepted` and `deployedAcceptance` remain false. The
separate `npm run audit:catalog-file:scale` passes an actual 25,000-row XLSX of
11,253,856 bytes through the existing guarded file decoder, checking all
1,775,000 fields exactly, including Unicode/JSON. The corresponding CSV is
44,334,545 bytes and is correctly rejected at the unchanged 20 MB limit. This
file-only proof takes 76.457 seconds and peaks at 1,856,668 KiB RSS, without disk
artifacts or network requests. A one-row RED regression isolated surrogate-pair
corruption in the Node exporter; the existing ExcelJS streaming writer fixes it
without modifying the decoder, schema or limits. Scanner and upload authority,
real catalog/reference/media evidence and operational UAT remain open. No
provider request, deployment or production mutation is implied.

CI/CD now targets only the user's isolated Oracle ARM64 runners, never hosted
GitHub compute. All workflows preserve their blocking checks and require a
verified repository runner label; the reserved denial label must never be
assigned. The existing `neteco` remote points to `tonomolla6/neteco`; a read-only
GitHub check on 2026-10-08 initially confirmed admin access, zero repository
runners and no Actions variables. The user subsequently authorized an isolated
runner: `neteco-oracle-arm64-01` (repository runner ID 2) is registered and was
verified online. It remains quarantined: no job-approval marker, verified
workflow label, Actions variables or external acceptance manifest was issued.
`PublicHer0/neteco-shop` was only the source/reference, never a publication or
CI target. Jobs require an
explicit matching `NETECO_GITHUB_REPOSITORY` and reject that reference. Registration
does not certify the complete CI, browser/container capabilities or deployment.
Node-only `npm run storage:preflight` gates builds without automatic
cleanup. See `docs/testing/neteco-e2e-server.md` for the separate local-browser and
Oracle-CI boundaries.

The 2026-10-08 13:24 UTC capability checkpoint now passes in the **exact runner
service**, UID 980, Node 24.18.1 and a sealed Ubuntu Noble ARM64 root directory:
native workerd/D1 insert/read, then Chromium 151.0.7922.34, Firefox 153.0 and
WebKit 26.5 sequentially, including real Unicode form/click/DOM round-trips and
blocked foreign requests. Worker outbound count is zero. The native compiler/
seccomp suite also passes 35/35 there without skips. These are operator-run
capability checks, not an Actions run or application acceptance. The normal
runner was restored and observed online, idle, with only automatic labels.

The additional physically reserved 16 GiB ext4 volume holds the sealed rootfs
derived from the pinned Playwright image, work, cache and temporary directories; the original
6 GiB runner volume remains separate. The image was imported without a Docker
daemon as UID 980 from the pinned ARM64 digest, then made root-owned and
non-writable by the runner. Node/tooling mounts are readonly. CPU/memory/PID,
network isolation, SELinux Enforcing and job quarantine remain in effect.
At the 2026-10-08 14:08 UTC checkpoint, the private Docker 29.8.1 daemon also
starts successfully under a **different UID 11080**, in a constrained user
manager with the same private network anchor and sealed Noble root directory.
Its API reports rootless, systemd/cgroups v2 and overlayfs; the mapped namespace
root is host UID 11080, not host root. Only the idmapped workspace is shared;
the Actions runner still has UID 980, NNP and zero effective capabilities.
The private data root/socket are on the reserved runtime volume. No images or
containers have been created, and this does not certify container execution,
BuildKit builds or application CI.

The installed root-managed host/datastore storage gate passes inside the exact
runner service. Empty readonly statfs views expose no host/container data and
require separate configured devices, 12 GiB host headroom, 4 GiB plus the fixed
2 GiB output estimate in the container volume, and 100,000 free inodes each.
The job-started hook runs it before image pulls/service initialization (Actions
archives are downloaded earlier by runner 2.338.0). This is a point-in-time
budget, not a reservation or write quota. Gate/hook/manifest/capability/stage/
native-seccomp regressions pass 120/120 in six focused suites.

Runner access to the private socket, actual PostgreSQL/Redis containers and
BuildKit builds, durable boot/aggregate-limit and private daemon-log retention
checks, remaining active network-destination proofs and the full quality/Oracle
CI gates remain open. Approval, verified labels and Actions variables remain
absent; no workflow was published or run. See the detailed operator checkpoint
in `docs/testing/neteco-e2e-server.md` before changing admission.

### Private Docker connection and purchase recovery (2026-10-08)

The registered `tonomolla6/neteco` runner now has a root-managed CLI pinned to
`unix:///run/neteco-container/docker.sock`, a service-local supplementary group
and only that private socket directory. Real acceptance in the runner unit
passes as UID980 with NNP and zero effective capabilities. Production Docker,
the builder user bus and foreign homes remain inaccessible. The installed job
hook validates the endpoint and operator-managed tools; approval is still absent.

Both pinned PostgreSQL/Redis images were pulled after the real storage gate.
The first container start **fails**: runc cannot obtain `OwnerUID` from busctl
under restricted proc visibility and falls back to the unavailable system bus.
The private session-bus environment is already present. No global bus/proc,
SELinux relaxation or cgroup bypass was introduced. The one labelled test
container was removed; no containers remain. Real service TCP, mounts, limits,
BuildKit/SBOM/scanning/save and unattended boot acceptance remain pending.

Checkout now retains an uncertain original command, offers explicit authenticated
GET recovery and prevents replacement/double submission. Only demonstrated
pre-write Cloudflare validation codes permit correction. Recovered unpaid orders
allow explicit card/Bizum selection and frozen-key payment recovery, never an
automatic POST. The combined affected component gate passes 115 cases and the
directed infrastructure/manifest gate 149, with Nuxt/auditor typechecks passing.
These use mocked API boundaries, not compiled-browser/provider acceptance.
All 695 active requirements and seven exclusions remain unchanged; no push,
workflow execution, deployment or Beply operation occurred.

### Typed catalogue acceptance checkpoint (2026-10-08)

The current disposable workerd/compiled-Chromium audit passes **309 scenarios,
59 migrations and 15 browser scenarios**, including two typed-attribute journeys,
with zero outbound Worker requests. Six value kinds, historical revisions,
authority loss and explicit lost-response/conflict recovery execute against D1
and the compiled UI. Actual 71-column CSV/XLSX intake completes bounded native
apply/replay/revert cycles; these are not provider or production acceptance.

The separate typed native maximum passes **25,000 products, 98 pages and
87,449,224 expanded JSON bytes**, with 150,000 typed values, 375,000 immutable
snapshots and two receipts. Apply/revert take 24.482/13.631 seconds, exact replays
14/14 ms; the full 258.320-second cycle preserves source/protected-state hashes
and cleans its owned disposable runtime/database. Hosted-limit and deployed
acceptance flags remain false.

The newly extended **typed** file fixture is a different result from the earlier
untyped XLSX proof: its CSV is 62,751,935 bytes and exceeds 20 MB; its actual XLSX
is 12,032,270 compressed bytes but exceeds the unchanged 100 MB expansion limit.
Both are correctly rejected; exit 1 is **not** a full-file round-trip PASS.
Typed fixed-budget fixtures still pass. The directed fixed/typed facet gate now
passes 42/42 cases, including over 1,000 contributors, late withdrawal, legacy
parity and D1 SQL/binding limits. Ten fixed aggregates and the typed aggregate
share the final D1 batch; JavaScript receives aggregate options, not every
contributor ID/row. Duplicate badge occurrences remain compatible; variant axes
count each product once. That historical checkpoint still spanned multiple reads
for the rest of the response. The subsequent coherent-response change puts
count, ordered page, eligible media, all facet aggregates, category existence and
typed-filter admission into one D1 batch with one server-owned evaluation time.
Semantic typed-filter preflight is revalidated inside that batch; no source read
occurs after it. Directed checks pass 36 product/fixed-facet/scale cases plus 213
typed-facet/publication/media cases, including withdrawal and price/name changes
before or immediately after the response snapshot. These are local SQLite
mechanics, not concurrent hosted-load or production acceptance.
The independent `scripts/audit-native-public-facets-scale.ts` also passes against
the actual bundle in local workerd/D1: 1,500 synthetic products, 3,000 variants,
59 migrations and nine public GETs in 1.678–1.849 seconds each. Brand/capacity
self-exclusion, SKU, variant deduplication and mixed-variant capacity pairs pass;
the off-page withdrawal occurs between requests. Largest response: 9,712 bytes;
zero Worker outbound requests, owned runtime and ephemeral database removed.
Publication evidence is explicitly synthetic, not R2 originals or real legal/
antivirus approval. Hosted-limit, deployed and whole-response concurrency
acceptance remain false for that historical run. Real business data, hosted
concurrency/load, UAT and the complete quality/Oracle CI gates remain open. Requirement
statuses are unchanged.

The rebuilt coherent-response checkpoint (`81239`) additionally passes **20
public GETs and four overlapping HTTP/D1-writer contenders** over the same 1,500
products/3,000 variants. Legal snapshots differ in total, page order, price range
and facet counts; the observed sequence is before/after/before/after, never a
mixture. Post-write reads and fixture restoration match exactly. Queries take
1.900–7.972 seconds on the shared local host; response maximum 9,717 bytes, zero
outbound and owned runtime/database removed. The narrow
`localConcurrentResponseSnapshotsVerified` flag is true; hosted/deployed/whole-
response acceptance flags stay false. Fresh bundle policy passes 6,909 entries/
859 original Nitro sources. No new browser-matrix or full Oracle CI PASS is
claimed by this directed verification.

The reference picker now searches explicitly by name/SKU while retaining manual
UUID entry: no GET on typing, one live-authorized private GET plus one public
candidate GET, at most 20 public matches, no intersection of differently sorted
first pages, and no automatic writes. Its 31 component cases pass, including
late authority denial, stale responses and frozen intent. The earlier
workerd/compiled-Chromium checkpoint (`45440`, before the whole-response change)
passes 309 scenarios/59 migrations/15 browser
journeys, including the actual name/SKU lookup and exact selected UUID receipt.
The typed browser helper records 799 requests and zero page errors. That earlier
bundle policy passes 6,905 entries/859 original Nitro sources. Owned private
Chromium, SSH tunnel and disposable D1/runtime are closed; no Oracle CI or
production/provider acceptance is implied.

## Bounded editorial CSV import (local, 2026-10-03)

Migration 0053 adds private immutable previews, atomic command receipts and
per-product before/after audit. This is an explicit **editorial CSV v1 profile**,
not the existing full 71-column catalogue format or native XLSX support. The
existing Node exports, ExcelJS/Buffer boundary and full-format behavior remain
unchanged; its CSV parser is reused through a pure shared module.

The nine exact columns identify existing products and their catalog versions,
then describe name, short description, description, usage, series and featured
status. Only `draft`/`review` products are editable; UUID, legacy identity and
version must agree. The limit is 100 products and 1,000,000 UTF-8 bytes. Templates
preserve incomplete drafts rather than inventing required content, and refuse
an oversized export rather than silently returning the first hundred rows.
Validation reports safe logical CSV row/column diagnostics without echoing
rejected cell values. Prices, stock, variants, categories, slug, media,
regulatory approval and publication are outside this profile's authority.

The native namespace `/api/admin/catalog/editorial-import` provides GET
`/template`, POST `/preview`, GET `/previews/:id` and explicit POST
`/previews/:id/apply` or `/revert`. Every route requires a live sealed session,
`catalog.write` and MFA; writes also require same-origin CSRF protection.
Previews are actor-owned, SHA-256-bound and expire after thirty minutes. A
single guarded D1 batch rechecks authority, versions and exact content and
persists the whole mutation and receipt together. Replays return the original
receipt; altered payloads conflict. Reversion restores null/blank distinctions
as a new version and refuses to overwrite subsequent work. It never rewinds
versions or deletes the original audit.

The existing admin product page exposes the capability only from a fresh
Cloudflare DTO. Its component shows exact before/after values, requires a
reason and confirmation, reads fresh state before and after a command and
never automatically resubmits a POST. Ambiguous responses retain the intent;
only confirmed rollback or a conclusive read unlocks another explicit action.
Context changes discard private state and pending download URLs.

The frozen focused gates pass **141 unit cases** and **44 component cases**,
including actual SQLite execution of all 53 migrations, a 100-product apply/
revert under D1 expression/bind limits, late authority/CAS races and rollback
after mid-batch failure. The final global suites pass **5,426 unit cases in 196
files** and **1,884 component cases in 51 files**. Worker/Nuxt types, lint,
formatting and the paired Cloudflare build pass; bundle policy covers **6,573
entries and 827 original Nitro sources**. Actual disposable workerd passes
**270 scenarios, 53 migrations and zero outbound requests**, preserving all
264 previous scenarios and adding six editorial HTTP/D1 cases. Those cases also
check real private CSV download, safe row/column diagnostics, exact replay,
null/blank restoration and refusal to overwrite a later HTTP edit. The local
hydration audit above also passes on the paired final artifacts.

Intermediate checks caught stale 52-migration/copy expectations and two native
fixture assertions (the ordinary customer's unverified MFA and quoted CSV
headers). They were corrected to the existing authorization/CSV contracts;
permissions, runtime limits and atomicity guards were not weakened.

This local checkpoint is **not deployed** and does not close CAT-014/CAT-015 in
full; full-format/XLSX and complete catalogue acceptance remain pending. The
historical financial/maintenance host-callback limitations above still apply;
this rerun establishes no bank/Beply/email/scanner or production acceptance.

## Scheduled prices, category authoring and warehouse operations (2026-10-03)

This checkpoint supersedes the scheduling/cancellation, category-authoring and
physical receipt/count gaps below, not their historical counts or production
acceptance. Migrations 0039–0041 add three independently audited D1 command
ledgers; no existing migration or PostgreSQL application is replaced.

Price scheduling and future-head cancellation require live
`administration.manage`, verified email and MFA, current catalog version and the
expected latest approved price. Read access still uses `catalog.write`.
Scheduling closes only an overlapping/open predecessor window; cancellation
restores the exact governed predecessor window rather than extending historical
gaps. The current price, quantity rules, stock and catalog version are not
rewritten. Reads expose complete authoritative head/current identifiers;
thirty-day evidence is explicitly limited to available approved windows and
does not claim complete legal price history.

Categories support draft creation, editing/moving and retirement of an empty
category, with live administration authority, bounded graph validation,
monotonic identities, CAS, owned claims and atomic audit/receipt persistence.
New categories are never silently published. Retirement retains identity and
history. Historical aliases identify immutable UUIDs and resolve directly to
the current public canonical URL, without chains or visibility expansion.
GET/HEAD redirects preserve only allowlisted bounded query fields; lookup
failure produces sanitized 503, never a fallback redirect or fabricated 404.
The admin selector keeps the existing folded tree and Node editor rather than
adding duplicate action pairs for every category.

The existing global InventoryCoordinator now handles governed manual entries
and count proposals/approvals for the single existing warehouse. Warehouse
staff need `inventory.read`/`inventory.write`, not catalog/administration grants.
SKU/name selection reads bounded current DTOs. A count proposal has no physical
effect; approval requires another live operator and current balance version.
Physical movements, ledger, command receipt and audit share an atomic guarded
batch. Blocked/reserved commitments are preserved, including expired
reservations awaiting release. No additional warehouse or transfer workflow is
introduced. Authorization is rechecked after awaits and before historical
replays; cached responses cannot bypass revoked authority.

All three forms retain the original URL, body and idempotency key after an
ambiguous POST, including an authorization failure that may follow a commit.
Manual replay is explicit. Historical receipts never replace a fresh current
GET. The account security page separately validates bounded own-data session
DTOs, distinguishes failed/loading reads from an empty device list and revokes
only a confirmed other session. An ambiguous DELETE invalidates the list,
without blindly retrying; a reload retaining the target cannot report success.

The preceding combined suites passed 3913 unit tests in 129 files and 1444
component tests in 33 files. Nuxt then exposed one `unknown` request-body type in
the inventory editor; schema-derived discriminated input types fixed it without
casts or relaxed validation. Nuxt typecheck and all 33 inventory component
cases subsequently pass. Worker/strict auditor typing, lint, formatting,
requirements audit and diff checks also pass for this checkpoint. Category
fixtures and a test hook returning a mock were corrected without weakening
assertions or extending deadlines.

The rebuilt renderer/native Worker passes bundle policy for 4894 dependency
entries and 694 original Nitro sources; the main script is 5855.11 KiB
(1225.16 KiB gzip). Real local workerd passes 56 scenarios with all 41
migrations, 20 explicitly selected synthetic public products and zero outbound
requests. New scenarios exercise category durable replay/retirement/direct
redirects, schedule/cancel preserving current price, receipts through the real
Durable Object, independent count approval and permission-revoked replay.

These are local completed pieces, not completion of all catalog, pricing,
inventory or account requirements. New category publication, full product
management, renewal alerts, picking/fulfillment, fiscal issuance, real catalog,
scanner and provider/business acceptance remain separate work. The active
next block assigns one agent each to fiscal issuance, fulfillment and CMS D1;
it is not included in this frozen checkpoint. No commit, push, deployment,
production/Beply call, manufactured grant or real approval occurred.

## Editorial calendar and private newsletter-link analytics (2026-10-03)

The CMS now has a read-only D1 editorial calendar at
`GET /api/admin/content/calendar`. It requires a sealed current session, verified
email, MFA, `catalog.write` and the existing explicit CMS-publication opt-in.
Missing configuration stays unavailable; encoded/unsupported aliases cannot
fall back to the Node CMS. Responses are private/no-store/noindex/no-referrer.

Month boundaries use the existing Europe/Madrid DST conversion. Both approved
publish/withdraw phases retain their immutable version title/slug and distinct
UTC offsets for repeated hours. Count, bounded page and global alerts share a
single D1 read batch, followed by a fresh authorization check. Applied, cancelled,
superseded, due and blocked are separate states. A due phase without an outcome
is pending, not a fabricated Cron failure. Active blocked alerts remain visible
outside the selected month; the bounded list shows the ten oldest with the full
count, never silently truncating the number of incidents.

`CmsEditorialCalendar` is integrated into the existing editor. It provides month
navigation, pagination and explicit read refresh, clears stale actor/runtime
responses, and opens a page only through its fresh confirmed detail endpoint.
Unsaved/ambiguous editor or publication commands prevent calendar navigation;
no calendar interaction publishes, reruns a failed task or performs a mutation.

Newsletter link pages, including `/newsletter/preferencias`, are excluded before
both analytics transport and data-layer/RUM events, even after token removal.
The existing Worker ingress already supplies private/no-store/noindex and
no-referrer headers; encoded route aliases retain these protections. No bearer
value is inspected by the analytics guard.

Focused SQLite/HTTP/timezone/privacy/ingress regressions pass **154 cases in seven
files**; actual Nuxt calendar/editor/publication/privacy components pass **101
cases in four files**. These are separate from the historical combined gate
below. Strict TypeScript for the calendar/HTTP/native-helper source, scoped lint,
format and requirements audit pass. Two new real-workerd
calendar assertions subsequently passed in the frozen **242-scenario** gate
above. Deployed Cron/Queue, external delivery and full business acceptance remain
open. No production resource or provider changed.

## Published CMS, governed RMA and fiscal/email execution (2026-10-03)

This checkpoint supersedes the publication/RMA/runtime gaps in the historical
checkpoint below. It does not close every CMS, returns, fiscal or communication
requirement, authorize real providers or represent a deployment. Incremental
migrations 0045–0047 leave existing contracts and historical migrations intact.

- CMS publication and withdrawal are separate live-authorized, CAS-governed
  commands over immutable draft versions. Public pages never expose a newer
  draft. Signed previews bind version, the supported default segment and device,
  expire in thirty minutes and remain revocable. Current scan/rights evidence and
  owned R2 originals govern both content and images. Preview routes are excluded
  from client analytics/RUM before either data-layer or API dispatch; noindex,
  no-store and no-referrer protections also apply to public preview bytes.
- Europe/Madrid scheduling handles DST gaps and repeated hours explicitly.
  Durable approval and unique phase events prevent duplicate transitions or a
  stale withdrawal hiding a newer release. Blocked outcomes stay visible.
  Runtime Cron is wired, but the native helper calls the domain scheduler
  directly; deployed Cron acceptance remains open. The later focused calendar
  and in-panel failure-alert implementation is documented above.
- CMS-enabled SEO includes a real content-shard count with one-thousand-entry
  pages. Count/slice share a batch and current publication/media authority is
  rechecked after awaits. Tests with 1001 releases demonstrate actual partitioning
  without truncation. Drafts, previews, noindex and withdrawn/invalid releases
  never become sitemap entries; the disabled CMS retains the old SEO contract.
- RMA is an independent D1 state/version/event/command projection. Verified
  owners request returns; administration manages approval, partial receipt,
  inspection and a `resolution_ready` handoff. Concurrent cases share a guarded
  purchased-quantity budget. All returned items remain `non_sellable` custody:
  no stock replenishment, refund, credit note or original-contract rewrite is
  implied. Unverified guests cannot use an email/order number as identity proof.
- Fiscal runtime execution requires an explicit policy allowlist and independent
  issuance/local-validation opt-ins. Environment, provider and mapping checks
  remain server-owned, and the known production Beply tenant is rejected in
  local/preview environments. Invoice emails have separate opt-ins and immutable
  renderer/source/message manifests. A synthetic workflow/PDF/email is labelled
  as local validation, never a real fiscal document or provider delivery.
- The private fiscal reader clears stale order/actor/session state, separates
  workflow completion from provider fiscal status and warns against retrying
  uncertain issuance. It adds no emission POST, bearer link or invented admin
  PDF route. Private customer PDFs retain existing ownership/checksum checks.

The integral gate exposed and fixed a genuine authenticated-checkout defect:
the CartCoordinator UUID validator omitted one UUID group. Four regressions
exercise a real sealed session through storefront HTTP and the coordinator,
durable owned checkout replay, malformed claims, revoked sessions and rejection
of customer-supplied ownership. Contact email is not an ownership proof.

The rebuilt Worker passes dependency policy for **5385 entries and 736 original
Nitro sources**; its main script is **6543.03 KiB (1381.99 KiB gzip)**. Real disposable
workerd passes **145 scenarios, 47 migrations, 20 synthetic public products and
zero outbound requests**. Three actual local checkout/callback/allocation flows
preserve the existing 87 scenarios. The additional 58 include public CMS/preview,
ownership-established RMA, private PDFs and versioned invoice-email replay.

Evidence boundaries are explicit: HTTP/SSR runs through the actual workerd shop;
positive fiscal execution uses the Worker-compatible domain dispatcher/factory
in the host with native D1/R2; email transport invokes the actual host outbox
publisher/consumer and a memory-only synthetic sender. This audit does **not**
exercise workerd's scheduled/Queue entrypoints or accept Beply/Email Service.
The final combined unit suite passes **4455 cases in 152 files**, including the
four authenticated-checkout regressions; the interface suite passes **1619 cases
in 41 files**. Worker/Nuxt typechecks, strict standalone native-auditor typing and
generated binding verification pass for this checkpoint. These counts do not
include the next parallel block's unfinished source files or provider acceptance.

Arbitrary CMS audience targeting, deployed calendar/Cron acceptance, guest RMA
verification, economic return resolution/refunds/credit notes, all transactional
templates, carrier tracking, newsletter campaigns/CRM and real data/provider/
operational acceptance remain separate work. The next parallel block is refund/
credit-note operations, support/CRM and advanced newsletter; none is counted as
completed here. External delivery stays off and production Beply is untouched.

## Draft CMS, warehouse fulfillment and ordinary fiscal protocol (2026-10-03)

This checkpoint closes the next three **local implementation pieces**, not
their entire business domains or provider acceptance. Migrations 0042–0044 are
incremental; no PostgreSQL service, existing migration, warehouse or grant is
replaced. Their native routes own the namespaces and cannot fall back to Node.

- CMS supports typed draft creation, editing, restoration as a new immutable
  version and recoverable archival, with reserved slugs, CAS, actor audit and
  durable exact replay. The editor keeps ambiguous sent intents and distinguishes
  failed reads from an empty list. Publication, signed preview, scheduling and
  public CMS rendering remain explicitly unavailable; image references are not
  approval of quarantine media.
- Preparation verifies the winning captured payment, completed recovery,
  assigned reservation and exact allocation/ledger evidence. Its independent
  graph covers picking, packing, pickup readiness or transit, delivery and
  an exception with exact interrupted-state recovery. Every command has
  `inventoryEffect: none`: payment already allocated physical stock. The order
  detail embeds a confirmed private reader and guided panel. Its list queue
  includes paid pending/picking/packed orders without claiming carrier readiness.
- Ordinary fiscal issuance requires an explicit governed policy and a separate
  live-authorized queue command. That command atomically records its owned
  receipt, historical contract, intent, work, audit and command ledger, releasing
  only the selected blocked transport event. Approving a policy never emits.
  An issuing marker precedes the provider call; uncertain results are never
  automatically reissued. Fenced privileged reconciliation requires matching
  authoritative evidence, which the local fake supports but the current Beply
  adapter does not claim. Document, event and email obligation finalize together.
- The Worker-compatible Beply port preserves the existing `/api/3` contract and
  is tested **offline only**. There is no production provider dispatch or Cron
  activation. Private R2 PDFs have bounded owned bytes, content-addressed keys,
  confirmed PUT acknowledgements and checksum validation. Owner/guest authority
  is rechecked after asynchronous storage/hash operations; HTTP is private,
  no-store, noindex and never exposes the storage key. Synthetic documents are
  restricted to `APP_ENV=local`. `preprod` maps to preview, not to local.

Specific suites pass: CMS 107 server and 43 component cases; fulfillment 56
server and 38 component cases; ordinary fiscal protocol/HTTP/offline port 95;
private R2 storage 12. Nuxt and Worker typechecks, standalone strict runtime
auditor typing, lint and formatting pass. The final combined checkpoint passes
4191 unit cases in 136 files and 1525 component cases in 36 files, including
the six environment-normalization regressions.

The rebuilt renderer/native Worker passes dependency policy for 5100 entries
and 712 original Nitro sources; its main script is 6186.00 KiB (1299.80 KiB
gzip). Real disposable workerd passes **87 scenarios, 44 migrations, 20
synthetic public products and zero outbound requests**. Its native checkout
creates and reserves a real local contractual order, then accepts a callback
signed with the published Redsys sandbox vector through the actual Inventory
Durable Object. No bank transaction is submitted. It exercises preparation
through delivery, exact replays/conflicts and unchanged inventory/contract
digests; draft CMS lifecycle and public non-disclosure; explicit local fake
issuance, private R2 storage, PDF ownership and durable email obligation.

Remaining gates include real Beply contract/series/mappings and fiscal policy,
provider acceptance, rectification, payment settlement and invoice-email
rendering/delivery. Carrier tracking, RMA/refunds, CMS publication/preview/
scheduling, real stock/catalog/media evidence and operational acceptance also
remain open. A completed workflow is not the same as `fiscalStatus: issued`;
that provider state is exposed independently. No secrets were read, no commit,
push or deployment occurred, and the Beply production instance was untouched.

## Draft catalog authoring, bounded filters and profile recovery (2026-10-01)

This checkpoint supersedes the draft-authoring and multiselect-parameter gaps
below, not older historical test counts or production acceptance. Migration 0038
adds immutable command/receipt/audit ledgers for five separate D1 operations:
draft product creation, assignment of an existing brand, and draft variant
creation, update and retirement. They require live `catalog.write`, verified
email and MFA before replay and throughout the SQL batch. Owned claim, CAS,
domain effects, complete audit and final guard commit or roll back together.
IDs are allocated above current high-water marks without reuse; existing
identities, SKU and slug stay stable. Late audit/constraint failures leave no
counter, command, partial variant or stock effects.

New variants start with a pending zero price and a zero balance in the single
existing warehouse. No initial price approval, zero ledger movement, new
warehouse, media evidence, policy assignment or publication is manufactured.
Draft-only changes preserve current/future volume-tier quantity rules and all
persisted reserved quantities, including expired reservations not yet released.
Retirement preserves at least one non-retired variant. These narrow capabilities
do not enable the legacy full-product PUT, price/stock writes or full CRUD.

Private reference options read current existing category, brand, tax and shipping
data. Own `success === true` and own results arrays are mandatory for references
and private list/detail/category envelopes; missing or malformed counts never
become a confirmed zero. DTO validation copies own JSON into null-prototype
records before schema access and requires canonical lowercase UUIDs. Outages
remain sanitized private 503 responses, not writable empty data.

The Nuxt forms separate identity/units/logistics from finance, stock and
publication. They require confirmed current DTO/capabilities and stop after
known loss of local session, admin role or MFA. Ambiguous delivery retains the
exact original body, URL and idempotency key for deliberate manual replay.
Historical receipts never replace current state; separate guarded GETs refresh
it. Route identity remounts command ownership. Node's existing editor is retained.

Eight catalog multiselect axes use one bounded JSON parameter per axis, retaining
50 values and paired capacity correlation, own-facet semantics, paging, literal
search escaping and effective-price ordering. SQLite tests enforce expression
depth 100, bindings 100 and function arguments 32. Real workerd additionally
exercises a match at the fiftieth brand and combined eight-by-fifty filters.

Account profile reads validate the current bounded Node/D1 DTO before enabling
contact, email or company forms. GET recovery preserves phone and dirty buffers,
rejects stale/unmounted/logout responses and never retries a mutation. A rejected
profile/company PUT may already have committed: it invalidates the old read and
offers an explicit GET before another write. Failed refreshes never report
success or clear sensitive input buffers.

Final local validation passes 3556 unit tests in 122 files and 1264 component
tests in 28 files. Focused authoring forms/page pass 69/82 cases, profile 59,
authoring domain/HTTP 122/55, private catalog 168 and facets 17. Nuxt and Worker
typechecks, strict HTTP/auditor typing, lint, formatting, requirements audit and
diff check pass. The rebuilt renderer/native Worker passes bundle policy for
4709 dependency entries and 681 original Nitro sources. The main script measures
5534.31 KiB (1157.12 KiB gzip). Real local workerd passes 51 scenarios, all 38
migrations and 20 explicitly selected synthetic public products with zero
outbound requests. Its fixtures use current high-water IDs rather than reserved
numbers and distinguish genuine governed history from newly pending variants.

The initial build exposed relative shared imports externalized incorrectly by
Nitro; the existing Nuxt root alias fixed resolution without allowing externals.
Final review also exposed incomplete provider envelopes, local session-loss
callbacks and missing manual GET recovery after an ambiguous PUT. All received
regressions and the complete final gate was rerun. No assertion, deadline,
capacity contract or financial/publication gate was relaxed.

Requirements remain 132/695 active IDs with repository evidence (18.99%), not
production completion. Category CRUD, complete product management, price
scheduling/cancellation, physical receipt/counting, full exception history,
renewal alerts and real business/provider acceptance remain outstanding. The
Cloudflare review guides kept build/configuration and audits local and isolated;
no commit, push, deployment, production/Beply call or real approval occurred.

After final checks, the four outputs proven absent at task start, untracked,
non-symlinked and unused by any process were removed: `.nuxt-cloudflare`,
`.output-cloudflare`, `.wrangler/shop-bundle` and `.wrangler/shop-meta.json`.
They are regenerable. Shared Nuxt outputs, Wrangler configuration/state,
preexisting reports, worktree, databases and unrelated processes were preserved.
Free host bytes measured 17,634,033,664 before removal and 17,721,171,968 after;
other shared-host activity can affect this measurement. No Docker resources,
backup, volume or agent session was pruned.

## Continuous publication validity and confirmed account reads (2026-10-01)

This checkpoint supersedes older outstanding postpublication validity notes,
not their historical validation results. A shared, execution-time D1 predicate
checks the latest explicit policy assignment, policy/exception windows and
withdrawals, regulatory classification, required fields/documents, identifiers,
tax validity, category ancestry, brand and attested media. Existing published
products receive no missing-policy exemption. Stock exhaustion alone does not
hide a valid product. Editorial state remains an independent caller condition.

Catalog, product detail, search, SEO and public media use the same current rule.
Final bounded checks verify the exact product/variant/media projection after
asynchronous enrichment; byte delivery still checks owned R2 originals and
current evidence around decoding. New cart additions, quotes, checkout and
payment redirects require current publication. Final transactional guards roll
back late invalidation; checkout compensates a reserved invalid attempt without
duplicating releases. Removal from an existing cart remains possible. Historical
contractual snapshots and callbacks/recovery for a payment already received are
not discarded when publication later becomes invalid. Saved payment redirects
recheck live authorization, reservation, payment status and publication, including
the lost-race replay path; they cannot be offered after capture.

Native SQLite and real D1 CHECK failures are distinguished from provider outages
without logging raw SQL or accepting arbitrary error text. The exact D1 extended
CHECK format is exercised against workerd. The storefront shipping facade retains
the stable `variant_not_available` code for a rejected quote while sanitizing
genuine outages as `internal`; rejected quotes leave no command, quote or stock
effects. Default governance clocks come from SQL execution, not a timestamp
captured before an `await`; explicit pinned clocks remain internal test seams.

The shared query is kept within D1's real expression-depth limit without removing
checks: balanced evidence/checksum expressions, materialized current projections
and bounded boolean requirements avoid a deep enclosing AND/subquery tree.
The 112-case validity suite, actual status-engine claim/write/audit/guard/replay
regression and the 87-case cart/checkout/payment suites enforce `exprDepth=100`
after migrations. Both status suites also pass 237 cases at that limit. A boolean
NULL still fails closed; a newer malformed identifier exception never falls back
to an older valid exception. These are statement-local projections, not a cached
publication approval.

The account orders and favorites pages display rows, counts and actions only
after a current validated read. Loading, failures and malformed responses never
become a confirmed empty list. Explicit GET recovery handles duplicates, stale
responses and unmounting; it never retries a mutation. Favorites validates the
entire pre-cart preparation before the first addition and stops after lost
authority or a partial write. The two focused component suites pass 54 and 69
cases; the unchanged complete component suite passes 1054 tests in 25 files.
Tracking, invoices, full repeat-order/list-sharing behavior and browser/production
acceptance are not certified by these component tests.

The final rebuilt Nuxt renderer and native Worker pass bundle policy for 4601
dependency entries and 669 original Nitro sources. The dry-run bundle is
5388.86 KiB (1122.96 KiB gzip). The real local workerd audit passes 46 scenarios,
all 37 migrations and 20 explicitly selected synthetic products with zero
outbound requests. It first proves that unapproved demo seeds yield an empty
catalog, then provisions disposable synthetic policies/rights/scan metadata and
owned image bytes. It exercises policy expiry, actual publisher HTTP commands,
current media and cart flows, and withdrawal of the last valid main image:
catalog/PDP/media denial, new add/quote rejection without effects, and unchanged
historical cart money/version. No generated seed acquires automatic approval;
synthetic evidence is not genuine legal, antivirus or licensing acceptance.

The final complete unit suite passes 3308 tests in 120 files. Nuxt and Worker
typechecks, standalone strict checks of the new validity/status/buy-path tests
and runtime auditor, lint, formatting, requirements audit and diff check pass.
The shipping bridge's eight focused cases include current-evidence withdrawal
and outage sanitization at `exprDepth=100`. The Nuxt runtime-config suite passes
five cases at its existing startup deadline after an initial startup timeout;
no deadline or assertion was relaxed. Sources and feature flags remain local,
with no commit, push, provider call or deployment in this checkpoint.

Earlier checks exposed D1 expression-depth incompatibility, a synthetic policy
code collision, an obsolete image expectation despite independent valid evidence,
and the shipping facade's missing safe error code. They were corrected and rerun,
not recorded as passing checks. Proactive expiry alerts/renewal, full exception
history, full product/category/variant CRUD and actual business/provider acceptance
remain outstanding. The admitted 50 capacity pairs can exceed D1's 100-bind
limit; the next query change must preserve that contract using bounded multivalue
parameters, not hide it by lowering the maximum. Broad states remain 132/695
active IDs with repository evidence (18.99%), not production completion.

After all checks ended, the four outputs proven absent before this task and
unused afterwards were removed: `.nuxt-cloudflare`, `.output-cloudflare`,
`.wrangler/shop-bundle` and `.wrangler/shop-meta.json`. They are regenerable by
the same local build. Shared `.nuxt`, `.output`, Wrangler configuration/state,
preexisting reports, sources, the worktree and unrelated processes remain.
Free host bytes measured 16,801,173,504 before removal and 16,886,542,336 after;
unrelated activity on this shared host can affect the measurement. No Docker
resource, database, backup or agent session was pruned.

## Explicit publication-policy authoring checkpoint (2026-10-01)

This checkpoint supersedes the outstanding policy-authoring/UI notes in older
checkpoints, not their historical test results. Migration 0037 adds an immutable
command/receipt ledger and exactly matching audit. Five private D1 commands
create policy versions, withdraw policies, assign a policy with explicit product
classification and create/withdraw reviewed identifier exceptions. They require
fresh `catalog.publish`, verified email, MFA and the live session/grant throughout
the SQL batch. Version/CAS checks, the owned command, domain effects, audit and
final guard commit or roll back together. Same-key/payload replays return the
original persisted receipt without repeating effects; current authorization is
checked again after awaiting the historical read.

Policy versions are explicit and never assigned automatically. Withdrawal is
rejected while a published product uses that policy; it never hides products.
Assignments and exceptions require draft, review or hidden state, and advance
the product's catalog version. Explicit regulatory classification preserves
unrelated object metadata and never defaults unknown SDS applicability to false.
Immutable policy/assignment/exception history retains its existing protections.
Readers recheck authority after awaiting D1, including revocation and a session
or grant expiring across a fractional second. Encoded namespace aliases share
the ingress feature flag/native limiter but remain invalid canonical routes.
Inputs are bounded own-data, dates are semantic canonical UTC, values are bound,
and provider outages remain sanitized failures rather than domain conflicts.

The Cloudflare-only policy page and independent product panel show only current
private reads and explicit narrow capabilities. Forms require reasons and review
confirmation; create uses the latest version for the exact code, including
withdrawn versions. Read failures hide unconfirmed data/actions. Ambiguous writes
retain the original payload/key for a deliberate exact retry, including across
parent refresh and advanced versions. A validated historical receipt triggers a
fresh GET instead of applying historical state; lost write authority disables
replay. Withdrawal controls identify the policy name, code and version.

The product reader rejects more than 500 variants rather than truncating them.
It shows only the latest current exception per variant; full historical/future
exception management is still pending. Publication validates evidence at the
transition; ongoing postpublication expiry handling remains a separate launch
gap. No legal classification, genuine document/scanner/licensing approval,
provider acceptance or deployment is supplied by these local mechanics. Full
product/category/variant CRUD and operational acceptance remain outstanding.
Broad requirement states are unchanged: 132/695 active IDs have repository
evidence (18.99%), not production completion.

The frozen backend/API suites pass 137 and 151 focused cases; the policy page
and product policy panel pass 121 component cases. The final complete unit
suite passes 3130 tests in 118 files, and the complete component suite passes
931 tests in 23 files. Nuxt and Worker typechecks, standalone
strict checks of both new unit suites and the runtime auditor, lint, formatting,
requirements audit and diff check pass. The rebuilt real workerd audit passes
41 scenarios, all 37 migrations and 20 seeded products with zero outbound
requests. It exercises real create/withdraw/assignment/exception HTTP commands,
exact durable replay after later state changes, policy-page SSR, rejection of
encoded aliases, blocked withdrawal while published and publication blocked
after policy/exception withdrawal. All decisions use explicit synthetic fixtures
in disposable D1, not genuine business or regulatory approval. The dry-run
bundle is 5337.84 KiB (1109.46 KiB gzip); bundle policy passes 4544 dependency
entries and 666 original Nitro sources. No deployment or provider call occurred.

Independent review closed historical-replay authorization after revocation,
post-read session/grant expiry across a fractional second, encoded-namespace
ingress divergence and misleading retry/withdrawal controls, with regressions.
Nuxt typechecking also exposed a missing raw-data narrowing; the validator now
narrows before using the value, without assertions or relaxed checks. Initial
failing checks were corrected and rerun, not represented as passing evidence.

After validation, the four regenerable outputs proven absent before this task
and unused afterwards were removed: `.nuxt-cloudflare`, `.output-cloudflare`,
`.wrangler/shop-bundle` and `.wrangler/shop-meta.json`. Shared `.nuxt`, `.output`,
Wrangler configuration/state, reports, sources, the worktree and unrelated
processes were preserved. Free host bytes measured 17,361,182,720 before removal
and 17,452,236,800 afterwards; unrelated activity on this shared host can affect
the measurement. No Docker volume, image, database or session was pruned.

## Audited product-status and authoritative-publication checkpoint (2026-09-30)

This checkpoint supersedes the older outstanding status/gate notes below, not
their historical validation results. Migration 0035 adds a separate
`PUT /api/admin/products/:numericLegacyId/status` command for the existing five
editorial states. Draft-to-review and review-to-draft require `catalog.write`;
all other allowed transitions require `catalog.publish`. Every stage rechecks
current session, verified email, MFA and grants at SQL execution time. The
owned command, optimistic version, product/all-variant snapshots, immutable
matching audit and final rollback guard share one D1 batch. Discontinued
variants are never resurrected. New no-op transitions fail; completed replays
return the original persisted receipt using the original required permission,
without repeating effects or reevaluating publication evidence.

Migration 0036 stores explicit reviewed product-type policies and assignments,
policy withdrawals and reviewed identifier exceptions/withdrawals. Histories
reject UPDATE, DELETE and duplicate REPLACE inserts independently of the
recursive-trigger pragma; assignment sequences must be positive. No policy,
real-world classification, legal approval or antivirus verdict is invented or
seeded. The authoritative publication gate requires a current assigned policy,
explicit matching type and SDS applicability, permitted fields/document roles
and current governed exception evidence when identifiers are absent. A product
document or documents for every sellable variant must cover each required role.
The shared editorial rules, effective price, current IVA and single-warehouse
stock/backorder rules remain the underlying checks, not duplicated money or
inventory policies.

Before mutation the gate reads bounded owned R2 originals, checks key, size,
etag, SHA-256 and content envelope, then rechecks live publication authority.
Its canonical private dependency projection is compared again in every SQL
claim/write/audit/final guard, including price winner, tax validity, stock,
category ancestry, policy/exception withdrawals and current media evidence.
Price identity is the raw nullable governed ID, not the potentially colliding
public legacy marker. The projection excludes only columns owned by the status
command; it is never returned over HTTP. D1 atomicity does not create a
cross-service transaction with R2 or protect against external deletion after
the verified read. Public byte delivery retains its independent current checks.
Known incomplete/missing evidence returns a sanitized 409; genuine storage
outages remain 503. Feature flags and real provider delivery stay off by default.

The independent panel uses only `productStatusTransition`, not legacy full
product/status CRUD capabilities. Its form requires own current ID/UUID,
version/status, a reason and explicit impact confirmation. Ambiguous delivery
retains the exact command/key for deliberate manual replay; deterministic
conflicts require a fresh GET before a new command. A historical receipt never
sets the visible product state: the panel refetches current detail. Invalid or
stale authority hides the form. The readiness panel remains advisory and does
not approve publication.

Final local validation passes 2840 unit tests in 116 files and 810 component
tests in 21 files. The new focused motor/HTTP/gate suites pass 291 cases after
the final strict D1/R2 test-adapter fixes; the status editor has 70 cases.
Worker and Nuxt typechecks, standalone strict checks for the three new unit
suites and runtime auditor, lint, formatting, requirements audit and diff check
pass. The rebuilt real workerd audit passes 38 scenarios with all 36 migrations,
20 seeded products and zero outbound requests. It exercises actual status-editor
SSR, rejection without a policy/no side effects, publication with an explicitly
synthetic policy and attested owned R2 original, exact replay, security/clock
negatives, public product visibility, subsequent hiding/byte denial and unchanged
discontinued variants. The dry-run bundle is 5183.98 KiB (1074.30 KiB gzip);
bundle policy passes 4475 dependency-evidence entries and 661 original Nitro
sources. No deployment, provider acceptance or genuine legal/AV approval occurred.

Independent review found and closed REPLACE history replacement, boolean values
satisfying textual type requirements and a governed-ID/legacy-marker expiry
collision, with regressions. Standalone strict checks also exposed test wrappers
that dropped generated D1/R2 class methods; proxies/bound methods retain the
platform surface without weakening assertions or deadlines. Operational policy
authoring/assignment UI, full product/category/variant CRUD, genuine catalog,
documents/scanner/licensing and deployed acceptance remain outstanding. Broad
requirement states stay unchanged: 132/695 active IDs have repository evidence
(18.99%), not production completion.

After successful validation, the four outputs proven absent before this task
and unused afterwards (`.nuxt-cloudflare`, `.output-cloudflare`,
`.wrangler/shop-bundle`, `.wrangler/shop-meta.json`) were removed; they can be
regenerated by the documented local build. Shared `.nuxt`, `.output`, Wrangler
configuration/state, reports, sources and the worktree were preserved. Available
host storage measured 17,325,223,936 bytes before cleanup and 17,405,620,224
afterwards; shared-host activity can also affect that measurement. No Docker
image, volume, session or database was pruned.

## Read recovery and advisory-publication checkpoint (2026-09-30)

This later checkpoint adds four bounded improvements without new providers or
migrations. The address agenda distinguishes pending, failed or malformed reads
from a successful empty list and hides stale rows. Reorder keeps read errors
visible, retries only the same order's GET, rejects duplicate/stale callbacks
and performs no cart mutation before a separate confirmation. Closing or
unmounting invalidates pending reads; partial-add errors do not retry writes.
The focused component suites pass 18 and 30 cases respectively.

Cart and checkout no longer show an empty cart or payment form after a failed
cart read. Explicit retries disable the existing legacy-cache import, so a GET
retry cannot repeat item POSTs with new idempotency keys. Checkout recovery
errors still block payment. The shared shipping-threshold message refers only
to eligible standard parcels subject to the authoritative destination/merchandise
quote, never unconditional free agency delivery; pallets and dangerous goods are
excluded from that promise. Invalid or disabled thresholds hide it. Thirty
component cases exercise the real pages and store, including cached items and
duplicate retry callbacks. Existing write/payment contracts are unchanged.

`GET /api/admin/products/:numericLegacyId/publication-readiness` is private,
no-store and advisory only. It rechecks live `catalog.write`, verified email and
MFA before and after a bounded D1 batch. Existing pure editorial rules,
effective-pricing SQL, tax classes, single-warehouse sellable inventory and
current governed media evidence supply the observations; legacy image/rights
attributes cannot substitute. Factored private media evidence permits draft
inspection while the public wrapper retains all publication gates. Outages or
malformed results fail closed. HTTP cannot choose the evaluation clock and
non-GET methods cannot mutate a product, claim or audit.

The independent panel validates its explicit capability, product ID/UUID,
version, UTC timestamp and response shape. It hides failed/stale observations
and offers a guarded GET refresh. Zero issues never means approval and no
publication control is enabled. Per-type policy, governed identifier
exceptions, genuine dataset/scanner/licensing acceptance, current R2 bytes and
a future atomic status-write guard remain outstanding. This slice is not
completion of CAT-006/ADM-008 in Cloudflare or the full account/checkout UX.

Final local gates pass 2549 unit tests in 113 files and 740 component tests in
20 files. The advisory suite passes 97 cases, its HTTP/metadata suite 61 cases
and its component/parent suite 56 cases. Worker/Nuxt and standalone strict
typechecks pass. The rebuilt workerd audit passes 36 scenarios, all 34
migrations, 20 seeded products and zero outbound requests, including actual
SSR of the advisory panel, auth/clock/method rejection and unchanged command,
audit and product-version rows. The dry-run Worker is 5078.49 KiB (1053.17 KiB
gzip); bundle policy passes 4436 dependency-evidence entries and 658 original
Nitro sources. No upload, deployment, email or provider acceptance occurred.

One agent component run ended with SIGTERM and is not counted as passing. The
central focused run exposed a test expectation that omitted Nuxt's generated
third composable-key argument; the test now checks the caller's exact first
two arguments and single call. Its hoisted runtime mock also supplies valid
app configuration before Nuxt bootstrap. The final complete 740-case run
passes with unchanged deadlines and functional assertions. Broad requirement
states remain unchanged: 132/695 active IDs have repository evidence (18.99%),
not production acceptance. Older checkpoints below retain historical counts.

## Configuration and category integration checkpoint (2026-09-30)

That configuration/category checkpoint passes 34 workerd scenarios with all 33 migrations,
20 seeded products and zero outbound requests. The additional scenario creates
an isolated draft/hidden category subtree and private draft product, verifies
their absence from the public category response, checks live staff/MFA access
and actual category SSR, and rejects POST/PUT/DELETE without changing rows.
Parent and child counts refer to the same product without adding it twice.
These fixtures are deleted only from the audit's disposable local database.

`app/pages/admin/categorias.vue` now reads the private D1 tree under a separate
cache key. Cloudflare create/edit/move/delete controls and callbacks remain
unavailable regardless of hostile mutation capabilities. Unknown runtimes,
invalid/cyclic trees, failed/stale reads and revoked capabilities fail closed.
Node retains its existing public-tree CRUD contract when no capability map
exists; a present map requires each own action capability to be literally true.
The focused category component suite passes 83 cases. This closes the read UI
integration, not product/category CRUD or ADM-008 acceptance.

Local/preprod generators now use the reviewed explicit binding/variable
contract in `scripts/lib/cloudflare-config-safety.ts`. They cannot inherit
production environments, services, custom aliases/build hooks or unknown vars;
local resources are reconstructed with `remote: false`. Auth, media, payment,
Bizum, newsletter and email stay disabled. Preprod IDs must be primitive strings
for the exact isolated resources. Plain own-data records prevent getters or
inherited declared secrets from changing a value after validation. Importing
the preprod resolver performs no credential reads or API calls. New legitimate
bindings require deliberate contract review rather than unrestricted cloning.

The bundle gate now checks the original esbuild graph separately from original
standard/indexed source maps. Empty/corrupt metadata cannot be made valid by
fabricating source-map inputs. Roots, resolved/original imports, output
attribution and optional entry/CSS references are inspected; backend
filesystem/socket/process, PostgreSQL/Redis/SMTP and native image dependencies
remain forbidden. Real `#neteco/nitro-renderer` aliases are retained, while a
forbidden resolved target is still rejected. The current real bundle passes
4377 dependency-evidence entries and 651 original Nitro sources. Six focused
config/policy/source-map suites pass 487 tests, including independent boundary
and actual-alias regressions. Arbitrarily falsified/renamed metadata cannot prove
package identity; this is a build gate, not a substitute for source review.

Validation execution note: run Nuxt typecheck and component suites sequentially,
without overlapping the full build. Under shared-host memory pressure the first
build exited with signal 143 and a concurrent unit run was interrupted after a
timing failure; the unchanged identity-email suite passed 57 cases in isolation.
The separate build passed with a process-only 1536 MiB Node old-space limit.
A component run overlapping typecheck hit the existing 10-second Nuxt bootstrap
hook (376 assertions passed, 41 tests skipped); it is not a passing suite.
Deadlines and assertions were not relaxed. Fresh, non-overlapping complete runs
passed 2199 unit tests in 110 files and 417 component tests in 13 files. Worker
and Nuxt typechecks, standalone strict checks for the configuration/build
helpers, lint, formatting, requirement audit and diff checks also passed. The
real-bundle alias regression was corrected before these final runs; the earlier
unit run with that regression is not counted as a passing run. No deployment or
provider acceptance is implied.

## Catalog and approved-media checkpoint (2026-09-30)

The subsequent draft-metadata vertical adds migration 0034 and a narrow
`PUT /api/admin/products/:numericLegacyId`. It accepts only a partial patch of
ten editorial fields plus expected version and reason, never the legacy
full-product payload. An owned command claim, CAS update, matching immutable
audit and final rollback guard share one D1 batch. SQL execution-time
`catalog.write`, email and MFA checks protect every stage; HTTP cannot select
that clock. A command without its audit is not a successful replay. Completed
replays return the original receipt even after later product/state changes.

Metadata updates preserve omitted JSON and visual extras, image/rights fields,
IDs, slug, regulatory data, variants, prices and stock. The dedicated UI uses
`productMetadataUpdate`, draft status and `catalogVersion`, not the unavailable
full-product capability. Existing Node CRUD remains a separate contract. The
independent mutation suite passes 192 cases and read/HTTP suites pass 157 cases.
The final combined gates pass 2438 unit tests in 112 files and 606 component
tests in 16 files, Worker/Nuxt typechecks, strict HTTP/audit typechecks and lint.
The real rebuilt local runtime passes 35 scenarios with all 34 migrations,
20 seeded products and zero outbound requests. Its new scenario checks genuine
SSR of the draft editor, simultaneous same-key writes, one command/audit and
byte-identical replay after a later status/version change; invalid fields,
unauthorized actors and non-draft writes remain rejected. The dry-run bundle is
5028.42 KiB (1040.38 KiB gzip); its policy passes 4409 dependency-evidence entries
and 655 original Nitro sources. No upload, deployment or provider acceptance
was performed. Full CRUD, publication transitions and readiness acceptance remain
open. Existing null/scalar/array visual metadata cannot be rewritten by this
editor; it requires an explicit repair outside this slice.

Two independent quick improvements are included in those combined gates:
`PasswordField.vue` preserves exact values and existing current/repeat-password
rules while exposing native requirements, accessible reveal controls and the
128-character ceiling for new passwords (24 focused component cases).
Newsletter confirmation/unsubscribe now require an explicit action, remove the
token from history, block duplicate/stale callbacks and distinguish permanent
failure from manual transport retries (54 focused cases). Generic `{ok:true}`
does not prove token existence or consent. Native control semantics are tested;
no browser-keyboard E2E or real newsletter delivery is claimed.

The first combined Nuxt typecheck rejected three possibly undefined detail
values; the page now normalizes the child prop to null and its legacy action
guard explicitly accepts absence. The fresh typecheck and complete 606-case
component rerun passed without relaxing deadlines. A separate pressured agent
run hit two existing bootstrap-hook timeouts; it is not a passing run and is
superseded by the clean full runs above.

Migration 0033 preserves immutable quarantined originals and adds signed scanner
receipts, human rights decisions and explicit product/variant media publications.
Uploading, approving rights and publishing are separate operations. Source hash,
size, key, latest clean scan, current rights decision, publication window and
public product/variant eligibility must all match. A new scan/rights decision
invalidates mappings pinned to obsolete evidence; fresh associations are explicit.
Withdrawals and all editorial commands use idempotency, optimistic versions and
live permission/MFA gates inside the mutation batch.

The implementation and focused evidence are
[`0033_media_publication.sql`](../../db/d1/migrations/0033_media_publication.sql),
[`governance.ts`](../../workers/media/governance.ts),
[`governance-http.ts`](../../workers/media/governance-http.ts),
[`public-catalog.ts`](../../workers/media/public-catalog.ts),
[`public-delivery.ts`](../../workers/media/public-delivery.ts),
[`d1-media-governance.test.ts`](../../tests/unit/d1-media-governance.test.ts),
[`d1-media-review-adversarial.test.ts`](../../tests/unit/d1-media-review-adversarial.test.ts)
and [`d1-media-public.test.ts`](../../tests/unit/d1-media-public.test.ts).

`GET /api/admin/products`, numeric detail and `/api/admin/categories` now read D1
with live `catalog.write`, email verification and MFA: `catalog.read` is also a
customer permission and cannot expose drafts. Effective prices and physical/
sellable inventory use the existing authorities. Full-product and pricing forms
remain capability-driven consultation; the separate draft-metadata editor above
does not enable full CRUD or status transitions. The subsequent category checkpoint
above integrates its private tree consumer and runtime/capability guards; the
private GET is still consultation only, not a category mutation implementation.
This is a read stage, not completion of ADM-008. The legacy 500-row listing limit
and panel role guard remain follow-up work for scale/editor access.
The read-only adapter and product UI gates are recorded in
[`admin-catalog.ts`](../../workers/catalog/admin-catalog.ts),
[`admin-catalog-http.ts`](../../workers/catalog/admin-catalog-http.ts),
[`d1-admin-catalog.test.ts`](../../tests/unit/d1-admin-catalog.test.ts) and
[`admin-catalog-capabilities.test.ts`](../../tests/components/admin-catalog-capabilities.test.ts).

Public catalog, suggestions and PDP media come exclusively from eligible D1
publications, including per-variant images and versioned technical PDFs. Their
metadata is private/no-store to avoid stale withdrawal decisions. `/media/**`
is Worker-authoritative; static `/img/products/**` originals cannot bypass it.
The ordinary Node profile retains its existing image behavior. Cloudflare UI uses
bounded AVIF/WebP/JPEG responsive sources and recorded alt text, not legacy sector/
family demonstration photos as an implied rights approval.

Byte delivery rechecks D1 before and after asynchronous R2/hash/transform work,
owns and validates the original SHA-256 bytes and never exposes quarantine keys
or raw image originals. Images use the installed Cloudflare `IMAGES` binding;
PDFs are explicit authorized technical downloads, not invoices or order files.
Shared CDN caching and ranges remain disabled rather than bypassing revocation.
`MEDIA_ADMIN_ENABLED` and `MEDIA_PUBLIC_ENABLED` default off. A distinct
`MEDIA_SCAN_SECRET` and genuine scanner integration are required: browser claims,
image magic bytes and synthetic signed test fixtures do not constitute antivirus.

The 2026-09-30 local workerd checkpoint passes 33 scenarios with all 33 migrations,
20 seeded products and zero outbound requests, including real R2 upload, signed synthetic evidence,
explicit human/publication commands, offline image decoding/resizing in AVIF,
WebP and JPEG, actual responsive product/library SSR, exact-variant cart photos,
same-second infected-scan revocation, immediate withdrawal, private pricing and
read-only inventory operations. Its
local emulator uses the already-installed Node decoder; the Worker bundle
contains neither Sharp nor a Node filesystem decoder. The full bundle is
audited against policy, with 2926 dependency entries and 651 original Nitro
sources passing in the final combined build. This checkpoint includes the
HTTP-origin boundary and explicit Node-runtime, nullable-stats and dashboard
guards. Real scanning, real licensed assets, deployed delivery,
provider acceptance, cache/performance design and operational CRUD remain gates.

The subsequent adversarial review reproduced scanner verdict ties, permission
expiry during a queued batch and identical-command races. Focused fixes and
independent SQLite regressions now cover infected-first ordering in the same
second, effective SQL execution-time permission/expiry checks and exact-command
replay after a concurrent winner (including preflight windows). Internal test
clock overrides are not HTTP inputs. The earlier 31-scenario checkpoint included
these changes and its full unit run passed 1523 tests in 103 files. The subsequent
combined unit run passes 1743 tests in 107 files; Worker/Nuxt typechecks, lint,
format and diff checks also pass. The final component run passes 334 tests in
12 files with `--maxWorkers=2`. An initial run overlapping the build/typechecks
hit the existing 10-second Nuxt bootstrap deadline in the image suite, not an
assertion failure. The repeat after the build passed without changing deadlines
or assertions. Natural session,
grant and cart expiry during asynchronous enrichment is covered independently.

Private cart, customer-order and staff-order projections now select only a
governed image explicitly associated with the exact current variant/SKU. Order
photos additionally require the current SKU to match the immutable order-line
snapshot; product-level, sibling-variant and legacy pointers cannot substitute.
Missing or withdrawn photos remain absent without changing contractual order
amounts or cart quantities/prices. These implementation paths and focused tests
are [`storefront-cart.ts`](../../workers/catalog/storefront-cart.ts),
[`customer-orders.ts`](../../workers/catalog/customer-orders.ts),
[`admin-orders.ts`](../../workers/catalog/admin-orders.ts),
[`d1-storefront-cart.test.ts`](../../tests/unit/d1-storefront-cart.test.ts),
[`d1-customer-orders.test.ts`](../../tests/unit/d1-customer-orders.test.ts) and
[`d1-admin-orders.test.ts`](../../tests/unit/d1-admin-orders.test.ts). The private
authorization/cart-version gates are rechecked after asynchronous media reads.
The synthetic publication fixture exercises the real services, not real asset
rights or antivirus. These photo projections pass local integration checks;
production/provider acceptance is not established by them.

The media panel now associates an approved file explicitly with a selected
product/optional exact SKU, role, title, alt, language, version and UTC validity.
Only authorized private catalog DTOs expose the UUIDs needed for this action.
Rights decisions and withdrawals use stable idempotency keys and versions; a
lost response can be retried without manufacturing a second operation. Blocking
an already-approved asset remains available. Association and withdrawal controls
fail closed on server capabilities and never expose quarantine URLs. Relevant
tests include [`media-publication-form.test.ts`](../../tests/unit/media-publication-form.test.ts),
[`media-publication-dialog.test.ts`](../../tests/components/media-publication-dialog.test.ts)
and [`media-library-governance.test.ts`](../../tests/components/media-library-governance.test.ts).

Responsive rendering and honest image failure/cache behavior are covered by
[`published-product-image.test.ts`](../../tests/components/published-product-image.test.ts).
The Cloudflare UI refuses ungoverned sources in product cards, cart/order photos,
hero, PDP preloads/lightbox and technical downloads. Real licensed asset inventory,
genuine scanner/provider configuration, editorial/document currentness review,
crop/quality/performance/cache measurement and deployed production acceptance
remain open. Both media flags remain off in deployment configuration and no production environment was
tested or changed for this checkpoint.

The requirement registry is still 132/695 active repository-evidence items
(18.99%); this checkpoint does not inflate production acceptance or mark entire
media/catalog requirements complete merely because their local vertical passes.

## Private pricing consultation (2026-09-30)

The new `GET /api/admin/prices` adapter preserves the ordinary Node item/history
fields and reads existing D1 prices, not a synthetic tariff. A verified session,
email, MFA and live `catalog.write` are required before and after its read batch;
elapsed server time is used for the final permission/expiry check. Count, current
prices and history share one read snapshot. The same effective-price rule selects
the winner and its compare/reference/volume fields. Real variant currency and
canonical pricing timestamps are retained; invalid legacy creation dates produce
`validFrom: null`, never an invented validity date.

Search is bounded and literal, without SQL wildcard interpretation. Listing
pagination counts variants; history pagination counts versions independently for
each variant. `scheduled` selects the earliest approved future version from the
whole history, including records outside the displayed history page. The only
route is the list GET: selecting a canonical numeric legacy `variant` enables a
targeted history read. There is no separate invented `/history` API. A list may
return at most 500 items, eight history versions per item and one scheduled
version per item: 4500 version records plus 500 items, or 5000 records total.
Targeted reads allow at most 100 history records and one scheduled version.
The response advertises these explicit limits; oversized history requests fail
rather than silently dropping records.

Cloudflare `/admin/precios` requires the server source/capabilities, paginates
25 references at a time and fetches fresh history in pages of 20 through that
same GET. Current/compare/reference prices and volume tiers remain readable on
mobile. History loading, failure/retry, cancellation evidence and permission or
selected-reference changes are handled explicitly. Future labels use the server
pricing instant. Scheduling, editing and cancellation controls are absent in
Cloudflare even if a hostile payload claims write capability: this cut implements
no price mutations. The ordinary Node POST scheduling/cancellation routes,
embedded history and client pagination retain their existing behavior.

Implementation and focused evidence are
[`admin-pricing.ts`](../../workers/catalog/admin-pricing.ts),
[`admin-pricing-http.ts`](../../workers/catalog/admin-pricing-http.ts),
[`precios.vue`](../../app/pages/admin/precios.vue),
[`d1-admin-pricing.test.ts`](../../tests/unit/d1-admin-pricing.test.ts),
[`d1-admin-pricing-review.test.ts`](../../tests/unit/d1-admin-pricing-review.test.ts) and
[`admin-pricing-capabilities.test.ts`](../../tests/components/admin-pricing-capabilities.test.ts).
The focused SQLite suite passes 107 cases, its independent pricing review passes
six and the focused pricing UI suite passes 36. The 33-scenario workerd checkpoint
includes real private pricing GET and SSR integration at that build checkpoint.
These are local synthetic fixtures, not a business-approved tariff or operational
acceptance; the final combined component run also passes.
No production/provider environment was exercised, no
deployment occurred, and flags remain unchanged. Price write governance,
scheduling/cancellation in Cloudflare and catalog CRUD remain open. Existing
PRI-006, PRI-008, PRI-011 and ADM-008 statuses and the 18.99% registry metric are
unchanged; read-only evidence does not complete their full acceptance criteria.

## Read-only inventory operations (2026-09-30)

The existing `GET /api/admin/operations` reads persisted facts with live
administration permission, verified email and MFA checks before and after the
query. Its server observation instant is taken after the initial authorization
await. It adds five aggregate diagnostics, not stock-editing endpoints:
`inventoryReservationExpiryPending`, `inventoryLedgerDivergences`,
`inventoryAvailabilityDeficits`, `inventoryStockExceptionOrders` and
`inventoryBackorderCommitments`, each with an explicit homonymous capability.
No buyer, reservation, ledger, warehouse or actor identifiers are projected.

“Liberación pendiente” counts expired reservations still persisted as reserved;
their quantities remain retained until a real release transition. “Diferencias
en el registro” counts unique variant/location pairs with a physical/reserved
ledger mismatch, including active retained reservations whose balance is missing.
Retired net-zero ledger history without active reservations is not an anomaly.
“Reservas sin cobertura” requires retained quantity greater than
`max(0, physical - blocked - safety stock)` without authorized backorder:
normal exhaustion below the safety buffer with no reservations is not an error.
Authorized backorder uses that same threshold but is a separate permitted
commitment, not an availability deficit. An independent structural ledger problem
can still coexist with it. Stock-exception orders are counted once each.

`inventoryExceptions` deduplicates pairs affected by ledger/coverage problems
and adds stock-exception orders; it does not sum overlapping diagnostic counters,
expired reservations or permitted backorders. Balance/reservation diagnostics
require one verified active warehouse. Zero/multiple active locations or inventory
referenced in an inactive location yield `null` with capability false rather than
hiding the extra inventory or asserting zero. The independently observable
stock-exception order count remains available even when warehouse scope cannot
be verified. No multi-warehouse selector, transfer workflow or location hierarchy
is introduced.

Cloudflare `/admin/operaciones` requires the exact runtime/source and literal
true measurement capabilities. Unknown counts stay “No disponible”; failed,
absent or pending reads cannot assert an all-clear. The five descriptions and
units remain visible in the mobile one-column layout, with named groups and
accessible count descriptions. Private bank/outbox/queue details, mutation
buttons and dialogs stay unavailable even if a hostile payload claims support.
The dashboard likewise does not claim stock was checked when its diagnostic is
unknown and links observed stock incidents to the real operations view.
Only explicit Node runtime retains the existing Node GET counts/details and
actual bank-reconciliation/outbox-retry POSTs; new unsupported diagnostics are
not fabricated for Node.

Implementation and focused evidence are
[`admin-orders.ts`](../../workers/catalog/admin-orders.ts),
[`admin-orders-http.ts`](../../workers/catalog/admin-orders-http.ts),
[`operaciones.vue`](../../app/pages/admin/operaciones.vue),
[`index.vue`](../../app/pages/admin/index.vue),
[`d1-admin-inventory-operations.test.ts`](../../tests/unit/d1-admin-inventory-operations.test.ts),
[`d1-admin-orders-origin.test.ts`](../../tests/unit/d1-admin-orders-origin.test.ts),
[`d1-admin-orders.test.ts`](../../tests/unit/d1-admin-orders.test.ts),
[`admin-operations-capabilities.test.ts`](../../tests/components/admin-operations-capabilities.test.ts),
[`admin-dashboard-capabilities.test.ts`](../../tests/components/admin-dashboard-capabilities.test.ts)
and [`audit-cloudflare-shop.ts`](../../scripts/audit-cloudflare-shop.ts).
The focused inventory suite passes 42 cases, operations UI 53, dashboard UI 27,
HTTP-origin boundary 62 and existing administrative-order regression 31. The
final combined 33-scenario workerd run exercised a real expired retained reservation with zero
inconsistencies, an injected ledger drift counted once, explicit restoration/
release and actual read-only operations SSR; it also includes the current HTTP/
dashboard guards, and the final combined component run passes. This is
not a daily reconciliation job, operational UAT,
browser accessibility/mobile acceptance or production verification. No new
inventory writes, deployment or flag enablement occurred; INV-003/005/009/012,
ADM-007 and UI-004 statuses and the 18.99% registry remain unchanged.

## Earlier full storefront Worker checkpoint (2026-09-30)

`NETECO_RUNTIME=cloudflare` selects the installed Nitro `cloudflare-module`
preset with Node compatibility, isolated `.nuxt-cloudflare`/`.output-cloudflare`
directories and only `server-cloudflare` handlers. The legacy `server/api`,
middleware and service tree is not scanned. The ordinary Node build is unchanged.

`workers/shop.ts` wraps the renderer with `createShopIngress()`. `/api/**` and
`/health`, `/robots.txt`, `/sitemap.xml` and `/sitemaps/**` reach the D1 Worker before Nitro reads request bodies. SSR internal
API fetches use the same handlers through the trusted Cloudflare request context,
preserving cookies and the original edge client IP. Missing context fails closed;
an internal caller cannot manufacture a trusted IP or a same-origin write.
The generated nuxt-auth-utils session handler is excluded: live D1 sessions
remain the only authority. Durable Objects, Workflow, Cron and Queue exports are
retained. Static Assets run Worker-first, with no HTML or SPA fallback.

Rendered HTML is private/no-store, including catalog pages that contain session
state. Account/admin/cart/checkout/order/auth pages also carry noindex and a
no-referrer policy. Public D1 API responses keep their own cache policy. Nuxt
Image uses no filesystem transformations; approved responsive delivery is described
in the newer media checkpoint above. Generated icons use `/_icons`, outside the reserved API namespace.

`GET /api/search` now returns published product suggestions from D1: exact SKU,
EAN, GTIN and MPN rank first, followed by FTS/folded-text matches, with governed
prices and VAT. Hidden variant references cannot reveal a public product through
either suggestions or the catalog SKU filter. Category/query suggestions and
full autocomplete keyboard/UAT acceptance remain open (SEA-003 is not closed).

Reproduce the full local runtime check without credentials or deployment:

```sh
npm run build:cloudflare-ui
npm run build:worker-shop
npm run audit:shop-bundle
npm run audit:shop:local
```

The generated ignored config derives bindings from `wrangler.canary.jsonc` and
adds the Nitro alias and `ASSETS` binding. It is local-only, not a production
configuration. The bundle audit inspects both Wrangler inputs and original
Nitro source maps to detect forbidden native/legacy dependencies hidden by
Rollup. The local workerd audit uses ephemeral D1/DO/KV/R2/Queues, 31 migrations
and synthetic users; it forbids outbound network access and cleans its state.
All 24 scenarios passed: actual product HTML on home/catalog/detail, CSS/JS,
search, account and admin SSR with MFA, external-document navigation with a valid
session, revoked-session enforcement, SEO ingress and the real identity lifecycle,
including recovery before email verification. Direct cross-site API reads and writes
remain rejected; the SSR normalization applies only to document-derived reads.
The full dry-run bundle measured 4708.91 KiB (968.23 KiB gzip); 2836 dependency
entries and 638 original Nitro sources passed the policy.

At this earlier checkpoint the complete unit project passed 1047 tests across 96 files. Nuxt and standalone
Worker typechecks, ESLint, Prettier and diff checks also pass. CIC-001 now has
repository evidence; the traceability audit reports 132/695 active requirements
(18.99%). This measures repository evidence, not production completion or the
fraction of legacy APIs ported. Regenerable runtime build artifacts are removed
after validation; shared state and source/configuration files are retained.

`.github/workflows/cloudflare-compat.yml` now includes this full-runtime job
alongside Worker checks and five isolated D1 audits. The workflow is prepared
locally, not published or executed remotely. Payments/email stay disabled;
Beply was not contacted. Deployed SEO/Access verification, approved media, operational mutations,
provider acceptance and deployed contention/load remain release gates.

## Identity and SEO checkpoint (2026-09-30)

Migration 0032 adds Cloudflare-native registration, email verification, password
recovery and reauthenticated email changes. The five POST routes use strict
schemas, 4 KiB streaming body limits, trusted-origin checks, native edge limits
and persisted IP/email quotas before password work. New accounts receive only
the customer role; companies remain pending, without locations or buyer
hierarchies. Terms evidence is immutable. Optional newsletter consent reuses the
existing double-opt-in ledger and suppression rules, atomically with registration.
Guest orders are never claimed merely because their email matches.

Registration returns the same 202 body for new and existing addresses, with no
cookie or identity projection. The UI shows a generic check-email state instead
of assuming login. Password-authenticated login still uses the existing D1
session/MFA authority; link verification never creates a session. Recovery and
email changes revoke sessions and obsolete links in the mutation batch. Recovery
before verification issues a fresh verification link for the new version in the
same transaction. Concurrent password/session/MFA changes are revalidated inside
the batch, not trusted from an earlier read. Database failures remain sanitized
availability errors, not credential or token failures.

The Cron identity dispatcher is separate from order email and remains opt-in/off
in local and preproduction configuration. Tokens are HMAC-hashed and encrypted,
never returned by issuance endpoints or logged. Durable leases prevent ambiguous
provider acceptance from causing automatic resend. See the
[identity delivery contract](../../workers/communications/README.md#identity-lifecycle-delivery).
Sender verification, delivery acceptance, migration of outstanding legacy links,
key rotation and retention are not established by local tests.

The D1 SEO handler generates robots and paginated sitemap indexes directly from
published read models, with a configured HTTPS origin rather than request Host
or cookies. Nonproduction responses disallow indexing, carry `noindex` and are
private/no-store; deployed Access protection remains a separate release gate.
Published product URLs must satisfy the existing PDP slug and legacy-ID contract;
unmapped categories and products are not advertised as reachable pages. Only
public static pages are listed. Errors fail closed; unsafe aliases and methods
cannot fall through to the renderer. Sitemap limits, XML escaping, publication
ancestry, server timestamps and HEAD behavior have local SQLite coverage.

The earlier identity integration check passed 1047 unit tests in 96 files, four focused
registration UI tests and 24 workerd scenarios with all 32 migrations and zero
outbound requests. Root integration and parallel adversarial review fixed the
pending-reset verification gap, renderer-incompatible registration names and
unreachable sitemap entries (including SQLite NUL truncation). Nuxt and Worker
typechecks, lint, formatting and traceability checks passed. CUS-003 evidence was
expanded without changing its `NOT_VERIFIED` status: the full requirement must
still be reviewed before phase acceptance. The registry remains 132/695 active
requirements with repository evidence (18.99%), not production completion.

## Canary contract

`wrangler.canary.jsonc` is the source of truth for the local canary. It declares the minimum production-platform contract:

- D1 (`DB`) for authoritative relational data.
- Durable Objects (`COORDINATOR`) for strict coordination.
- KV (`CACHE`) only for derived, eventually consistent data.
- R2 (`MEDIA`) for objects and media.
- Queues (`ASYNC_JOBS`) with retries and a dead-letter queue.
- Workflows (`CATALOG_WORKFLOW`) for durable, multi-step jobs.

The canary exposes `GET /health` and the migrated routes described below. Its health probe executes `SELECT 1` in D1 and validates the shape of the other bindings without writing to them. It never imports the Nuxt application or its Node-only dependencies.

The first vertical route, `GET /api/categories`, reads the published category tree from D1 and applies an explicit public cache policy. Public product listing/detail, inventory and scheduled pricing are modeled separately below. Approved media now uses migration 0033; its real scanner, licensed dataset and deployed acceptance remain prerequisites before traffic can move from the Node runtime.

`GET /api/products` now exercises the D1 product/variant read model with stable pagination, category descendants, safe sort selection, parameterized FTS5 search, effective gross/net minimum prices and governed compare-at values. It accepts the current Nuxt catalog filters (brand, badge, container, size, capacity, color, measurement, finish, gross price and featured). `facets=1` returns the current UI facet shape with product-deduplicated counts and self-exclusion of each active axis; scroll requests omit the ten fixed facet queries. The local full-storefront profile uses these same D1 APIs; catalog-scale query plans remain a production-readiness gate.

`GET /api/products/:slug` returns the Nuxt product-detail shape for a published product and variants: governed price/version and matching compare/reference/tier fields, VAT-derived net price, sellable stock from the existing inventory expression, siblings, breadcrumb and same-category related items. It never returns draft/hidden products or original quarantine keys. Images and documents are populated only by eligible migration-0033 publications; unapproved legacy media is absent. Successful detail and errors are no-store, with fresh delivery gates for every publication URL. This is not full PDP/operational acceptance. SQLite contract tests cover temporal prices, stock reservations, approved-media mapping, withdrawal and the HTTP route.

## Payments in development

`0007_payments.sql` adds payment intents, order payment states, immutable events,
command replay and recovery jobs. `POST /api/orders/:id/payment-intents` accepts
`Authorization: Order <token>`, `Idempotency-Key` and a JSON body containing only
`method: card | bizum`. Amounts come from the contractual order. Bizum requires
explicit terminal enablement. `POST /api/payments/redsys/notification` accepts the
signed form envelope; all payment responses use `no-store`.

The adapter uses Web Crypto and Redsys `HMAC_SHA512_V2`, checked against the
published signature vector. A verified successful notification persists the
provider authorisation and recovery job before requesting assignment through the
global inventory coordinator. A lost response is replayable without another stock
decrement. Expired reservations become `stock_exception` with manual review.
Order lookup returns a separate `payment` object; bank return navigation cannot
set this state.

The local canary configuration declares a one-minute Cron Trigger. Its handler
processes at most 25 due, already-authorised payments per invocation and retries
through persistent D1 jobs. This recovers the local finalisation step only; bank
reconciliation for notifications that never arrived and full concurrency review
are still pending. The isolated checkout audit uses the actual local workerd D1
binding to verify redirect replay, signed capture, duplicate callbacks, the paid
order view and exactly one stock allocation. Inventory assignment goes through
the production `InventoryCoordinator` class running as a real local SQLite
Durable Object, bundled through `tests/support/inventory-runtime.ts`; it is not
a mock coordinator. The audit starts 12 duplicate callback handlers concurrently
against that shared D1/DO and requires exactly one capture domain event and one
stock allocation, then verifies a second real capture is retained for review.
It does not prove distinct concurrent bank operations, deployed integration or
production load. This vertical is not yet approved for production.

`0008_payment_fulfilment_claims.sql` fixes the reproduced late-success regression:
the first persisted authorisation claims order fulfilment atomically, while every
other verified capture retains its bank event and a `manual_review` recovery job
with `duplicate_provider_capture`. Only the immutable claim holder can request
stock assignment. The redirect index still prevents simultaneous new redirects;
an additional in-batch claim guard prevents initiation racing a bank callback.
Issued redirects are not falsely labelled bank-cancelled. Already-paid redirects
can still produce a second real bank charge: this is recorded for manual review,
not silently ignored or automatically refunded. The refund/operator UI remains
pending. `paidGrossCents` is the amount applied to the order, not an aggregate of
all provider receipts; duplicate receipts remain in the intent/event ledger.

Local capture/stock-exception events are keyed by intent, not by callback or
recovery delivery. Barrier-based tests cover recovery overtaking an in-flight
callback, including a callback carrying a pre-expiry timestamp after recovery
has observed expiry. Assignment now atomically persists expiry and its release
ledger entry for the affected reservation; stale assignment cannot reactivate
that terminal state. A sweep from another caller can repeat that expiry safely.
Other reservations are not expired by this targeted operation. These tests prove
the service-level interleaving, not deployed coordinator execution-time handling,
which remains a release gate.

Payments default to disabled (`REDSYS_ENABLED=false`). Configure the merchant,
terminal, HTTPS public base URL and secret `REDSYS_SECRET_KEY` separately for each
environment before enabling. No bank credentials are stored in Wrangler vars.

Local checkpoint (2026-09-08): the complete unit project passes 469 tests across
58 files. The canary dry-run bundle is 187.36 KiB (37.06 KiB gzip), and its
dependency policy passes with 68 manifest entries. This is not evidence that the
full Nuxt application is Cloudflare-ready or that fiscal/provider acceptance is
complete. Generated bundle artifacts are regenerable and removed after checking.

## Effective pricing

Governed price history lives in `variant_price_versions` (`db/d1/migrations/0003_variant_price_versions.sql`). Migration `0023_price_window_precision.sql` replaces its original text-order window checks and effective index: canonical UTC seconds and milliseconds are normalized before comparison, so versions inside the same second retain correct inclusive-start/exclusive-end ordering. Every published variant resolves one deterministic effective price: the latest approved version with `valid_from <= instant` and an open or not-yet-reached `valid_until`, ties broken by `created_at DESC, id DESC`. Variants without any live version fall back to the legacy base price. The evaluation instant is always bound server-side; request input can never select it.

The shared selection logic in `workers/catalog/pricing.ts` is used by both the Worker and `scripts/audit-d1-catalog.ts`. The audit creates an isolated temporary D1, applies every migration and seed, executes active/future/expired/cancelled/tie/boundary/mixed-precision/fallback scenarios, and proves that its final canonical data snapshot matches the pre-scenario digest. The temporary D1 is discarded even when an assertion fails.

The canary explicitly declares `REDSYS_SECRET_KEY` as its required secret. Values remain outside Git; unrelated application secrets must not be imported into this Worker configuration.

## Current observations when repeating an owned order

The Cloudflare owned-order detail includes an explicit nullable `reorderOffer`
for each historical line. One final D1 read binds live ownership, confirmed
fulfillment and all current offers to the same server SQL clock after media
reads. It uses the existing governed effective price, volume tiers, VAT,
publication checks and inventory/quantity rules, with no per-line queries or
stock reservations. The contractual name, SKU, quantity and historical amounts
remain unchanged; zero-price or unpublished offers are unavailable.

The reorder dialog compares historical gross prices with separately observed
current unit/line gross and net prices, VAT, quantity limits and availability.
Stock is the maximum sellable at one active location, matching the reservation
engine rather than promising a cross-location split. Invalid quantities and
insufficient stock are excluded unless the existing backorder policy permits
them. Missing Cloudflare offers fail closed; absent optional offers preserve
the Node contract. Confirmation still uses the normal cart API, which
revalidates all current conditions. These observations never guarantee a price,
reserve stock or select a substitute. Substitute selection and compiled-browser
and operational acceptance remain pending.

## Permission-scoped recent administrative activity

### Global product and order search

The Cloudflare admin shell also provides explicit global entity search via
`GET /api/admin/global-search?q=...&limit=10`. Queries are NFC-trimmed, bounded
to 2–100 characters and matched literally with the existing Spanish folding;
`%`, `_` and SQL-like text never become operators. Live `catalog.write` grants
product name/SKU results, including editable drafts, and
`administration.manage` grants order-identifier results. A single bounded data
query sits between two fresh capability checks, with exact matches ranked
first and stable ordering. The private response contains canonical existing
detail links, never customer names, addresses or financial amounts.

The search UI sends no request while typing and no automatic retry. It validates
the shared response and the parent's currently authorized destinations, and
aborts/purges results on query, identity, grant or pending-state changes. Loading,
errors and confirmed empty results are distinct. Node retains its existing UI;
this endpoint does not introduce a customer directory or a new write operation.

### Confirmed audit activity

`GET /api/admin/activity?limit=5` returns at most the requested 1–20 audit
entries and an opaque bounded cursor. Eight existing immutable audit sources
are matched to their durable commands; live session, email, MFA and read
permissions are checked again after the bounded query. The response contains
only event ID, kind, action, UTC timestamp and an existing canonical destination,
never actor identity, customer data, reasons or command payloads. It is a
private `no-store` read and performs no writes.

The Cloudflare admin shell exposes this list separately from visited pages,
inside a collapsible activity section. Loading, errors and a confirmed empty
list are distinct; retries are manual reads and authority changes invalidate
pending or displayed activity. Node does not mount this Cloudflare-only reader.
Directed service, HTTP, component and real D1 tests cover the implementation;
the full admin P0 journeys and production acceptance are not claimed.

## Confirmed owner and administrative order timeline

Cloudflare exposes read-only `GET /api/orders/:uuid/timeline` for the currently
verified customer who owns the order, and
`GET /api/admin/orders/:uuid/timeline` for live `administration.manage` with MFA.
Unknown and foreign orders have the same customer 404; administrative status
does not bypass customer ownership. Guest access is not added by this reader.
Responses are private/no-store, with no cookie exchange or provider calls.

Seven existing source families supply confirmed checkout, payment, preparation,
return, refund, invoice and credit-note records. Operational commands must match
their immutable audits; financial records must match completed work, contractual
fingerprints and receipts/documents. Actor, origin and correlation evidence
remains in the durable ledgers, never in this safe response. The DTO contains
only source ID, kind, state, UTC time and an explicit validation marker. Local
financial validation is labelled as such and excluded outside local mode;
legacy payment records have an unknown marker, not a fabricated real-payment
claim. A capture record never claims bank settlement.

Pages contain 1–20 events (default 10), descending by timestamp and source ID.
The canonical cursor binds the order, audience, cutoff and last event. The
cutoff is not an authorization clock or a cross-request transaction guarantee;
current access is rechecked independently before returning data. Customer UI
mounts only for an open, authenticated, current validated order; session/email
changes invalidate its scope. Admin mounts only with current matching
capabilities and order detail. Errors discard old data, and retries/refreshes
are explicit reads. The Node timeline is unchanged. Compiled-browser journeys,
guest integration and operational/global release acceptance remain pending.

## Unpaid cancellation and operational order workbench

Cloudflare owns `GET|POST /api/orders/:uuid/cancellation` and the equivalent
administrative path, plus GET-only `/cancellation/commands/:commandId` recovery.
Verified current owners or live MFA administrators use these private/no-store
routes; anonymous and guest bearer access do not authorize cancellation.
POST requires same origin, a UUID idempotency key and the strict server-validated
`{expectedStatus: 'awaiting_payment', reason}` body. Eligibility never comes from
the browser. **Any payment attempt**, including a failed or cancelled one,
blocks this operation, as do preparation and fiscal histories.

One D1 batch checks live authority and exact reservation lines, releases only
eligible stock, cancels the order and appends its durable command and audit.
Replay preserves the original receipt; contractual lines and addresses remain
unchanged. Payment initiation independently checks current order/reservation and
the fresh SQL clock inside its transaction. The unified timeline verifies the
cancellation receipt against its immutable audit before exposing the safe event.
No bank, Beply, carrier, refund or email send is performed by this command.
It now records a versioned cancellation email source in the same transaction;
delivery remains separately opted in, as described below.

The customer row and administrative detail retain ambiguous commands in their
current tab, block competing actions, and offer explicit receipt lookup and
same-key recovery. Success requires both a matching receipt and a fresh cancelled
state. Leaving warns that tab-local recovery context will be lost; session or
permission changes purge private context. Node behavior is retained.

The separate Cloudflare order workbench uses existing bounded server queries,
explicit applied filters and sort, and one governed fulfillment context. It
distinguishes failed reads from confirmed empty results and clears private
filters/results at authority boundaries. Paid cancellation, complete operational
rules and compiled-browser/UAT/provider acceptance remain pending.

### Filtered operational order CSV

`GET /api/admin/orders/export.csv` is a separate private read, using the same
query builder, filters and stable order as the operational workbench. It exports
all matches, not just the displayed page; `page` and `perPage` are rejected.
More than 1,000 rows or 2,000,000 UTF-8 bytes returns `export_too_large`, never a
silently truncated download. One coherent D1 data query measures and projects
the bounded result. Current session, verified email, MFA and
`administration.manage` are checked before reading and with a fresh SQL clock
before returning private data.

The sixteen-column CSV uses UTF-8/BOM/CRLF, quoted cells and spreadsheet-formula
protection including leading Unicode whitespace. `totalGrossCents` contains
integer minor units. No internal notes, bearer tokens, postal addresses or
tracking are added. `X-Neteco-Export-Source`, `-Rows` and `-Bytes` describe the
bounded payload; the response is private/no-store with a fixed filename.

The explicit workbench download uses only its last confirmed applied filters.
It validates response headers, bytes and CSV before creating a temporary object
URL, then wipes its buffers and revokes that URL. Draft filters do not silently
change the export. Authority changes, failed reads and competing fulfillment
commands suppress or invalidate the download; Node keeps its existing page.
Directed service/HTTP/component and focused actual D1 tests cover this slice.
The same bound literal search covers buyer NIF/CIF and contractual billing NIF
without exposing those identifiers in result rows. Carrier/exception search,
browser download/UAT and operational acceptance remain separate pending
criteria; ORD-015 is not closed by this feature.

### Private operational notes and labels

Migration `0063_order_annotations.sql` adds append-only notes and command
receipts, plus the current versioned label set. Private administration routes
`/api/admin/orders/:id/annotations` and `/commands/:commandId` require a current
verified session, MFA and `administration.manage`; writes also require
same-origin CSRF, an idempotency key and the expected version. Notes are plain
text bounded to 2,000 characters; labels are limited to eight of forty
characters. History is read in bounded keyset pages. D1 guards preserve live
authority, atomic effects, immutable history and exact replay under contention.

The Cloudflare administrative detail mounts the panel only for that current
authority. Ambiguous writes retain the original intent and block competing
order actions while explicit receipt/current-state reads recover the result.
An obsolete CAS is discarded only after a fresh advanced version and a second
unknown receipt; submitting the preserved draft again remains explicit.
Session/order/grant changes clear private state. Notes and labels are absent
from customer order reads, safe timelines and CSV. Directed component, HTTP
and actual D1 regressions pass. The compiled desktop/mobile journey also
confirms a lost successful response through explicit receipt/current-state
reads without duplicating the POST. Operational acceptance remains pending.

### Versioned transactional order emails

Fulfillment commands atomically record sources for confirmed preparation,
ready-for-pickup, transit and delivery. Unpaid cancellation records its own
source. The registered `order.operations.fulfillment.v1` and
`order.operations.cancelled.v1` renderers reuse the existing transactional
outbox, delivery manifests and leases; there is no new migration or sender.
Return commands also enqueue `order.return.requested.v1` and
`order.return.status.v1`. Verified payment capture enqueues
`order.payment.confirmed.v1`, binding the captured amount/currency, original
verified provider evidence, payment claim and assigned reservation. This does
not backfill unverifiable legacy payments or claim bank settlement. Immutable
command/audit/receipt proof and the current projection govern the recipient and
message. Superseded or otherwise invalid sources go to manual review rather
than sending stale operational claims.

The runtime allows these known renderer keys only by explicit opt-in. Defaults
remain empty with delivery disabled; unselected events remain pending. Escaped
plain/HTML content omits internal notes, reasons, actors and tracking details,
and does not claim bank settlement or reimbursement. An uncertain send is not
automatically duplicated. Directed tests use synthetic recipients and a local
fake sender only. Five compiled workerd/D1 scenarios additionally verify six
current targets, fifteen obsolete sources, exact replay, disabled delivery and
an unchanged digest across twenty-eight domain tables. The combined native
audit passes 385 scenarios with 63 migrations, twenty-five executed Chromium
journeys and zero outbound requests. Current delivered,
cancelled, captured and return-resolution-ready messages are covered. Sending
the other fulfillment/return states, rejected-return native coverage, native
unknown-send proof, real mailbox/provider acceptance and the complete ORD-012
matrix remain pending. No actual email or payment provider is called.

## Customer orders and newsletter groundwork

Migration `0025_order_customer_ownership.sql` adds an immutable, optional `customer_id` to orders. Guest orders remain unassigned; matching an order email to a later account never claims it. Checkout binds a verified, currently active session to the order in the final D1 batch, and replays cannot change ownership. `GET /api/orders`, `GET /api/orders/:id/lines` and the payment-only `GET /api/orders/:id` projection recheck the live session and customer relationship on every owned read, return private `no-store` responses, and use the same 404 for unknown and other customers' order IDs. The owner can open the order after the separate guest bearer expires; no email-match claim is performed. D1 does not yet have a customer-facing shipment/invoice model or a separate public order number; those UI capabilities are not claimed here.

Migrations `0024_newsletter_consent.sql` and `0030_newsletter_confirmation_delivery.sql` provide D1-backed consent and a transactional confirmation-delivery ledger. `POST /api/newsletter/subscribe`, `/confirm` and `/unsubscribe` now use the same body contract as the storefront, with a 4 KiB JSON cap, same-origin check, trusted-IP edge limit, exact D1 request budgets, generic no-store responses, and server-owned text/version/source. A subscription stays `pending` until a signed double-opt-in link is confirmed; unsubscribing or suppressing immediately blocks marketing eligibility. The requested-consent event creates its delivery job in the same D1 transaction. Jobs contain only the request ID and delivery metadata, never recipient, token or message body.

Cron dispatch reconstructs the link from the immutable event, rechecks the current pending request, expiry and suppression, then calls the Cloudflare Email Service `NEWSLETTER_EMAIL` send binding. On an ambiguous provider error or an unacknowledged in-flight send it marks the job `manual_review` rather than automatically sending a duplicate. `NEWSLETTER_ENABLED=false` in this local canary, so these endpoints return 503 and Cron does not send. **Do not enable the isolated canary as-is**: it serves APIs but not `/newsletter/confirmar` or `/newsletter/baja`, and the browser requires a same-origin POST. First route the full Nuxt storefront and these Worker APIs under one HTTPS origin, onboard and verify the sender domain/binding, provision a dedicated base64url 32-byte `NEWSLETTER_HMAC_KEY`, and authorize a controlled acceptance test. Before replacing the PostgreSQL newsletter routes, also drain or explicitly migrate outstanding legacy confirmation/unsubscribe links: those token formats are not interchangeable, while invalid D1 links intentionally return a generic response. Campaign sending, welcome email, provider bounce/complaint ingestion, secret rotation, retention and explicit re-opt-in policy remain open; transactional `0027_email_outbox.sql` still has no provider and is not reused for marketing.

## Storefront cart, favorites and email transport checkpoint

The canary now exposes the current storefront cart paths (`/api/cart` and
`/api/cart/items`) over D1 and the per-cart Durable Object. Its `neteco-cart-v2`
cookie is host-only, `HttpOnly`, `Secure` and `SameSite=Lax`; only the SHA-256
token hash is persisted. Browser writes require a matching `Origin`. Both
anonymous cart-creation paths fail closed behind the dedicated `CART_EDGE_LIMIT`
binding and a trusted Cloudflare client-IP header; the local namespace ID is a
placeholder and must be replaced for the target account before deployment.
Clearing a cart atomically deletes its lines and revokes the token. Repeated add
commands cannot increment twice. The facade accepts legacy numeric variant IDs
for the existing UI while the D1 cart keeps UUIDs internally.

The canary also serves `POST /api/shipping/rates` through the same private cart
cookie. It creates D1 quote and shipping snapshots through the per-cart
Durable Object, replays an identical `Idempotency-Key` exactly, returns only
server-calculated totals and opaque selection proofs, and never sends the cart
token to JavaScript. Same-origin, body-size and edge-abuse checks apply. This
is a Worker canary route only: the current Nuxt
`node-server` build still serves its PostgreSQL handler at the same path.
The replay uses the first persisted cart version even after later cart changes
or expiry; the storefront must rotate its key when requesting a fresh quote.
The D1 rate resolver selects the latest active version for each zone, method
and service profile. The canary seed makes warehouse pickup and own delivery
free, matching the current storefront promise. Standard parcel becomes free
when the cart's effective, volume-tiered gross reaches the trusted
`FREE_SHIPPING_THRESHOLD_CENTS`; both Node and Worker parse that policy with
`shippingCommercialPolicy()`, and checkout revalidates it before reservation.
The canary explicitly sets a demo threshold of 15000 cents. Production must
configure the same threshold in the Nuxt public build and Worker runtime before
cutover, or disable the public promise in both; the separate deployments do
not synchronize environment values automatically. The Worker-only
order/payment/detail adapters and the local Nuxt-on-Worker runtime now exist;
provider and deployed acceptance remain mandatory before replacing Node checkout.

This is **not** a complete storefront cutover. D1 product detail, storefront
cart and checkout quotes now select the same governed volume tier for the cart
quantity. Cart responses include `lineNet` and authoritative totals rounded
once per line with `money.ts`; the unit `netPrice` remains indicative and must
not be multiplied to calculate fiscal totals. Checkout revalidates tier changes
before reserving stock. The PDP caps purchasable quantity at the D1 cart's 999
units per line; catalog publication still needs to reject a minimum quantity
or volume tier above that limit before cutover. The canary accepts the selected
quote/shipping proofs at `POST /api/orders`, revalidates the displayed total
before stock reservation and sets a separate `HttpOnly` order-access cookie
without returning its token in JSON. `POST /api/checkout/pay` uses that cookie,
a required idempotency key and the existing Redsys D1 ledger; an active
redirect can be recovered after a lost response, while authorised, failed or
signed-pending bank forms are not replayed. When a converted cart is replaced,
`GET /api/cart` also issues a short-lived HttpOnly recovery cookie;
`GET /api/checkout/recover` can recover the same order even if Nuxt's global
cart loader already replaced the original cart cookie. That replacement is
flagged in the cart response so cached purchased lines are not re-added to a
new cart. Both mutations require an exact same-origin
`Origin` header and fail closed behind the edge limiter. `GET /api/orders/:id`
provides a payment-only view: shipment tracking and invoice availability are
explicitly untracked, not invented. Both the browser adapter and older raw
bearer-token routes limit guest access to 24 hours from order creation in D1.
Migration `0029` adds revocation without changing the immutable contractual
token hash; Worker logout revokes presented order and cart credentials and
clears their cookies. This does not revoke bearers absent from the browser
request; account-owned access uses a separate live-session and immutable-owner check.
Marketing opt-in and bank transfer are
rejected/hidden in the D1 checkout until their real workflows exist; they are
not silently discarded. Payments remain disabled in the canary configuration,
and the Worker will not create a storefront order while payment configuration
is unavailable.

The local Nuxt-on-Worker ingress is validated as described above. Delivery
and fiscal provider integration, representative edge-abuse testing and
deployed DO contention must still be resolved before traffic moves.

`0026_customer_favorites.sql` adds private D1 favorite lists with verified live
session ownership and read-time revalidation. The HTTP/fresh-pre-cart integration
is now implemented (see the current favorites checkpoint above). `0027_email_outbox.sql`
adds a PII-free D1 transport ledger, leases, Cron-driven Queue publication and a
deduplicated Queue receipt which deliberately remains `blocked_provider`. It is
connected to the D1 `order.created` event in the same checkout batch, but not
to Cloudflare Email Service; no email is sent. Other event types remain unwired.

The canary remains API-only. The separate full-storefront profile described
above now selects `cloudflare-module` and serves `/` and Static Assets. It
excludes legacy Node handlers rather than claiming those APIs have been ported.
The full-runtime audit is separate from `cloudflare:check`, whose scope remains
the canary and existing D1 verticals.

Run the complete local gate with:

```sh
npm run cloudflare:check
```

Run a local Worker after applying the D1 migration:

```sh
npm run d1:migrate:canary:local
npm run dev:worker-canary
```

The generated `worker-configuration.d.ts` is committed so the binding contract is checked by the main TypeScript build. Regenerate it after every Wrangler configuration change with `npm run cloudflare:typegen`.

## Inventory operations

Inventory state lives in D1 (`db/d1/migrations/0004_inventory_operations.sql`): locations, per-variant/location balances (physical / blocked), append-only movements with signed deltas, and multi-line reservations. Safety stock remains authoritative on the catalog variant. Sellable stock is derived, never duplicated:

```
sellable = physical - blocked - safety - SUM(active reservation lines)
```

Every multi-row mutation (`workers/catalog/inventory.ts`) runs as one D1 batch — a single implicit transaction — and ends with a guard statement that violates a CHECK constraint unless all post-conditions hold, so partial effects cannot survive a failure. Idempotency keys are unique per reservation and movement; replays return the same reservation state without new ledger rows, and key reuse with a different payload is rejected. Expiries are gated on the current `expires_at`, which makes stale alarms or redelivered queue messages harmless no-ops.

`InventoryCoordinator` (`workers/inventory-coordinator.ts`) serialises commands through one globally named Durable Object and persistently stores successful command responses for retry-after-lost-response safety. Reusing a command ID with different content is rejected. The object schedules expiry alarms from live D1 data and never stores stock quantities itself. The queue consumer processes versioned expiry messages with per-message ack/retry: malformed payloads are acknowledged permanently, transient failures retry with backoff into the configured dead-letter queue, and duplicates inside one batch are processed once. Delivery stays at-least-once; exactly-once effects come from the D1 idempotency keys.

The isolated inventory audit (`npm run d1:audit:inventory:isolated`) runs migrations, seeds and the full adversarial scenario suite against an ephemeral local D1 directory that is always deleted afterwards, even on failure.

## Server-side carts and pre-checkout quotes

Carts live in D1 (`db/d1/migrations/0005_cart_checkout.sql`): non-enumerable ids, the secret token stored only as SHA-256, explicit active/expired/converted states and a monotonic optimistic-concurrency version. One line per variant; quantity 0 removes.

Every mutation or quote is a command with an idempotency key scoped to its cart, `expectedVersion`, a correlation id and a server-generated instant. Authentication happens before either replay layer is consulted. The persistent `cart_commands` ledger plus `CartCoordinator` (`workers/cart-coordinator.ts`) — one Durable Object instance per cart via the deterministic key `cart:<cartId>` — give replayable, serialised mutations: same key+payload replays the original response byte-for-byte even after a Durable Object restart, same key+different payload is rejected, stale versions conflict without effects, and each batch ends with a CHECK-violating guard so partial writes cannot survive. The object caches only successful results, and its command fingerprints exclude the cart token.

Quotes are immutable at the database boundary (UPDATE/DELETE triggers) and resolved entirely server-side: effective prices through `workers/catalog/pricing.ts`, VAT through `tax_classes` with rounding from `server/domain/money.ts` (the single math implementation), availability observed from inventory without reserving anything, EUR currency, shipping explicitly pending at 0 cents. A quote fails as a whole if any line is no longer published; changing prices, stock or the cart never mutates an existing quote.

The canary exposes `POST /api/carts`, `GET /api/carts/:id`, `PUT /api/carts/:id/items/:variantId` and `POST /api/carts/:id/quote` — all `Cache-Control: no-store`, token via `Authorization: Cart <token>`, mutations requiring `Idempotency-Key`. The creation response returns the token exactly once.

The isolated cart audit (`npm run d1:audit:cart:isolated`) runs migrations, code-generated seeds and the full adversarial suite against an ephemeral D1 directory that is always deleted afterwards.

### Recovering an ambiguous storefront ADD

`GET /api/cart/operations/:key?variantId=<legacy-id>&quantity=<original-quantity>&expectedVersion=<original-version>` reads the authenticated cookie cart's durable command receipt without projecting, expiring or mutating that cart. The strict response contains only `source`, `cartId`, `commandId`, `outcome` and `appliedVersion`. `applied` proves the exact original ADD; `unknown` is not proof that no write occurred. A different payload conflicts. Retired variants and expired/converted carts do not prevent an authorized receipt read; malformed ledger responses fail closed.

Cloudflare ADD requests include the optional `X-Neteco-Cart-Id` header. A mismatch with the authenticated cookie cart returns 409 before dispatch or expiry, preventing a frozen retry from moving to a replacement cart. Requests without this header retain their existing contract.

The storefront persists a bounded recovery journal containing only the original cart/idempotency key, variant, quantity, version and hashed session scope, never cookies, tokens or raw identity. Reload restoration requires the same authorized cart and scope. Recovery is explicit: check the receipt, then read the current cart; retry sends the original body/key/header, never an automatically regenerated command. An applied receipt followed by a failed cart read permits only another read. Pending ADDs block cart mutations and checkout; a partial reorder stops before unsent lines. The PostgreSQL contract is unchanged and its recovery remains tab-local without a Cloudflare receipt request.

## Checkout acceptance, shipping and contractual orders

`0006_checkout_orders.sql` adds the server-side shipping configuration (zones for warehouse pickup, own delivery by postal prefix and peninsular parcel fallback, with parcel/pallet/ADR rate profiles), expirable shipping-option snapshots, orders with immutable line/address snapshots, the persistent `checkout_attempts` saga and append-only `order_events`/`checkout_commands` ledgers protected by triggers. ADR is deliberately ineligible until regulatory data exists. Quote expiry arrives here too without touching 0005.

`0028_order_contact_contract.sql` extends the immutable order/address snapshot with the buyer's contact name/phone, company and fiscal identifier plus shipping/billing company, tax ID and delivery instructions. The Worker validates Spanish fiscal IDs and includes these fields in checkout idempotency; authorized order lookup can return them, while a bad order token still returns nothing. Historical orders keep nullable details. The Nuxt checkout has not yet been switched to this D1 path; a secure HttpOnly-cookie adapter and explicit privacy-consent flow are still required before cutover.

The checkout flow enters through the same per-cart `CartCoordinator`: `shipping-options` and `checkout` commands serialise against mutations and quotes, while inventory mutations are sent through the global `InventoryCoordinator`. Before any side effect the service revalidates quote ownership/freshness, cart version/state, effective prices, price-version ids, publication, availability/backorder and the selected shipping option against live data; any drift returns `revalidation_required` plus fresh server-side snapshots with zero effects. Shipping rates are stored net and tax/gross use the shared integer money rounding; order totals include both goods and shipping and are constrained to `net + tax = gross` in D1.

The saga models its failure windows explicitly on D1 (`checkout_attempts`): the immutable reservation plan is persisted first, reservation uses deterministic derived keys and a real TTL, and order creation, attempt completion, response ledger and cart conversion commit atomically. Interrupted attempts recover on retry from persisted state alone; only genuinely expired/abandoned ones are compensated idempotently, and an order-linked attempt can never be swept. Guest order lookup accepts the access token returned at creation/replay; only its SHA-256 is stored, and unknown-id and wrong-token answer identically with `no-store`.

The isolated audit (`npm run d1:audit:checkout:isolated`) applies migrations and every seed from scratch into an ephemeral D1 directory that is always deleted afterwards.

## Media migration boundary

`shared/media-envelope.ts` and `shared/media-dimensions.ts` provide Node-independent upload size/MIME checks, safe filenames and PNG/JPEG header dimensions. The existing Node upload utility re-exports these functions. Dimension inspection respects sliced byte-array boundaries and rejects zero dimensions, malformed PNG IHDR headers and JPEG frame lengths/component counts that would read outside their segment.

`shared/media-metadata.ts` removes common PNG metadata chunks and JPEG APP1/APP13 segments before the first scan using owned `Uint8Array` output. The legacy utility wraps this output in `Buffer` to preserve its public contract. Missing PNG termination and truncated pre-scan JPEG segments now fail instead of returning partially normalized output. The focused suite has 13 tests covering byte-array offsets, non-aliasing, metadata removal and malformed envelopes.

These helpers are not a complete decoder or security approval. JPEG scan data and PDF contents are preserved; this is not comprehensive metadata sanitization. Antivirus transport in the Node utility is not a Cloudflare scanner integration. Governed publication and responsive delivery are described in the newer migration-0033 checkpoint above; MED-007/MED-008 still lack full operational/deployed acceptance.

`0012_media_quarantine.sql` and `workers/catalog/media.ts` add an internal original-upload service. It requires an authenticated administrative actor supplied by its caller and a private R2 bucket (no public domain or `r2.dev` access). An actor-scoped idempotency key binds the original SHA-256 and immutable provenance/alt fields. D1 records the intent before a conditional R2 put, and only records a quarantine receipt after verifying the server object checksum. Interrupted uploads remain staging and can resume with the same payload; changed payloads conflict. No cleanup is attempted after an ambiguous failure. The service retains original bytes for analysis, limits uploads to 10 MiB and raster headers to 600–12000 pixels per dimension, and never grants rights or scan approval. These limits do not establish that the file decodes safely.

Eleven focused tests use migrated SQLite and an R2 test double to cover persistence, conflicts, actor isolation, failure recovery, checksum mismatch, reconciliation fairness and completion races. `npm run d1:audit:media:isolated` additionally runs the service inside workerd with real local D1/R2 bindings: migrations from empty state, original upload and checksum verification, replay/conflict, R2-success/D1-failure recovery without object changes (both client retry and background reconciliation), and 12 concurrent requests converging on one receipt/object. The privileged fixture in `tests/support/media-runtime.ts` is audit-only and must never enter a deployable bundle. Its temporary database/bucket are disposed and removed in `finally`; no remote binding is configured.

`0013_media_storage_reconciliation.sql` adds storage-check evidence and a sweep index. The canary scheduled handler inspects up to 25 staging attempts older than one minute, prioritising never/least-recently checked attempts. A matching R2 checksum closes only the storage receipt; missing, mismatched and unavailable objects stay staging with a recorded outcome. Concurrent client completion is respected, and no sweep deletes or overwrites originals. Retention and genuine scanner integration remain pending; immutable originals are not moved into a public prefix by migration 0033. No production bucket or existing media was changed.

`POST /api/admin/media` is wired through `workers/media/http.ts` but disabled by default (`MEDIA_ADMIN_ENABLED=false`). When enabled it requires a valid sealed cookie, a current D1 `catalog.write` grant, MFA, a session no older than one hour, and an exact `Origin` match to configured `MEDIA_ADMIN_ORIGIN`; cross-site Fetch Metadata is rejected. Multipart bodies are counted while reading (10 MiB plus 64 KiB overhead), with a separate 10 MiB file cap. Existing fields `file`, `ownerName`, `license`, `authorizedAt`, `altText` and the pending response contract are preserved; optional `source` is recorded as an unverified reference. Rights approval refuses declarations without a complete date/reference/owner/license. The authorization date is retained in a structured uploader declaration, never fabricated as verified evidence. Duplicate/unexpected fields are rejected and the actor comes only from authorization. Clients can supply `Idempotency-Key` for replay; without it, each upload is a new command as in the existing form. All handled responses are no-store and never report approval. Listing, separate rights review, explicit publication and withdrawal are now implemented by `workers/media/governance-http.ts`, described in the migration-0033 checkpoint; no flag is enabled by that implementation.

`0015_identity_rate_limits.sql` and `workers/auth/identity-quota.ts` enforce the existing `admin-media-upload` policy (20 requests/hour), now keyed by authenticated identity rather than IP. The HTTP handler checks it after authorization/CSRF and before reading the body. One D1 UPSERT atomically increments or resets the window; denied counters saturate, and each identity/scope reuses its row rather than accumulating expired windows. Replays and invalid upload attempts also consume quota. Responses include quota headers on success and `429`; denial includes `Retry-After`, and unavailable quota storage returns `503` without accepting the upload. No raw IP or email is stored. This is not protection against anonymous traffic before cookie verification.

`workers/auth/edge-limit.ts` adds a pre-cookie filter via the native `ADMIN_EDGE_LIMIT` binding (300/minute). It uses HMAC-SHA256 of a canonical `CF-Connecting-IP` with the separate `AUTH_RATE_LIMIT_PEPPER` secret; no raw IP or derived key is logged. Missing/invalid addresses, secret or limiter failures return a private `503`; denial returns `429` before cookie verification, D1 access or body reads. There is no `X-Forwarded-For` fallback. This requires direct Cloudflare ingress with platform-controlled headers; arbitrary service callers or other Worker routes must not be trusted to supply that header. NAT clients share the preliminary limit. Native counters are approximate and per-location, not a replacement for the exact authenticated D1 quota ([Cloudflare reference](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).

Do not enable the flag remotely until D1 login/session provisioning, the ingress/header trust boundary and private-bucket configuration are verified. Reserve an account-unique limiter namespace before replacing local placeholder `900001`. `NUXT_SESSION_PASSWORD` and `AUTH_RATE_LIMIT_PEPPER` are required secrets without Worker fallbacks. Unit tests cover HMAC privacy, equivalent IPv6 keys, forwarded-header independence and pre-auth denial; the local workerd audit exercises native binding allowance/denial plus the multipart route, CSRF, actor spoofing, duplicate fields, oversize rejection, replay, a 25-request concurrent quota burst and a simulated quota outage. No production or shared Nuxt UI changes are made.

### D1 MFA completion (internal, not a public login)

Migration `0016_mfa_challenges.sql` and `workers/auth/mfa-completion.ts` add password-challenge completion using the existing TOTP and encrypted-secret format. A single D1 batch consumes the challenge, advances the TOTP step or removes the recovery hash, and inserts the verified session. Compare-and-swap against the current MFA state prevents reuse across different challenges; a named CHECK aborts a lost race. Challenges expire, allow at most six failed attempts, and are pinned to the current identity session version. Disabled identities and unverified MFA cannot complete them.

Twelve SQLite tests cover replay, invalidation, bounded attempts, forced stale reads, session-write rollback and password-gated login. The isolated workerd audit additionally verifies native scrypt login only issues an MFA challenge, then issues eight concurrent requests for one TOTP and eight for one recovery code, asserting exactly one session per code against local D1. These are synthetic fixtures only. No production identities or secrets are provisioned by this migration.

`workers/auth/login.ts` verifies the existing password hash, executes a dummy scrypt for absent accounts, and rechecks the password/session version and MFA requirement inside the statement that creates a fresh session or five-minute challenge. It does not issue privileged access or bypass MFA. `session-cookie.ts` can seal persisted session claims in the installed h3 format, with a random envelope ID and host-only Secure/HttpOnly/SameSite=Lax cookie bounded by both configuration and D1 expiry. Logout revokes the signed session in D1 before returning a clearing cookie; outages propagate. Issuance and revocation have SQLite tests, including independent h3 decoding.

### Authentication HTTP canary (disabled by default)

`AUTH_ENABLED=false` gates POST `/api/auth/login`, `/api/auth/mfa/complete` and `/api/auth/logout`. Enabling requires a canonical HTTPS `AUTH_ORIGIN`, session secret, `AUTH_TOKEN_PEPPER`, `AUTH_ENCRYPTION_KEY`, and the `AUTH_EDGE_LIMIT` binding (30/minute, local placeholder namespace `900003`; reserve an account-unique namespace before deployment). Secrets have no development fallback. Origin is checked against configuration, never forwarded headers. Every response is no-store; JSON bodies are streamed with a 4 KiB cap and strict field schemas. Errors expose stable codes, never credential/SQL details.

After the approximate native edge limit, migration `0017` supplies exact D1 windows using the existing sensitive policies: login 5/900 seconds per trusted IP and separately per normalized email, MFA 6/300 seconds per trusted IP in addition to each challenge's attempt cap. Only scoped HMAC subjects are persisted; denied counters saturate. Quota outages fail closed. The existing scheduled handler deletes at most 500 expired quota rows per invocation when auth is enabled. Large-scale retention/throughput and distributed attack testing remain operational gates.

SQLite tests exercise login/MFA/logout, CSRF, unknown-account errors, body bounds, spoofed fields, outages, window reset and pruning. The isolated workerd audit runs password login, cookie issuance, logout and a concurrent attempt burst against real local D1 and native edge bindings. Success returns `{authenticated:true}` (or `{mfaRequired,challenge,expiresAt}`).

GET `/api/_auth/session` implements the installed `useUserSession().fetch()` contract: `{user,sessionId,sessionVersion}` or `{}` for an absent/invalid/revoked session. Roles, email verification and MFA are projected from live D1 state, never copied from cookie data. Role expiry/future grants are filtered, and display role priority is shared with the existing Nuxt backend. GET does not extend session expiry. DELETE on the same path supports `useUserSession().clear()` with origin/CSRF enforcement and D1 revocation. Cross-site reads are rejected; same-origin GET need not carry an Origin header. Both methods remain behind the disabled auth flag and the native ingress limiter. Local workerd checks the refresh projection before and after logout; SQLite tests additionally change roles and disable identities while retaining the same cookie.

Migrations `0018_customer_profiles.sql` and `0019_company_review_events.sql` add one customer profile per identity and at most one company per customer, without locations or delegated buyer roles. The `/_auth/session` projection now reads name, phone and legal name from the currently linked active customer. GET `/api/account` returns the existing account UI profile shape, including tax ID and review status, only after a live D1 session lookup. PUT `/api/account/profile` updates name and phone with a single owner-scoped statement; stale or revoked sessions write nothing. PUT `/api/account/company` requires a verified email, current password and MFA when enrolled, plus the existing five-per-hour identity quota. A fiscal change returns the company to pending review. Its company write and redacted append-only audit event share a D1 batch. Duplicate fiscal identities are rejected. SQLite tests cover two-customer isolation, account update, anonymization, password denial, review status and a revocation race; the isolated workerd audit exercises the same account routes with a synthetic company.

`0020_customer_addresses.sql` adds a personal address book for the existing `/cuenta/direcciones` UI; it does not add customer sites or warehouses. GET/POST `/api/account/addresses` and PUT/DELETE `/api/account/addresses/:id` use the live D1 session in each owner-scoped SQL statement, validate the existing country/postcode/tax/phone contract, cap each customer at 50 entries, and expose no other customer's addresses. A single default is maintained atomically by triggers and a unique index; append-only audit events omit recipient, street, phone and tax ID. Deleting an address does not affect immutable order address snapshots. SQLite adversarial tests and the isolated workerd audit exercise this API; saved-address selection in Cloudflare checkout is still pending.

`0021_account_security.sql` adds a bounded `last_seen_at` heartbeat and append-only, redacted password/session events. GET `/api/account/sessions` lists only current-version live sessions owned by the D1-authenticated customer; DELETE `/api/account/sessions/:id` revokes another device but requires the normal logout route for the current one. PUT `/api/account/password` requires the current password, enrolled MFA, the five-per-15-minute identity quota, and a strong new password. One guarded D1 batch changes the hash/version, retains and reissues only the current session cookie, and revokes the rest; a lost race rolls the whole batch back. No credential, token, IP or user agent enters the security event log. SQLite tests cover owner isolation, rotation, rollback, stale cookies, MFA denial and rate limiting; the isolated workerd audit exercises session listing/revocation and rotation against real local D1. Security email notices are still pending because the transactional email provider has not been ported.

`0022_mfa_enrollments.sql` adds a ten-minute pending TOTP enrollment bound to the issuing session/version. POST `/api/auth/mfa/setup` requires a live session, verified email, current password and the six-per-five-minute identity quota. The one-time response contains the authenticator URI, manual key and eight recovery codes; D1 stores only the encrypted secret and HMAC recovery hashes. POST `/api/auth/mfa/verify-setup` requires the matching setup ID and TOTP code, atomically activates the factor, elevates only the current session, revokes the others and removes the pending secret. A verified factor cannot be overwritten by this flow. The scheduled handler removes expired pending secrets in bounded batches. The account security UI asks for the current password and includes the setup ID in confirmation; SQLite and isolated workerd/D1 tests exercise the flow.

Registration/reset, email verification workflows, MFA replacement/recovery/revocation and idle-session policy remain pending. Full Nuxt SSR/bundle routing is locally validated in the checkpoint above. Company review by staff and tax-ID checks beyond the existing country format rules remain pending; a submitted company is not approved for special pricing. Do not enable production authentication until these integrations and the deployed ingress trust boundary are verified.

## Identity authorization migration boundary

`0014_identity_authorization.sql` introduces the D1 identity, role, permission, grant and revocable session tables needed by the existing authorization contract. It provisions no users, passwords, administrative accounts or default grants. Customer/company profile relations arrive in `0018`; MFA completion state is in `0016`; enrollment and identity-token workflows are still pending.

`workers/catalog/authorization.ts` authorizes **already verified sealed-session claims** against current D1 state. It is not a cookie verifier and must never receive claims taken directly from a request body or unsigned header. A single query checks identity/session binding, identity status, revocation, version, time bounds, verified email, session MFA and current permission grants (including grant time/expiry). MFA is required by default with no local-environment bypass. Unknown sessions and stale identity bindings share the same denial; database outages propagate instead of masquerading as denials. Roles cached in the cookie cannot override current grants. Resource ownership and company isolation require additional checks by the resource handler.

`workers/auth/session-cookie.ts` verifies the `neteco-session` cookie using the same iron-webcrypto v1 envelope as installed Nuxt/h3. Version 1.2.1 is now a direct pinned dependency (already present transitively), without upgrading the session protocol. Input size, duplicate cookies, age and claim shape are checked; unsigned headers/query/body values are not accepted. Missing/weak configuration fails closed, with no local fallback password. `workers/auth/authorize.ts` composes cookie verification with D1 permission/MFA checks; cached cookie roles or MFA flags never grant access.

The 24 focused SQLite tests cover authorization, the cookie-to-D1 boundary and identity quotas, and 11 cookie tests include an envelope generated by the installed h3 implementation, tampering, wrong secrets and malformed claims. The isolated media audit also exercises an h3-issued cookie inside workerd against actual local D1: successful authorization, absent/tampered cookies, grant removal, missing MFA and session revocation. A random per-run signing secret and synthetic identities exist only in the temporary audit environment; no credentials or identities are provisioned remotely.

`workers/auth/password.ts` supports the installed Nuxt/Adonis scrypt PHC format through native `node:crypto` under `nodejs_compat`. New hashes retain the installed defaults (`N=16384`, `r=8`, `p=1`, 16-byte random salt, 64-byte key, 32 MiB maximum memory). Verification checks canonical base64, lengths, duplicate parameters, power-of-two cost and bounded resource use before calling scrypt, then compares with `timingSafeEqual`. Accepted legacy parameters are bounded (`N<=32768`, `r<=32`, `p<=4`, within the memory estimate); unsupported imported hashes require review, not an automatic password reset or cost reduction. Four unit tests and the workerd audit verify compatibility in both directions with the installed Adonis driver, including UTF-8 passwords. These helpers do not establish a password-strength policy or provide a complete anti-enumeration login flow.

The local canary now implements login, cookie issuance, session revocation, account profile, password change and initial TOTP enrollment behind `AUTH_ENABLED=false`. Reset/verification tokens, MFA replacement/recovery/revocation and administrative provisioning remain pending. Mutating handlers must additionally enforce CSRF and object/organization ownership.

## Bundle boundary

`scripts/audit-worker-bundle.ts` rejects Node/server dependencies that cannot enter the Cloudflare runtime: PostgreSQL, Redis, SMTP, Sharp, native binaries, filesystem and raw network imports. The Nuxt Worker is not eligible for deployment until its complete server import graph passes the same gate.

The migration order is: platform contracts, D1/catalog reads, D1 writes and transactions, Durable Object coordination, Queues/Workflows, R2/media, transactional email, and finally the complete Nuxt Worker bundle. Remote resource identifiers and secrets are not represented by local placeholder identifiers and must be provisioned per environment before any remote deployment.
