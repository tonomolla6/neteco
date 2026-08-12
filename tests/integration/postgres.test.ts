import postgres from 'postgres'
import { readdir } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'

const connection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
const sql = postgres(connection, { max: 2 })

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

describe('PostgreSQL foundation', () => {
  it('has applied every migration exactly once', async () => {
    const migrations = await sql<{ version: string }[]>`SELECT version FROM _neteco_migrations ORDER BY version`
    const expected = (await readdir(new URL('../../db/migrations/', import.meta.url)))
      .filter((file) => file.endsWith('.sql'))
      .sort()
    expect(migrations.map((row) => row.version)).toEqual(expected)
  })

  it('reproduces the deterministic synthetic catalog and searchable references', async () => {
    const [counts] = await sql<{ categories: number; products: number; variants: number; movements: number }[]>`SELECT
        (SELECT count(*)::int FROM categories) AS categories,
        (SELECT count(*)::int FROM products) AS products,
        (SELECT count(*)::int FROM variants) AS variants,
        (SELECT count(*)::int FROM inventory_movements WHERE movement_type = 'initial') AS movements`
    expect(counts).toEqual({ categories: 45, products: 20, variants: 50, movements: 50 })

    const exact = await sql<{ sku: string; name: string }[]>`
      SELECT v.sku, p.name
      FROM variants v
      JOIN products p ON p.id = v.product_id
      WHERE v.sku = '378'
    `
    expect(exact).toEqual([{ sku: '378', name: 'Guante de nitrilo Nitriflex Blue (caja 100 uds)' }])
  })

  it('enforces immutable uniqueness and domain constraints in the real engine', async () => {
    const [constraintCount] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
        AND contype IN ('p', 'f', 'u', 'c')
    `
    expect(constraintCount!.count).toBeGreaterThan(80)
  })
})
