import { afterEach, beforeEach, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { fulfillmentFixture, CLAIMS, ACTOR, utc } from './d1-fulfillment-fixture'
import { provisionPromotionFixture } from '../support/promotion-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import { previewD1PromotionBasket } from '../../workers/catalog/promotion-basket-preview'
import { promotionBasketPreviewResponseSchema } from '../../shared/promotion-basket-preview'
import type { PromotionRule } from '../../shared/promotions'
import { evaluatePromotion } from '../../workers/catalog/promotions'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const rule: PromotionRule = {
  id: deterministicUuid('basket-preview-rule'),
  version: 1,
  code: 'PREVIEW',
  status: 'paused',
  channel: 'online',
  startsAt: '2020-01-01T00:00:00Z',
  endsAt: null,
  benefit: { kind: 'fixed', grossCents: 101 },
  scope: { kind: 'all' },
  segment: 'all',
  totalLimit: null,
  perCustomerLimit: null,
  volumeMode: 'stack_volume'
}
let sqlite: DatabaseSync
let database: D1Database
const input = () => ({
  lines: [{ variantId: 'v-1-1', quantity: 2 }],
  destination: { city: 'Ontinyent', postalCode: '46870' },
  customerId: null,
  rule
})
beforeEach(async () => {
  const fixture = await fulfillmentFixture()
  sqlite = fixture.sqlite
  database = fixture.database
  sqlite.exec(
    "INSERT OR IGNORE INTO permissions VALUES('catalog.write','catalog','write','Synthetic'); INSERT INTO role_permissions VALUES('operator','catalog.write'); UPDATE variants SET cost_net_cents=250 WHERE id='v-1-1'"
  )
  await provisionPromotionFixture(sqlite, rule, ACTOR)
})
afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})
it('previews real goods/tax/cost and a proposed active rule without activating it or writing a domain row', async () => {
  const changes = sqlite.prepare('SELECT total_changes() n').get()
  const result = promotionBasketPreviewResponseSchema.parse(await previewD1PromotionBasket(database, CLAIMS, input()))
  expect(result).toMatchObject({
    simulation: true,
    ruleEvaluation: 'proposed_active',
    eligible: true,
    totals: { proposed: { grossCents: 899, netCents: 743, costNetCents: 500, marginNetCents: 243, loss: false } },
    shipping: { operationalCostNetCents: null },
    totalMarginNetCents: null
  })
  expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(changes)
})
it('preserves unknown cost instead of zero and distinguishes known zero', async () => {
  sqlite.exec("UPDATE variants SET cost_net_cents=NULL WHERE id='v-1-1'")
  expect((await previewD1PromotionBasket(database, CLAIMS, input())).totals.proposed).toMatchObject({
    costNetCents: null,
    marginNetCents: null,
    loss: null
  })
  sqlite.exec("UPDATE variants SET cost_net_cents=0 WHERE id='v-1-1'")
  expect((await previewD1PromotionBasket(database, CLAIMS, input())).totals.proposed.costNetCents).toBe(0)
})
it('reports a merchandise loss without claiming total shipping profitability', async () => {
  sqlite.exec("UPDATE variants SET cost_net_cents=500 WHERE id='v-1-1'")
  expect((await previewD1PromotionBasket(database, CLAIMS, input())).totals.proposed).toMatchObject({
    marginNetCents: -257,
    loss: true
  })
})
it('requires both current permissions rather than either one', async () => {
  sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
  await expect(previewD1PromotionBasket(database, CLAIMS, input())).rejects.toMatchObject({ code: 'forbidden' })
})
it('rejects missing variants and duplicate request identities instead of dropping lines', async () => {
  await expect(
    previewD1PromotionBasket(database, CLAIMS, { ...input(), lines: [{ variantId: 'missing', quantity: 1 }] })
  ).rejects.toMatchObject({ code: 'variant_not_available' })
  await expect(
    previewD1PromotionBasket(database, CLAIMS, { ...input(), lines: [...input().lines, ...input().lines] })
  ).rejects.toMatchObject({ code: 'invalid_input' })
})
it('retains calendar and authoritative guest segment restrictions in a proposal', async () => {
  const future = { ...input(), rule: { ...rule, startsAt: '2099-01-01T00:00:00Z' } }
  expect((await previewD1PromotionBasket(database, CLAIMS, future)).reason).toBe('not_started')
  expect(
    (await previewD1PromotionBasket(database, CLAIMS, { ...input(), rule: { ...rule, segment: 'registered' } })).reason
  ).toBe('segment_not_eligible')
})
it('rejects an expired session even when a fixed evaluation instant was supplied', async () => {
  sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(-1000), CLAIMS.sessionId)
  await expect(previewD1PromotionBasket(database, CLAIMS, input())).rejects.toMatchObject({ code: 'unauthenticated' })
})
it('does not release private costs when a grant is revoked during the coherent source read', async () => {
  const observed = Object.create(database) as D1Database
  observed.batch = async (statements) => {
    const rows = await database.batch(statements)
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
    return rows
  }
  await expect(previewD1PromotionBasket(observed, CLAIMS, input())).rejects.toMatchObject({ code: 'forbidden' })
})
it('rejects unsupported quantity increments and unsafe aggregate cents', async () => {
  sqlite.exec("UPDATE variants SET minimum_quantity=2,quantity_increment=2 WHERE id='v-1-1'")
  await expect(
    previewD1PromotionBasket(database, CLAIMS, { ...input(), lines: [{ variantId: 'v-1-1', quantity: 3 }] })
  ).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(
    previewD1PromotionBasket(database, CLAIMS, {
      ...input(),
      lines: [{ variantId: 'v-1-1', quantity: Number.MAX_SAFE_INTEGER - 1 }]
    })
  ).rejects.toMatchObject({ code: 'service_unavailable' })
})
it('keeps shipping charges separate and returns stable source digests without domain writes', async () => {
  let batchReads = 0
  const observed = Object.create(database) as D1Database
  observed.batch = async (statements) => {
    batchReads += 1
    expect(statements).toHaveLength(3)
    return database.batch(statements)
  }
  const now = utc()
  const first = await previewD1PromotionBasket(observed, CLAIMS, input(), { now })
  const second = await previewD1PromotionBasket(observed, CLAIMS, input(), { now })
  expect(batchReads).toBe(2)
  expect(second.snapshotHash).toBe(first.snapshotHash)
  expect(first.shipping.options.find((rate) => rate.methodCode === 'own_delivery')).toMatchObject({
    netCents: 500,
    grossCents: 605
  })
  expect(first.totals.proposed.grossCents).toBe(899)
})

async function secondVariant() {
  await provisionPublicationValidityFixture(database, { productIds: ['p-2'], now: utc(-3600000) })
  return {
    ...input(),
    lines: [
      { variantId: 'v-1-1', quantity: 1 },
      { variantId: 'v-2-1', quantity: 1 }
    ]
  }
}

it('prorates an odd cent discount across real mixed VAT lines and conserves every contractual cent', async () => {
  const basket = await secondVariant()
  sqlite.exec(
    "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES('t10','ES-RED-10','Synthetic reduced',1000,'2020-01-01T00:00:00Z'); UPDATE variants SET tax_class_id='t10',cost_net_cents=100 WHERE id='v-2-1'"
  )
  const result = await previewD1PromotionBasket(database, CLAIMS, basket)
  expect(result.lines.map((line) => ({ discount: line.discountGrossCents, ...line.proposed }))).toEqual([
    { discount: 51, netCents: 371, taxCents: 78, grossCents: 449 },
    { discount: 50, netCents: 409, taxCents: 41, grossCents: 450 }
  ])
  expect(result.totals.proposed).toEqual({
    netCents: 780,
    taxCents: 119,
    grossCents: 899,
    costNetCents: 350,
    marginNetCents: 430,
    loss: false
  })
})

it('matches the actual promotion evaluator at both sides of a governed volume boundary for all three combination modes', async () => {
  sqlite
    .prepare(
      `INSERT INTO variant_price_versions(id,variant_id,gross_cents,volume_tiers,valid_from,status,reason,created_at)
    VALUES('preview-tier','v-1-1',500,'[{"minimumQuantity":2,"unitGrossCents":400}]','2020-01-01T00:00:00Z','approved','Synthetic preview tier','2020-01-01T00:00:00Z')`
    )
    .run()
  for (const volumeMode of ['stack_volume', 'exclude_volume', 'best_of_volume'] as const) {
    for (const quantity of [1, 2]) {
      const now = utc()
      const proposedRule = { ...rule, volumeMode }
      const expected = evaluatePromotion(
        { ...proposedRule, status: 'active' },
        {
          now,
          channel: 'online',
          customerId: null,
          companyApproved: false,
          redemptions: { total: 0, customer: 0 },
          lines: [
            {
              lineIndex: 0,
              variantId: 'v-1-1',
              productId: 'p-1',
              categoryId: 'c1',
              sku: 'SKU-1-1',
              quantity,
              baseUnitGrossCents: 500,
              volumeUnitGrossCents: quantity < 2 ? 500 : 400,
              taxRateBasisPoints: 2100
            }
          ]
        }
      )
      const result = await previewD1PromotionBasket(
        database,
        CLAIMS,
        { ...input(), lines: [{ variantId: 'v-1-1', quantity }], rule: proposedRule },
        { now }
      )
      expect(result).toMatchObject({
        eligible: expected.eligible,
        reason: expected.reason,
        totals: {
          base: { grossCents: quantity * 500 },
          volume: { grossCents: quantity * (quantity < 2 ? 500 : 400) },
          proposed: {
            netCents: expected.totals.netCents,
            taxCents: expected.totals.taxCents,
            grossCents: expected.totals.grossCents
          }
        }
      })
      expect(result.lines[0]?.priceVersionId).toBe('preview-tier')
    }
  }
})

it('does not turn a partially unknown basket cost into zero while retaining distinct known line costs', async () => {
  const basket = await secondVariant()
  sqlite.exec(
    "UPDATE variants SET cost_net_cents=0 WHERE id='v-1-1'; UPDATE variants SET cost_net_cents=NULL WHERE id='v-2-1'"
  )
  const unknown = await previewD1PromotionBasket(database, CLAIMS, basket)
  expect(unknown.lines.map((line) => line.costNetCents)).toEqual([0, null])
  expect(unknown.totals.proposed).toMatchObject({ costNetCents: null, marginNetCents: null, loss: null })
  sqlite.exec("UPDATE variants SET cost_net_cents=17 WHERE id='v-2-1'")
  const known = await previewD1PromotionBasket(database, CLAIMS, basket)
  expect(known.lines.map((line) => line.costNetCents)).toEqual([0, 17])
  expect(known.totals.proposed.costNetCents).toBe(17)
  expect(known.totals.proposed.marginNetCents).toBe(known.totals.proposed.netCents - 17)
})

it('preserves canonical ADR exclusion, pallet eligibility and remote postal restrictions without carrier cost claims', async () => {
  sqlite.exec(`INSERT INTO shipping_profiles(id,code,name,kind) VALUES('preview-adr','preview-adr','Synthetic ADR','adr');
    INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('preview-parcel','preview-parcel','Synthetic parcel','parcel_peninsular','["peninsular"]',1,'2020-01-01T00:00:00Z');
    INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at)
      VALUES('preview-parcel-standard','preview-parcel','parcel','parcel',300,2100,1,2,1,1,'2020-01-01T00:00:00Z'),
      ('preview-parcel-pallet','preview-parcel','parcel','pallet',900,2100,2,3,1,1,'2020-01-01T00:00:00Z');
    UPDATE variants SET shipping_profile_id='preview-adr' WHERE id='v-1-1';`)
  expect((await previewD1PromotionBasket(database, CLAIMS, input())).shipping.options).toEqual([])
  sqlite.exec("UPDATE variants SET shipping_profile_id='sp1',weight_grams=11000 WHERE id='v-1-1'")
  const pallet = await previewD1PromotionBasket(database, CLAIMS, input())
  expect(pallet.shipping.options.find((option) => option.methodCode === 'parcel')).toMatchObject({
    serviceProfile: 'pallet',
    netCents: 900,
    grossCents: 1089
  })
  expect(pallet.shipping.operationalCostNetCents).toBeNull()
  const remote = await previewD1PromotionBasket(database, CLAIMS, {
    ...input(),
    destination: { city: 'Synthetic island', postalCode: '35001' }
  })
  expect(remote.shipping.options.map((option) => option.methodCode)).toEqual(['pickup'])
})

it('never exposes private source costs through a real public cart quote after canonical read extraction', async () => {
  const now = utc()
  const cart = await createCart(database, { correlationId: 'preview-cost-boundary', now })
  const added = await setCartLine(database, {
    cartId: cart.cartId,
    token: cart.token,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: 'preview-cost-line',
    correlationId: 'preview-cost-boundary',
    now
  })
  expect(added.outcome).toBe('applied')
  const quoted = await quoteCart(database, {
    cartId: cart.cartId,
    token: cart.token,
    expectedVersion: 2,
    idempotencyKey: 'preview-cost-quote',
    correlationId: 'preview-cost-boundary',
    now
  })
  expect(quoted.outcome).toBe('quoted')
  expect(JSON.stringify(quoted)).not.toContain('costUnitNetCents')
  expect(JSON.stringify(quoted)).not.toContain('costNetCents')
})
