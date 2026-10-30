import { z } from 'zod'
import type { PaymentInventoryGateway, PaymentRuntimeConfiguration } from '../catalog/payments'
import type { OneClickProvider, TokenizationDependencies } from './tokenization'

export interface TokenizationRuntime {
  DB: D1Database
  PAYMENT_TOKENIZATION_ENABLED?: unknown
  /** Set to "confirmed" only once the acquirer has confirmed tokenisation / COF support in writing. */
  PAYMENT_TOKENIZATION_BANK_SUPPORT?: unknown
  /** "reviewed:<reference>" naming the completed PCI scope review. */
  PAYMENT_TOKENIZATION_PCI_REVIEW?: unknown
  PAYMENT_TOKEN_REMOVAL_ENABLED?: unknown
  PAYMENT_TOKEN_DELETION?: { fetch(request: Request): Promise<Response> }
  PAYMENT_ONE_CLICK_SERVICE?: { fetch(request: Request): Promise<Response> }
}

const hasFetch = (binding: unknown): boolean =>
  typeof binding === 'object' && binding !== null && typeof (binding as { fetch?: unknown }).fetch === 'function'

/**
 * All acceptance conditions of PAY-022. Every one comes from trusted deployment configuration, never a request.
 * Returns the missing conditions so a closed gate is explainable in logs/tests.
 */
export function tokenizationGate(env: TokenizationRuntime): { open: boolean; missing: string[] } {
  const missing: string[] = []
  if (env.PAYMENT_TOKENIZATION_ENABLED !== 'true') missing.push('enabled')
  if (env.PAYMENT_TOKENIZATION_BANK_SUPPORT !== 'confirmed') missing.push('bank_support')
  if (
    typeof env.PAYMENT_TOKENIZATION_PCI_REVIEW !== 'string' ||
    !/^reviewed:[A-Za-z0-9._-]{3,64}$/.test(env.PAYMENT_TOKENIZATION_PCI_REVIEW)
  )
    missing.push('pci_review')
  if (env.PAYMENT_TOKEN_REMOVAL_ENABLED !== 'true' || !hasFetch(env.PAYMENT_TOKEN_DELETION))
    missing.push('self_service_removal')
  if (!hasFetch(env.PAYMENT_ONE_CLICK_SERVICE)) missing.push('one_click_service')
  return { open: missing.length === 0, missing }
}

const envelopeSchema = z
  .object({
    Ds_MerchantParameters: z.string().min(1).max(16384),
    Ds_Signature: z.string().min(1).max(16384),
    Ds_SignatureVersion: z.literal('HMAC_SHA512_V2')
  })
  .strict()

/** Internal contract: the service returns the bank's signed envelope, verified again by checkout code. */
export function createBoundOneClickProvider(binding: { fetch(request: Request): Promise<Response> }): OneClickProvider {
  return {
    async charge(input) {
      const response = await binding.fetch(
        new Request('https://oneclick.internal/charge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input)
        })
      )
      if (
        !response.ok ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')
      )
        throw new Error('provider_unavailable')
      const text = await response.text()
      if (text.length > 40000) throw new Error('provider_unavailable')
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        throw new Error('provider_unavailable')
      }
      const parsed = envelopeSchema.safeParse(raw)
      if (!parsed.success) throw new Error('provider_unavailable')
      return parsed.data
    }
  }
}

export function configuredTokenization(
  env: TokenizationRuntime,
  configuration: PaymentRuntimeConfiguration | null,
  inventory: PaymentInventoryGateway,
  now: () => string
): TokenizationDependencies | null {
  if (!configuration || !tokenizationGate(env).open) return null
  return {
    database: env.DB,
    configuration,
    provider: createBoundOneClickProvider(env.PAYMENT_ONE_CLICK_SERVICE!),
    inventory,
    now
  }
}
