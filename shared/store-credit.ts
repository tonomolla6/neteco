import { z } from 'zod'

/**
 * PRI-018 store credit / compensation coupon. Pure rules: FIFO-by-expiry spending
 * that conserves every cent, and issuance fraud limits. Persistence lives in
 * workers/pricing/store-credit.ts.
 */
export const STORE_CREDIT_POLICY = {
  maxSingleIssueCents: 50_000,
  maxRollingIssueCents: 100_000,
  rollingWindowDays: 30,
  maxIssuesPerWindow: 5,
  minExpiryDays: 30,
  maxExpiryDays: 730
} as const

export const storeCreditIssueInputSchema = z
  .object({
    customerId: z.string().uuid(),
    kind: z.enum(['refund_credit', 'compensation_coupon']),
    sourceRef: z.string().trim().min(3).max(128),
    amountCents: z.number().int().min(1).max(STORE_CREDIT_POLICY.maxSingleIssueCents),
    expiresInDays: z.number().int().min(STORE_CREDIT_POLICY.minExpiryDays).max(STORE_CREDIT_POLICY.maxExpiryDays),
    reason: z.string().trim().min(10).max(300)
  })
  .strict()
export type StoreCreditIssueInput = z.infer<typeof storeCreditIssueInputSchema>

export interface RedeemableGrant {
  id: string
  remainingCents: number
  expiresAt: string
}

export function allocateRedemption(
  grants: RedeemableGrant[],
  amountCents: number,
  now: string
): Array<{ grantId: string; cents: number }> | null {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new RangeError('amount must be a positive integer')
  const instant = Date.parse(now)
  const usable = grants
    .filter((g) => g.remainingCents > 0 && Date.parse(g.expiresAt) > instant)
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || (a.id < b.id ? -1 : 1))
  const out: Array<{ grantId: string; cents: number }> = []
  let left = amountCents
  for (const grant of usable) {
    if (left === 0) break
    const cents = Math.min(grant.remainingCents, left)
    out.push({ grantId: grant.id, cents })
    left -= cents
  }
  return left === 0 ? out : null
}

export type IssuanceBlock = 'single_cap' | 'rolling_cap' | 'velocity'
export function evaluateIssuance(input: {
  amountCents: number
  /** Amounts issued to the same customer inside the rolling window. */
  recent: readonly number[]
}): { allowed: true } | { allowed: false; reason: IssuanceBlock } {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new RangeError('invalid amount')
  if (input.amountCents > STORE_CREDIT_POLICY.maxSingleIssueCents) return { allowed: false, reason: 'single_cap' }
  if (input.recent.length >= STORE_CREDIT_POLICY.maxIssuesPerWindow) return { allowed: false, reason: 'velocity' }
  const total = input.recent.reduce((n, v) => n + v, 0) + input.amountCents
  if (total > STORE_CREDIT_POLICY.maxRollingIssueCents) return { allowed: false, reason: 'rolling_cap' }
  return { allowed: true }
}
