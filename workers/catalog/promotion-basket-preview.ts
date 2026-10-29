import {
  promotionBasketPreviewInputSchema,
  promotionBasketPreviewResponseSchema,
  type PromotionBasketPreviewResponse
} from '../../shared/promotion-basket-preview'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { quoteLine, validateQuantity } from '../../server/domain/money'
import { prepareQuoteLinesStatement, mapQuoteLines, type RawResolvedLine, CartError } from './cart'
import { prepareShippingRatesStatement, mapShippingOptions, type RateRow } from './shipping'
import { evaluatePromotion, promotionRuleHash } from './promotions'
import { canonicalJson, sha256Hex } from './inventory'
import type { VerifiedSessionClaims } from './authorization'

export class PromotionBasketPreviewError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'variant_not_available'
      | 'customer_not_available'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'service_unavailable'
  ) {
    super(code)
    this.name = 'PromotionBasketPreviewError'
  }
}
export async function previewD1PromotionBasket(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  options: { now?: string; freeShippingThresholdCents?: number | null } = {}
): Promise<PromotionBasketPreviewResponse> {
  const started = Date.now()
  const now = options.now ?? new Date(started).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const parsed = promotionBasketPreviewInputSchema.safeParse(raw)
  const threshold = options.freeShippingThresholdCents ?? null
  if (
    !parsed.success ||
    !catalogPolicyInstantSchema.safeParse(now).success ||
    (threshold !== null && (!Number.isSafeInteger(threshold) || threshold < 0))
  )
    throw new PromotionBasketPreviewError('invalid_input')
  const fresh = () =>
    new Date(Date.parse(now) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const input = parsed.data
  try {
    await authorize(database, claims, fresh())
    // One D1 read batch gives prices, stock facts, costs, rates, customer segment
    // and usage counters one coherent snapshot. No quote/cart/usage is persisted.
    const results = await database.batch([
      prepareQuoteLinesStatement(database, { lines: input.lines, instant: now }),
      prepareShippingRatesStatement(database, 1001),
      database
        .prepare(
          `SELECT
        EXISTS(SELECT 1 FROM customers c JOIN identities i ON i.customer_id=c.id
          WHERE c.id=?1 AND c.status='active' AND c.created_at<=?3
          AND i.status='active' AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?3) AS customerActive,
        EXISTS(SELECT 1 FROM companies WHERE customer_id=?1 AND status='approved' AND created_at<=?3) AS companyApproved,
        (SELECT count(*) FROM promotion_redemptions WHERE rule_id=?2) AS totalUses,
        (SELECT count(*) FROM promotion_redemptions WHERE rule_id=?2 AND customer_id=?1) AS customerUses`
        )
        .bind(input.customerId, input.rule.id, now)
    ])
    if (results.length !== 3 || results.some((result) => result.success !== true || !Array.isArray(result.results)))
      throw new PromotionBasketPreviewError('service_unavailable')
    const lines = mapQuoteLines(results[0]!.results as unknown as RawResolvedLine[])
    if (
      lines.length !== input.lines.length ||
      lines.some(
        (line) => !input.lines.some((item) => item.variantId === line.variantId && item.quantity === line.quantity)
      )
    )
      throw new PromotionBasketPreviewError('variant_not_available')
    if (results[1]!.results.length > 1000) throw new PromotionBasketPreviewError('service_unavailable')
    const segment = results[2]!.results[0] as Record<string, unknown> | undefined
    if (
      !segment ||
      ![0, 1].includes(Number(segment.customerActive)) ||
      ![0, 1].includes(Number(segment.companyApproved)) ||
      !Number.isSafeInteger(segment.totalUses) ||
      Number(segment.totalUses) < 0 ||
      !Number.isSafeInteger(segment.customerUses) ||
      Number(segment.customerUses) < 0 ||
      Number(segment.customerUses) > Number(segment.totalUses)
    )
      throw new PromotionBasketPreviewError('service_unavailable')
    if (input.customerId !== null && segment.customerActive !== 1)
      throw new PromotionBasketPreviewError('customer_not_available')
    for (const line of lines) {
      try {
        validateQuantity(line.quantity, line)
      } catch {
        throw new PromotionBasketPreviewError('invalid_input')
      }
      for (const amount of [
        line.baseUnitGrossCents,
        line.unitGrossCents,
        line.taxRateBasisPoints,
        line.costUnitNetCents
      ])
        if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0))
          throw new PromotionBasketPreviewError('service_unavailable')
    }
    const evaluated = evaluatePromotion(
      { ...input.rule, status: 'active' },
      {
        now,
        channel: 'online',
        customerId: input.customerId,
        companyApproved: segment.companyApproved === 1,
        redemptions: { total: Number(segment.totalUses), customer: Number(segment.customerUses) },
        lines: lines.map((line, lineIndex) => ({
          lineIndex,
          variantId: line.variantId,
          productId: line.productId,
          categoryId: line.categoryId,
          sku: line.sku,
          quantity: line.quantity,
          baseUnitGrossCents: line.baseUnitGrossCents,
          volumeUnitGrossCents: line.unitGrossCents,
          taxRateBasisPoints: line.taxRateBasisPoints
        }))
      }
    )
    const projected = lines.map((line, lineIndex) => {
      const amount = (unitGrossCents: number) => {
        const quoted = quoteLine({ ...line, unitGrossCents })
        return { netCents: quoted.netCents, taxCents: quoted.taxCents, grossCents: quoted.grossCents }
      }
      const proposed = evaluated.lines[lineIndex]!
      return {
        lineIndex,
        variantId: line.variantId,
        sku: line.sku,
        name: line.name,
        quantity: line.quantity,
        priceVersionId: line.priceVersionId,
        costUnitNetCents: line.costUnitNetCents,
        costNetCents: line.costUnitNetCents === null ? null : line.costUnitNetCents * line.quantity,
        base: amount(line.baseUnitGrossCents),
        volume: amount(line.unitGrossCents),
        proposed: { netCents: proposed.netCents, taxCents: proposed.taxCents, grossCents: proposed.grossCents },
        discountGrossCents: proposed.discountGrossCents
      }
    })
    const cost = projected.some((line) => line.costNetCents === null)
      ? null
      : projected.reduce((sum, line) => sum + line.costNetCents!, 0)
    const totals = (scenario: 'base' | 'volume' | 'proposed') => {
      const sum = projected.reduce(
        (sum, line) => ({
          netCents: sum.netCents + line[scenario].netCents,
          taxCents: sum.taxCents + line[scenario].taxCents,
          grossCents: sum.grossCents + line[scenario].grossCents
        }),
        { netCents: 0, taxCents: 0, grossCents: 0 }
      )
      return {
        ...sum,
        costNetCents: cost,
        marginNetCents: cost === null ? null : sum.netCents - cost,
        loss: cost === null ? null : sum.netCents < cost
      }
    }
    const volume = totals('volume')
    const rates = results[1]!.results as unknown as RateRow[]
    const shippingOptions = mapShippingOptions(
      lines.map((line) => ({ ...line, published: 1 })),
      rates,
      input.destination,
      threshold === null ? undefined : { threshold, goodsGross: volume.grossCents }
    )
    const ruleHash = await promotionRuleHash(input.rule)
    const snapshotHash = await sha256Hex(canonicalJson({ now, input, lines, rates, segment, threshold }))
    const response = promotionBasketPreviewResponseSchema.parse({
      source: 'cloudflare',
      simulation: true,
      ruleEvaluation: 'proposed_active',
      evaluatedAt: now,
      ruleHash,
      snapshotHash,
      eligible: evaluated.eligible,
      reason: evaluated.reason,
      lines: projected,
      totals: { base: totals('base'), volume, proposed: totals('proposed') },
      shipping: { options: shippingOptions, operationalCostNetCents: null },
      totalMarginNetCents: null
    })
    // Hashing and all data awaits precede the last atomic intersection of grants.
    await authorize(database, claims, fresh())
    return response
  } catch (error) {
    if (error instanceof PromotionBasketPreviewError) throw error
    if (error instanceof CartError && error.code === 'variant_not_available')
      throw new PromotionBasketPreviewError('variant_not_available')
    throw new PromotionBasketPreviewError('service_unavailable')
  }
}

async function authorize(database: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  if (
    !claims ||
    !catalogPolicyUuidSchema.safeParse(claims.identityId).success ||
    !catalogPolicyUuidSchema.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    throw new PromotionBasketPreviewError('unauthenticated')
  const row = await database
    .prepare(
      `SELECT s.mfa_verified AS mfa,
    (i.email_verified_at IS NOT NULL AND i.email_verified_at<=?1) AS email,
    (SELECT count(DISTINCT g.permission_code) FROM identity_roles r JOIN role_permissions g ON g.role_code=r.role_code
      WHERE r.identity_id=i.id AND g.permission_code IN ('catalog.write','administration.manage')
      AND r.granted_at<=?1 AND (r.expires_at IS NULL OR r.expires_at>?1)) AS permissions
    FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
    WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.session_version=i.session_version
      AND s.revoked_at IS NULL AND s.created_at<=?1 AND s.expires_at>?1 AND i.status IN ('pending','active')`
    )
    .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{ mfa: number; email: number; permissions: number }>()
  if (!row) throw new PromotionBasketPreviewError('unauthenticated')
  if (![0, 1].includes(row.mfa) || ![0, 1].includes(row.email) || ![0, 1, 2].includes(row.permissions))
    throw new PromotionBasketPreviewError('service_unavailable')
  if (row.email !== 1) throw new PromotionBasketPreviewError('email_unverified')
  if (row.mfa !== 1) throw new PromotionBasketPreviewError('mfa_required')
  if (row.permissions !== 2) throw new PromotionBasketPreviewError('forbidden')
}
