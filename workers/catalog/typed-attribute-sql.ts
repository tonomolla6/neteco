import {
  CATALOG_TYPED_ATTRIBUTE_MAX_DEFINITIONS,
  CATALOG_TYPED_ATTRIBUTE_MAX_SELECTIONS
} from '../../shared/catalog-typed-attributes'

export interface TypedAttributeEntrySqlOptions {
  entrySql: string
  definitionAlias: string
  revisionAlias: string
  categoryIdSql: string
  productIdSql?: string
  mode: 'historical' | 'write'
}

const aliases = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const trimCharacters =
  'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)'
const object = (expression: string) =>
  `CASE WHEN json_valid(${expression}) THEN CASE WHEN json_type(${expression})='object' THEN ${expression} ELSE '{}' END ELSE '{}' END`
const uuid = (value: string) => `(typeof(${value})='text' AND length(${value})=36 AND instr(${value},char(0))=0
  AND substr(${value},9,1)='-' AND substr(${value},14,1)='-' AND substr(${value},19,1)='-' AND substr(${value},24,1)='-'
  AND length(replace(${value},'-',''))=32 AND replace(${value},'-','') NOT GLOB '*[^0-9a-f]*')`
const code = (
  value: string
) => `(typeof(${value})='text' AND length(${value}) BETWEEN 1 AND 64 AND instr(${value},char(0))=0
  AND ${value} GLOB '[a-z]*' AND ${value} NOT GLOB '*[^a-z0-9_-]*')`

/** Public category authority mirrors publication validity: every ancestor must
 * be published and mapped, and a root must be reached without a cycle within
 * the same bounded traversal. This is visibility, not definition inheritance.
 * categoryIdSql is a trusted internal expression, never request data. */
export function typedAttributePublicCategoryValiditySql(categoryIdSql: string): string {
  return `(WITH RECURSIVE typed_category_ancestors AS (
    SELECT id,parent_id,status,legacy_id,0 AS depth,0 AS cycle,json_array(id) AS visited
    FROM categories WHERE id=${categoryIdSql}
    UNION ALL SELECT parent.id,parent.parent_id,parent.status,parent.legacy_id,child.depth+1,
      EXISTS(SELECT 1 FROM json_each(child.visited) WHERE value=parent.id),json_insert(child.visited,'$[#]',parent.id)
    FROM typed_category_ancestors child JOIN categories parent ON parent.id=child.parent_id
    WHERE child.cycle=0 AND child.depth<128
  ) SELECT EXISTS(SELECT 1 FROM typed_category_ancestors WHERE parent_id IS NULL)
    AND NOT EXISTS(SELECT 1 FROM typed_category_ancestors WHERE cycle=1 OR status<>'published'
      OR legacy_id IS NULL OR legacy_id NOT BETWEEN 1 AND 9007199254740991))`
}

/** SQL expressions are trusted internal fragments, never HTTP data. JSON may
 * nevertheless contain arbitrary scalar entries. CASE, not AND ordering, makes
 * every JSON function safe. Missing namespace is deliberately not accepted. */
export function typedAttributeNamespaceValiditySql(namespaceSql: string): string {
  const ns = object(namespaceSql)
  const entry = object('typed_namespace_entry.value')
  return `(CASE WHEN json_valid(${namespaceSql}) THEN
    json_type(${namespaceSql})='object'
    AND (SELECT count(*) FROM json_each(${ns}))=2
    AND NOT EXISTS(SELECT 1 FROM json_each(${ns}) WHERE key NOT IN ('version','values'))
    AND json_type(${ns},'$.version') IN ('integer','real') AND json_extract(${ns},'$.version')=1
    AND json_type(${ns},'$.values')='array'
    AND json_array_length(${ns},'$.values')<=${CATALOG_TYPED_ATTRIBUTE_MAX_DEFINITIONS}
    AND NOT EXISTS(SELECT 1 FROM json_each(${ns},'$.values') typed_namespace_entry
      WHERE json_type(${entry},'$.definitionId')='text'
      GROUP BY json_extract(${entry},'$.definitionId') HAVING count(*)>1)
    ELSE 0 END)`
}

function text(value: string, maximum: string) {
  // Zod counts UTF-16 code units; SQLite length counts Unicode code points.
  // At most maxLength (<=500) code points are inspected, never unbounded text.
  return `(CASE WHEN typeof(${value})='text' AND length(${value}) BETWEEN 1 AND ${maximum}
    AND instr(${value},char(0))=0 AND length(trim(${value},${trimCharacters}))>0 THEN
    (WITH RECURSIVE typed_chars(n) AS (
      SELECT 1 UNION ALL SELECT n+1 FROM typed_chars WHERE n<length(${value})
    ) SELECT sum(CASE WHEN unicode(substr(${value},n,1))>65535 THEN 2 ELSE 1 END)<=${maximum}
      AND sum(CASE WHEN unicode(substr(${value},n,1))<32 OR unicode(substr(${value},n,1))=127 THEN 1 ELSE 0 END)=0
      FROM typed_chars) ELSE 0 END)`
}
function number(value: string, type: string, config: string) {
  const precision = `json_extract(${config},'$.precision')`
  return `(${type} IN ('integer','real') AND abs(${value})<=1000000000
    AND json_type(${config},'$.precision') IN ('integer','real') AND ${precision} BETWEEN 0 AND 6
    AND CAST(${precision} AS INTEGER)=${precision} AND round(${value},${precision})=${value}
    AND (json_type(${config},'$.min') IS NULL OR (json_type(${config},'$.min') IN ('integer','real') AND ${value}>=json_extract(${config},'$.min')))
    AND (json_type(${config},'$.max') IS NULL OR (json_type(${config},'$.max') IN ('integer','real') AND ${value}<=json_extract(${config},'$.max'))))`
}

/** Equivalent value rules to the shared validator for a caller-joined exact
 * revision. Existence/public eligibility of reference destinations is a caller
 * concern (writes may reference the same staged job). Historical mode does not
 * grant visibility to withdrawn definitions: public callers add current active.
 */
export function typedAttributeEntryValiditySql(options: TypedAttributeEntrySqlOptions): string {
  const { entrySql, definitionAlias: d, revisionAlias: r, categoryIdSql, productIdSql, mode } = options
  if (!aliases.test(d) || !aliases.test(r) || !['historical', 'write'].includes(mode))
    throw new Error('invalid_typed_attribute_sql')
  const entry = object(entrySql),
    value = `json_extract(${entry},'$.value')`,
    type = `json_type(${entry},'$.value')`
  const valueObject = object(`${entry} -> '$.value'`),
    config = `${r}.config`
  const array = `CASE WHEN ${type}='array' THEN ${entry} -> '$.value' ELSE '[]' END`
  return `(CASE WHEN json_valid(${entrySql}) THEN json_type(${entrySql})='object'
    AND (SELECT count(*) FROM json_each(${entry}))=3
    AND NOT EXISTS(SELECT 1 FROM json_each(${entry}) WHERE key NOT IN ('definitionId','revision','value'))
    AND ${uuid(`json_extract(${entry},'$.definitionId')`)}
    AND json_extract(${entry},'$.definitionId')=${d}.id AND ${r}.definition_id=${d}.id
    AND ${d}.category_id=${categoryIdSql}
    AND json_type(${entry},'$.revision') IN ('integer','real')
    AND json_extract(${entry},'$.revision') BETWEEN 1 AND 9007199254740990
    AND json_extract(${entry},'$.revision')=${r}.revision
    ${mode === 'write' ? `AND ${d}.status='active' AND ${r}.status='active' AND ${r}.revision=${d}.current_revision` : ''}
    AND CASE ${d}.kind
      WHEN 'text' THEN ${type}='text' AND ${text(value, `json_extract(${config},'$.maxLength')`)}
      WHEN 'number' THEN ${number(value, type, config)}
      WHEN 'unit' THEN ${type}='object' AND (SELECT count(*) FROM json_each(${valueObject}))=2
        AND NOT EXISTS(SELECT 1 FROM json_each(${valueObject}) WHERE key NOT IN ('quantity','unit'))
        AND ${number(`json_extract(${valueObject},'$.quantity')`, `json_type(${valueObject},'$.quantity')`, config)}
        AND json_type(${valueObject},'$.unit')='text'
        AND EXISTS(SELECT 1 FROM json_each(${config},'$.units') WHERE type='text' AND value=json_extract(${valueObject},'$.unit'))
      WHEN 'boolean' THEN ${type} IN ('true','false')
      WHEN 'list' THEN ${type}='array' AND json_array_length(${array})<=${CATALOG_TYPED_ATTRIBUTE_MAX_SELECTIONS}
        AND (SELECT count(*) FROM json_each(${array}))=(SELECT count(DISTINCT value) FROM json_each(${array}))
        AND NOT EXISTS(SELECT 1 FROM json_each(${array}) typed_option WHERE typed_option.type<>'text' OR NOT ${code('typed_option.value')}
          OR NOT EXISTS(SELECT 1 FROM json_each(${config},'$.options') allowed
            WHERE json_extract(allowed.value,'$.code')=typed_option.value ${mode === 'write' ? "AND json_extract(allowed.value,'$.status')='active'" : ''}))
      WHEN 'reference' THEN ${type}='text' AND ${uuid(value)} ${productIdSql ? `AND ${value}<>${productIdSql}` : ''}
      ELSE 0 END ELSE 0 END)`
}
