import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { cancelScheduledVariantPrice, scheduleVariantPrice } from '../../server/services/pricing'

const connection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
const sql = postgres(connection, { max: 2 })

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

describe('governed price schedules', () => {
  it('switches the effective price, preserves history and safely cancels the latest future version', async () => {
    const rollback = new Error('ROLLBACK_PRICING_TEST')
    await expect(
      sql.begin(async (transaction) => {
        const [fixture] = await transaction<
          {
            variantId: string
            actorId: string
            grossCents: number
            minimumQuantity: number
            quantityIncrement: number
          }[]
        >`
          SELECT variant.id AS "variantId", identity.id AS "actorId", price.gross_cents AS "grossCents",
                 variant.minimum_quantity AS "minimumQuantity", variant.quantity_increment AS "quantityIncrement"
          FROM variants variant
          JOIN effective_variant_prices price ON price.variant_id = variant.id
          CROSS JOIN LATERAL (SELECT id FROM identities ORDER BY created_at LIMIT 1) identity
          WHERE variant.status = 'published' AND variant.minimum_quantity = 1 AND variant.quantity_increment = 1
          ORDER BY variant.id LIMIT 1
        `
        if (!fixture) throw new Error('Pricing integration fixture unavailable')
        const correlationId = randomUUID()
        const immediate = await scheduleVariantPrice(transaction, {
          variantId: fixture.variantId,
          grossCents: fixture.grossCents - 1,
          compareAtGrossCents: fixture.grossCents,
          volumeTiers: [{ minimumQuantity: 10, unitGrossCents: fixture.grossCents - 2 }],
          validFrom: new Date(Date.now() - 1000),
          reason: 'Prueba de vigencia inmediata',
          actorId: fixture.actorId,
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
          validFrom: new Date(Date.now() + 24 * 60 * 60_000),
          reason: 'Prueba de programación futura',
          actorId: fixture.actorId,
          correlationId
        })
        await cancelScheduledVariantPrice(transaction, {
          id: future.id,
          actorId: fixture.actorId,
          reason: 'Prueba de cancelación segura',
          correlationId
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
