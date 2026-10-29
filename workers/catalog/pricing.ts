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
export const PRICE_CUSTOMER_TOKEN = '__NETECO_PRICING_CUSTOMER__'

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
  /** Resolved from a verified server session, never a request field. */
  customerId?: string
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
  instant: string,
  customerId?: string
): { sql: string; instantParameters: string[] } {
  const comparableInstant = resolvePricingInstant({ instant })
  const instantParameters: string[] = []
  const sql = fragment.replace(/__NETECO_PRICING_INSTANT__|__NETECO_PRICING_CUSTOMER__/g, (token) => {
    if (token === PRICE_CUSTOMER_TOKEN) {
      if (!customerId) throw new Error('Missing trusted pricing customer')
      instantParameters.push(customerId)
    } else instantParameters.push(new Date(comparableInstant).toISOString())
    return '?'
  })
  return { sql, instantParameters }
}

/**
 * Literal form used by the audit CLI (wrangler d1 execute cannot bind values).
 * Only fixed audit constants pass through here after strict format validation.
 */
export function inlineEffectivePricingSql(fragment: string, instant: string): string {
  if (!isCanonicalUtcInstant(instant)) throw new Error(`Invalid pricing instant: ${instant}`)
  return fragment.replaceAll(PRICE_INSTANT_TOKEN, `'${new Date(instant).toISOString()}'`)
}

/** The customer reference is a server-bound SQL parameter, never request SQL.
 * The public winner remains the sole base for percentage discounts. */
function b2bRuleExpression(variantRef: string, customerRef: string, field: 'gross' | 'version' | 'source'): string {
  const publicGross = effectiveGrossCentsExpression(variantRef)
  const publicVersion = effectiveVersionIdExpression(variantRef)
  const factor = '(10000 - cr.discount_basis_points)'
  // Divide first to avoid overflowing SQLite's integer multiplication.
  const discounted = `MAX(1, ((${publicGross} / 10000) * ${factor} + ((${publicGross} % 10000) * ${factor} + 5000) / 10000))`
  const projection =
    field === 'gross'
      ? `CASE WHEN vr.variant_id IS NOT NULL THEN vr.unit_gross_cents ELSE ${discounted} END`
      : field === 'source'
        ? `CASE WHEN vr.variant_id IS NOT NULL THEN 'b2b_variant' ELSE 'b2b_category' END`
        : `CASE WHEN vr.variant_id IS NOT NULL THEN 'b2b:' || l.id || ':v' || l.version || ':a' || a.version || ':variant:' || ${variantRef}.id
          ELSE 'b2b:' || l.id || ':v' || l.version || ':a' || a.version || ':category:' || p.category_id || ':' || ${publicVersion} END`
  return `(SELECT ${projection}
    FROM companies company
    JOIN customers customer ON customer.id=company.customer_id AND customer.status='active'
    JOIN b2b_company_assignments a ON a.company_id=company.id AND a.active=1
    JOIN b2b_price_lists l ON l.id=a.price_list_id AND l.status='active'
    JOIN products p ON p.id=${variantRef}.product_id
    LEFT JOIN b2b_variant_rules vr ON vr.price_list_id=l.id AND vr.variant_id=${variantRef}.id
    LEFT JOIN b2b_category_rules cr ON cr.price_list_id=l.id AND cr.category_id=p.category_id
    WHERE customer.id=${customerRef} AND company.status='approved'
      AND strftime('%Y-%m-%dT%H:%M:%fZ',a.valid_from)<=${PRICE_INSTANT_TOKEN}
      AND (a.valid_until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',a.valid_until)>${PRICE_INSTANT_TOKEN})
      AND strftime('%Y-%m-%dT%H:%M:%fZ',l.valid_from)<=${PRICE_INSTANT_TOKEN}
      AND (l.valid_until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',l.valid_until)>${PRICE_INSTANT_TOKEN})
      AND (vr.variant_id IS NOT NULL OR cr.category_id IS NOT NULL)
    LIMIT 1)`
}

/** Contractual effective gross with public fallback; customerRef is trusted SQL. */
export function effectiveB2BGrossCentsExpression(variantRef: string, customerRef: string): string {
  return `COALESCE(${b2bRuleExpression(variantRef, customerRef, 'gross')}, ${effectiveGrossCentsExpression(variantRef)})`
}

/** Contractual identity embeds both tariff and assignment versions. */
export function effectiveB2BVersionIdExpression(variantRef: string, customerRef: string): string {
  return `COALESCE(${b2bRuleExpression(variantRef, customerRef, 'version')}, ${effectiveVersionIdExpression(variantRef)})`
}

/** Source is derived from matching rows, not from public version identifiers. */
export function effectiveB2BSourceExpression(variantRef: string, customerRef: string): string {
  return `COALESCE(${b2bRuleExpression(variantRef, customerRef, 'source')}, 'public')`
}
