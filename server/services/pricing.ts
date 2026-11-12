import { createError } from 'h3'
import type { TransactionSql } from 'postgres'
import { selectVolumeUnitPrice, validateQuantity, type VolumePriceTier } from '../domain/money'

interface SchedulePriceInput {
  variantId: string
  grossCents: number
  compareAtGrossCents: number | null
  volumeTiers: VolumePriceTier[]
  validFrom: Date
  reason: string
  actorId: string
  correlationId: string
}

interface PriceVersionRow {
  id: string
  grossCents: number
  validFrom: Date
  validUntil: Date | null
}

export async function scheduleVariantPrice(transaction: TransactionSql, input: SchedulePriceInput) {
  selectVolumeUnitPrice(input.grossCents, 1, input.volumeTiers)
  const volumeTiers = input.volumeTiers.map((tier) => ({
    minimumQuantity: tier.minimumQuantity,
    unitGrossCents: tier.unitGrossCents
  }))
  const [variant] = await transaction<
    { id: string; sku: string; minimumQuantity: number; maximumQuantity: number | null; quantityIncrement: number }[]
  >`
    SELECT id, sku, minimum_quantity AS "minimumQuantity", maximum_quantity AS "maximumQuantity",
           quantity_increment AS "quantityIncrement"
    FROM variants WHERE id = ${input.variantId} FOR UPDATE
  `
  if (!variant) throw createError({ statusCode: 404, statusMessage: 'Variante no encontrada' })
  for (const tier of input.volumeTiers) {
    if (tier.minimumQuantity <= variant.minimumQuantity) {
      throw createError({
        statusCode: 422,
        statusMessage: `Un tramo debe empezar por encima de la cantidad mínima (${variant.minimumQuantity})`
      })
    }
    validateQuantity(tier.minimumQuantity, variant)
  }
  const [latest] = await transaction<PriceVersionRow[]>`
    SELECT id, gross_cents AS "grossCents", valid_from AS "validFrom", valid_until AS "validUntil"
    FROM variant_price_versions
    WHERE variant_id = ${variant.id} AND status = 'approved'
    ORDER BY valid_from DESC, created_at DESC
    LIMIT 1
    FOR UPDATE
  `
  if (latest && input.validFrom <= latest.validFrom) {
    throw createError({
      statusCode: 409,
      statusMessage: 'La vigencia debe ser posterior al último precio; cancela primero la programación futura'
    })
  }
  const referenceWindowStart = new Date(input.validFrom.getTime() - 30 * 24 * 60 * 60_000)
  const [reference] = await transaction<{ amount: number | null }[]>`
    SELECT min(gross_cents)::int AS amount
    FROM variant_price_versions
    WHERE variant_id = ${variant.id} AND status = 'approved'
      AND valid_from < ${input.validFrom}
      AND COALESCE(valid_until, ${input.validFrom}) > ${referenceWindowStart}
  `
  if (latest) {
    await transaction`
      UPDATE variant_price_versions SET valid_until = ${input.validFrom}
      WHERE id = ${latest.id}
    `
  }
  const referenceGrossCents30d = reference?.amount ?? latest?.grossCents ?? null
  const [created] = await transaction<{ id: string }[]>`
    INSERT INTO variant_price_versions (
      variant_id, gross_cents, compare_at_gross_cents, reference_gross_cents_30d,
      volume_tiers, valid_from, reason, created_by
    ) VALUES (
      ${variant.id}, ${input.grossCents}, ${input.compareAtGrossCents}, ${referenceGrossCents30d},
      ${transaction.json(volumeTiers)}, ${input.validFrom}, ${input.reason}, ${input.actorId}
    )
    RETURNING id
  `
  if (!created) throw new Error('Price version insert returned no row')
  await transaction`
    INSERT INTO audit_log (
      actor_type, actor_id, action, resource_type, resource_id, after_redacted, reason, correlation_id
    ) VALUES (
      'staff', ${input.actorId}, 'variant_price.schedule', 'variant_price', ${created.id},
      ${transaction.json({
        variantId: variant.id,
        sku: variant.sku,
        grossCents: input.grossCents,
        compareAtGrossCents: input.compareAtGrossCents,
        referenceGrossCents30d,
        volumeTiers,
        validFrom: input.validFrom.toISOString()
      })},
      ${input.reason}, ${input.correlationId}
    )
  `
  return { id: created.id, effective: input.validFrom <= new Date() }
}

export async function createInitialVariantPrice(
  transaction: TransactionSql,
  input: Omit<SchedulePriceInput, 'compareAtGrossCents' | 'volumeTiers'>
) {
  return scheduleVariantPrice(transaction, { ...input, compareAtGrossCents: null, volumeTiers: [] })
}

export async function cancelScheduledVariantPrice(
  transaction: TransactionSql,
  input: { id: string; actorId: string; reason: string; correlationId: string; now?: Date }
) {
  const now = input.now ?? new Date()
  const [reference] = await transaction<{ id: string; variantId: string }[]>`
    SELECT id, variant_id AS "variantId" FROM variant_price_versions WHERE id = ${input.id}
  `
  if (!reference) throw createError({ statusCode: 404, statusMessage: 'Precio programado no encontrado' })
  await transaction`SELECT id FROM variants WHERE id = ${reference.variantId} FOR UPDATE`
  const [scheduled] = await transaction<{ id: string; variantId: string; validFrom: Date }[]>`
    SELECT id, variant_id AS "variantId", valid_from AS "validFrom"
    FROM variant_price_versions WHERE id = ${input.id} FOR UPDATE
  `
  if (!scheduled) throw createError({ statusCode: 404, statusMessage: 'Precio programado no encontrado' })
  const [latest] = await transaction<{ id: string }[]>`
    SELECT id FROM variant_price_versions
    WHERE variant_id = ${scheduled.variantId} AND status = 'approved'
    ORDER BY valid_from DESC, created_at DESC LIMIT 1 FOR UPDATE
  `
  if (scheduled.validFrom <= now || latest?.id !== scheduled.id) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Solo se puede cancelar la última programación aún no vigente'
    })
  }
  await transaction`
    UPDATE variant_price_versions SET status = 'cancelled', cancelled_by = ${input.actorId},
      cancelled_at = ${now}, cancellation_reason = ${input.reason}
    WHERE id = ${scheduled.id}
  `
  await transaction`
    UPDATE variant_price_versions SET valid_until = NULL
    WHERE id = (
      SELECT id FROM variant_price_versions
      WHERE variant_id = ${scheduled.variantId} AND status = 'approved'
      ORDER BY valid_from DESC, created_at DESC LIMIT 1
    )
  `
  await transaction`
    INSERT INTO audit_log (
      actor_type, actor_id, action, resource_type, resource_id, reason, correlation_id
    ) VALUES (
      'staff', ${input.actorId}, 'variant_price.cancel', 'variant_price', ${scheduled.id},
      ${input.reason}, ${input.correlationId}
    )
  `
  return { id: scheduled.id }
}

/** A variant without a public price ("Consultar precio") cannot be bought online. */
export function priceOnRequestError() {
  return createError({
    statusCode: 409,
    statusMessage: 'Este artículo es de precio a consultar; pídenos presupuesto',
    data: { code: 'PRICE_ON_REQUEST' }
  })
}
