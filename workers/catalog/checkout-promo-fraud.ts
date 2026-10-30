import { isPromoBenefitBlocked } from '../../shared/promo-fraud'
import { PromoFraudError, assessPromoFraud, getPromoFraudBenefitGates } from '../security/promo-fraud'

/**
 * SEC-036 checkout gate. One case per customer and coupon (`context=promotion`, ref = customer:code), so a
 * retry reuses the verdict and a human release or upheld decision is honoured. Signals are derived on the
 * server from the authenticated identity and the delivery address, never from client-declared risk data.
 * A single exceeded signal only opens a review (the coupon still applies); a hold needs two kinds.
 */
export async function promotionBenefitBlocked(
  database: D1Database,
  input: {
    customerId: string
    identityId: string
    couponCode: string
    shippingAddress: { line1: string; line2?: string; postalCode: string; city: string }
    pepper: string
    now: string
  }
): Promise<boolean> {
  const refId = `${input.customerId}:${input.couponCode}`
  const readGate = async () => (await getPromoFraudBenefitGates(database, 'promotion', [refId])).get(refId)
  const known = await readGate()
  if (known?.caseId) return known.blocked

  const identity = await database
    .prepare('SELECT email FROM identities WHERE id = ?1')
    .bind(input.identityId)
    .first<{ email: string | null }>()
  const address = input.shippingAddress
  const signals: { identity?: string; address?: string } = {
    address: [address.line1, address.line2, address.postalCode, address.city]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(', ')
  }
  if (identity?.email) signals.identity = identity.email
  try {
    const { case: assessed } = await assessPromoFraud(
      database,
      { commandId: crypto.randomUUID(), context: 'promotion', refId, customerId: input.customerId, signals },
      { now: input.now, pepper: input.pepper }
    )
    return isPromoBenefitBlocked(assessed.decision, assessed.status)
  } catch (error) {
    // A concurrent checkout of the same customer won the unique (context, ref): honour its verdict.
    if (
      error instanceof PromoFraudError &&
      (error.code === 'already_assessed' || error.code === 'idempotency_conflict')
    )
      return (await readGate())?.blocked ?? true
    throw error
  }
}
