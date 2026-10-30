import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bvFixture, CLAIMS, ID, utc } from './bv-fixture'
import {
  channelFeedTransformSchema,
  reconcileChannelFeed,
  renderChannelFeedXml,
  transformFeedItem,
  type FeedSourceRow
} from '../../shared/channel-feeds'
import {
  activateChannelTransform,
  generateChannelFeed,
  listChannelTransforms,
  publishChannelTransform
} from '../../workers/catalog/channel-feeds'

const ORIGIN = 'https://neteco.example'
const options = { now: () => utc() }
const config = (over: Record<string, unknown> = {}) => channelFeedTransformSchema.parse(over)
const source = (over: Partial<FeedSourceRow> = {}): FeedSourceRow => ({
  variantId: 'v-x',
  sku: 'SKU-X',
  gtin: null,
  productName: 'Desengrasante industrial',
  slug: 'desengrasante-industrial',
  brand: 'NETECO',
  priceGrossCents: 1234,
  availableUnits: 10,
  backorderAllowed: false,
  published: true,
  hazardous: false,
  ...over
})

describe('SEO-034 channel transform (pure)', () => {
  it('applies title prefix and truncates to the channel limit without breaking the price', () => {
    const result = transformFeedItem(config({ titlePrefix: 'NETECO ', titleMaxLength: 30 }), source(), ORIGIN)
    if (!('item' in result)) throw new Error('expected item')
    expect(result.item.title.length).toBeLessThanOrEqual(30)
    expect(result.item.title.startsWith('NETECO ')).toBe(true)
    expect(result.item.price).toBe('12.34 EUR')
    expect(result.item.link).toBe(`${ORIGIN}/producto/desengrasante-industrial?sku=SKU-X`)
  })

  it('keeps a safety buffer and the channel allocation so the channel never gets all stock', () => {
    const result = transformFeedItem(
      config({ stockBuffer: 3, allocationPercent: 50 }),
      source({ availableUnits: 11 }),
      ORIGIN
    )
    if (!('item' in result)) throw new Error('expected item')
    expect(result.item.quantity).toBe(4) // floor((11 - 3) * 0.5)
    expect(result.item.availability).toBe('in_stock')
  })

  it('never advertises negative stock and caps by maxChannelUnits', () => {
    const low = transformFeedItem(config({ stockBuffer: 50 }), source({ availableUnits: 5 }), ORIGIN)
    if (!('item' in low)) throw new Error('expected item')
    expect(low.item.quantity).toBe(0)
    expect(low.item.availability).toBe('out_of_stock')
    const capped = transformFeedItem(config({ maxChannelUnits: 2 }), source({ availableUnits: 99 }), ORIGIN)
    if (!('item' in capped)) throw new Error('expected item')
    expect(capped.item.quantity).toBe(2)
  })

  it('only offers backorder when the variant allows it and the channel opts in', () => {
    const no = transformFeedItem(config(), source({ availableUnits: 0, backorderAllowed: true }), ORIGIN)
    const yes = transformFeedItem(
      config({ includeBackorder: true }),
      source({ availableUnits: 0, backorderAllowed: true }),
      ORIGIN
    )
    const never = transformFeedItem(config({ includeBackorder: true }), source({ availableUnits: 0 }), ORIGIN)
    expect('item' in no && no.item.availability).toBe('out_of_stock')
    expect('item' in yes && yes.item.availability).toBe('backorder')
    expect('item' in yes && yes.item.quantity).toBe(0)
    expect('item' in never && never.item.availability).toBe('out_of_stock')
  })

  it('excludes out-of-stock items when the channel asks for it', () => {
    expect(transformFeedItem(config({ includeOutOfStock: false }), source({ availableUnits: 0 }), ORIGIN)).toEqual({
      excluded: { sku: 'SKU-X', reason: 'out_of_stock' }
    })
  })

  it('excludes hazardous goods by default, unpublished variants and invalid prices', () => {
    expect(transformFeedItem(config(), source({ hazardous: true }), ORIGIN)).toEqual({
      excluded: { sku: 'SKU-X', reason: 'hazardous' }
    })
    expect('item' in transformFeedItem(config({ excludeHazardous: false }), source({ hazardous: true }), ORIGIN)).toBe(
      true
    )
    expect(transformFeedItem(config(), source({ published: false }), ORIGIN)).toEqual({
      excluded: { sku: 'SKU-X', reason: 'not_published' }
    })
    expect(transformFeedItem(config(), source({ priceGrossCents: 0 }), ORIGIN)).toEqual({
      excluded: { sku: 'SKU-X', reason: 'invalid_price' }
    })
  })

  it('rejects unknown keys and out-of-range transform values', () => {
    for (const bad of [
      { unknown: 1 },
      { allocationPercent: 0 },
      { allocationPercent: 101 },
      { stockBuffer: -1 },
      { titleMaxLength: 5 },
      { titlePrefix: 'x'.repeat(41) }
    ])
      expect(channelFeedTransformSchema.safeParse(bad).success).toBe(false)
  })

  it('renders XML escaping every untrusted value', () => {
    const result = transformFeedItem(config(), source({ productName: 'A & <b>"B"</b>' }), ORIGIN)
    if (!('item' in result)) throw new Error('expected item')
    const xml = renderChannelFeedXml({
      channel: 'google_merchant',
      transformVersion: 1,
      generatedAt: utc(),
      items: [result.item],
      excluded: []
    })
    expect(xml).toContain('A &amp; &lt;b&gt;&quot;B&quot;&lt;/b&gt;')
    expect(xml).not.toContain('<b>')
  })
})

describe('SEO-034 reconciliation (pure)', () => {
  const items = ['A', 'B', 'C'].map((sku) => {
    const r = transformFeedItem(config(), source({ sku, variantId: sku, availableUnits: 10 }), ORIGIN)
    if (!('item' in r)) throw new Error('item')
    return r.item
  })

  it('reports a clean channel as consistent', () => {
    const report = reconcileChannelFeed(
      items,
      items.map((i) => ({ sku: i.sku, priceCents: i.priceCents, quantity: i.quantity, availability: i.availability }))
    )
    expect(report.consistent).toBe(true)
    expect(report.oversellRisk).toBe(false)
    expect(report.discrepancies).toEqual([])
  })

  it('flags price drift, stock above what we allow, stale availability, delisted SKUs and missing SKUs', () => {
    const report = reconcileChannelFeed(items, [
      { sku: 'A', priceCents: 999, quantity: 10, availability: 'in_stock' },
      { sku: 'B', priceCents: 1234, quantity: 50, availability: 'in_stock' },
      { sku: 'GHOST', priceCents: 100, quantity: 1, availability: 'in_stock' }
    ])
    const kinds = report.discrepancies.map((d) => `${d.sku}:${d.kind}`).sort()
    expect(kinds).toEqual([
      'A:price_mismatch',
      'B:stock_above_allocation',
      'C:missing_in_channel',
      'GHOST:unknown_in_channel'
    ])
    expect(report.oversellRisk).toBe(true)
    expect(report.consistent).toBe(false)
  })

  it('treats an out-of-stock item the channel still lists as in stock as an oversell risk', () => {
    const out = transformFeedItem(config(), source({ sku: 'Z', variantId: 'Z', availableUnits: 0 }), ORIGIN)
    if (!('item' in out)) throw new Error('item')
    const report = reconcileChannelFeed(
      [out.item],
      [{ sku: 'Z', priceCents: 1234, quantity: 0, availability: 'in_stock' }]
    )
    expect(report.discrepancies).toEqual([
      { sku: 'Z', kind: 'availability_mismatch', expected: 'out_of_stock', reported: 'in_stock' }
    ])
    expect(report.oversellRisk).toBe(true)
  })

  it('rejects duplicated or malformed channel rows', () => {
    expect(() =>
      reconcileChannelFeed(items, [
        { sku: 'A', priceCents: 1, quantity: 1, availability: 'in_stock' },
        { sku: 'A', priceCents: 1, quantity: 1, availability: 'in_stock' }
      ])
    ).toThrow()
  })
})

describe('SEO-034 versioned channel transforms (D1)', () => {
  let f: Awaited<ReturnType<typeof bvFixture>>
  beforeEach(async () => {
    f = await bvFixture()
  })
  afterEach(() => f.sqlite.close())

  let n = 200
  const publish = (channel: string, expectedLatestVersion: number, cfg: Record<string, unknown> = {}, id = ID(++n)) =>
    publishChannelTransform(f.database, CLAIMS, id, channel, { expectedLatestVersion, config: cfg }, options)
  const activate = (channel: string, version: number, expectedActiveVersion: number, id = ID(++n)) =>
    activateChannelTransform(f.database, CLAIMS, id, channel, { version, expectedActiveVersion }, options)

  it('publishes immutable, sequential versions per channel with CAS', async () => {
    expect(await publish('google_merchant', 0)).toMatchObject({ channel: 'google_merchant', version: 1 })
    expect(await publish('google_merchant', 1, { stockBuffer: 2 })).toMatchObject({ version: 2 })
    await expect(publish('google_merchant', 1)).rejects.toMatchObject({ code: 'conflict' })
    expect(await publish('meta_catalog', 0)).toMatchObject({ version: 1 })
    const listing = await listChannelTransforms(f.database, 'google_merchant')
    expect(listing.versions.map((v) => v.version)).toEqual([1, 2])
    expect(listing.activeVersion).toBe(0)
    expect(() => f.sqlite.exec("UPDATE channel_feed_transform_versions SET config_json='{}'")).toThrow(/immutable/)
    expect(() => f.sqlite.exec('DELETE FROM channel_feed_transform_versions')).toThrow(/immutable/)
  })

  it('stores the normalised config with defaults filled in', async () => {
    await publish('google_merchant', 0, { stockBuffer: 4 })
    const [version] = (await listChannelTransforms(f.database, 'google_merchant')).versions
    expect(version!.config).toMatchObject({ stockBuffer: 4, allocationPercent: 100, excludeHazardous: true })
  })

  it('is idempotent per command and rejects a replay with a different payload', async () => {
    const id = ID(990)
    const first = await publish('google_merchant', 0, {}, id)
    expect(await publish('google_merchant', 0, {}, id)).toEqual(first)
    await expect(publish('google_merchant', 0, { stockBuffer: 9 }, id)).rejects.toMatchObject({ code: 'conflict' })
    await expect(publish('meta_catalog', 0, {}, id)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('validates channel, command id and config', async () => {
    await expect(publish('amazon', 0)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(publish('google_merchant', 0, { bogus: true })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(publish('google_merchant', -1)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(publish('google_merchant', 0, {}, 'nope')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('requires a live MFA administrator for every write', async () => {
    await expect(
      publishChannelTransform(
        f.database,
        null,
        ID(1),
        'google_merchant',
        { expectedLatestVersion: 0, config: {} },
        options
      )
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(
      publishChannelTransform(
        f.database,
        f.plainClaims,
        ID(2),
        'google_merchant',
        { expectedLatestVersion: 0, config: {} },
        options
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      activateChannelTransform(
        f.database,
        f.plainClaims,
        ID(3),
        'google_merchant',
        { version: 1, expectedActiveVersion: 0 },
        options
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('activates with CAS, supports rollback and keeps an append-only activation log', async () => {
    await publish('google_merchant', 0)
    await publish('google_merchant', 1, { stockBuffer: 5 })
    await expect(activate('google_merchant', 3, 0)).rejects.toMatchObject({ code: 'not_found' })
    expect(await activate('google_merchant', 1, 0)).toMatchObject({ fromVersion: 0, toVersion: 1 })
    await expect(activate('google_merchant', 2, 0)).rejects.toMatchObject({ code: 'conflict' })
    expect(await activate('google_merchant', 2, 1)).toMatchObject({ fromVersion: 1, toVersion: 2 })
    expect(await activate('google_merchant', 1, 2)).toMatchObject({ fromVersion: 2, toVersion: 1 })
    expect((await listChannelTransforms(f.database, 'google_merchant')).activeVersion).toBe(1)
    expect(() => f.sqlite.exec('DELETE FROM channel_feed_activations')).toThrow(/immutable/)
  })

  it('replays an activation idempotently', async () => {
    await publish('google_merchant', 0)
    const id = ID(991)
    const first = await activate('google_merchant', 1, 0, id)
    expect(await activate('google_merchant', 1, 0, id)).toEqual(first)
    await expect(activate('google_merchant', 1, 1, id)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('never lets active channels allocate more than 100% of the stock in total', async () => {
    await publish('google_merchant', 0, { allocationPercent: 60 })
    await publish('meta_catalog', 0, { allocationPercent: 50 })
    await publish('meta_catalog', 1, { allocationPercent: 40 })
    await activate('google_merchant', 1, 0)
    await expect(activate('meta_catalog', 1, 0)).rejects.toMatchObject({ code: 'allocation_exceeded' })
    expect(await activate('meta_catalog', 2, 0)).toMatchObject({ toVersion: 2 })
  })

  it('generates nothing without an active transform', async () => {
    await publish('google_merchant', 0)
    await expect(
      generateChannelFeed(f.database, 'google_merchant', { origin: ORIGIN, ...options })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(generateChannelFeed(f.database, 'bogus', { origin: ORIGIN, ...options })).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })

  it('generates a feed from the active version with live price, sellable stock and exclusions', async () => {
    await publish('google_merchant', 0, { stockBuffer: 2, includeBackorder: true })
    await activate('google_merchant', 1, 0)
    const feed = await generateChannelFeed(f.database, 'google_merchant', { origin: ORIGIN, ...options })
    expect(feed.transformVersion).toBe(1)
    const bySku = new Map(feed.items.map((i) => [i.sku, i]))
    // p-1: 25 physical - 1 safety - 2 buffer
    expect(bySku.get('SKU-1-1')).toMatchObject({ quantity: 22, availability: 'in_stock', priceCents: 500 })
    // p-4: 3 physical - 1 safety - 2 buffer = 0
    expect(bySku.get('SKU-4-1')).toMatchObject({ quantity: 0, availability: 'out_of_stock' })
    // p-5 allows backorder
    expect(bySku.get('SKU-5-1')).toMatchObject({ availability: 'in_stock' })
    expect(feed.items.map((i) => i.sku)).toEqual([...feed.items.map((i) => i.sku)].sort())
  })

  it('reflects a price change and a reservation on the next generation, and a new version after republish', async () => {
    await publish('google_merchant', 0)
    await activate('google_merchant', 1, 0)
    f.sqlite.exec("UPDATE variants SET price_gross_cents = 777 WHERE id = 'v-1-1'")
    f.sqlite.exec("UPDATE inventory_balances SET blocked_quantity = 20 WHERE variant_id = 'v-1-1'")
    const feed = await generateChannelFeed(f.database, 'google_merchant', { origin: ORIGIN, ...options })
    expect(feed.items.find((i) => i.sku === 'SKU-1-1')).toMatchObject({ priceCents: 777, quantity: 4 })
    await publish('google_merchant', 1, { stockBuffer: 1 })
    await activate('google_merchant', 2, 1)
    const next = await generateChannelFeed(f.database, 'google_merchant', { origin: ORIGIN, ...options })
    expect(next.transformVersion).toBe(2)
    expect(next.items.find((i) => i.sku === 'SKU-1-1')!.quantity).toBe(3)
  })

  it('excludes hazardous variants and unpublished variants from the feed', async () => {
    await publish('google_merchant', 0)
    await activate('google_merchant', 1, 0)
    f.sqlite.exec("UPDATE variants SET status = 'hidden' WHERE id = 'v-2-1'")
    f.sqlite.exec("INSERT INTO shipping_profiles(id, code, name, kind) VALUES('sp-adr','adr','ADR','adr')")
    f.sqlite.exec("UPDATE variants SET shipping_profile_id = 'sp-adr' WHERE id = 'v-3-1'")
    const feed = await generateChannelFeed(f.database, 'google_merchant', { origin: ORIGIN, ...options })
    expect(feed.excluded).toContainEqual({ sku: 'SKU-3-1', reason: 'hazardous' })
    expect(feed.excluded).toContainEqual({ sku: 'SKU-2-1', reason: 'not_published' })
    expect(feed.items.some((i) => i.sku === 'SKU-3-1' || i.sku === 'SKU-2-1')).toBe(false)
  })
})
