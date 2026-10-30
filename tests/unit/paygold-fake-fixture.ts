import { z } from 'zod'
import { canonicalPayloadHash } from '../../workers/catalog/cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
const schema = z
  .object({
    paymentIntentId: z.string().uuid(),
    amountCents: z.number().int().safe().positive(),
    expiresAt: catalogPolicyInstantSchema,
    redirect: z
      .object({
        actionUrl: z.string().url(),
        method: z.literal('POST'),
        fields: z
          .object({
            Ds_MerchantParameters: z.string().min(1),
            Ds_Signature: z.string().min(1),
            Ds_SignatureVersion: z.literal('HMAC_SHA512_V2')
          })
          .strict()
      })
      .strict(),
    idempotencyKey: z.string().min(1).max(200)
  })
  .strict()
/** Test-only synthetic provider. No network or real bank capability. */
export function createFakePayGoldService(origin: string) {
  const target = new URL(origin)
  if (target.protocol !== 'https:' || target.origin !== origin) throw new Error('invalid origin')
  const commands = new Map<
    string,
    { hash: string; url: string; expiresAt: string; redirect: z.infer<typeof schema>['redirect'] }
  >()
  const links = new Map<string, { expiresAt: string; redirect: z.infer<typeof schema>['redirect'] }>()
  return {
    async fetch(request: Request) {
      if (request.method !== 'POST' || new URL(request.url).href !== 'https://paygold.internal/create')
        return new Response(null, { status: 404 })
      let raw: unknown
      try {
        raw = await request.json()
      } catch {
        return new Response(null, { status: 400 })
      }
      const parsed = schema.safeParse(raw)
      if (!parsed.success) return new Response(null, { status: 400 })
      const value = parsed.data,
        hash = await canonicalPayloadHash(value),
        existing = commands.get(value.idempotencyKey)
      if (existing)
        return existing.hash === hash
          ? Response.json({ url: existing.url, expiresAt: existing.expiresAt })
          : new Response(null, { status: 409 })
      const id = await canonicalPayloadHash({ purpose: 'synthetic-paygold-link', key: value.idempotencyKey }),
        url = `${origin}/link/${id}`
      const item = { hash, url, expiresAt: value.expiresAt, redirect: structuredClone(value.redirect) }
      commands.set(value.idempotencyKey, item)
      links.set(url, item)
      return Response.json({ url, expiresAt: value.expiresAt })
    },
    redeem(url: string, now: string) {
      if (!catalogPolicyInstantSchema.safeParse(now).success) return null
      const item = links.get(url)
      if (!item || now >= item.expiresAt) return null
      return structuredClone(item.redirect)
    }
  }
}
