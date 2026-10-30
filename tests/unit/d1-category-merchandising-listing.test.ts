import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { MER_CLAIMS, MER_ROOT, merUtc as at, merchandisingWorld } from '../support/category-merchandising-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { listPublishedProducts, type ProductQuery } from '../../workers/catalog/products'
import { executeCategoryMerchandisingCommand } from '../../workers/catalog/category-merchandising'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const noWeights = { stock: 0, margin: 0, popularity: 0, contract: 0, campaign: 0 }
let world: Awaited<ReturnType<typeof merchandisingWorld>>
let sqlite: DatabaseSync
let database: D1Database

const rule = (extra: Record<string, unknown> = {}) => ({
  action: 'save',
  id: null,
  expectedVersion: 0,
  categoryId: MER_ROOT,
  weights: { ...noWeights, popularity: 5 },
  guardrails: { minStock: 0, minMarginBps: null, maxBoosted: 10 },
  campaign: { campaignId: null, productIds: [] },
  reason: 'Priorizar lo más vendido',
  validFrom: at(-HOUR),
  validUntil: at(30 * DAY),
  ...extra
})
const save = (input: unknown) =>
  executeCategoryMerchandisingCommand(database, MER_CLAIMS, input, { idempotencyKey: crypto.randomUUID() })
const query = (extra: Partial<ProductQuery> = {}): ProductQuery => ({
  category: 'limpieza',
  page: 1,
  limit: 24,
  sort: 'default',
  ...extra
})
const slugs = async (extra: Partial<ProductQuery> = {}) =>
  ((await listPublishedProducts(database, query(extra)))?.items ?? []).map((item) => item.slug)

beforeEach(async () => {
  world = await merchandisingWorld()
  ;({ sqlite, database } = world)
  world.addProduct({ n: 1, stock: 50, cost: 600 })
  world.addProduct({ n: 2, stock: 0, cost: 200 })
  world.addProduct({ n: 3, stock: 5, cost: 100 })
  world.addProduct({ n: 5, stock: 30, cost: 900 })
  await provisionPublicationValidityFixture(database, {
    productIds: [1, 2, 3, 5].map((n) => `40000000-0000-4000-8000-0000000c00${String(n).padStart(2, '0')}`),
    now: at(-DAY)
  })
  world.paidPurchase(5, at(-DAY), 9)
})
afterEach(() => sqlite.close())

describe('SEA-015 storefront listing wiring', () => {
  it('keeps the default order when there is no rule', async () => {
    expect(await slugs()).toEqual(['producto-1', 'producto-2', 'producto-3', 'producto-5'])
  })
  it('applies a live rule to the default listing of the category: boosted first, out of stock last', async () => {
    await save(rule())
    expect(await slugs()).toEqual(['producto-5', 'producto-1', 'producto-3', 'producto-2'])
  })
  it('keeps pagination, total and the order across pages consistent', async () => {
    await save(rule())
    const first = await listPublishedProducts(database, query({ limit: 2, page: 1 }))
    const second = await listPublishedProducts(database, query({ limit: 2, page: 2 }))
    expect(first?.items.map((i) => i.slug)).toEqual(['producto-5', 'producto-1'])
    expect(second?.items.map((i) => i.slug)).toEqual(['producto-3', 'producto-2'])
    expect(first?.total).toBe(4)
  })
  it('does not touch an explicit sort, a text search or another category', async () => {
    const before = {
      child: await slugs({ category: 'lejias' }),
      search: await slugs({ search: 'Producto' }),
      name: await slugs({ sort: 'name' })
    }
    await save(rule())
    expect(await slugs({ category: 'lejias' })).toEqual(before.child)
    expect(await slugs({ search: 'Producto' })).toEqual(before.search)
    expect(await slugs({ sort: 'name' })).toEqual(before.name)
    expect(before.name).toEqual(['producto-1', 'producto-2', 'producto-3', 'producto-5'])
  })
  it('stops applying the rule once it is retired, expired or not yet live', async () => {
    const saved = await save(rule())
    await save({ action: 'retire', id: saved.item.id, expectedVersion: 1, reason: 'Fin de campaña' })
    expect(await slugs()).toEqual(['producto-1', 'producto-2', 'producto-3', 'producto-5'])
    await save(rule({ validFrom: at(2 * DAY), validUntil: at(10 * DAY) }))
    expect(await slugs()).toEqual(['producto-1', 'producto-2', 'producto-3', 'producto-5'])
  })
  it('honours the guardrails when ranking the listing', async () => {
    await save(
      rule({ weights: { ...noWeights, margin: 5 }, guardrails: { minStock: 0, minMarginBps: 5000, maxBoosted: 3 } })
    )
    // margins: p1 4000, p3 9000, p5 1000 bps: only p3 meets the 5000 floor, so only p3 is boosted
    const order = await slugs()
    expect(order[order.length - 1]).toBe('producto-2')
    expect(order.indexOf('producto-3')).toBeLessThan(order.indexOf('producto-1'))
  })
  it('falls back to the default order if the ranking cannot be computed', async () => {
    await save(rule())
    sqlite.exec('DROP VIEW category_merchandising_current')
    expect(await slugs()).toEqual(['producto-1', 'producto-2', 'producto-3', 'producto-5'])
  })
})
