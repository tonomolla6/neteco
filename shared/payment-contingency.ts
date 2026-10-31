import { z } from 'zod'

export const contingencyToggleSchema = z
  .object({
    marketCode: z.string().min(2).max(10),
    activateContingency: z.boolean(),
    reason: z.string().min(3).max(500),
    expectedVersion: z.number().int().min(1)
  })
  .strict()

export type ContingencyToggleInput = z.infer<typeof contingencyToggleSchema>

export interface ContingencyRoutingRule {
  id: string
  marketCode: string
  primaryProvider: 'redsys' | 'euro_contingency'
  alternativeProvider: 'redsys' | 'euro_contingency'
  activeProvider: 'redsys' | 'euro_contingency'
  contingencyActive: boolean
  contingencyReason: string | null
  contingencyActivatedAt: string | null
  contingencyActivatedBy: string | null
  failureCountWindow: number
  circuitState: 'closed' | 'open' | 'half_open'
  version: number
  createdAt: string
  updatedAt: string
}

export interface PaymentRouteDecision {
  selectedProvider: 'redsys' | 'euro_contingency'
  isContingency: boolean
  contingencyReason: string | null
  circuitState: 'closed' | 'open' | 'half_open'
}

export const unifiedSettlementInputSchema = z
  .object({
    intentId: z.string(),
    orderId: z.string().uuid(),
    provider: z.enum(['redsys', 'euro_contingency']),
    providerReference: z.string().min(1).max(120),
    amountCents: z.number().int().min(1),
    currency: z.literal('EUR'),
    status: z.enum(['authorized', 'captured', 'refunded', 'settled', 'discrepancy']),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    settledAt: z.string().datetime().optional().nullable()
  })
  .strict()

export type UnifiedSettlementInput = z.infer<typeof unifiedSettlementInputSchema>

export interface UnifiedSettlementRecord {
  id: string
  intentId: string
  orderId: string
  provider: 'redsys' | 'euro_contingency'
  providerReference: string
  amountCents: number
  currency: 'EUR'
  status: 'authorized' | 'captured' | 'refunded' | 'settled' | 'discrepancy'
  payloadHash: string
  settledAt: string | null
  reconciledAt: string
  createdAt: string
}
