/**
 * Deterministic effective-price resolution shared by the Worker catalog and the
 * local audit tooling. This module must stay dependency-free so it can be part
 * of the Workers bundle and imported by Node scripts at the same time.
 *
 * Selection rule for a given evaluation instant:
 *   1. status = 'approved' (cancelled versions never influence pricing)
 *   2. valid_from <= instant            (inclusive start)
 *   3. valid_until IS NULL OR > instant (exclusive end)
 *   4. most recent valid_from; ties break by created_at DESC, then id DESC,
 *      which is a total order and therefore fully deterministic.
 * When no version matches, callers fall back to the legacy base price stored on
 * the variant itself.
 *
 * The instant is never taken from request input. The Worker binds the server
 * clock value as a parameter; tests may pin it explicitly.
 */

export const PRICE_INSTANT_TOKEN = '__NETECO_PRICING_INSTANT__'

const ISO_UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/

function isCanonicalUtcInstant(instant: string) {
  if (!ISO_UTC_INSTANT_PATTERN.test(instant)) return false
  const parsed = new Date(instant)
  if (Number.isNaN(parsed.getTime())) return false
  const canonical = parsed.toISOString()
  return instant === canonical || (canonical.endsWith('.000Z') && instant === canonical.replace('.000Z', 'Z'))
}

export interface EffectivePricingOptions {
  /** Pinned evaluation instant (ISO-8601 UTC). Tests only; never client input. */
  instant?: string
}

export function resolvePricingInstant(options?: EffectivePricingOptions): string {
  const instant = options?.instant ?? new Date().toISOString()
  if (!isCanonicalUtcInstant(instant)) throw new Error(`Invalid pricing instant: ${instant}`)
  return instant
}

/** Scalar subquery returning the effective gross cents for one variant row. */
export function effectiveGrossCentsExpression(variantRef: string): string {
  return `COALESCE((
    SELECT price.gross_cents
    FROM variant_price_versions price
    WHERE price.variant_id = ${variantRef}.id
      AND price.status = 'approved'
      AND price.valid_from <= ${PRICE_INSTANT_TOKEN}
      AND (price.valid_until IS NULL OR price.valid_until > ${PRICE_INSTANT_TOKEN})
    ORDER BY price.valid_from DESC, price.created_at DESC, price.id DESC
    LIMIT 1
  ), ${variantRef}.price_gross_cents)`
}

/** Parameterized form used by the Worker: every instant becomes a bound value. */
export function parameterizeEffectivePricingSql(
  fragment: string,
  instant: string
): { sql: string; instantParameters: string[] } {
  return { sql: fragment.replaceAll(PRICE_INSTANT_TOKEN, '?'), instantParameters: [instant, instant] }
}

/**
 * Literal form used by the audit CLI (wrangler d1 execute cannot bind values).
 * Only fixed audit constants pass through here after strict format validation.
 */
export function inlineEffectivePricingSql(fragment: string, instant: string): string {
  if (!isCanonicalUtcInstant(instant)) throw new Error(`Invalid pricing instant: ${instant}`)
  return fragment.replaceAll(PRICE_INSTANT_TOKEN, `'${instant}'`)
}
