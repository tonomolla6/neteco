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
 * clock value as a parameter; tests may pin it explicitly. D1 stores canonical
 * seconds OR milliseconds, so every comparison/order normalizes to milliseconds
 * first. Plain text comparison would misorder `...00Z` versus `...00.123Z`.
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

/** One indexed winner-selection rule for all public price fields. */
function selectedPriceExpression(variantRef: string, field: 'gross_cents' | 'id'): string {
  return `(
    SELECT price.${field}
    FROM variant_price_versions price
    WHERE price.variant_id = ${variantRef}.id
      AND price.status = 'approved'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', price.valid_from) <= ${PRICE_INSTANT_TOKEN}
      AND (price.valid_until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', price.valid_until) > ${PRICE_INSTANT_TOKEN})
    ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ', price.valid_from) DESC,
             strftime('%Y-%m-%dT%H:%M:%fZ', price.created_at) DESC, price.id DESC
    LIMIT 1
  )`
}

/** Scalar subquery returning the effective gross cents for one variant row. */
export function effectiveGrossCentsExpression(variantRef: string): string {
  return `COALESCE(${selectedPriceExpression(variantRef, 'gross_cents')}, ${variantRef}.price_gross_cents)`
}

/** Nullable database identity for JOINs. Never join on the legacy DTO marker:
 * stored IDs are arbitrary text, so an inactive/foreign row can share it. */
export function effectiveGovernedVersionIdExpression(variantRef: string): string {
  return selectedPriceExpression(variantRef, 'id')
}

/** Public snapshot marker; only for projection, not database JOINs. */
export function effectiveVersionIdExpression(variantRef: string): string {
  return `COALESCE(${effectiveGovernedVersionIdExpression(variantRef)}, 'legacy:' || ${variantRef}.id)`
}

/** Parameterized form used by the Worker: every instant becomes a bound value. */
export function parameterizeEffectivePricingSql(
  fragment: string,
  instant: string
): { sql: string; instantParameters: string[] } {
  const comparableInstant = resolvePricingInstant({ instant })
  const count = fragment.split(PRICE_INSTANT_TOKEN).length - 1
  return {
    sql: fragment.replaceAll(PRICE_INSTANT_TOKEN, '?'),
    instantParameters: Array(count).fill(new Date(comparableInstant).toISOString())
  }
}

/**
 * Literal form used by the audit CLI (wrangler d1 execute cannot bind values).
 * Only fixed audit constants pass through here after strict format validation.
 */
export function inlineEffectivePricingSql(fragment: string, instant: string): string {
  if (!isCanonicalUtcInstant(instant)) throw new Error(`Invalid pricing instant: ${instant}`)
  return fragment.replaceAll(PRICE_INSTANT_TOKEN, `'${new Date(instant).toISOString()}'`)
}
