import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const reportPath = resolve('INFORME_MAESTRO_NETECO_PRODUCCION.md')
const outputPath = resolve('docs/production/requirements-traceability.csv')
const validPhases = new Set(['MVP', 'Alpha', 'Beta', 'Fase 1', 'Fase 2', 'Fase 3', 'Fase 4', 'Fase 5', 'Fase 6'])
const expectedPhases: Record<string, number> = {
  MVP: 65,
  Alpha: 389,
  Beta: 57,
  'Fase 1': 49,
  'Fase 2': 24,
  'Fase 3': 42,
  'Fase 4': 31,
  'Fase 5': 22,
  'Fase 6': 7
}
const expectedPriorities: Record<string, number> = { P0: 286, P1: 183, P2: 180, P3: 37 }

type Status = 'REPO_EVIDENCE' | 'PARTIAL_EXTERNAL' | 'MISSING' | 'NOT_VERIFIED' | 'ROADMAP_NOT_STARTED'

interface Requirement {
  id: string
  phase: string
  priority: string
  requirement: string
  acceptance: string
  domain: string
}

function ids(specification: string) {
  const result: string[] = []
  for (const token of specification
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const range = token.match(/^([A-Z]+)-(\d+)\.\.(\d+)$/)
    if (!range) {
      result.push(token)
      continue
    }
    const [, prefix, from, to] = range
    for (let value = Number(from); value <= Number(to); value += 1) {
      result.push(`${prefix}-${String(value).padStart(from.length, '0')}`)
    }
  }
  return result
}

const mvpRepoEvidence = ids(
  'CAT-003;PRI-001..002;SEA-001;CHK-001;PAY-001..002;BEP-003..004;ORD-001;INV-002;SHP-001..002;CUS-001..002;ADM-001..002;MED-002;SEO-001..002;DAT-001..002;MKT-001;COM-001..002;SEC-001..003;INT-001..004;TST-001..010;CIC-001..006;CIC-008;OBS-001..002;OBS-004'
)
const mvpExternal = ids('CAT-001..002;BEP-001..002;INV-001;MED-001;PER-001..002;SUP-001;LEG-001..002;OBS-003')
const mvpMissing = ids('CIC-007')

const currentRepoEvidence = new Set(
  ids(
    'CAT-004..006;CAT-008;PRI-002..008;PRI-010..011;SEA-004;PDP-001..002;PDP-003;PDP-006..008;PDP-010..011;CHK-002..010;CHK-014;CHK-017;ADM-001..003;ADM-009..011;ADM-017;MED-007;MED-011;MED-015;SEO-003;SEO-007;SEO-012;SEO-014;PER-004;PER-011;PER-016..017;MKT-002..003;COM-004..008;TST-011..013;TST-015..016'
  )
)
const currentPartialExternal = new Set(
  ids('SEO-015;PER-003;PER-013;PAY-003..017;BEP-005..018;SHP-003..020;LEG-003..034;OBS-005..023;TST-014;TST-017')
)

function csv(value: string | number) {
  const text = String(value).replaceAll('"', '""')
  return `"${text}"`
}

function statusFor(requirement: Requirement): Status {
  if (mvpRepoEvidence.includes(requirement.id)) return 'REPO_EVIDENCE'
  if (mvpExternal.includes(requirement.id)) return 'PARTIAL_EXTERNAL'
  if (mvpMissing.includes(requirement.id)) return 'MISSING'
  if (currentRepoEvidence.has(requirement.id)) return 'REPO_EVIDENCE'
  if (currentPartialExternal.has(requirement.id)) return 'PARTIAL_EXTERNAL'
  if (requirement.phase === 'Alpha') return 'NOT_VERIFIED'
  return 'ROADMAP_NOT_STARTED'
}

function evidenceFor(id: string) {
  const evidence: Record<string, string> = {
    'SEA-001': 'db/migrations/0020_search_relevance.sql; server/api/search.get.ts; server/api/products.get.ts',
    'SEA-004': 'server/utils/search-terms.ts; db/migrations/0020_search_relevance.sql',
    'PDP-003': 'server/api/shipping/product-rates.post.ts; server/services/shipping.ts; app/pages/producto/[slug].vue',
    'PDP-007': 'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue',
    'PDP-008': 'server/api/admin/products/[id]/active.put.ts; server/api/health/ready.get.ts',
    'CHK-002': 'server/services/orders.ts; app/pages/checkout.vue; tests/integration/commerce-transactions.test.ts',
    'CHK-006': 'server/services/shipping.ts; server/services/orders.ts',
    'CHK-009': 'app/pages/checkout.vue; server/domain/money.ts',
    'PRI-004': 'server/services/cart.ts; app/components/ProductCard.vue; app/pages/checkout.vue',
    'PRI-006':
      'db/migrations/0024_price_history_and_schedules.sql; server/services/pricing.ts; app/pages/admin/precios.vue',
    'PRI-008':
      'server/domain/money.ts; server/services/orders.ts; app/pages/producto/[slug].vue; tests/unit/money.test.ts',
    'PRI-011': 'server/services/pricing.ts; server/api/admin/prices.post.ts; app/pages/admin/precios.vue',
    'SEO-003': 'server/routes/sitemap.xml.get.ts; server/routes/sitemaps/',
    'SEO-007': 'app/app.vue; app/pages/producto/[slug].vue',
    'SEO-015': 'server/routes/feeds/google-merchant.xml.get.ts; docs/operations/merchant-feed.md',
    'ADM-009': 'server/utils/content-schema.ts; app/pages/admin/contenido.vue',
    'ADM-010':
      'server/api/admin/content/pages/[id]/preview.post.ts; server/api/admin/content/pages/[id]/publish.post.ts',
    'ADM-011': 'db/migrations/0022_typed_content_cms.sql; server/api/admin/content/pages/[id]/rollback.post.ts',
    'ADM-017':
      'db/migrations/0023_feature_flag_governance.sql; server/api/admin/feature-flags; app/pages/admin/flags.vue',
    'COM-004': 'scripts/outbox-worker.ts; db/migrations/0015_support_and_communications.sql',
    'COM-005':
      'server/api/webhooks/email.post.ts; db/migrations/0025_email_delivery_webhooks.sql; tests/e2e/email-webhook.spec.ts',
    'COM-006':
      'scripts/outbox-worker.ts; scripts/invoice-worker.ts; server/domain/admin-order-status.ts; server/services/invoice-email.ts; tests/unit/invoice-email.test.ts; tests/integration/commerce-transactions.test.ts',
    'COM-007':
      'server/api/orders/[id].get.ts; server/api/orders/[id]/invoice.get.ts; server/api/auth/reset-password.post.ts; server/api/auth/verify-email.post.ts; server/api/account/email-change.post.ts',
    'COM-008':
      'scripts/outbox-worker.ts; server/integrations/email-provider.ts; server/utils/email-base-url.ts; tests/unit/email-provider.test.ts; tests/unit/email-base-url.test.ts; tests/unit/invoice-email.test.ts',
    'TST-006':
      'docs/testing/coverage-policy.json; scripts/audit-coverage-policy.ts; vitest.config.ts; .github/workflows/ci.yml',
    'TST-004':
      'tests/fixtures/deterministic.ts; tests/fixtures/postgres.ts; tests/fixtures/playwright.ts; tests/support/integration-global-setup.ts; tests/support/no-external-network.ts; server/utils/application-clock.ts; scripts/audit-test-determinism.ts; tests/integration/; tests/e2e/',
    'TST-011':
      'tests/e2e/redsys-checkout.spec.ts; scripts/run-e2e.ts; playwright.config.ts; server/api/checkout/pay.post.ts; app/pages/pedido/[id].vue',
    'TST-012':
      'tests/e2e/authenticated-purchase.spec.ts; scripts/run-e2e.ts; server/api/orders/index.post.ts; server/api/auth/logout.post.ts; app/pages/pedido/[id].vue',
    'TST-013':
      'tests/e2e/bank-transfer.spec.ts; scripts/bank-transfer-reconcile.ts; server/services/orders.ts; server/api/admin/operations/bank-transfers/[id]/reconcile.post.ts; scripts/reservation-worker.ts',
    'TST-014':
      'tests/e2e/shipping-fulfillment.spec.ts; server/services/shipping.ts; server/integrations/mock-carrier.ts; app/pages/admin/pedidos.vue; playwright.config.ts',
    'TST-015':
      'tests/e2e/shipping-fulfillment.spec.ts; server/services/orders.ts; server/services/returns.ts; scripts/refund-worker.ts; scripts/credit-note-worker.ts; scripts/outbox-worker.ts; app/pages/devoluciones.vue; app/pages/admin/devoluciones.vue',
    'TST-016':
      'tests/integration/commerce-transactions.test.ts; tests/e2e/bank-transfer.spec.ts; tests/e2e/redsys-checkout.spec.ts; server/services/orders.ts; scripts/reservation-worker.ts; db/migrations/0012_payment_webhook_idempotency.sql',
    'TST-017':
      'tests/fixtures/redsys-official.ts; tests/unit/redsys.test.ts; tests/e2e/redsys-checkout.spec.ts; server/integrations/redsys.ts; server/utils/runtime-config.ts; scripts/redsys-sandbox-contract.ts; docs/testing/strategy.md',
    'MKT-002':
      'db/migrations/0026_newsletter_double_opt_in.sql; server/services/newsletter.ts; tests/integration/newsletter-double-opt-in.test.ts',
    'MKT-003':
      'server/services/newsletter-email.ts; server/api/newsletter/unsubscribe.post.ts; app/pages/newsletter/baja.vue; scripts/outbox-worker.ts',
    'PER-003': 'app/plugins/rum.client.ts; server/api/analytics/events.post.ts',
    'PER-013': 'app/plugins/rum.client.ts; server/api/analytics/events.post.ts; db/migrations/0019_rum_measurement.sql'
  }
  const domainEvidence: Record<string, string> = {
    CAT: 'db/migrations/0001_platform_foundation.sql; server/services/catalog-admin.ts',
    PRI: 'server/domain/money.ts; tests/unit/money.test.ts',
    SEA: 'server/api/search.get.ts; server/api/products.get.ts',
    PDP: 'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue',
    CHK: 'server/services/cart.ts; server/services/orders.ts; app/pages/checkout.vue',
    PAY: 'server/integrations/payment-provider.ts; server/services/orders.ts',
    BEP: 'server/integrations/beply.ts; scripts/invoice-worker.ts',
    ORD: 'server/services/orders.ts; db/migrations/0001_platform_foundation.sql',
    INV: 'server/domain/inventory.ts; server/services/orders.ts',
    SHP: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    CUS: 'server/services/customer.ts; server/api/auth/',
    ADM: 'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/',
    MED: 'server/api/admin/media.post.ts; server/routes/media/[id].get.ts',
    SEO: 'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts',
    DAT: 'db/migrations/; scripts/db-migrate.ts',
    MKT: 'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts',
    COM: 'scripts/outbox-worker.ts; server/integrations/email-provider.ts',
    SEC: 'server/middleware/security.ts; server/utils/auth-session.ts',
    INT: 'db/migrations/0001_platform_foundation.sql; scripts/reconcile.ts',
    TST: 'tests/; vitest.config.ts; playwright.config.ts',
    CIC: '.github/workflows/ci.yml; Dockerfile; package-lock.json',
    OBS: 'server/api/health/; scripts/operational-alerts.ts; docs/operations/'
  }
  return evidence[id] ?? domainEvidence[id.split('-')[0]!] ?? ''
}

const source = await readFile(reportPath, 'utf8')
const requirements: Requirement[] = []
let domain = ''
for (const line of source.slice(0, source.indexOf('## 9.26 ')).split('\n')) {
  const heading = line.match(/^## 9\.\d+ (.+)$/)
  if (heading) domain = heading[1]!.trim()
  const columns = line
    .split('|')
    .slice(1, -1)
    .map((value) => value.trim())
  if (columns.length !== 5 || !/^[A-Z]{3}-\d{3}$/.test(columns[0]!) || !validPhases.has(columns[1]!)) continue
  requirements.push({
    id: columns[0]!,
    phase: columns[1]!,
    priority: columns[2]!,
    requirement: columns[3]!,
    acceptance: columns[4]!,
    domain
  })
}

const failures: string[] = []
if (requirements.length !== 686) failures.push(`expected 686 requirements, found ${requirements.length}`)
const duplicated = requirements.filter(
  (item, index) => requirements.findIndex((candidate) => candidate.id === item.id) !== index
)
if (duplicated.length) failures.push(`duplicated IDs: ${duplicated.map((item) => item.id).join(', ')}`)
for (const [phase, expected] of Object.entries(expectedPhases)) {
  const actual = requirements.filter((requirement) => requirement.phase === phase).length
  if (actual !== expected) failures.push(`${phase}: expected ${expected}, found ${actual}`)
}
for (const [priority, expected] of Object.entries(expectedPriorities)) {
  const actual = requirements.filter((requirement) => requirement.priority === priority).length
  if (actual !== expected) failures.push(`${priority}: expected ${expected}, found ${actual}`)
}
for (const id of [...mvpRepoEvidence, ...mvpExternal, ...mvpMissing]) {
  if (!requirements.some((requirement) => requirement.id === id)) failures.push(`unknown classified ID: ${id}`)
}
if (failures.length) throw new Error(`Master requirement audit failed:\n- ${failures.join('\n- ')}`)

const header = [
  'id',
  'phase_min',
  'domain',
  'priority',
  'requirement',
  'acceptance',
  'status',
  'implementation_refs',
  'operational_evidence',
  'external_owner',
  'last_verified',
  'notes'
]
const rows = requirements.map((requirement) => {
  const status = statusFor(requirement)
  const operationalEvidence = status === 'PARTIAL_EXTERNAL' ? 'Required before phase acceptance' : ''
  const externalOwner = status === 'PARTIAL_EXTERNAL' ? 'Business/Operations/Legal/Provider (assign explicitly)' : ''
  const notes =
    status === 'REPO_EVIDENCE'
      ? 'Repository evidence is not production acceptance; execute the stated criterion and retain evidence.'
      : status === 'NOT_VERIFIED'
        ? 'No pass claim: inspect every acceptance atom before changing this status.'
        : status === 'ROADMAP_NOT_STARTED'
          ? 'Minimum phase is after Alpha; intentionally not claimed by the current production-candidate scope.'
          : status === 'MISSING'
            ? 'Known repository gap.'
            : 'Provider, contract, real data, approval or operational exercise remains outstanding.'
  return [
    requirement.id,
    requirement.phase,
    requirement.domain,
    requirement.priority,
    requirement.requirement,
    requirement.acceptance,
    status,
    evidenceFor(requirement.id),
    operationalEvidence,
    externalOwner,
    '2026-08-13',
    notes
  ]
    .map(csv)
    .join(',')
})

const generated = `${header.map(csv).join(',')}\n${rows.join('\n')}\n`

if (process.argv.includes('--write')) {
  await mkdir(resolve('docs/production'), { recursive: true })
  await writeFile(outputPath, generated, 'utf8')
} else {
  const existing = await readFile(outputPath, 'utf8').catch(() => '')
  if (existing !== generated) {
    throw new Error('Requirements traceability is stale; run npm run requirements:audit -- --write')
  }
}

const counts = requirements.reduce<Record<Status, number>>(
  (summary, requirement) => {
    summary[statusFor(requirement)] += 1
    return summary
  },
  { REPO_EVIDENCE: 0, PARTIAL_EXTERNAL: 0, MISSING: 0, NOT_VERIFIED: 0, ROADMAP_NOT_STARTED: 0 }
)
process.stdout.write(
  `requirements=686 ${Object.entries(counts)
    .map(([status, count]) => `${status}=${count}`)
    .join(' ')}${process.argv.includes('--write') ? ` output=${outputPath}` : ''}\n`
)
