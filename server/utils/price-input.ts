import { z } from 'zod'

export const volumePriceTierSchema = z
  .object({
    minimumQuantity: z.number().int().positive(),
    unitGrossCents: z.number().int().positive()
  })
  .strict()

export const volumePriceTiersSchema = z.array(volumePriceTierSchema).max(20)

export const priceScheduleSchema = z
  .object({
    variantId: z.string().uuid(),
    grossCents: z.number().int().positive(),
    compareAtGrossCents: z.number().int().positive().nullable().default(null),
    volumeTiers: volumePriceTiersSchema.default([]),
    validFrom: z.string().datetime(),
    reason: z.string().trim().min(3).max(500)
  })
  .strict()
  .superRefine((input, context) => {
    if (input.compareAtGrossCents !== null && input.compareAtGrossCents <= input.grossCents) {
      context.addIssue({
        code: 'custom',
        path: ['compareAtGrossCents'],
        message: 'El precio anterior debe ser mayor que el nuevo precio'
      })
    }
    let previousMinimum = 0
    let previousPrice = input.grossCents
    for (const [index, tier] of input.volumeTiers.entries()) {
      if (tier.minimumQuantity <= previousMinimum) {
        context.addIssue({
          code: 'custom',
          path: ['volumeTiers', index, 'minimumQuantity'],
          message: 'Los tramos deben estar ordenados y no repetirse'
        })
      }
      if (tier.unitGrossCents > previousPrice) {
        context.addIssue({
          code: 'custom',
          path: ['volumeTiers', index, 'unitGrossCents'],
          message: 'Un tramo de volumen no puede aumentar el precio unitario'
        })
      }
      previousMinimum = tier.minimumQuantity
      previousPrice = tier.unitGrossCents
    }
  })

export type PriceScheduleInput = z.infer<typeof priceScheduleSchema>
