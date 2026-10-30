import { z } from 'zod'
import type { AssignResult, OperationInput, SimpleResult } from '../catalog/inventory'
import { INVENTORY_COORDINATOR_NAME } from '../catalog/inventory'
import type { PaymentRuntimeConfiguration } from '../catalog/payments'
import type { PreauthDependencies, PreauthInventory, PreauthProvider } from './preauth'

export interface PreauthRuntime {
  DB: D1Database
  INVENTORY?: DurableObjectNamespace
  PAYMENT_PREAUTH_ENABLED?: unknown
  PAYMENT_PREAUTH_SERVICE?: { fetch(request: Request): Promise<Response> }
}

const captureSchema = z
  .object({
    outcome: z.enum(['captured', 'rejected']),
    providerReference: z.string().max(100).optional(),
    responseCode: z
      .string()
      .regex(/^\d{4}$/)
      .optional()
  })
  .strict()
const cancelSchema = z.object({ outcome: z.enum(['cancelled', 'rejected']) }).strict()

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? ''))
    throw new Error('provider_unavailable')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('provider_unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 4096) {
        await reader.cancel()
        throw new Error('provider_unavailable')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('provider_unavailable')
  }
}

/** Internal contract only: no bank URL, secret or card data is known to this code. */
export function createBoundPreauthProvider(binding: { fetch(request: Request): Promise<Response> }): PreauthProvider {
  const call = (operation: 'capture' | 'cancel', input: unknown) =>
    binding.fetch(
      new Request(`https://preauth.internal/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
      })
    )
  return {
    async capture(input) {
      const parsed = captureSchema.safeParse(await boundedJson(await call('capture', input)))
      if (!parsed.success) throw new Error('provider_unavailable')
      return parsed.data
    },
    async cancel(input) {
      const parsed = cancelSchema.safeParse(await boundedJson(await call('cancel', input)))
      if (!parsed.success) throw new Error('provider_unavailable')
      return parsed.data
    }
  }
}

/** Inventory commands go through the same Durable Object that serialises checkout stock changes. */
export function createCoordinatedInventory(namespace: DurableObjectNamespace): PreauthInventory {
  async function send<T>(type: 'assign' | 'renew' | 'release', payload: Record<string, unknown>, accept: number[]) {
    const stub = namespace.get(namespace.idFromName(INVENTORY_COORDINATOR_NAME))
    const response = await stub.fetch(
      new Request('https://inventory.invalid/command', {
        method: 'POST',
        body: JSON.stringify({ type, commandId: crypto.randomUUID(), payload })
      })
    )
    if (!accept.includes(response.status)) throw new Error('inventory_unavailable')
    return (await response.json()) as T
  }
  return {
    assign: (input: OperationInput) => send<AssignResult>('assign', { ...input }, [200, 409]),
    renew: (input: OperationInput & { expiresAt: string }) => send<SimpleResult>('renew', { ...input }, [200, 409]),
    release: (input: OperationInput) => send<SimpleResult>('release', { ...input }, [200, 409])
  }
}

/** Off by default. Needs the flag, the payment terminal configuration and an internal provider binding. */
export function configuredPreauth(
  env: PreauthRuntime,
  configuration: PaymentRuntimeConfiguration | null,
  now: () => string
): PreauthDependencies | null {
  if (
    env.PAYMENT_PREAUTH_ENABLED !== 'true' ||
    !configuration ||
    !env.INVENTORY ||
    !env.PAYMENT_PREAUTH_SERVICE ||
    typeof env.PAYMENT_PREAUTH_SERVICE.fetch !== 'function'
  )
    return null
  return {
    database: env.DB,
    configuration,
    provider: createBoundPreauthProvider(env.PAYMENT_PREAUTH_SERVICE),
    inventory: createCoordinatedInventory(env.INVENTORY),
    now
  }
}
