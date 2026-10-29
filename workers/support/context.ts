import { supportContextSchema } from '../../shared/support-operations'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { authorizeD1Session } from '../catalog/authorization'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'

/** Read-only role-redacted context. Never reuse the broader administrative
 * order/fiscal readers to give support staff administration.manage authority. */
export async function readSupportContext(
  rawDatabase: D1Database,
  claims: VerifiedSessionClaims,
  orderId: string | null,
  customerId: string | null,
  now: () => string
) {
  const database = guardedFiscalDatabase(rawDatabase)
  const result = {
    order: null,
    payment: null,
    fulfillment: null,
    returns: [],
    fiscal: null,
    redacted: []
  } as ReturnType<typeof supportContextSchema.parse>
  if (!orderId) return supportContextSchema.parse(result)
  const customer = customerId !== null
  const permitted = async (permission: string) =>
    customer
      ? (await activeOrderCustomerId(database, claims, now())) === customerId
      : (await authorizeD1Session(database, claims, permission, { now: now(), requireMfa: true })).allowed
  if (!(await permitted('orders.read'))) {
    result.redacted = ['order', 'payment', 'fiscal']
    return supportContextSchema.parse(result)
  }
  const order = await database
    .prepare(
      'SELECT id,status,currency,total_gross_cents AS totalGrossCents,shipping_method_code AS shippingMethod FROM orders WHERE id=?1 AND (?2 IS NULL OR customer_id=?2)'
    )
    .bind(orderId, customerId)
    .first<NonNullable<typeof result.order>>()
  if (!order) throw new Error('support_context_unconfirmed')
  const lines = (
    await database
      .prepare(
        'SELECT line_index AS "index",sku,name,quantity,unit_gross_cents AS unitGrossCents,gross_cents AS grossCents FROM order_lines WHERE order_id=? ORDER BY line_index LIMIT 101'
      )
      .bind(orderId)
      .all<NonNullable<typeof result.order>['lines'][number]>()
  ).results
  result.order = { ...order, lines }
  result.fulfillment = await database
    .prepare(
      'SELECT f.status,f.updated_at AS updatedAt FROM order_fulfillments f JOIN order_fulfillment_commands c ON c.id=f.last_command_id JOIN order_fulfillment_audit a ON a.command_id=c.id AND a.response=c.response AND a.input=c.input WHERE f.order_id=? AND c.result_version=f.version'
    )
    .bind(orderId)
    .first<NonNullable<typeof result.fulfillment>>()
  result.returns = (
    await database
      .prepare(
        'SELECT r.public_ref AS publicRef,r.state,r.updated_at AS updatedAt FROM order_returns r JOIN order_return_commands c ON c.id=r.last_command_id JOIN order_return_events e ON e.command_id=c.id AND e.response=c.response WHERE r.order_id=? AND c.result_version=r.version ORDER BY r.created_at DESC,r.id DESC LIMIT 50'
      )
      .bind(orderId)
      .all<(typeof result.returns)[number]>()
  ).results
  if (await permitted('payments.read')) {
    result.payment = await database
      .prepare('SELECT status,paid_gross_cents AS paidGrossCents FROM order_payment_states WHERE order_id=?')
      .bind(orderId)
      .first<NonNullable<typeof result.payment>>()
  } else result.redacted.push('payment')
  if (await permitted('invoices.read')) {
    const fiscal = await database
      .prepare(
        'SELECT j.status,i.validation_only AS validationOnly FROM fiscal_invoice_intents i JOIN fiscal_issuance_work j ON j.intent_id=i.id WHERE i.order_id=? ORDER BY i.created_at DESC LIMIT 1'
      )
      .bind(orderId)
      .first<{ status: string; validationOnly: number }>()
    if (fiscal)
      result.fiscal = { status: fiscal.status, validationOnly: fiscal.validationOnly === 1, pdfAvailable: false }
  } else result.redacted.push('fiscal')
  // Each grant must still exist after every multi-query enrichment. A revoked
  // grant never leaks previously collected fields through a successful DTO.
  if (!(await permitted('orders.read'))) throw new Error('support_context_unconfirmed')
  if (result.payment && !(await permitted('payments.read'))) throw new Error('support_context_unconfirmed')
  if (result.fiscal && !(await permitted('invoices.read'))) throw new Error('support_context_unconfirmed')
  return supportContextSchema.parse(result)
}
