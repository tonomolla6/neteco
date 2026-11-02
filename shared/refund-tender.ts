/**
 * PRI-018 downstream: how a refund of an order partly paid with store credit is split between the
 * card (refunded through the payment provider) and store credit (restored to the customer's balance).
 *
 * Rule (deterministic, independent of how the refunds are partitioned): refunds follow the original
 * tender proportion by CUMULATIVE FLOOR. After refunds totalling R cents of an order whose total T was
 * paid C by card and S = T - C with store credit, the card has received exactly floor(R x C / T) and
 * store credit the rest. The card share is rounded down, so the card never receives more than it was
 * charged, and the refund that closes the order closes both tenders exactly (C and S).
 * When earlier holds did not follow that path (a cancelled refund left them uneven), the share is
 * clamped so neither tender can exceed what remains of it.
 */
export interface RefundTenderInput {
  /** Amount actually captured by the card/provider for the order. */
  cardCapturedCents: number
  /** Store credit applied to the order at checkout (net of restores). */
  storeCreditCents: number
  /** Card share of the order's earlier, non-cancelled refunds. */
  heldCardCents: number
  /** Store-credit share of the order's earlier, non-cancelled refunds. */
  heldStoreCreditCents: number
  /** Gross amount of this refund. */
  amountCents: number
}
export interface RefundTender {
  cardCents: number
  storeCreditCents: number
}

const cents = (value: number, minimum: number) => Number.isSafeInteger(value) && value >= minimum

export function allocateRefundTender(input: RefundTenderInput): RefundTender {
  const { cardCapturedCents, storeCreditCents, heldCardCents, heldStoreCreditCents, amountCents } = input
  if (
    !cents(cardCapturedCents, 0) ||
    !cents(storeCreditCents, 1) ||
    !cents(heldCardCents, 0) ||
    !cents(heldStoreCreditCents, 0) ||
    !cents(amountCents, 1) ||
    heldCardCents > cardCapturedCents ||
    heldStoreCreditCents > storeCreditCents
  )
    throw new RangeError('invalid_tender_input')
  const cardRemaining = cardCapturedCents - heldCardCents,
    creditRemaining = storeCreditCents - heldStoreCreditCents
  if (amountCents > cardRemaining + creditRemaining) throw new RangeError('amount_unavailable')
  const total = BigInt(cardCapturedCents + storeCreditCents),
    refunded = BigInt(heldCardCents + heldStoreCreditCents + amountCents),
    cumulativeCard = Number((refunded * BigInt(cardCapturedCents)) / total)
  let card = Math.min(amountCents, Math.max(0, cumulativeCard - heldCardCents))
  card = Math.min(card, cardRemaining)
  card = Math.max(card, amountCents - creditRemaining)
  return { cardCents: card, storeCreditCents: amountCents - card }
}
