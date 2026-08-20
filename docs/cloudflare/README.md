# Cloudflare migration lane

The Cloudflare lane is intentionally isolated from the current Nuxt/Node production bundle while the platform adapters and D1 schema are migrated. This keeps the existing verification path green without presenting a PostgreSQL-backed Worker as a finished Cloudflare deployment.

## Canary contract

`wrangler.canary.jsonc` is the source of truth for the local canary. It declares the minimum production-platform contract:

- D1 (`DB`) for authoritative relational data.
- Durable Objects (`COORDINATOR`) for strict coordination.
- KV (`CACHE`) only for derived, eventually consistent data.
- R2 (`MEDIA`) for objects and media.
- Queues (`ASYNC_JOBS`) with retries and a dead-letter queue.

The canary exposes only `GET /health`. Its probe executes `SELECT 1` in D1 and validates the shape of the other bindings without writing to them. It never imports the Nuxt application or its Node-only dependencies.

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

## Bundle boundary

`scripts/audit-worker-bundle.ts` rejects Node/server dependencies that cannot enter the Cloudflare runtime: PostgreSQL, Redis, SMTP, Sharp, native binaries, filesystem and raw network imports. The Nuxt Worker is not eligible for deployment until its complete server import graph passes the same gate.

The migration order is: platform contracts, D1/catalog reads, D1 writes and transactions, Durable Object coordination, Queues/Workflows, R2/media, transactional email, and finally the complete Nuxt Worker bundle. Remote resource identifiers and secrets are not represented by local placeholder identifiers and must be provisioned per environment before any remote deployment.
