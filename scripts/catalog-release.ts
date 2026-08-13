import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import postgres, { type TransactionSql } from 'postgres'
import { z } from 'zod'

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const sql = postgres(connection, { max: 1, connect_timeout: 10 })

const tableNames = [
  'catalog_sources',
  'media_assets',
  'brands',
  'categories',
  'tax_classes',
  'shipping_profiles',
  'products',
  'variants',
  'product_media',
  'product_relations'
] as const
type TableName = (typeof tableNames)[number]

const payloadSchema = z
  .object({
    format: z.literal('neteco-catalog-release-v1'),
    version: z.string().regex(/^[a-zA-Z0-9._-]{3,80}$/),
    createdAt: z.string().datetime(),
    tables: z.record(z.enum(tableNames), z.array(z.record(z.string(), z.unknown())).max(250_000))
  })
  .strict()
const releaseSchema = z
  .object({
    payload: payloadSchema,
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

function checksum(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function quotedIdentifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe database identifier: ${value}`)
  return `"${value}"`
}

async function columns(transaction: TransactionSql, table: TableName) {
  const result = await transaction<{ columnName: string }[]>`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND is_generated = 'NEVER'
    ORDER BY ordinal_position
  `
  if (!result.length) throw new Error(`Catalog release table ${table} is missing`)
  return result.map((row) => row.columnName)
}

async function exportRelease(path: string, version: string) {
  const tables = {} as Record<TableName, Record<string, unknown>[]>
  for (const table of tableNames) {
    const result = await sql.unsafe<Array<{ row: Record<string, unknown> }>>(
      `SELECT to_jsonb(source) AS row FROM ${quotedIdentifier(table)} source ORDER BY to_jsonb(source)::text`
    )
    tables[table] = result.map((item) => item.row)
  }
  if (tables.catalog_sources.filter((source) => source.is_master === true).length !== 1) {
    throw new Error('Catalog release requires exactly one declared master source')
  }
  const payload = payloadSchema.parse({
    format: 'neteco-catalog-release-v1',
    version,
    createdAt: new Date().toISOString(),
    tables
  })
  const release = { payload, checksumSha256: checksum(payload) }
  await writeFile(path, `${JSON.stringify(release, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  process.stdout.write(
    `${JSON.stringify({
      event: 'catalog.release.exported',
      version,
      checksumSha256: release.checksumSha256,
      path,
      products: tables.products.length,
      variants: tables.variants.length
    })}\n`
  )
}

async function insertRows(transaction: TransactionSql, table: TableName, rows: Record<string, unknown>[]) {
  if (!rows.length) return
  const tableColumns = await columns(transaction, table)
  const names = tableColumns.map(quotedIdentifier).join(', ')
  await transaction.unsafe(
    `INSERT INTO ${quotedIdentifier(table)} (${names})
     SELECT ${names} FROM jsonb_populate_recordset(NULL::${quotedIdentifier(table)}, $1::jsonb)`,
    [JSON.stringify(rows)]
  )
}

async function applyRelease(path: string) {
  const source = await readFile(path, 'utf8')
  if (Buffer.byteLength(source) > 100_000_000) throw new Error('Catalog release exceeds the 100 MB safety limit')
  const release = releaseSchema.parse(JSON.parse(source))
  const actualChecksum = checksum(release.payload)
  if (actualChecksum !== release.checksumSha256) throw new Error('Catalog release checksum verification failed')
  const expectedConfirmation = `release:${release.payload.version}:${actualChecksum}`
  if (process.env.APP_ENV === 'production' && process.env.CATALOG_RELEASE_CONFIRM !== expectedConfirmation) {
    throw new Error(`Set CATALOG_RELEASE_CONFIRM=${expectedConfirmation} after reviewing the production diff`)
  }
  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('neteco:catalog-release'))`
    const [existingRelease] = await transaction<{ existing: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM catalog_releases WHERE version = ${release.payload.version}) AS existing
    `
    if (existingRelease?.existing) throw new Error('Catalog release version already exists')
    for (const table of tableNames) {
      const [state] = await transaction.unsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${quotedIdentifier(table)}`
      )
      if (!state || state.count > 0) {
        throw new Error(`Catalog release requires an empty target; ${table} already contains records`)
      }
    }
    const categories = release.payload.tables.categories
    const categoriesWithoutParents = categories.map((category) => ({ ...category, parent_id: null }))
    for (const table of tableNames) {
      await insertRows(
        transaction,
        table,
        table === 'categories' ? categoriesWithoutParents : release.payload.tables[table]
      )
    }
    if (categories.length) {
      await transaction.unsafe(
        `UPDATE categories target SET parent_id = source.parent_id
         FROM jsonb_populate_recordset(NULL::categories, $1::jsonb) source
         WHERE target.id = source.id`,
        [JSON.stringify(categories)]
      )
    }
    const masterSources = release.payload.tables.catalog_sources.filter((source) => source.is_master === true)
    if (masterSources.length !== 1 || typeof masterSources[0]?.id !== 'string') {
      throw new Error('Catalog release must contain one master source')
    }
    const [batch] = await transaction<{ id: string }[]>`
      INSERT INTO catalog_import_batches (
        source_id, source_version, checksum_sha256, status, preview_summary,
        validation_report, applied_at
      ) VALUES (
        ${masterSources[0].id}, ${release.payload.version}, ${actualChecksum}, 'applied',
        ${transaction.json({
          products: release.payload.tables.products.length,
          variants: release.payload.tables.variants.length,
          categories: categories.length,
          assets: release.payload.tables.media_assets.length
        })}, '[]'::jsonb, now()
      ) RETURNING id
    `
    await transaction`
      INSERT INTO catalog_releases (
        version, checksum_sha256, import_batch_id, status, product_count,
        variant_count, manifest, released_at
      ) VALUES (
        ${release.payload.version}, ${actualChecksum}, ${batch!.id}, 'released',
        ${release.payload.tables.products.length}, ${release.payload.tables.variants.length},
        ${transaction.json({ format: release.payload.format, createdAt: release.payload.createdAt })}, now()
      )
    `
  })
  process.stdout.write(
    `${JSON.stringify({
      event: 'catalog.release.applied',
      version: release.payload.version,
      checksumSha256: actualChecksum,
      products: release.payload.tables.products.length,
      variants: release.payload.tables.variants.length
    })}\n`
  )
}

try {
  const [command, path, version] = process.argv.slice(2)
  if (command === 'export' && path && version) await exportRelease(path, version)
  else if (command === 'apply' && path) await applyRelease(path)
  else throw new Error('Usage: catalog-release export <new-file.json> <version> | apply <file.json>')
} finally {
  await sql.end({ timeout: 5 })
}
