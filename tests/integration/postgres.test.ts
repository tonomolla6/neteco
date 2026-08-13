import { readdir } from 'node:fs/promises'
import type { Sql } from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deterministicTestData } from '../fixtures/deterministic'
import { isolatedPostgresDatabase, type IsolatedPostgresDatabase } from '../fixtures/postgres'

const baseConnection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
let sql: Sql
let database: IsolatedPostgresDatabase

beforeEach(async (context) => {
  const testData = deterministicTestData(`integration:postgres:${context.task.id}:${context.task.name}`)
  database = await isolatedPostgresDatabase(testData.namespace)
  process.env.DATABASE_URL = database.connection
  sql = database.sql
})

afterEach(async () => {
  try {
    await database.dispose()
  } finally {
    process.env.DATABASE_URL = baseConnection
  }
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

    const columns = await sql<{ columnName: string }[]>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'variants'
        AND column_name IN ('color', 'image')
      ORDER BY column_name
    `
    expect(columns.map((column) => column.columnName)).toEqual(['color', 'image'])

    await expect(
      sql.begin(async (transaction) => {
        const [variant] = await transaction<{ id: string }[]>`SELECT id FROM variants ORDER BY id LIMIT 1`
        await transaction`UPDATE variants SET color = 'blue' WHERE id = ${variant!.id}`
      })
    ).rejects.toMatchObject({ code: '23514' })

    await sql.begin(async (transaction) => {
      const [variant] = await transaction<{ id: string }[]>`SELECT id FROM variants ORDER BY id LIMIT 1`
      await transaction`UPDATE variants SET image = '/img/products/example/principal.jpg' WHERE id = ${variant!.id}`
      await transaction`UPDATE variants SET image = NULL WHERE id = ${variant!.id}`
    })
  })
})
