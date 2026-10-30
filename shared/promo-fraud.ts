import { z } from 'zod'

/** SEC-036. Pure promotional / referral fraud policy. A signal is the number of OTHER customers that
 * shared the same pseudonymised identity, address, device or payment token inside the window. One
 * exceeded signal only requests review (the benefit still flows); a hold needs two independent kinds.
 * Nothing here blocks automatically: every hold is a human-reviewable, appealable case. */
export const PROMO_FRAUD_WINDOW_DAYS = 30
export const PROMO_FRAUD_SIGNAL_RETENTION_DAYS = 90
export const PROMO_FRAUD_KINDS = ['identity', 'address', 'device', 'payment'] as const
export type PromoFraudKind = (typeof PROMO_FRAUD_KINDS)[number]
/** Max number of other customers allowed to share a signal before it counts as exceeded. */
export const PROMO_FRAUD_LIMITS: Readonly<Record<PromoFraudKind, number>> = {
  identity: 0,
  address: 2,
  device: 2,
  payment: 1
}
/** Explainable weights; they add up to 100. */
export const PROMO_FRAUD_WEIGHTS: Readonly<Record<PromoFraudKind, number>> = {
  identity: 35,
  address: 15,
  device: 20,
  payment: 30
}
export type PromoFraudDecision = 'clear' | 'review' | 'hold'
export type PromoFraudStatus =
  'closed' | 'open' | 'released' | 'upheld' | 'appealed' | 'appeal_accepted' | 'appeal_rejected'

export function evaluatePromoFraud(shared: Partial<Record<PromoFraudKind, number>>): {
  decision: PromoFraudDecision
  score: number
  exceededKinds: PromoFraudKind[]
} {
  const exceededKinds = PROMO_FRAUD_KINDS.filter((kind) => (shared[kind] ?? 0) > PROMO_FRAUD_LIMITS[kind])
  const score = Math.min(
    100,
    exceededKinds.reduce((sum, kind) => sum + PROMO_FRAUD_WEIGHTS[kind], 0)
  )
  const decision: PromoFraudDecision =
    exceededKinds.length === 0 ? 'clear' : exceededKinds.length === 1 ? 'review' : 'hold'
  return { decision, score, exceededKinds }
}

/** The benefit (reward, coupon redemption) is withheld while a hold is pending and after a confirmed
 * abuse; a mere review request never blocks it. */
export function isPromoBenefitBlocked(decision: PromoFraudDecision, status: PromoFraudStatus): boolean {
  if (status === 'upheld' || status === 'appeal_rejected') return true
  return decision === 'hold' && (status === 'open' || status === 'appealed')
}

const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
/** Cosmetic differences must not hide a shared identity or address. */
export function normalizePromoSignal(kind: PromoFraudKind, raw: string): string {
  const value = raw.trim()
  if (kind === 'identity') {
    const folded = fold(value)
    const at = folded.lastIndexOf('@')
    if (at > 0) {
      const local = folded.slice(0, at).split('+')[0]!.replace(/\./g, '')
      return `${local}@${folded.slice(at + 1)}`
    }
    return folded.replace(/[^a-z0-9]/g, '')
  }
  if (kind === 'address')
    return fold(value)
      .replace(/[^a-z0-9, ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  return value
}

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/)
const signal = z.string().trim().min(1).max(300)
const note = z
  .string()
  .trim()
  .min(3)
  .max(1000)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

export const assessInputSchema = z
  .object({
    commandId: z.string().uuid(),
    context: z.enum(['referral', 'promotion']),
    refId: id,
    customerId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
    signals: z
      .object({ identity: signal, address: signal, device: signal, payment: signal })
      .partial()
      .strict()
      .refine((value) => Object.keys(value).length >= 1)
  })
  .strict()
export type AssessInput = z.infer<typeof assessInputSchema>

export const caseDecisionInputSchema = z
  .object({ expectedVersion: version, outcome: z.enum(['release', 'uphold']), note })
  .strict()
export const appealInputSchema = z
  .object({
    caseVersion: version,
    statement: z
      .string()
      .trim()
      .min(10)
      .max(1000)
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
  })
  .strict()
export const appealResolutionInputSchema = z
  .object({ expectedVersion: version, outcome: z.enum(['accept', 'reject']), note })
  .strict()
