# Cloudflare migration lane

The Cloudflare lane is intentionally isolated from the current Nuxt/Node production bundle while the platform adapters and D1 schema are migrated. This keeps the existing verification path green without presenting a PostgreSQL-backed Worker as a finished Cloudflare deployment.

## Canary contract

`wrangler.canary.jsonc` is the source of truth for the local canary. It declares the minimum production-platform contract:

- D1 (`DB`) for authoritative relational data.
- Durable Objects (`COORDINATOR`) for strict coordination.
- KV (`CACHE`) only for derived, eventually consistent data.
- R2 (`MEDIA`) for objects and media.
- Queues (`ASYNC_JOBS`) with retries and a dead-letter queue.
- Workflows (`CATALOG_WORKFLOW`) for durable, multi-step jobs.

The canary exposes only `GET /health`. Its probe executes `SELECT 1` in D1 and validates the shape of the other bindings without writing to them. It never imports the Nuxt application or its Node-only dependencies.

The first vertical route, `GET /api/categories`, reads the published category tree from D1 and applies an explicit public cache policy. This slice does not yet promise product detail, inventory, scheduled prices or media documents; those require their own D1/R2 models before traffic can move from the Node runtime.

`GET /api/products` now exercises the D1 product/variant read model with stable pagination, category descendants, safe sort selection, parameterized FTS5 search and gross/net minimum prices. It deliberately omits facets until those models have parity tests; the existing Node endpoint remains authoritative during this canary stage.

## Effective pricing

Governed price history lives in `variant_price_versions` (`db/d1/migrations/0003_variant_price_versions.sql`). Every published variant resolves one deterministic effective price: the latest approved version with `valid_from <= instant` and an open or not-yet-reached `valid_until`, ties broken by `created_at DESC, id DESC`. Variants without any live version fall back to the legacy base price. The evaluation instant is always bound server-side; request input can never select it.

The shared selection logic in `workers/catalog/pricing.ts` is used by both the Worker and `scripts/audit-d1-catalog.ts`. The audit creates an isolated temporary D1, applies every migration and seed, executes active/future/expired/cancelled/tie/boundary/fallback scenarios, and proves that its final canonical data snapshot matches the pre-scenario digest. The temporary D1 is discarded even when an assertion fails.

The canary declares an empty required-secret set, so Wrangler does not expose unrelated application secrets from a local `.env` file. Environment-specific secret names must be declared explicitly when a Worker starts using them; values remain outside Git.

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

## Checkout acceptance, shipping and contractual orders

`0006_checkout_orders.sql` adds the server-side shipping configuration (zones for warehouse pickup, own delivery by postal prefix and peninsular parcel fallback, with parcel/pallet/ADR rate profiles), expirable shipping-option snapshots, orders with immutable line/address snapshots, the persistent `checkout_attempts` saga and append-only `order_events`/`checkout_commands` ledgers protected by triggers. ADR is deliberately ineligible until regulatory data exists. Quote expiry arrives here too without touching 0005.

The checkout flow enters through the same per-cart `CartCoordinator`: `shipping-options` and `checkout` commands serialise against mutations and quotes, while inventory mutations are sent through the global `InventoryCoordinator`. Before any side effect the service revalidates quote ownership/freshness, cart version/state, effective prices, price-version ids, publication, availability/backorder and the selected shipping option against live data; any drift returns `revalidation_required` plus fresh server-side snapshots with zero effects. Shipping rates are stored net and tax/gross use the shared integer money rounding; order totals include both goods and shipping and are constrained to `net + tax = gross` in D1.

The saga models its failure windows explicitly on D1 (`checkout_attempts`): the immutable reservation plan is persisted first, reservation uses deterministic derived keys and a real TTL, and order creation, attempt completion, response ledger and cart conversion commit atomically. Interrupted attempts recover on retry from persisted state alone; only genuinely expired/abandoned ones are compensated idempotently, and an order-linked attempt can never be swept. Guest order lookup accepts the access token returned at creation/replay; only its SHA-256 is stored, and unknown-id and wrong-token answer identically with `no-store`.

The isolated audit (`npm run d1:audit:checkout:isolated`) applies migrations and every seed from scratch into an ephemeral D1 directory that is always deleted afterwards.

## Bundle boundary

`scripts/audit-worker-bundle.ts` rejects Node/server dependencies that cannot enter the Cloudflare runtime: PostgreSQL, Redis, SMTP, Sharp, native binaries, filesystem and raw network imports. The Nuxt Worker is not eligible for deployment until its complete server import graph passes the same gate.

The migration order is: platform contracts, D1/catalog reads, D1 writes and transactions, Durable Object coordination, Queues/Workflows, R2/media, transactional email, and finally the complete Nuxt Worker bundle. Remote resource identifiers and secrets are not represented by local placeholder identifiers and must be provisioned per environment before any remote deployment.
