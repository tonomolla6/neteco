import { z } from 'zod'

export class ChannelFeedError extends Error {
  constructor(
    readonly code:
      'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'allocation_exceeded' | 'too_large'
  ) {
    super(code)
    this.name = 'ChannelFeedError'
  }
}

export const CHANNELS = ['google_merchant', 'meta_catalog', 'price_comparator'] as const
export const channelSchema = z.enum(CHANNELS)
export type FeedChannel = z.infer<typeof channelSchema>

/** Versioned, per-channel transformation. Price is never editable here: it always comes from the effective price. */
export const channelFeedTransformSchema = z
  .object({
    titlePrefix: z.string().max(40).default(''),
    titleMaxLength: z.number().int().min(30).max(150).default(150),
    stockBuffer: z.number().int().min(0).max(100_000).default(0),
    allocationPercent: z.number().int().min(1).max(100).default(100),
    maxChannelUnits: z.number().int().min(1).max(1_000_000).nullable().default(null),
    includeBackorder: z.boolean().default(false),
    includeOutOfStock: z.boolean().default(true),
    excludeHazardous: z.boolean().default(true)
  })
  .strict()
export type ChannelFeedTransform = z.infer<typeof channelFeedTransformSchema>

export interface FeedSourceRow {
  variantId: string
  sku: string
  gtin: string | null
  productName: string
  slug: string
  brand: string
  priceGrossCents: number
  availableUnits: number
  backorderAllowed: boolean
  published: boolean
  hazardous: boolean
}

export type FeedAvailability = 'in_stock' | 'out_of_stock' | 'backorder'

export interface ChannelFeedItem {
  variantId: string
  sku: string
  gtin: string | null
  title: string
  brand: string
  link: string
  priceCents: number
  price: string
  quantity: number
  availability: FeedAvailability
}

export type FeedExclusionReason = 'not_published' | 'hazardous' | 'invalid_price' | 'out_of_stock'
export interface FeedExclusion {
  sku: string
  reason: FeedExclusionReason
}

export interface ChannelFeed {
  channel: FeedChannel
  transformVersion: number
  generatedAt: string
  items: ChannelFeedItem[]
  excluded: FeedExclusion[]
}

export function formatPrice(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')} EUR`
}

export function transformFeedItem(
  config: ChannelFeedTransform,
  row: FeedSourceRow,
  origin: string
): { item: ChannelFeedItem } | { excluded: FeedExclusion } {
  const excluded = (reason: FeedExclusionReason) => ({ excluded: { sku: row.sku, reason } })
  if (!row.published) return excluded('not_published')
  if (row.hazardous && config.excludeHazardous) return excluded('hazardous')
  if (!Number.isSafeInteger(row.priceGrossCents) || row.priceGrossCents <= 0) return excluded('invalid_price')

  const sellable = Math.max(0, Math.floor(row.availableUnits) - config.stockBuffer)
  let quantity = Math.floor((sellable * config.allocationPercent) / 100)
  if (config.maxChannelUnits !== null) quantity = Math.min(quantity, config.maxChannelUnits)
  let availability: FeedAvailability = 'out_of_stock'
  if (quantity > 0) availability = 'in_stock'
  else if (row.backorderAllowed && config.includeBackorder) availability = 'backorder'
  if (availability === 'out_of_stock' && !config.includeOutOfStock) return excluded('out_of_stock')

  return {
    item: {
      variantId: row.variantId,
      sku: row.sku,
      gtin: row.gtin,
      title: `${config.titlePrefix}${row.productName}`.slice(0, config.titleMaxLength).trimEnd(),
      brand: row.brand,
      link: `${origin}/producto/${encodeURIComponent(row.slug)}?sku=${encodeURIComponent(row.sku)}`,
      priceCents: row.priceGrossCents,
      price: formatPrice(row.priceGrossCents),
      quantity,
      availability
    }
  }
}

export interface ChannelReportedRow {
  sku: string
  priceCents: number
  quantity: number
  availability: FeedAvailability
}

export type DiscrepancyKind =
  'price_mismatch' | 'stock_above_allocation' | 'availability_mismatch' | 'unknown_in_channel' | 'missing_in_channel'

export interface FeedDiscrepancy {
  sku: string
  kind: DiscrepancyKind
  expected?: string | number
  reported?: string | number
}

export const channelReportedRowsSchema = z
  .array(
    z
      .object({
        sku: z.string().trim().min(1).max(64),
        priceCents: z.number().int().min(0).max(100_000_000),
        quantity: z.number().int().min(0).max(100_000_000),
        availability: z.enum(['in_stock', 'out_of_stock', 'backorder'])
      })
      .strict()
  )
  .max(5000)

/** Compares what the channel says it sells with what our active transform allows. */
export function reconcileChannelFeed(items: ChannelFeedItem[], reportedInput: unknown) {
  const parsed = channelReportedRowsSchema.safeParse(reportedInput)
  if (!parsed.success) throw new ChannelFeedError('invalid_input')
  const reported = new Map<string, ChannelReportedRow>()
  for (const row of parsed.data) {
    if (reported.has(row.sku)) throw new ChannelFeedError('invalid_input')
    reported.set(row.sku, row)
  }
  const discrepancies: FeedDiscrepancy[] = []
  let oversellRisk = false
  const known = new Set<string>()
  for (const item of items) {
    known.add(item.sku)
    const seen = reported.get(item.sku)
    if (!seen) {
      discrepancies.push({ sku: item.sku, kind: 'missing_in_channel' })
      continue
    }
    if (seen.priceCents !== item.priceCents)
      discrepancies.push({
        sku: item.sku,
        kind: 'price_mismatch',
        expected: item.priceCents,
        reported: seen.priceCents
      })
    if (seen.quantity > item.quantity) {
      discrepancies.push({
        sku: item.sku,
        kind: 'stock_above_allocation',
        expected: item.quantity,
        reported: seen.quantity
      })
      oversellRisk = true
    }
    if (seen.availability !== item.availability) {
      discrepancies.push({
        sku: item.sku,
        kind: 'availability_mismatch',
        expected: item.availability,
        reported: seen.availability
      })
      if (seen.availability !== 'out_of_stock') oversellRisk = true
    }
  }
  for (const row of reported.values()) {
    if (known.has(row.sku)) continue
    discrepancies.push({ sku: row.sku, kind: 'unknown_in_channel' })
    oversellRisk = true
  }
  discrepancies.sort((a, b) => a.sku.localeCompare(b.sku) || a.kind.localeCompare(b.kind))
  return { consistent: discrepancies.length === 0, oversellRisk, discrepancies }
}

function xml(value: string | number): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function renderChannelFeedXml(feed: ChannelFeed): string {
  const entries = feed.items
    .map(
      (item) =>
        `<item><g:id>${xml(item.sku)}</g:id><title>${xml(item.title)}</title><link>${xml(item.link)}</link>` +
        `<g:price>${xml(item.price)}</g:price><g:availability>${xml(item.availability)}</g:availability>` +
        `<g:quantity>${item.quantity}</g:quantity><g:brand>${xml(item.brand)}</g:brand>` +
        `${item.gtin ? `<g:gtin>${xml(item.gtin)}</g:gtin>` : ''}</item>`
    )
    .join('')
  return (
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>` +
    `<title>NETECO ${xml(feed.channel)} v${feed.transformVersion}</title>${entries}</channel></rss>`
  )
}
