import type { Sql } from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cancelScheduledVariantPrice, scheduleVariantPrice } from '../../server/services/pricing'
import { deterministicTestData, type DeterministicTestData } from '../fixtures/deterministic'
import { isolatedPostgresDatabase, type IsolatedPostgresDatabase } from '../fixtures/postgres'

const baseConnection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
let sql: Sql
let database: IsolatedPostgresDatabase
let testData: DeterministicTestData
const randomUUID = () => testData.uuid()

beforeEach(async (context) => {
  testData = deterministicTestData(`integration:pricing:${context.task.id}:${context.task.name}`)
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

describe('governed price schedules', () => {
  it('switches the effective price, preserves history and safely cancels the latest future version', async () => {
    const rollback = new Error('ROLLBACK_PRICING_TEST')
    await expect(
      sql.begin(async (transaction) => {
        const actorId = testData.uuid('actor')
        await transaction`
          INSERT INTO identities (id, email, password_hash, email_verified_at, status)
          VALUES (${actorId}, ${testData.email('actor')}, 'integration-password-hash',
                  '2026-08-12T00:00:00Z', 'active')
        `
        const [fixture] = await transaction<
          {
            variantId: string
            grossCents: number
            minimumQuantity: number
            quantityIncrement: number
          }[]
        >`
          SELECT variant.id AS "variantId", price.gross_cents AS "grossCents",
                 variant.minimum_quantity AS "minimumQuantity", variant.quantity_increment AS "quantityIncrement"
          FROM variants variant
          JOIN effective_variant_prices price ON price.variant_id = variant.id
          WHERE variant.status = 'published' AND variant.minimum_quantity = 1 AND variant.quantity_increment = 1
          ORDER BY variant.id LIMIT 1
        `
        if (!fixture) throw new Error('Pricing integration fixture unavailable')
        await transaction`
          INSERT INTO variant_price_versions (
            variant_id, gross_cents, volume_tiers, valid_from, reason, created_by
          ) VALUES (
            ${fixture.variantId}, ${fixture.grossCents}, '[]'::jsonb, '2026-08-12T00:00:00Z',
            'Precio base de la prueba aislada', ${actorId}
          )
        `
        const correlationId = randomUUID()
        const immediate = await scheduleVariantPrice(transaction, {
          variantId: fixture.variantId,
          grossCents: fixture.grossCents - 1,
          compareAtGrossCents: fixture.grossCents,
          volumeTiers: [{ minimumQuantity: 10, unitGrossCents: fixture.grossCents - 2 }],
          validFrom: new Date('2026-08-13T00:00:00Z'),
          reason: 'Prueba de vigencia inmediata',
          actorId,
          correlationId
        })
        const [effective] = await transaction<
          { pricingVersion: string; grossCents: number; referenceGrossCents30d: number; volumeTiers: unknown }[]
        >`
          SELECT pricing_version AS "pricingVersion", gross_cents AS "grossCents",
                 reference_gross_cents_30d AS "referenceGrossCents30d", volume_tiers AS "volumeTiers"
          FROM effective_variant_prices WHERE variant_id = ${fixture.variantId}
        `
        expect(effective).toMatchObject({
          pricingVersion: immediate.id,
          grossCents: fixture.grossCents - 1,
          referenceGrossCents30d: fixture.grossCents,
          volumeTiers: [{ minimumQuantity: 10, unitGrossCents: fixture.grossCents - 2 }]
        })

        const future = await scheduleVariantPrice(transaction, {
          variantId: fixture.variantId,
          grossCents: fixture.grossCents + 100,
          compareAtGrossCents: null,
          volumeTiers: [],
          validFrom: new Date('2100-01-01T00:00:00Z'),
          reason: 'Prueba de programación futura',
          actorId,
          correlationId
        })
        await cancelScheduledVariantPrice(transaction, {
          id: future.id,
          actorId,
          reason: 'Prueba de cancelación segura',
          correlationId,
          now: new Date('2026-08-13T12:00:00Z')
        })
        const [cancelled] = await transaction<{ status: string }[]>`
          SELECT status FROM variant_price_versions WHERE id = ${future.id}
        `
        const [restored] = await transaction<{ validUntil: Date | null }[]>`
          SELECT valid_until AS "validUntil" FROM variant_price_versions WHERE id = ${immediate.id}
        `
        expect(cancelled?.status).toBe('cancelled')
        expect(restored?.validUntil).toBeNull()
        throw rollback
      })
    ).rejects.toBe(rollback)
  })
})
