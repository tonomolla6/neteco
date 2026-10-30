import { z } from 'zod'
import { PaymentTokenError } from './token-removal'
import { recoverPaymentTokenRemovals } from './token-removal-recovery'

/** An explicitly configured internal service owns provider-specific deletion. */
export interface TokenRemovalRuntime {
  DB: D1Database
  PAYMENT_TOKEN_REMOVAL_ENABLED?: unknown
  PAYMENT_TOKEN_DELETION?: { fetch(request: Request): Promise<Response> }
}

async function boundedResponse(response: Response): Promise<unknown> {
  if (!response.ok || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? ''))
    throw new PaymentTokenError('unavailable')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024)) throw new PaymentTokenError('unavailable')
  const reader = response.body?.getReader()
  if (!reader) throw new PaymentTokenError('unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 1024) {
        await reader.cancel()
        throw new PaymentTokenError('unavailable')
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
    throw new PaymentTokenError('unavailable')
  }
}
const resultSchema = z.object({ outcome: z.enum(['deleted', 'already_deleted', 'pending']) }).strict()
export async function runConfiguredTokenRemovalRecovery(env: TokenRemovalRuntime, now: string) {
  if (env.PAYMENT_TOKEN_REMOVAL_ENABLED !== 'true') return { enabled: false as const }
  const service = env.PAYMENT_TOKEN_DELETION
  if (!service || typeof service.fetch !== 'function') throw new PaymentTokenError('unavailable')
  const result = await recoverPaymentTokenRemovals(
    env.DB,
    {
      async remove(input) {
        const response = await service.fetch(
          new Request('https://payment-token-deletion.internal/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input)
          })
        )
        const parsed = resultSchema.safeParse(await boundedResponse(response))
        if (!parsed.success) throw new PaymentTokenError('unavailable')
        return parsed.data.outcome
      }
    },
    { now, limit: 25 }
  )
  return { enabled: true as const, ...result }
}
