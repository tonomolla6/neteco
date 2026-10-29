import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'

const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const text = (minimum: number, maximum: number) =>
  z
    .string()
    .refine((value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0)!
        return code > 31 && (code < 127 || code > 159) && code !== 0x2028 && code !== 0x2029
      })
    )
    .transform((value) => value.trim().normalize('NFC'))
    .pipe(z.string().min(minimum).max(maximum))
export const catalogRelationKindSchema = z.enum(['substitute', 'compatible', 'accessory', 'equivalent'])
export const catalogRelationSchema = z.object({ targetProductId: id, kind: catalogRelationKindSchema }).strict()
const relations = z
  .array(catalogRelationSchema)
  .max(50)
  .refine(
    (items) => new Set(items.map((item) => `${item.targetProductId}:${item.kind}`)).size === items.length,
    'Duplicate directed relation'
  )
export const catalogRelationsInputSchema = z
  .object({
    expectedVersion: version,
    relations,
    reason: text(10, 500),
    reviewReference: text(3, 200)
  })
  .strict()
export const adminCatalogRelationsSchema = z
  .object({
    source: z.literal('cloudflare'),
    productId: id,
    version,
    items: relations,
    updatedAt: instant.nullable()
  })
  .strict()
  .refine((value) => value.items.every((item) => item.targetProductId !== value.productId), 'Self relation')
export const catalogRelationsReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    productId: id,
    expectedVersion: version,
    version: version.min(1),
    payloadHash: hash,
    recordedAt: instant
  })
  .strict()
  .refine((value) => value.version === value.expectedVersion + 1, 'Receipt version mismatch')
export const catalogRelationsCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: catalogRelationsReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export const catalogRelationSlugsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  )
  .min(1)
  .max(20)
  .refine((items) => new Set(items).size === items.length, 'Duplicate source slug')
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const publicCatalogRelationsSchema = z
  .object({
    source: z.literal('cloudflare'),
    groups: z
      .array(
        z
          .object({
            productId: id,
            productSlug: z.string().min(1).max(200),
            items: z
              .array(
                z
                  .object({
                    kind: catalogRelationKindSchema,
                    productId: id,
                    slug: z.string().min(1).max(200),
                    name: z.string().min(1).max(500),
                    brand: z.string().min(1).max(200),
                    minPrice: money,
                    minNetPrice: money,
                    formats: z.number().int().min(1).max(10000)
                  })
                  .strict()
              )
              .max(50)
          })
          .strict()
      )
      .max(20)
  })
  .strict()
export type CatalogRelationsInput = z.infer<typeof catalogRelationsInputSchema>
export type AdminCatalogRelations = z.infer<typeof adminCatalogRelationsSchema>
export type CatalogRelationsReceipt = z.infer<typeof catalogRelationsReceiptSchema>
export type CatalogRelationsCommand = z.infer<typeof catalogRelationsCommandSchema>
export type PublicCatalogRelations = z.infer<typeof publicCatalogRelationsSchema>
export type CatalogRelationKind = z.infer<typeof catalogRelationKindSchema>
/** Origin and normalized ordered snapshot are bound to the command, not just its edges. */
export async function catalogRelationsIntentHash(productId: number, raw: unknown): Promise<string> {
  id.parse(productId)
  const input = catalogRelationsInputSchema.parse(raw)
  const bytes = new TextEncoder().encode(JSON.stringify({ productId, ...input }))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('')
}
