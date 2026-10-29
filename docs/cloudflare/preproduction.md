# Neteco preproduction

Historical provisioning checkpoint: 2026-09-30. The D1 and R2 resources below were
subsequently reused by the public synthetic demo recorded on 2026-10-03 in
[README.md](README.md#public-isolated-worker-demo-2026-10-03). This document does
not certify their current remote state or production readiness.

## Isolated resources

The 2026-09-30 inventory recorded an initially empty D1 `neteco-preprod` (EU), KV
`neteco-preprod-cache`, R2 `neteco-preprod-media` (EU), Queue
`neteco-preprod-jobs` and dead-letter Queue `neteco-preprod-jobs-dlq`.
The existing `neteco-landing`, production DNS and Beply have not been changed.
No remote migrations, seed, Worker upload or traffic cutover were performed at
that initial checkpoint. The later demo applied migrations and populated this
same D1 and R2 with synthetic data and artwork; they must not be described as an
empty preproduction environment now. Do not adopt, reset, recreate or delete
these resources as clean infrastructure without a fresh authorized inventory,
ownership/data review and a preservation/migration plan. No remote inspection or
change was performed for this documentation correction.

`scripts/cloudflare-preprod.ts` defaults to read-only inventory. `--generate`
resolves existing resources and writes only the ignored local
`.wrangler/preprod/wrangler.json`; `--apply` additionally creates missing exact-name
resources. Neither mode deploys or deletes anything. Supply Cloudflare credentials
through the environment or `--credentials-file` outside Git. Never print or commit
tokens or generated configuration. Do not upload the generated config as an artifact.

The generated Worker is `neteco-shop-preprod`, with no routes, no workers.dev and
no preview URLs. Authentication, media administration, payments, newsletter and
transactional and identity email stay disabled. The full storefront ingress now passes local
workerd validation, but this provisioned API-canary configuration is not the
combined shop configuration. Remote application/schema migration and controlled
acceptance testing remain separate release prerequisites.

## GitHub

The configured repository is `tonomolla6/neteco` (currently public; the upstream
source is private, so publication requires an explicit visibility decision).
Its `preprod` environment permits
only branch `main`. Environment secrets `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` hold an isolated account token, not the general local account
credential. Its expiry is 2027-03-30; permissions are D1/KV/R2/Queues/Workers read
and zone read restricted to neteco.es. It cannot deploy, modify DNS or manage tokens.
Resource-read permissions apply at account scope, not just to individual preprod
resources; the resolver selects only the exact project names. Keep the token in
the protected environment and never expose it to pull-request or untrusted code.
Environment variables record `APP_ENV=preprod`, the intended HTTPS public origin
and `REMOTE_DEPLOY_ENABLED=false` (informational; token permissions enforce no writes).

The local development history has no common ancestor with this repository's
current main branch. The original upstream remains remote `origin`; the owned
repository is remote `neteco`. Do not force-push or overwrite main. Integration
strategy must be resolved before publishing these local changes.

The local workflow `cloudflare-preprod.yml` is manual, read-only and main-only:
resolve resources, typecheck/test, dry-run build, never upload/deploy. It has not
been pushed or run in GitHub. `cloudflare-compat.yml` runs Worker checks alongside
five isolated D1 audits in a declared matrix; no credentials are required for
those local audits. These workflows require the approved self-hosted Oracle
Linux ARM64 runner and retain the unverified-label quarantine fallback; their
configuration is not evidence of an online/approved runner or an executed CI
job. Existing resource gates and production approvals still apply. New IaC
work is local and in progress, not an authorization to adopt/recreate the
demo resources or proof that a clean environment has been provisioned.

## Activation gates

Remote schema migration, approved dataset, secret provisioning, Cloudflare Email
Service sender verification, HTTPS ingress and Nuxt-on-Worker acceptance are still
pending. `EMAIL` only permits `orders@neteco.es`; newsletter uses its own binding.
Both are configured locally but disabled; no real email was sent. The transactional
renderer currently handles only `order.created`, not payment, shipping or campaigns.
Production Beply and Redsys must not be exercised as implicit development tests.

## Local validation and next implementation

The 2026-09-30 checkpoint passed 761 unit tests, five focused operations UI tests,
Nuxt typecheck, standalone Worker typecheck, ESLint, Prettier and diff checks.
The isolated checkout audit used local workerd D1 and a real Durable Object.
The canary dry-run bundle was 656.19 KiB (135.86 KiB gzip), with 324 dependency
entries passing its policy. This is not the full `cloudflare:check` or acceptance
of the complete Nuxt application. Regenerable bundle/map/manifest artifacts were
removed; state and the ignored preprod configuration were retained.

The subsequent local checkpoint implements the isolated Cloudflare-module Nuxt
profile and outer Worker ingress. The full dry-run bundle and original Nitro
source-map graph exclude PostgreSQL, Redis, SMTP and native filesystem/socket
handlers. A real workerd audit passes the D1 storefront, assets, account/admin SSR
and session-revocation scenarios without any outbound requests. See the current
[full storefront checkpoint](README.md#full-storefront-worker-checkpoint-2026-09-30)
and run `npm run cloudflare:shop:check` to regenerate its ephemeral evidence.
The combined shop config is generated under `.wrangler/shop`, not the separate
provisioned preprod resolver config. Neither has been deployed.

The subsequent identity/SEO checkpoint adds D1 registration, verification,
recovery and email change, with a separate disabled-by-default identity email
dispatcher. Robots and paginated sitemaps now read D1, use the configured origin,
and exclude private or unreachable routes. See the
[identity and SEO contract](README.md#identity-and-seo-checkpoint-2026-09-30).
Outstanding legacy link migration, delivery acceptance, key rotation and
retention are explicit release gates, not covered by local fake senders.

The latest local checkpoint adds D1 administrative catalog reads and governed
image/document associations and delivery; see the catalog/media checkpoint in
README.md. Its 28 workerd scenarios use 33 migrations and no outbound requests,
with real offline Images transformations but synthetic scanner/rights fixtures.
Both media flags stay disabled in generated local/preprod configuration.
Genuine scanning, licensed dataset and deployed acceptance remain unresolved.

Next priorities are operational catalog/order mutations, published-data redirects,
feeds and completing the editorial publication UI. Unported routes fail explicitly,
never reach the legacy Node APIs. Controlled provider/deployed acceptance remains
open; no production Beply or Redsys tests are implied by the local runtime passing.

The subsequent configuration/category checkpoint passes 34 local workerd
scenarios with 33 migrations and zero outbound requests. Generators now project
only the reviewed bindings and non-secret variables, reject nested remote
escapes, remove inherited `env.production`/services/build hooks, and keep every
sensitive feature including Bizum disabled. IDs are validated primitive strings;
data-only records prevent inherited/getter/coercion substitutions. Importing the
resolver is inert. No resolver CLI, account API, workflow or deploy was exercised
for this change. The generated local shop configuration uses only placeholder
resources and `remote: false`; the previously provisioned configuration/state
has not been replaced. Future manifest additions require allowlist review.
See [current configuration/category evidence](README.md#configuration-and-category-integration-checkpoint-2026-09-30).
