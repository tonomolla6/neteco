import { REQUIRED_PUBLICATION_FIELDS, PUBLICATION_DOCUMENT_ROLES } from '../../shared/catalog-publication-policy'
import { eligibleMediaEvidenceSql } from '../media/evidence-sql'
import { resolvePricingInstant } from './pricing'

const aliases = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const hasControls = (value: string) =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
function clock(value?: string) {
  if (value === undefined) return "'now'"
  if (typeof value !== 'string' || hasControls(value)) throw new Error('invalid_publication_clock_sql')
  if (value === '(SELECT now FROM gate_clock)') return value
  if (/^\?(?:[1-9]|[1-9]\d|100)$/.test(value)) return value
  if (/^COALESCE\(\?(?:[1-9]|[1-9]\d|100),'now'\)$/.test(value)) return value
  throw new Error('invalid_publication_clock_sql')
}
const values = (items: readonly string[]) => items.map((item) => `'${item}'`).join(',')
function booleanExpression(operator: 'AND' | 'OR', clauses: readonly string[]): string {
  if (clauses.length === 1) return `(${clauses[0]})`
  if (!clauses.length) throw new Error('empty_publication_conjunction')
  const middle = Math.floor(clauses.length / 2)
  return `(${booleanExpression(operator, clauses.slice(0, middle))} ${operator} ${booleanExpression(operator, clauses.slice(middle))})`
}
const conjunction = (clauses: readonly string[]) => booleanExpression('AND', clauses)
const disjunction = (clauses: readonly string[]) => booleanExpression('OR', clauses)
function sumExpression(terms: readonly string[]): string {
  if (terms.length === 1) return `(${terms[0]})`
  if (!terms.length) throw new Error('empty_publication_sum')
  const middle = Math.floor(terms.length / 2)
  return `(${sumExpression(terms.slice(0, middle))}+${sumExpression(terms.slice(middle))})`
}
// ECMAScript String.trim whitespace, not SQLite's space-only default. Policy
// fields and identifiers must not become present through newline/Unicode space.
const trimCharacters =
  'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)'
const trimmed = (expression: string) => `trim(${expression},${trimCharacters})`
// SQL counterpart of domain validGtin, required at execution-time guards. The
// parity regression imports that existing function; this is not a policy rule.
function validGtinSql(value: string) {
  // Left zero-padding to fourteen digits preserves each supported checksum's
  // right-to-left weights. A balanced fixed sum avoids a deep scalar SELECT.
  const padded = `substr('00000000000000'||${value},-14,14)`
  const checksum = sumExpression(
    Array.from({ length: 13 }, (_, index) => `CAST(substr(${padded},${index + 1},1) AS INTEGER)*${index % 2 ? 1 : 3}`)
  )
  return conjunction([
    `length(${value}) IN (8,12,13,14)`,
    `${value} NOT GLOB '*[^0-9]*'`,
    `instr(${value},char(0))=0`,
    `(10-(${checksum}%10))%10=CAST(substr(${value},length(${value}),1) AS INTEGER)`
  ])
}

/** Current governing evidence, independent of editorial state or inventory.
 * Callers retain their own published-product/variant gates. No historical
 * publication grants missing-policy exemptions, stock availability or R2 bytes.
 * SQL's execution clock is the default; explicit clocks are internal tests/gate.
 */
export function publicationValidityExpression(productAlias: string, clockSql?: string): string {
  if (typeof productAlias !== 'string' || !aliases.test(productAlias) || /[\r\n]/.test(productAlias))
    throw new Error('invalid_publication_product_alias')
  const instant = clock(clockSql),
    product = `${productAlias}.id`
  const evidence = eligibleMediaEvidenceSql().replace('SELECT ? AS now', 'SELECT now FROM validity_clock')
  const regulatory = `CASE WHEN json_valid(${productAlias}.regulatory) THEN ${productAlias}.regulatory ELSE 'null' END`
  const eligibleException = conjunction([
    `exception.id IS NOT NULL`,
    `length(${trimmed('exception.reason')})>=10`,
    `length(${trimmed('exception.evidence_reference')})>=3`,
    `exception.created_at<=validity_clock.now`,
    `exception.valid_from<=validity_clock.now`,
    `(exception.valid_until IS NULL OR exception.valid_until>validity_clock.now)`,
    `NOT EXISTS(SELECT 1 FROM catalog_variant_identifier_exception_withdrawals WHERE exception_id=exception.id)`
  ])
  const invalidVariant = disjunction([
    `tax.id IS NULL`,
    `tax.rate_basis_points NOT BETWEEN 0 AND 10000`,
    `variant.legacy_id IS NULL`,
    `variant.legacy_id NOT BETWEEN 1 AND 9007199254740991`,
    `(COALESCE(variant.ean,'')<>'' AND NOT variant.valid_ean)`,
    `(COALESCE(variant.gtin,'')<>'' AND NOT variant.valid_gtin)`,
    `COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',tax.valid_from)<=validity_clock.milliseconds,0)=0`,
    `(tax.valid_until IS NOT NULL AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',tax.valid_until)>validity_clock.milliseconds,0)=0)`,
    conjunction([
      `COALESCE(variant.ean,'')=''`,
      `COALESCE(variant.gtin,'')=''`,
      `length(${trimmed("COALESCE(variant.mpn,'')")})=0`,
      `(policy.identifier_exceptions_allowed<>1 OR NOT COALESCE(exception.evidence_valid,0))`
    ])
  ])
  // Evaluate the same boolean requirements as a bounded JSON set, rather than
  // making every nested subquery inherit one large enclosing WHERE height.
  // Only integer 1 passes; false and SQL NULL both fail as in a WHERE AND chain.
  const requirements = [
    `validity_clock.now IS NOT NULL`,
    `policy.created_at<=validity_clock.now AND policy.assignment_created_at<=validity_clock.now`,
    `policy.valid_from<=validity_clock.now AND (policy.valid_until IS NULL OR policy.valid_until>validity_clock.now)`,
    `NOT EXISTS(SELECT 1 FROM catalog_publication_policy_withdrawals WHERE policy_id=policy.id)`,
    `json_type(${regulatory})='object'`,
    `json_type(${regulatory},'$.productType')='text' AND json_extract(${regulatory},'$.productType')=policy.code`,
    `json_type(${regulatory},'$.requiresSds') IN ('true','false')`,
    `EXISTS(SELECT 1 FROM brands WHERE id=${productAlias}.brand_id AND status='published')`,
    `EXISTS(SELECT 1 FROM validity_ancestors WHERE parent_id IS NULL)`,
    `NOT EXISTS(SELECT 1 FROM validity_ancestors WHERE cycle=1 OR status<>'published' OR legacy_id IS NULL
        OR legacy_id NOT BETWEEN 1 AND 9007199254740991)`,
    `json_type(policy.required_fields)='array' AND json_type(policy.required_media_roles)='array'`,
    `NOT EXISTS(SELECT 1 FROM json_each(policy.required_fields) WHERE type<>'text' OR value NOT IN (${values(REQUIRED_PUBLICATION_FIELDS)}))`,
    `NOT EXISTS(SELECT 1 FROM json_each(policy.required_media_roles) WHERE type<>'text' OR value NOT IN (${values(PUBLICATION_DOCUMENT_ROLES)}))`,
    `(SELECT count(DISTINCT value) FROM json_each(policy.required_fields))=json_array_length(policy.required_fields)`,
    `(SELECT count(DISTINCT value) FROM json_each(policy.required_media_roles))=json_array_length(policy.required_media_roles)`,
    `NOT EXISTS(SELECT 1 FROM json_each(policy.required_fields) field WHERE CASE field.value
        WHEN 'usage' THEN COALESCE(length(${trimmed(`${productAlias}.usage`)})>0,0)
        WHEN 'series' THEN COALESCE(length(${trimmed(`${productAlias}.series`)})>0,0)
        WHEN 'regulatory.requiresSds' THEN json_type(${regulatory},'$.requiresSds') IN ('true','false')
        ELSE COALESCE(json_type(${regulatory},'$.'||substr(field.value,12))='text'
          AND length(${trimmed(`json_extract(${regulatory},'$.'||substr(field.value,12))`)})>0,0) END=0)`,
    `EXISTS(SELECT 1 FROM validity_media media WHERE ${conjunction([
      `media.product_id=${product}`,
      `media.variant_id IS NULL`,
      `media.role='main'`,
      `length(${trimmed('media.alt')})>=5`,
      `julianday(media.authorized_at) IS NOT NULL`,
      `julianday(media.authorized_at)<=julianday(validity_clock.now)`
    ])})`,
    `EXISTS(SELECT 1 FROM validity_variants)`,
    `(SELECT count(*) FROM validity_variants)<=500`,
    `NOT EXISTS(SELECT 1 FROM validity_roles role CROSS JOIN validity_variants variant
        LEFT JOIN validity_media product_media ON product_media.product_id=${product}
          AND product_media.role=role.role AND product_media.variant_id IS NULL
        LEFT JOIN validity_media variant_media ON variant_media.product_id=${product}
          AND variant_media.role=role.role AND variant_media.variant_id=variant.id
        WHERE product_media.id IS NULL AND variant_media.id IS NULL)`,
    `NOT EXISTS(SELECT 1 FROM validity_variants variant LEFT JOIN tax_classes tax ON tax.id=variant.tax_class_id
        LEFT JOIN validity_current_exceptions exception ON exception.variant_id=variant.id
        WHERE ${invalidVariant})`
  ]
  return `(WITH RECURSIVE validity_clock AS MATERIALIZED (
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ',${instant}) AS now,
      strftime('%Y-%m-%dT%H:%M:%fZ',${instant}) AS milliseconds
  ), validity_policy AS MATERIALIZED (
    SELECT policy.*,assignment.created_at AS assignment_created_at
    FROM catalog_product_publication_policies assignment JOIN catalog_publication_policies policy ON policy.id=assignment.policy_id
    WHERE assignment.product_id=${product} ORDER BY assignment.seq DESC LIMIT 1
  ), validity_media AS MATERIALIZED (${evidence}), validity_variants AS MATERIALIZED (
    SELECT v.*,${validGtinSql('v.ean')} AS valid_ean,${validGtinSql('v.gtin')} AS valid_gtin
    FROM variants v WHERE v.product_id=${product} AND v.status<>'discontinued'
  ), validity_exception_candidates AS MATERIALIZED (
    SELECT exception.*,COALESCE(${eligibleException},0) AS evidence_valid,row_number() OVER (
      PARTITION BY exception.variant_id ORDER BY exception.valid_from DESC,exception.created_at DESC,exception.id DESC
    ) AS current_position
    FROM catalog_variant_identifier_exceptions exception JOIN validity_variants variant ON variant.id=exception.variant_id
    CROSS JOIN validity_clock WHERE ${conjunction([
      `exception.created_at<=validity_clock.now`,
      `exception.valid_from<=validity_clock.now`,
      `(exception.valid_until IS NULL OR exception.valid_until>validity_clock.now)`,
      `NOT EXISTS(SELECT 1 FROM catalog_variant_identifier_exception_withdrawals WHERE exception_id=exception.id)`
    ])}
  ), validity_current_exceptions AS MATERIALIZED (
    SELECT * FROM validity_exception_candidates WHERE current_position=1
  ), validity_ancestors AS (
    SELECT id,parent_id,status,legacy_id,0 AS depth,0 AS cycle,json_array(id) AS visited FROM categories WHERE id=${productAlias}.category_id
    UNION ALL SELECT parent.id,parent.parent_id,parent.status,parent.legacy_id,child.depth+1,
      EXISTS(SELECT 1 FROM json_each(child.visited) WHERE value=parent.id),json_insert(child.visited,'$[#]',parent.id)
    FROM validity_ancestors child JOIN categories parent ON parent.id=child.parent_id WHERE child.cycle=0 AND child.depth<128
  ), validity_roles AS MATERIALIZED (
    SELECT value AS role FROM validity_policy,json_each(required_media_roles)
    UNION SELECT 'sds' WHERE json_type(${regulatory},'$.requiresSds')='true'
  ) SELECT EXISTS(SELECT 1 FROM validity_policy policy CROSS JOIN validity_clock
    WHERE NOT EXISTS(SELECT 1 FROM json_each(json_array(${requirements.join(',')})) WHERE value IS NOT 1)
  ))`
}

/** Final, bounded authority read after asynchronous DTO enrichment. Never
 * emit a partial list with stale totals/facets when a product became invalid.
 * Passing a clock is an explicit internal test seam, never an HTTP option.
 */
export async function assertCurrentPublicationValidity(
  database: D1Database,
  productIds: readonly string[],
  now?: string,
  projection?: { variantIds?: readonly string[]; mediaIds?: readonly string[] }
) {
  const ids = [...new Set(productIds)]
  if (!ids.length) return
  const variants = [...new Set(projection?.variantIds ?? [])],
    media = [...new Set(projection?.mediaIds ?? [])]
  const payloads = [ids, variants, media].map((entries) => {
    if (
      entries.length > 1000 ||
      entries.some((id) => typeof id !== 'string' || !id || id.length > 200 || hasControls(id))
    )
      throw new Error('invalid_publication_validity_ids')
    const payload = JSON.stringify(entries)
    if (new TextEncoder().encode(payload).byteLength > 256 * 1024) throw new Error('invalid_publication_validity_ids')
    return payload
  })
  const pinned = now === undefined ? null : resolvePricingInstant({ instant: now })
  const evidence = eligibleMediaEvidenceSql().replace(
    'SELECT ? AS now',
    "SELECT strftime('%Y-%m-%dT%H:%M:%SZ',COALESCE(?2,'now')) AS now"
  )
  const result = await database
    .prepare(
      `WITH current_media AS (${evidence})
    SELECT (SELECT count(*) FROM products p
      WHERE p.id IN (SELECT value FROM json_each(?1)) AND p.status='published'
        AND ${publicationValidityExpression('p', "COALESCE(?2,'now')")}) AS valid,
      (SELECT count(*) FROM variants v WHERE v.id IN (SELECT value FROM json_each(?3))
        AND v.product_id IN (SELECT value FROM json_each(?1)) AND v.status='published'
        AND v.legacy_id BETWEEN 1 AND 9007199254740991) AS variantsValid,
      (SELECT count(*) FROM current_media m LEFT JOIN variants v ON v.id=m.variant_id AND v.product_id=m.product_id
        WHERE m.id IN (SELECT value FROM json_each(?4)) AND m.product_id IN (SELECT value FROM json_each(?1))
          AND (m.variant_id IS NULL OR (v.status='published' AND v.legacy_id BETWEEN 1 AND 9007199254740991))) AS mediaValid`
    )
    .bind(payloads[0], pinned, payloads[1], payloads[2])
    .first<{ valid: number; variantsValid: number; mediaValid: number }>()
  if (
    !result ||
    !Number.isSafeInteger(result.valid) ||
    result.valid !== ids.length ||
    !Number.isSafeInteger(result.variantsValid) ||
    result.variantsValid !== variants.length ||
    !Number.isSafeInteger(result.mediaValid) ||
    result.mediaValid !== media.length
  )
    throw new Error('publication_validity_changed')
}

/** IDs from our own generated media URLs only, retained privately for the final
 * authority read. This is not a parser for caller URLs or a public DTO change. */
export function publicMediaProjectionIds(
  entries: Iterable<{
    image?: string
    variants: ReadonlyMap<string, { image: string }>
    documents: readonly { id: string }[]
  }>
) {
  const mediaIds = new Set<string>(),
    variantIds = new Set<string>()
  function imageId(url: string) {
    const match =
      /^\/media\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/image\?w=800&format=jpeg$/.exec(url)
    if (!match) throw new Error('invalid_publication_projection')
    mediaIds.add(match[1]!)
  }
  for (const entry of entries) {
    if (entry.image) imageId(entry.image)
    for (const [variantId, image] of entry.variants) {
      variantIds.add(variantId)
      imageId(image.image)
    }
    for (const document of entry.documents) mediaIds.add(document.id)
  }
  return { mediaIds: [...mediaIds], variantIds: [...variantIds] }
}

/** Anonymous bind fragment for existing read-only APIs' explicit test clock.
 * Production callers omit instant and use SQLite time without extra bindings.
 */
export function publicationValidityWithClock(productAlias: string, instant?: string) {
  if (instant === undefined) return { sql: publicationValidityExpression(productAlias), parameters: [] as string[] }
  const pinned = resolvePricingInstant({ instant }),
    sql = publicationValidityExpression(productAlias, '?1')
  return { sql: sql.replaceAll('?1', '?'), parameters: Array<string>(sql.split('?1').length - 1).fill(pinned) }
}
