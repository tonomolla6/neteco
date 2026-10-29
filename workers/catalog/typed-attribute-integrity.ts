import { publicationValidityExpression } from './publication-validity'
import { typedAttributeEntryValiditySql, typedAttributeNamespaceValiditySql } from './typed-attribute-sql'

export interface CatalogTypedAttributeIntegritySqlOptions {
  sourceSql: string
  mode: 'write' | 'historical'
  clockSql: string
  requirePublicReferences?: boolean
  prefix?: string
}

/** Trusted SQL sources return id, category_id and attributes; callers bound
 * their rows and perform their own live identity/authority checks. Historical
 * retention does not reinterpret references unless public eligibility is
 * explicitly required. Reference publication is independent of typed data.
 * Materialized scalar checks keep final command guards within D1 expression
 * depth, without loading catalogue IDs into application memory. */
export function catalogTypedAttributeIntegrityCtes(options: CatalogTypedAttributeIntegritySqlOptions): {
  ctes: string
  validitySql: string
} {
  const { sourceSql, mode, clockSql, prefix = 'typed_integrity', requirePublicReferences = mode === 'write' } = options
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(prefix) || !['write', 'historical'].includes(mode))
    throw new Error('invalid_typed_attribute_integrity_sql')
  const source = `${prefix}_source`,
    namespaces = `${prefix}_namespaces`,
    checks = `${prefix}_checks`,
    entries = `${prefix}_entries`,
    definition = `${prefix}_definition`,
    revision = `${prefix}_revision`,
    referenceIds = `${prefix}_reference_ids`,
    references = `${prefix}_references`,
    reference = `${prefix}_ref`,
    rules = `${prefix}_rules`
  // Validate the supplied trusted clock through the existing publication
  // builder even when historical retention does not need public references.
  const publication = publicationValidityExpression(reference, clockSql)
  const entryValid = typedAttributeEntryValiditySql({
    entrySql: 'entry.value',
    definitionAlias: definition,
    revisionAlias: revision,
    categoryIdSql: 'entry.category_id',
    productIdSql: 'entry.id',
    mode
  })
  return {
    ctes: `${source} AS MATERIALIZED (${sourceSql}),
    ${namespaces} AS MATERIALIZED (
      SELECT id,category_id,json_valid(attributes) AS attributes_valid,
        CASE WHEN json_valid(attributes) THEN attributes -> '$.typed' ELSE 'null' END AS namespace
      FROM ${source}
    ), ${checks} AS MATERIALIZED (
      SELECT *,${typedAttributeNamespaceValiditySql('namespace')} AS namespace_valid FROM ${namespaces}
    ), ${entries} AS MATERIALIZED (
      SELECT checked.id,checked.category_id,CASE WHEN value.type='object' THEN value.value ELSE '{}' END AS value
      FROM ${checks} checked CROSS JOIN json_each(
        CASE WHEN checked.namespace_valid=1 THEN checked.namespace ELSE '{"values":[]}' END,'$.values') value
    ), ${referenceIds} AS MATERIALIZED (
      SELECT DISTINCT json_extract(entry.value,'$.value') AS id
      FROM ${entries} entry CROSS JOIN catalog_typed_attribute_definitions ${definition}
        ON ${definition}.id=json_extract(entry.value,'$.definitionId')
      WHERE ${definition}.kind='reference' AND json_type(entry.value,'$.value')='text'
    ), ${references} AS MATERIALIZED (
      SELECT ${reference}.id,${publication} AS eligible
      FROM ${referenceIds} needed CROSS JOIN products ${reference} ON ${reference}.id=needed.id
      WHERE ${reference}.status='published' AND ${reference}.legacy_id BETWEEN 1 AND 9007199254740991
        AND EXISTS(SELECT 1 FROM variants public_variant WHERE public_variant.product_id=${reference}.id
          AND public_variant.status='published' AND public_variant.legacy_id BETWEEN 1 AND 9007199254740991)
    ), ${rules} AS MATERIALIZED (
      SELECT ${entryValid} AS entry_valid,
        ${
          requirePublicReferences
            ? `CASE WHEN ${definition}.kind='reference' THEN EXISTS(
          SELECT 1 FROM ${references} public_reference
          WHERE public_reference.id=json_extract(entry.value,'$.value') AND public_reference.eligible=1) ELSE 1 END`
            : '1'
        } AS reference_valid
      FROM ${entries} entry LEFT JOIN catalog_typed_attribute_definitions ${definition}
        ON ${definition}.id=json_extract(entry.value,'$.definitionId')
      LEFT JOIN catalog_typed_attribute_revisions ${revision} ON ${revision}.definition_id=${definition}.id
        AND ${revision}.revision=json_extract(entry.value,'$.revision')
    )`,
    validitySql: `NOT EXISTS(SELECT 1 FROM ${checks} WHERE attributes_valid IS NOT 1
        OR (namespace IS NOT NULL AND namespace_valid IS NOT 1))
      AND NOT EXISTS(SELECT 1 FROM ${rules} WHERE entry_valid IS NOT 1 OR reference_valid IS NOT 1)`
  }
}

/** Scalar read/guard form; intake batches can lift the very same CTEs to their
 * top-level WITH rather than adding nested expression depth around this form. */
export function catalogTypedAttributeIntegritySql(options: CatalogTypedAttributeIntegritySqlOptions): string {
  const { ctes, validitySql } = catalogTypedAttributeIntegrityCtes(options)
  return `(WITH ${ctes} SELECT ${validitySql})`
}
