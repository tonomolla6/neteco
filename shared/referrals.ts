import { z } from 'zod'

export interface ReferralPolicy {
  id: 'global'
  version: number
  isActive: boolean
  termsVersion: string
  rewardCents: number
  refereeDiscountCents: number
  minOrderCents: number
  returnWindowDays: number
  maxReferralsPerAdvocate: number
  updatedAt: string
  updatedBy: string
}

export interface ReferralAttributionView {
  id: string
  referralCode: string
  advocateCustomerId: string
  refereeCustomerId: string
  orderId: string
  orderAmountCents: number
  orderCompletedAt: string
  returnWindowEndsAt: string
  status: 'pending_window' | 'rewarded' | 'rejected' | 'clawback'
  rejectionReason: string | null
  fraudCheckPassed: boolean
  fraudReasons: string[]
  rewardCents: number
  rewardIssuedAt: string | null
  createdAt: string
}

export interface CustomerReferralOverview {
  enrolled: boolean
  referralCode?: string
  termsVersion?: string
  consentedAt?: string
  totalAttributions: number
  pendingWindowCount: number
  pendingRewardCents: number
  rewardedCount: number
  totalRewardedCents: number
  rejectedCount: number
}

export interface ReferralFraudEvaluation {
  passed: boolean
  reasons: string[]
}

export const referralPolicyUpdateSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  expectedVersion: z.number().int().min(0),
  isActive: z.boolean().optional(),
  termsVersion: z.string().min(1).max(32).optional(),
  rewardCents: z.number().int().min(100).max(50000).optional(),
  refereeDiscountCents: z.number().int().min(100).max(50000).optional(),
  minOrderCents: z.number().int().min(500).max(500000).optional(),
  returnWindowDays: z.number().int().min(14).max(60).optional(),
  maxReferralsPerAdvocate: z.number().int().min(1).max(50).optional()
})

export const referralEnrollSchema = z.object({
  termsVersion: z.string().min(1).max(32),
  consentedAt: z.string().optional()
})

export const referralAttributeOrderSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  referralCode: z.string().min(6).max(32),
  refereeCustomerId: z.string().uuid(),
  orderId: z.string().uuid()
})

export function generateReferralCode(customerId: string): string {
  const cleanId = customerId
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 6)
    .toUpperCase()
  const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `REF-${cleanId}-${randomSuffix}`
}

export function evaluateReferralFraud(params: {
  advocateCustomerId: string
  refereeCustomerId: string
  advocateEmailHash: string
  refereeEmailHash: string
  advocateAddressHash?: string
  refereeAddressHash?: string
  priorOrdersCount: number
  activeAdvocateReferralsCount: number
  maxReferralsAllowed: number
}): ReferralFraudEvaluation {
  const reasons: string[] = []

  if (params.advocateCustomerId === params.refereeCustomerId) {
    reasons.push('self_referral')
  }

  if (
    params.advocateEmailHash &&
    params.refereeEmailHash &&
    params.advocateEmailHash.toLowerCase() === params.refereeEmailHash.toLowerCase()
  ) {
    reasons.push('duplicate_identity_or_email')
  }

  if (
    params.advocateAddressHash &&
    params.refereeAddressHash &&
    params.advocateAddressHash === params.refereeAddressHash
  ) {
    reasons.push('duplicate_shipping_address')
  }

  if (params.priorOrdersCount > 0) {
    reasons.push('referee_not_new_customer')
  }

  if (params.activeAdvocateReferralsCount >= params.maxReferralsAllowed) {
    reasons.push('advocate_referral_cap_reached')
  }

  return {
    passed: reasons.length === 0,
    reasons
  }
}

export function calculateReturnWindowEndsAt(orderCompletedAt: string, returnWindowDays: number): string {
  const completedDate = new Date(orderCompletedAt)
  const windowEnd = new Date(completedDate.getTime() + returnWindowDays * 24 * 60 * 60 * 1000)
  return windowEnd.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function isReturnWindowElapsed(orderCompletedAt: string, returnWindowDays: number, now: string): boolean {
  const windowEnd = calculateReturnWindowEndsAt(orderCompletedAt, returnWindowDays)
  return new Date(now).getTime() >= new Date(windowEnd).getTime()
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalizeJson(element)).join(',')}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`
}

export async function referralIntentHash(payload: unknown): Promise<string> {
  const text = canonicalizeJson(payload)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
