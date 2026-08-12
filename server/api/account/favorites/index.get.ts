import { useDatabase } from '../../../db/client'
import { requireCustomerAccount } from '../../../utils/account'

export default defineEventHandler(async (event) => {
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const lists = await sql`
    SELECT list.id, list.name, list.is_default AS "isDefault",
           COALESCE(jsonb_agg(jsonb_build_object(
             'variantId', variant.id, 'sku', variant.sku, 'quantity', item.quantity,
             'name', product.name, 'slug', product.slug,
             'available', variant.status = 'published' AND product.status = 'published'
           ) ORDER BY item.created_at) FILTER (WHERE item.variant_id IS NOT NULL), '[]'::jsonb) AS items
    FROM favorite_lists list
    LEFT JOIN favorite_items item ON item.list_id = list.id
    LEFT JOIN variants variant ON variant.id = item.variant_id
    LEFT JOIN products product ON product.id = variant.product_id
    WHERE list.customer_id = ${account.customerId}
    GROUP BY list.id ORDER BY list.is_default DESC, list.created_at
  `
  return { lists }
})
