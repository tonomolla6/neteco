import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { effectiveGrossCentsExpression, inlineEffectivePricingSql } from '../workers/catalog/pricing'
import { CATEGORIES, PRODUCTS } from '../server/db/seed'
import { stableUuid } from './lib/d1-category-seed'

const execute = promisify(execFile)
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const persistenceDirectory = await mkdtemp(join(tmpdir(), 'neteco-d1-catalog-audit-'))
const localArguments = ['--config', 'wrangler.canary.jsonc', '--local', '--persist-to', persistenceDirectory]

async function runWrangler(arguments_: string[]) {
  const { stdout } = await execute(executable, ['wrangler', ...arguments_], {
    cwd: process.cwd(),
    maxBuffer: 8 * 1024 * 1024
  })
  return stdout
}

function wrangler(arguments_: string[]) {
  return runWrangler(['d1', 'execute', 'DB', ...localArguments, '--yes', ...arguments_])
}

async function query(statements: string) {
  const output = await wrangler(['--json', '--command', statements])
  const result = JSON.parse(output) as Array<{ results: Array<Record<string, unknown>>; success: boolean }>
  if (!result.every((entry) => entry.success)) throw new Error('D1 statement failed')
  return result.map((entry) => entry.results)
}

const snapshotQuery = `
SELECT id, legacy_id, parent_id, name, slug, status, sort_order, source_id, source_version
FROM categories ORDER BY id;
SELECT id, legacy_id, category_id, brand_id, source_id, name, slug, short_description,
       description, usage, series, status, featured, attributes, source_version
FROM products ORDER BY id;
SELECT id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status,
       unit_label, content_quantity, price_gross_cents, weight_grams, width_mm, height_mm,
       depth_mm, source_version
FROM variants ORDER BY id;
SELECT id, variant_id, gross_cents, compare_at_gross_cents, reference_gross_cents_30d,
       volume_tiers, valid_from, valid_until, status, reason, created_by, created_at,
       cancelled_by, cancelled_at, cancellation_reason
FROM variant_price_versions ORDER BY id;
SELECT count(*) AS orphan_count
FROM categories child LEFT JOIN categories parent ON parent.id = child.parent_id
WHERE child.parent_id IS NOT NULL AND parent.id IS NULL;
SELECT count(*) AS orphan_price_version_count
FROM variant_price_versions version LEFT JOIN variants variant ON variant.id = version.variant_id
WHERE variant.id IS NULL;
SELECT count(*) AS fts_count FROM products_fts;
`.trim()

async function snapshot() {
  const result = JSON.parse(await wrangler(['--json', '--command', snapshotQuery])) as Array<{
    results: Array<Record<string, unknown>>
    success: boolean
  }>
  if (result.length !== 7 || result.some((entry) => !entry.success)) throw new Error('D1 catalog snapshot failed')
  return result.map((entry) => entry.results)
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

try {
  await runWrangler(['d1', 'migrations', 'apply', 'DB', ...localArguments])
  await wrangler(['--file', '.wrangler/generated/d1-demo-categories.sql'])
  await wrangler(['--file', '.wrangler/generated/d1-demo-products.sql'])
  const before = await snapshot()
  await wrangler(['--file', '.wrangler/generated/d1-demo-categories.sql'])
  await wrangler(['--file', '.wrangler/generated/d1-demo-products.sql'])
  const after = await snapshot()
  const canonicalDigest = digest(after)
  if (digest(before) !== canonicalDigest) throw new Error('D1 catalog seed is not idempotent')

  const expectedVariants = PRODUCTS.reduce((sum, product) => sum + product.variants.length, 0)
  const [categories, products, variants, priceVersions, orphans, priceOrphans, fts] = after
  if (categories!.length !== CATEGORIES.length) throw new Error('D1 category count differs from seed source')
  if (products!.length !== PRODUCTS.length) throw new Error('D1 product count differs from seed source')
  if (variants!.length !== expectedVariants) throw new Error('D1 variant count differs from seed source')
  if (priceVersions!.length !== expectedVariants) throw new Error('D1 initial price versions differ from variants')
  if (Number(orphans![0]?.orphan_count) !== 0) throw new Error('D1 catalog contains orphan categories')
  if (Number(priceOrphans![0]?.orphan_price_version_count) !== 0)
    throw new Error('D1 catalog contains orphan price versions')
  if (Number(fts![0]?.fts_count) !== PRODUCTS.length) throw new Error('D1 FTS index differs from products')

  // ---------------------------------------------------------------------------
  // Effective-price resolution scenarios against real D1.
  // Temporary rows use dedicated deterministic IDs and are removed afterwards;
  // a final canonical snapshot must match the digest captured above.
  // ---------------------------------------------------------------------------

  const probeVariantId = stableUuid('variant:1:1')
  const probeBaseCents = Number(
    (await query(`SELECT price_gross_cents AS cents FROM variants WHERE id = '${probeVariantId}'`))[0][0]?.cents
  )
  if (!Number.isInteger(probeBaseCents)) throw new Error('Probe variant missing from D1 dataset')
  const fallbackVariantId = stableUuid('variant:2:1')

  function effectivePrice(instant: string, variantId: string) {
    const fragment = inlineEffectivePricingSql(effectiveGrossCentsExpression('target'), instant)
    return query(`SELECT ${fragment} AS effective FROM variants target WHERE target.id = '${variantId}'`)
  }

  let failures = 0
  function expectEqual(actual: unknown, expected: unknown, scenario: string) {
    if (actual !== expected) {
      failures += 1
      throw new Error(`Effective-price scenario "${scenario}" failed: expected ${expected}, got ${actual}`)
    }
  }

  const AUDIT_REASON = 'Fila efímera de auditoría D1 para escenarios de resolución temporal'
  interface AuditVersion {
    name: string
    grossCents: number
    validFrom: string
    validUntil?: string
    status?: 'approved' | 'cancelled'
  }
  const auditVersions: AuditVersion[] = [
    { name: 'future', grossCents: 999999, validFrom: '2099-01-01T00:00:00Z' },
    {
      name: 'expired',
      grossCents: 777777,
      validFrom: '2026-08-13T00:00:00Z',
      validUntil: '2026-08-14T00:00:00Z'
    },
    {
      name: 'cancelled',
      grossCents: 888888,
      validFrom: '2026-08-15T00:00:00Z',
      status: 'cancelled'
    },
    { name: 'tie-a', grossCents: 111111, validFrom: '2026-09-01T00:00:00Z' },
    { name: 'tie-b', grossCents: 222222, validFrom: '2026-09-01T00:00:00Z' },
    { name: 'boundary-start', grossCents: 333333, validFrom: '2026-10-01T00:00:00Z' }
  ]
  const auditVersionIds = new Map(
    auditVersions.map((version) => [version.name, stableUuid(`price-version-audit:${version.name}`)])
  )

  async function insertAuditVersion(version: AuditVersion) {
    const id = auditVersionIds.get(version.name)!
    const cancelled = version.status === 'cancelled'
    await query(`INSERT INTO variant_price_versions (
    id, variant_id, gross_cents, volume_tiers, valid_from, valid_until, status,
    reason, created_at, cancelled_at, cancelled_by, cancellation_reason
  ) VALUES (
    '${id}', '${probeVariantId}', ${version.grossCents}, '[]', '${version.validFrom}',
    ${version.validUntil ? `'${version.validUntil}'` : 'NULL'}, '${version.status ?? 'approved'}',
    '${AUDIT_REASON}', '2026-08-16T00:00:00Z',
    ${cancelled ? "'2026-08-17T00:00:00Z'" : 'NULL'},
    ${cancelled ? `'${stableUuid('identity:auditor')}'` : 'NULL'},
    ${cancelled ? "'Retirado por la auditoría antes de entrar en vigor'" : 'NULL'}
  )`)
  }

  async function removeAuditVersions(names: string[]) {
    const ids = names.map((name) => `'${auditVersionIds.get(name)!}'`).join(', ')
    await query(`DELETE FROM variant_price_versions WHERE id IN (${ids})`)
  }

  // S1: only the seeded initial version exists -> effective equals the base price.
  expectEqual(
    Number((await effectivePrice('2026-08-20T00:00:00Z', probeVariantId))[0][0].effective),
    probeBaseCents,
    'vigente inicial'
  )

  // S2: an approved but future version must never leak into the present.
  await insertAuditVersion(auditVersions[0]!)
  try {
    expectEqual(
      Number((await effectivePrice('2026-08-20T00:00:00Z', probeVariantId))[0][0].effective),
      probeBaseCents,
      'versión futura ignorada'
    )
  } finally {
    await removeAuditVersions(['future'])
  }

  // S3: an expired version is ignored now, governed inside its window, and its
  // valid_until bound is exclusive.
  await insertAuditVersion(auditVersions[1]!)
  try {
    expectEqual(
      Number((await effectivePrice('2026-08-20T00:00:00Z', probeVariantId))[0][0].effective),
      probeBaseCents,
      'versión caducada ignorada'
    )
    expectEqual(
      Number((await effectivePrice('2026-08-13T12:00:00Z', probeVariantId))[0][0].effective),
      777777,
      'versión dentro de ventana'
    )
    expectEqual(
      Number((await effectivePrice('2026-08-14T00:00:00Z', probeVariantId))[0][0].effective),
      probeBaseCents,
      'fin de vigencia exclusivo'
    )
  } finally {
    await removeAuditVersions(['expired'])
  }

  // S4: cancelled versions are excluded even while their window covers the instant.
  await insertAuditVersion(auditVersions[2]!)
  try {
    expectEqual(
      Number((await effectivePrice('2026-08-20T00:00:00Z', probeVariantId))[0][0].effective),
      probeBaseCents,
      'versión cancelada ignorada'
    )
  } finally {
    await removeAuditVersions(['cancelled'])
  }

  // S5: identical valid_from/created_at resolve through the stable id tiebreak.
  await insertAuditVersion(auditVersions[3]!)
  await insertAuditVersion(auditVersions[4]!)
  try {
    const tieWinner = [...auditVersionIds.entries()]
      .filter(([name]) => name.startsWith('tie-'))
      .map(([name, id]) => ({ name, id }))
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .at(-1)!
    expectEqual(
      Number((await effectivePrice('2026-09-01T00:05:00Z', probeVariantId))[0][0].effective),
      auditVersions.find((version) => version.name === tieWinner.name)!.grossCents,
      `empate resuelto por id (${tieWinner.name})`
    )
  } finally {
    await removeAuditVersions(['tie-a', 'tie-b'])
  }

  // S6: inclusive valid_from bound at the exact evaluation instant.
  await insertAuditVersion(auditVersions[5]!)
  try {
    expectEqual(
      Number((await effectivePrice('2026-10-01T00:00:00Z', probeVariantId))[0][0].effective),
      333333,
      'inicio de vigencia inclusivo'
    )
  } finally {
    await removeAuditVersions(['boundary-start'])
  }

  // S7: without any governed version the legacy base price takes over, and the
  // seed restores the initial version deterministically.
  await query(`DELETE FROM variant_price_versions WHERE id = '${stableUuid('price-version:2:1')}'`)
  try {
    expectEqual(
      Number((await effectivePrice('2026-08-20T00:00:00Z', fallbackVariantId))[0][0].effective),
      Number(
        (await query(`SELECT price_gross_cents AS cents FROM variants WHERE id = '${fallbackVariantId}'`))[0][0].cents
      ),
      'fallback al precio base legado'
    )
  } finally {
    await wrangler(['--file', '.wrangler/generated/d1-demo-products.sql'])
  }

  // No temporary evidence may survive: the canonical row snapshot must be identical again.
  const restored = await snapshot()
  if (digest(restored) !== canonicalDigest) throw new Error('D1 pricing audit changed its canonical data snapshot')
  if (failures !== 0) throw new Error(`${failures} pricing scenario(s) reported failures`)

  process.stdout.write(
    `D1 catalog audit passed (${CATEGORIES.length} categories, ${PRODUCTS.length} products, ${expectedVariants} variants, ${expectedVariants} price versions, sha256 ${canonicalDigest})\n`
  )
} finally {
  await rm(persistenceDirectory, { recursive: true, force: true })
}
