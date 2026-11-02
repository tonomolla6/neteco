/**
 * PRI-018 downstream. SQL expression for the store credit applied to an order (net of restores), read
 * from the order history: migration 0153 mirrors every redeem/restore ledger entry into order_events
 * ('store_credit.applied', appliedCents) in the same statement. order_events exists in every database
 * (0006), so the expression is 0 where no credit was ever applied. Amount due = total - this value.
 * `orderIdSql` must be a trusted SQL column/parameter reference, never caller input.
 */
export const orderStoreCreditSql = (orderIdSql: string) =>
  `COALESCE((SELECT SUM(json_extract(store_credit_event.payload_json,'$.appliedCents')) FROM order_events store_credit_event WHERE store_credit_event.order_id=${orderIdSql} AND store_credit_event.event_type='store_credit.applied'),0)`
