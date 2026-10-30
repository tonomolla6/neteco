import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'

/** SEA-015. Category merchandising by rule. A rule combines five normalised signals (stock, margin,
 * popularity, contract, campaign) with integer weights and is bounded by guardrails: out-of-stock
 * products are always sunk, stock and margin floors block a boost, and a cap limits how many products
 * can jump ahead. Everything here is pure; the signals are read server-side by the worker. */
export const CATEGORY_MERCHANDISING_MAX_VALIDITY_DAYS = 180
export const CATEGORY_MERCHANDISING_MAX_BOOSTED = 50
export const CATEGORY_MERCHANDISING_MAX_CAMPAIGN_PRODUCTS = 100
export const CATEGORY_MERCHANDISING_POPULARITY_DAYS = 30
export const STOCK_SATURATION_UNITS = 100
export const MARGIN_SATURATION_BPS = 6000
const DAY_MS = 24 * 60 * 60 * 1000

export const CATEGORY_MERCHANDISING_SIGNALS = ['stock', 'margin', 'popularity', 'contract', 'campaign'] as const
export type CategoryMerchandisingSignal = (typeof CATEGORY_MERCHANDISING_SIGNALS)[number]

const noControls = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value)
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((value) => {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z') === value
  })
const reason = z.string().trim().min(3).max(500).refine(noControls)
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const weight = z.number().int().min(0).max(10)

export const categoryMerchandisingWeightsSchema = z
  .object({ stock: weight, margin: weight, popularity: weight, contract: weight, campaign: weight })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry > 0), 'At least one weight must be positive')
export const categoryMerchandisingGuardrailsSchema = z
  .object({
    minStock: z.number().int().min(0).max(10_000),
    minMarginBps: z.number().int().min(0).max(10_000).nullable(),
    maxBoosted: z.number().int().min(1).max(CATEGORY_MERCHANDISING_MAX_BOOSTED)
  })
  .strict()
export const categoryMerchandisingCampaignSchema = z
  .object({
    campaignId: catalogPolicyUuidSchema.nullable(),
    productIds: z.array(catalogPolicyUuidSchema).max(CATEGORY_MERCHANDISING_MAX_CAMPAIGN_PRODUCTS)
  })
  .strict()
  .refine((value) => new Set(value.productIds).size === value.productIds.length, 'Duplicate campaign product')

const saveSchema = z
  .object({
    action: z.literal('save'),
    id: catalogPolicyUuidSchema.nullable(),
    expectedVersion: version,
    categoryId: catalogPolicyUuidSchema,
    weights: categoryMerchandisingWeightsSchema,
    guardrails: categoryMerchandisingGuardrailsSchema,
    campaign: categoryMerchandisingCampaignSchema,
    reason,
    validFrom: instant,
    validUntil: instant
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message })
    if ((value.id === null) !== (value.expectedVersion === 0)) issue('Identity and version do not match.')
    const span = Date.parse(value.validUntil) - Date.parse(value.validFrom)
    if (!(span > 0 && span <= CATEGORY_MERCHANDISING_MAX_VALIDITY_DAYS * DAY_MS)) issue('Invalid validity period.')
    if (value.weights.campaign > 0 && value.campaign.productIds.length === 0)
      issue('The campaign signal needs campaign products.')
  })
const retireSchema = z
  .object({
    action: z.literal('retire'),
    id: catalogPolicyUuidSchema,
    expectedVersion: version.refine((value) => value >= 1),
    reason
  })
  .strict()
const own = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
export const categoryMerchandisingInputSchema = z.preprocess(own, z.union([saveSchema, retireSchema]))
export type CategoryMerchandisingInput = z.infer<typeof saveSchema> | z.infer<typeof retireSchema>
export type CategoryMerchandisingWeights = z.infer<typeof categoryMerchandisingWeightsSchema>
export type CategoryMerchandisingGuardrails = z.infer<typeof categoryMerchandisingGuardrailsSchema>

export function categoryMerchandisingState(
  rule: { status: 'active' | 'retired'; validFrom: string; validUntil: string },
  at: string
): 'live' | 'scheduled' | 'expired' | 'retired' {
  return rule.status === 'retired'
    ? 'retired'
    : at < rule.validFrom
      ? 'scheduled'
      : at >= rule.validUntil
        ? 'expired'
        : 'live'
}

export interface CategoryProductSignals {
  productId: string
  /** 1-based position of the product in the category's default order. */
  baselineRank: number
  sellableStock: number
  backorderAllowed: boolean
  /** Net margin in basis points of the net price; null when no cost is known. */
  marginBps: number | null
  units30d: number
  contract: boolean
  campaign: boolean
}
export type CategoryGuardrailCode = 'out_of_stock' | 'below_min_stock' | 'margin_floor' | 'margin_unknown' | 'boost_cap'
export interface CategoryRankedItem {
  productId: string
  position: number
  baselineRank: number
  /** 0..100 */
  score: number
  group: 'boosted' | 'neutral' | 'demoted'
  guardrails: CategoryGuardrailCode[]
  contributions: Array<{ signal: CategoryMerchandisingSignal; value: number; weight: number; points: number }>
}
export interface CategoryRanking {
  items: CategoryRankedItem[]
  boostedIds: string[]
  demotedIds: string[]
}

const round = (value: number) => Math.round(value * 10_000) / 10_000
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export function rankCategoryProducts(
  rule: { weights: CategoryMerchandisingWeights; guardrails: CategoryMerchandisingGuardrails },
  products: readonly CategoryProductSignals[]
): CategoryRanking {
  const totalWeight = CATEGORY_MERCHANDISING_SIGNALS.reduce((sum, signal) => sum + rule.weights[signal], 0)
  const maxUnits = products.reduce((max, item) => Math.max(max, item.units30d), 0)
  const evaluated = products.map((item) => {
    const values: Record<CategoryMerchandisingSignal, number> = {
      stock: clamp01(item.sellableStock / STOCK_SATURATION_UNITS),
      margin: item.marginBps === null ? 0 : clamp01(item.marginBps / MARGIN_SATURATION_BPS),
      popularity: maxUnits > 0 ? clamp01(item.units30d / maxUnits) : 0,
      contract: item.contract ? 1 : 0,
      campaign: item.campaign ? 1 : 0
    }
    const contributions = CATEGORY_MERCHANDISING_SIGNALS.filter((signal) => rule.weights[signal] > 0).map((signal) => ({
      signal,
      value: values[signal],
      weight: rule.weights[signal],
      points: round((100 * rule.weights[signal] * values[signal]) / totalWeight)
    }))
    const guardrails: CategoryGuardrailCode[] = []
    const outOfStock = !item.backorderAllowed && item.sellableStock <= 0
    if (outOfStock) guardrails.push('out_of_stock')
    else if (!item.backorderAllowed && item.sellableStock < rule.guardrails.minStock) guardrails.push('below_min_stock')
    const floor = rule.guardrails.minMarginBps
    if (!outOfStock && floor !== null) {
      if (item.marginBps === null) guardrails.push('margin_unknown')
      else if (item.marginBps < floor) guardrails.push('margin_floor')
    }
    const score = round(contributions.reduce((sum, part) => sum + part.points, 0))
    return { item, contributions, guardrails, score, outOfStock, blocked: guardrails.length > 0 }
  })
  const byBaseline = (a: (typeof evaluated)[number], b: (typeof evaluated)[number]) =>
    a.item.baselineRank - b.item.baselineRank || a.item.productId.localeCompare(b.item.productId)
  const candidates = evaluated
    .filter((entry) => !entry.blocked && entry.score > 0)
    .sort((a, b) => b.score - a.score || byBaseline(a, b))
  const boosted = new Set(candidates.slice(0, rule.guardrails.maxBoosted))
  for (const entry of candidates.slice(rule.guardrails.maxBoosted)) entry.guardrails.push('boost_cap')
  const front = candidates.slice(0, rule.guardrails.maxBoosted)
  const middle = evaluated.filter((entry) => !boosted.has(entry) && !entry.outOfStock).sort(byBaseline)
  const back = evaluated.filter((entry) => entry.outOfStock).sort(byBaseline)
  const items = [...front, ...middle, ...back].map((entry, index): CategoryRankedItem => ({
    productId: entry.item.productId,
    position: index + 1,
    baselineRank: entry.item.baselineRank,
    score: entry.score,
    group: entry.outOfStock ? 'demoted' : boosted.has(entry) ? 'boosted' : 'neutral',
    guardrails: entry.guardrails,
    contributions: entry.contributions
  }))
  return {
    items,
    boostedIds: items.filter((item) => item.group === 'boosted').map((item) => item.productId),
    demotedIds: items.filter((item) => item.group === 'demoted').map((item) => item.productId)
  }
}
