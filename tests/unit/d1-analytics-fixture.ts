import { readFile } from 'node:fs/promises'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { refundsCreditFixture } from './d1-refunds-credit-fixture'
import { analyticsMeasurementPolicySchema } from '../../shared/analytics-measurement'
import type { AnalyticsMeasurementDependencies } from '../../workers/analytics/authority'
import { PersistentLocalRefundProvider } from '../../workers/refunds/local-provider'
import { dispatchD1Refunds } from '../../workers/refunds/operations'

export { CLAIMS, BUYER_CLAIMS, utc }
export async function analyticsFixture(options: { commerce?: boolean; refund?: boolean; promotional?: boolean } = {}) {
  const world = options.commerce ? await refundsCreditFixture() : await returnsFixture()
  if (!world.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='analytics_client_events'").get())
    world.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0052_analytics_measurement.sql', import.meta.url), 'utf8')
    )
  if (options.promotional !== false)
    world.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0081_promotional_analytics.sql', import.meta.url), 'utf8')
    )
  const batch = world.database.batch.bind(world.database)
  let tail = Promise.resolve()
  world.database = {
    ...world.database,
    batch: (statements) => {
      const result = tail.then(() => batch(statements))
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
  }
  if (options.refund && 'completed' in world) await world.completed()
  let now = utc(1000)
  const deps: AnalyticsMeasurementDependencies = {
    database: world.database,
    origin: 'https://analytics-fixture.neteco.test',
    environment: 'local',
    enabled: true,
    policy: analyticsMeasurementPolicySchema.parse({
      reference: 'synthetic-local-measurement',
      version: 'fixture-v1',
      purpose: 'first_party_measurement',
      consentVersion: 'v1',
      retentionDays: 30,
      environment: 'local',
      approvedAt: utc(-3600000)
    }),
    sessionPepper: crypto.getRandomValues(new Uint8Array(32)),
    now: () => now
  }
  const range = () => ({ from: utc(-3600000), to: utc(3600000), page: 1, perPage: 20 })
  const financialDigest = () =>
    JSON.stringify(
      [
        'orders',
        'order_lines',
        'payment_intents',
        'payment_events',
        'order_payment_states',
        'payment_fulfilment_claims',
        'payment_recovery_jobs',
        'inventory_balances',
        'inventory_movements',
        'refund_contracts',
        'refund_work',
        'refund_receipts',
        'fiscal_invoice_intents',
        'fiscal_issuance_work',
        'fiscal_provider_receipts',
        'fiscal_documents'
      ].map((table) => ({ table, rows: world.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() }))
    )
  async function refundScenario(stage: 'planned' | 'confirmed' | 'ambiguous') {
    if (!('plan' in world)) throw new Error('analytics_fixture_requires_commerce')
    const planned = await world.plan()
    if (stage === 'planned') return planned
    await world.confirm(planned.id, planned.generation, planned.contractFingerprint)
    if (stage === 'ambiguous') {
      const provider = new PersistentLocalRefundProvider(world.database, world.refundProvider.mappingFingerprint, {
        responseLost: true
      })
      await dispatchD1Refunds(world.database, provider, {
        now: utc(),
        appEnvironment: 'local',
        policyId: world.policy.id,
        enabled: true,
        localValidationEnabled: true
      })
    }
    return planned
  }
  return {
    ...world,
    deps,
    range,
    financialDigest,
    refundScenario,
    setNow: (value: string) => {
      now = value
    }
  }
}
export const ANALYTICS_CONSENT = JSON.stringify({ version: 'v1', analytics: true })
export function pageEvent(properties: { path: string } = { path: '/catalogo' }) {
  return { eventId: crypto.randomUUID(), taxonomyVersion: 'v1', name: 'page_view', properties, occurredAt: utc() }
}
