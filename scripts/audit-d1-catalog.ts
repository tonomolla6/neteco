import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { CATEGORIES, PRODUCTS } from '../server/db/seed'

const execute = promisify(execFile)
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const baseArguments = ['wrangler', 'd1', 'execute', 'DB', '--config', 'wrangler.canary.jsonc', '--local', '--yes']

async function wrangler(arguments_: string[]) {
  const { stdout } = await execute(executable, [...baseArguments, ...arguments_], {
    cwd: process.cwd(),
    maxBuffer: 8 * 1024 * 1024
  })
  return stdout
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
SELECT count(*) AS orphan_count
FROM categories child LEFT JOIN categories parent ON parent.id = child.parent_id
WHERE child.parent_id IS NOT NULL AND parent.id IS NULL;
SELECT count(*) AS fts_count FROM products_fts;
`.trim()

async function snapshot() {
  const output = await wrangler(['--json', '--command', snapshotQuery])
  const result = JSON.parse(output) as Array<{ results: Array<Record<string, unknown>>; success: boolean }>
  if (result.length !== 5 || result.some((entry) => !entry.success)) throw new Error('D1 catalog snapshot failed')
  return result.map((entry) => entry.results)
}

const before = await snapshot()
await wrangler(['--file', '.wrangler/generated/d1-demo-categories.sql'])
await wrangler(['--file', '.wrangler/generated/d1-demo-products.sql'])
const after = await snapshot()

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const beforeDigest = digest(before)
const afterDigest = digest(after)
if (beforeDigest !== afterDigest) throw new Error('D1 catalog seed is not idempotent')

const expectedVariants = PRODUCTS.reduce((sum, product) => sum + product.variants.length, 0)
const [categories, products, variants, orphans, fts] = after
if (categories!.length !== CATEGORIES.length) throw new Error('D1 category count differs from seed source')
if (products!.length !== PRODUCTS.length) throw new Error('D1 product count differs from seed source')
if (variants!.length !== expectedVariants) throw new Error('D1 variant count differs from seed source')
if (Number(orphans![0]?.orphan_count) !== 0) throw new Error('D1 catalog contains orphan categories')
if (Number(fts![0]?.fts_count) !== PRODUCTS.length) throw new Error('D1 FTS index differs from products')

process.stdout.write(
  `D1 catalog audit passed (${CATEGORIES.length} categories, ${PRODUCTS.length} products, ${expectedVariants} variants, sha256 ${afterDigest})\n`
)
