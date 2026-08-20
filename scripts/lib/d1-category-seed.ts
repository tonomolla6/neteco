import { createHash } from 'node:crypto'
import { CATEGORIES } from '../../server/db/seed'
import { slugify } from '../../server/utils/slug'

function stableUuid(value: string) {
  const bytes = createHash('sha256').update(`neteco:${value}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sqlText(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

export function renderD1CategorySeed() {
  const sourceId = stableUuid('source:neteco-demo')
  const statements = [
    'BEGIN TRANSACTION;',
    `INSERT INTO catalog_sources (id, code, name, owner, kind, is_master)
VALUES (${sqlText(sourceId)}, 'neteco-demo', 'Catálogo sintético NETECO', 'Producto', 'neteco', 1)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name,
  owner = excluded.owner,
  kind = excluded.kind,
  is_master = excluded.is_master;`
  ]

  for (const [legacyId, name, parentLegacyId] of CATEGORIES) {
    const id = stableUuid(`category:${legacyId}`)
    const parentId = parentLegacyId === null ? 'NULL' : sqlText(stableUuid(`category:${parentLegacyId}`))
    statements.push(`INSERT INTO categories (
  id, legacy_id, parent_id, name, slug, status, sort_order, source_id, source_version
) VALUES (
  ${sqlText(id)}, ${legacyId}, ${parentId}, ${sqlText(name)}, ${sqlText(slugify(name))},
  'published', ${legacyId}, ${sqlText(sourceId)}, 'demo-v1'
)
ON CONFLICT (id) DO UPDATE SET
  parent_id = excluded.parent_id,
  name = excluded.name,
  slug = excluded.slug,
  status = excluded.status,
  sort_order = excluded.sort_order,
  source_id = excluded.source_id,
  source_version = excluded.source_version,
  updated_at = CURRENT_TIMESTAMP;`)
  }

  statements.push('COMMIT;')
  return `${statements.join('\n\n')}\n`
}
