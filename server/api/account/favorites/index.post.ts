import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { requireCustomerAccount } from '../../../utils/account'

const schema = z.object({
  variantId: z.string().uuid(),
  quantity: z.coerce.number().positive().max(999_999).default(1)
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const item = await sql.begin(async (transaction) => {
    const [variant] = await transaction<{ id: string }[]>`
      SELECT variant.id FROM variants variant JOIN products product ON product.id = variant.product_id
      WHERE variant.id = ${body.variantId} AND variant.status = 'published' AND product.status = 'published'
    `
    if (!variant) throw createError({ statusCode: 404, statusMessage: 'Variante no disponible' })
    const [list] = await transaction<{ id: string }[]>`
      INSERT INTO favorite_lists (customer_id, name, is_default)
      VALUES (${account.customerId}, 'Favoritos', true)
      ON CONFLICT (customer_id, name) DO UPDATE SET updated_at = now()
      RETURNING id
    `
    if (!list) throw new Error('Favorite list insert returned no row')
    await transaction`
      INSERT INTO favorite_items (list_id, variant_id, quantity)
      VALUES (${list.id}, ${body.variantId}, ${body.quantity})
      ON CONFLICT (list_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity
    `
    return { listId: list.id, variantId: body.variantId, quantity: body.quantity }
  })
  setResponseStatus(event, 201)
  return item
})
