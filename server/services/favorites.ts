import { createError } from 'h3'
import type { TransactionSql } from 'postgres'
import { z } from 'zod'

/**
 * Guardar en la lista del cliente. La variante llega por su uuid (ficha, listado) o por la
 * referencia numérica que llevan las líneas de un pedido («Guardar como lista»).
 */
export const saveFavoriteSchema = z.object({
  variantId: z.union([z.string().uuid(), z.number().int().positive().safe()]),
  quantity: z.coerce.number().positive().max(999_999).default(1)
})
export type SaveFavoriteInput = z.infer<typeof saveFavoriteSchema>

export async function saveCustomerFavorite(transaction: TransactionSql, customerId: string, input: SaveFavoriteInput) {
  const [variant] =
    typeof input.variantId === 'number'
      ? await transaction<{ id: string }[]>`
          SELECT variant.id FROM variants variant JOIN products product ON product.id = variant.product_id
          WHERE variant.legacy_id = ${input.variantId} AND variant.status = 'published' AND product.status = 'published'
        `
      : await transaction<{ id: string }[]>`
          SELECT variant.id FROM variants variant JOIN products product ON product.id = variant.product_id
          WHERE variant.id = ${input.variantId} AND variant.status = 'published' AND product.status = 'published'
        `
  if (!variant) throw createError({ statusCode: 404, statusMessage: 'Variante no disponible' })
  const [list] = await transaction<{ id: string }[]>`
    INSERT INTO favorite_lists (customer_id, name, is_default)
    VALUES (${customerId}, 'Favoritos', true)
    ON CONFLICT (customer_id, name) DO UPDATE SET updated_at = now()
    RETURNING id
  `
  if (!list) throw new Error('Favorite list insert returned no row')
  await transaction`
    INSERT INTO favorite_items (list_id, variant_id, quantity)
    VALUES (${list.id}, ${variant.id}, ${input.quantity})
    ON CONFLICT (list_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity
  `
  return { listId: list.id, variantId: variant.id, quantity: input.quantity }
}
