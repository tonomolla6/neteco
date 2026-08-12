import { hashAccessToken } from '../../utils/access-token'
import { useDatabase } from '../../db/client'
import { publicOrderStatus } from '../../utils/order-status'

interface OrderRow {
  id: string
  public_number: string
  guest_access_hash: string | null
  order_status: string
  payment_status: string
  inventory_status: string
  fulfillment_status: string
  invoice_status: string
  shipping_method: string
  payment_method: string
  subtotal_net_cents: number
  shipping_net_cents: number
  tax_cents: number
  total_gross_cents: number
  customer_snapshot: Record<string, string | null>
  shipping_snapshot: Record<string, string | null>
  created_at: Date
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
  const cookie = getCookie(event, 'neteco-order-access')
  const cookieToken = cookie?.startsWith(`${id}.`) ? cookie.slice(id.length + 1) : undefined
  const token = String(getQuery(event).token ?? cookieToken ?? '')
  const session = await getUserSession(event)

  const sql = useDatabase()
  const [order] = await sql<OrderRow[]>`
    SELECT id, public_number, guest_access_hash, order_status, payment_status, inventory_status,
           fulfillment_status, invoice_status, shipping_method, payment_method, subtotal_net_cents,
           shipping_net_cents, tax_cents, total_gross_cents, customer_snapshot, shipping_snapshot,
           created_at
    FROM orders
    WHERE public_number = ${id}
      AND (
        (${token} <> '' AND guest_access_hash = ${hashAccessToken(token)})
        OR EXISTS (
          SELECT 1
          FROM identities identity
          JOIN auth_sessions active_session ON active_session.identity_id = identity.id
          WHERE identity.customer_id = orders.customer_id
            AND identity.id = ${session.user?.id ?? null}
            AND active_session.id = ${session.sessionId ?? null}
            AND active_session.revoked_at IS NULL AND active_session.expires_at > now()
            AND active_session.session_version = identity.session_version
        )
        OR EXISTS (
          SELECT 1
          FROM auth_sessions staff_session
          JOIN identity_roles staff_role ON staff_role.identity_id = staff_session.identity_id
          JOIN role_permissions staff_permission ON staff_permission.role_code = staff_role.role_code
          WHERE staff_session.identity_id = ${session.user?.id ?? null}
            AND staff_session.id = ${session.sessionId ?? null}
            AND staff_session.revoked_at IS NULL AND staff_session.expires_at > now()
            AND staff_session.mfa_verified = true
            AND staff_permission.permission_code = 'orders.read'
            AND (staff_role.expires_at IS NULL OR staff_role.expires_at > now())
        )
      )
  `
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
  const items = await sql<Array<{ id: string; name: string; format: string; sku: string; price: number; qty: number }>>`
    SELECT id, name, variant_name AS format, sku,
           COALESCE((logistics_snapshot ->> 'unitGrossCents')::int, total_gross_cents / quantity) AS price,
           quantity AS qty
    FROM order_lines
    WHERE order_id = ${order.id}
    ORDER BY id
  `
  const customer = order.customer_snapshot
  const address = order.shipping_snapshot
  const goodsGross = items.reduce((total, item) => total + item.price * item.qty, 0)
  return {
    id: order.public_number,
    status: publicOrderStatus({
      orderStatus: order.order_status,
      paymentStatus: order.payment_status,
      fulfillmentStatus: order.fulfillment_status,
      paymentMethod: order.payment_method
    }),
    orderStatus: order.order_status,
    paymentStatus: order.payment_status,
    inventoryStatus: order.inventory_status,
    fulfillmentStatus: order.fulfillment_status,
    invoiceStatus: order.invoice_status,
    name: customer.name,
    company: customer.company,
    nif: customer.taxId,
    email: customer.email,
    phone: customer.phone,
    address: address.line1,
    zip: address.postalCode,
    city: address.city,
    province: address.region,
    notes: address.instructions,
    shippingMethod: order.shipping_method,
    paymentMethod: order.payment_method,
    subtotal: goodsGross,
    shippingCost: order.total_gross_cents - goodsGross,
    tax: order.tax_cents,
    total: order.total_gross_cents,
    createdAt: order.created_at.toISOString(),
    items
  }
})
