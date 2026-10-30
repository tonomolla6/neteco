import { z } from 'zod'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { PayGoldError, type PayGoldDependencies } from './paygold-links'
const responseSchema = z.object({ url: z.string().url().max(2048), expiresAt: catalogPolicyInstantSchema }).strict()
export function createBoundPayGoldProvider(binding: {
  fetch(request: Request): Promise<Response>
}): PayGoldDependencies['provider'] {
  return {
    async create(input) {
      const response = await binding.fetch(
        new Request('https://paygold.internal/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input)
        })
      )
      if (
        !response.ok ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')
      )
        throw new PayGoldError('unavailable')
      const declared = response.headers.get('content-length')
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 4096))
        throw new PayGoldError('unavailable')
      const reader = response.body?.getReader()
      if (!reader) throw new PayGoldError('unavailable')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.length
          if (size > 4096) {
            await reader.cancel()
            throw new PayGoldError('unavailable')
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
      let raw: unknown
      try {
        raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } catch {
        throw new PayGoldError('unavailable')
      }
      const parsed = responseSchema.safeParse(raw)
      if (!parsed.success) throw new PayGoldError('unavailable')
      return parsed.data
    }
  }
}
