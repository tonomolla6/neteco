import type { Sql } from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveCustomerFavorite, saveFavoriteSchema } from '../../server/services/favorites'
import { deterministicTestData } from '../fixtures/deterministic'
import { isolatedPostgresDatabase, type IsolatedPostgresDatabase } from '../fixtures/postgres'

let database: IsolatedPostgresDatabase
let sql: Sql
let customerId: string
let variant: { id: string; legacyId: number }

beforeEach(async (context) => {
  const data = deterministicTestData(`integration:favorites:${context.task.id}`)
  database = await isolatedPostgresDatabase(data.namespace)
  sql = database.sql
  const [customer] = await sql<{ id: string }[]>`
    INSERT INTO customers (email, name) VALUES (${`${data.token('email')}@integration.invalid`}, 'Cliente')
    RETURNING id
  `
  customerId = customer!.id
  const [published] = await sql<{ id: string; legacyId: number }[]>`
    SELECT variant.id, variant.legacy_id AS "legacyId"
    FROM variants variant JOIN products product ON product.id = variant.product_id
    WHERE variant.status = 'published' AND product.status = 'published'
    ORDER BY variant.id LIMIT 1
  `
  if (!published) throw new Error('The integration catalog has no published variant')
  variant = published
})

afterEach(async () => {
  await database.dispose()
})

describe('saving to the customer list', () => {
  it('accepts the numeric reference an order line carries, as well as the variant uuid', async () => {
    const byLegacy = saveFavoriteSchema.parse({ variantId: variant.legacyId, quantity: 4 })
    await sql.begin((transaction) => saveCustomerFavorite(transaction, customerId, byLegacy))
    const [saved] = await sql<{ variantId: string; quantity: number }[]>`
      SELECT item.variant_id AS "variantId", item.quantity::int AS quantity
      FROM favorite_items item JOIN favorite_lists list ON list.id = item.list_id
      WHERE list.customer_id = ${customerId}
    `
    expect(saved).toEqual({ variantId: variant.id, quantity: 4 })

    const byUuid = saveFavoriteSchema.parse({ variantId: variant.id, quantity: 6 })
    const result = await sql.begin((transaction) => saveCustomerFavorite(transaction, customerId, byUuid))
    expect(result).toMatchObject({ variantId: variant.id, quantity: 6 })
  })

  it('refuses an unknown reference', async () => {
    await expect(
      sql.begin((transaction) =>
        saveCustomerFavorite(transaction, customerId, saveFavoriteSchema.parse({ variantId: 2_000_000_000 }))
      )
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
