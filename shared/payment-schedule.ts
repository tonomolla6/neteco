import { z } from 'zod'
import { roundRatio } from '../server/domain/money'

/**
 * PRI-021 deposits and partial payments for quotes/equipment.
 * Rounding: deposit = round-half-up(total * bp / 10000); the remainder is split
 * equally with the final balance absorbing the cents, so parts always sum to total.
 */
export const paymentScheduleInputSchema = z
  .object({
    depositBasisPoints: z.number().int().min(500).max(9000),
    installments: z.number().int().min(1).max(11),
    intervalDays: z.number().int().min(7).max(90)
  })
  .strict()
export type PaymentScheduleInput = z.infer<typeof paymentScheduleInputSchema>

export interface PlannedInstallment {
  seq: number
  kind: 'deposit' | 'installment' | 'balance'
  dueCents: number
  dueAt: string
}

const DAY_MS = 86_400_000
export function buildPaymentSchedule(input: {
  totalGrossCents: number
  depositBasisPoints: number
  installments: number
  intervalDays: number
  now: string
}): PlannedInstallment[] {
  const parsed = paymentScheduleInputSchema.parse({
    depositBasisPoints: input.depositBasisPoints,
    installments: input.installments,
    intervalDays: input.intervalDays
  })
  const total = input.totalGrossCents
  if (!Number.isSafeInteger(total) || total < parsed.installments + 1) throw new RangeError('total too small')
  const start = Date.parse(input.now)
  if (!Number.isFinite(start) || new Date(start).toISOString().replace(/\.\d{3}Z$/, 'Z') !== input.now)
    throw new RangeError('invalid instant')
  const deposit = Math.min(
    roundRatio(BigInt(total) * BigInt(parsed.depositBasisPoints), 10000n),
    total - parsed.installments
  )
  const remainder = total - deposit
  const each = Math.floor(remainder / parsed.installments)
  if (deposit < 1 || each < 1) throw new RangeError('plan produces empty installments')
  const at = (n: number) => new Date(start + n * parsed.intervalDays * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const plan: PlannedInstallment[] = [{ seq: 1, kind: 'deposit', dueCents: deposit, dueAt: at(0) }]
  for (let i = 1; i <= parsed.installments; i++) {
    const last = i === parsed.installments
    plan.push({
      seq: i + 1,
      kind: last ? 'balance' : 'installment',
      dueCents: last ? remainder - each * (parsed.installments - 1) : each,
      dueAt: at(i)
    })
  }
  return plan
}

export interface LedgerEntryLike {
  entryType: 'capture' | 'refund' | 'invoice' | 'credit_note'
  seq: number | null
  amountCents: number
}
export interface ScheduleReconciliation {
  dueCents: number
  capturedCents: number
  refundedCents: number
  /** Still to collect: due - (captured - refunded). */
  remainingCents: number
  invoicedCents: number
  creditedCents: number
  /** Cash received and not yet invoiced (advance invoices cover deposits). */
  toInvoiceCents: number
  /** Invoiced but no longer backed by cash: needs a rectifying invoice. */
  creditNoteDueCents: number
  settled: boolean
  consistent: boolean
  issues: string[]
  installments: Array<{ seq: number; dueCents: number; capturedCents: number; remainingCents: number }>
}

export function reconcileSchedule(
  totalGrossCents: number,
  plan: ReadonlyArray<Pick<PlannedInstallment, 'seq' | 'dueCents'>>,
  entries: readonly LedgerEntryLike[]
): ScheduleReconciliation {
  const sum = (type: LedgerEntryLike['entryType'], seq?: number) =>
    entries
      .filter((e) => e.entryType === type && (seq === undefined || e.seq === seq))
      .reduce((n, e) => n + e.amountCents, 0)
  const captured = sum('capture')
  const refunded = sum('refund')
  const invoiced = sum('invoice')
  const credited = sum('credit_note')
  const issues: string[] = []
  if (plan.reduce((n, p) => n + p.dueCents, 0) !== totalGrossCents) issues.push('plan_total_mismatch')
  const installments = plan.map((p) => {
    const got = sum('capture', p.seq)
    if (got > p.dueCents) issues.push(`installment_overpaid:${p.seq}`)
    return { seq: p.seq, dueCents: p.dueCents, capturedCents: got, remainingCents: Math.max(0, p.dueCents - got) }
  })
  if (captured > totalGrossCents) issues.push('capture_exceeds_total')
  if (refunded > captured) issues.push('refund_exceeds_capture')
  if (invoiced > totalGrossCents) issues.push('invoice_exceeds_total')
  if (credited > invoiced) issues.push('credit_exceeds_invoice')
  const netCash = captured - refunded
  const netInvoiced = invoiced - credited
  return {
    dueCents: totalGrossCents,
    capturedCents: captured,
    refundedCents: refunded,
    remainingCents: totalGrossCents - netCash,
    invoicedCents: invoiced,
    creditedCents: credited,
    toInvoiceCents: Math.max(0, netCash - netInvoiced),
    creditNoteDueCents: Math.max(0, netInvoiced - netCash),
    settled: issues.length === 0 && netCash === totalGrossCents && netInvoiced === totalGrossCents,
    consistent: issues.length === 0,
    issues,
    installments
  }
}
