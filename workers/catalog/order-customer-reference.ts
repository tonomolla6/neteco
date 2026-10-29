import { CartError, CartInfrastructureError } from './cart'

/** A contractual customer reference, never fiscal identity or delivery instructions. */
export function normalizeOrderPurchaseOrderReference(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string') throw new CartError('invalid_input', 'purchaseOrderReference must be single-line text')
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || (code >= 127 && code <= 159) || code === 8232 || code === 8233)
      throw new CartError('invalid_input', 'purchaseOrderReference must be single-line text')
  }
  const normalized = value.trim().normalize('NFC')
  if (normalized.length > 120) throw new CartError('invalid_input', 'purchaseOrderReference exceeds 120 characters')
  return normalized || null
}

/** Internal read only, NOT authorization. Callers must bind ownership/session
 * before and after awaits. SELECT * supports historical schemas lacking the
 * optional column; only this validated scalar may leave this private loader. */
export async function readOrderPurchaseOrderReference(database: D1Database, orderId: string): Promise<string | null> {
  const row = await database
    .prepare('SELECT * FROM orders WHERE id = ?1')
    .bind(orderId)
    .first<Record<string, unknown>>()
  if (!row || row.purchase_order_reference === undefined || row.purchase_order_reference === null) return null
  try {
    const normalized = normalizeOrderPurchaseOrderReference(row.purchase_order_reference)
    if (normalized === null || normalized !== row.purchase_order_reference) throw new Error('noncanonical_reference')
    return normalized
  } catch {
    throw new CartInfrastructureError('Stored purchase order reference is invalid')
  }
}
