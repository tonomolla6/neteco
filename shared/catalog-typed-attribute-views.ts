import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'
import {
  catalogTypedAttributeDefinitionSchema,
  catalogTypedAttributeValuesSchema,
  updateCatalogTypedAttributeDefinitionSchema,
  retireCatalogTypedAttributeDefinitionSchema
} from './catalog-typed-attributes'
import type {
  CatalogTypedAttributeDefinition,
  CatalogTypedAttributeValues,
  UpdateCatalogTypedAttributeDefinitionInput,
  RetireCatalogTypedAttributeDefinitionInput
} from './catalog-typed-attributes'

export interface CatalogTypedAttributeDefinitionsView {
  source: 'cloudflare'
  categoryId: number
  categoryUuid: string
  definitions: CatalogTypedAttributeDefinition[]
  capabilities: { read: true; create: boolean; update: boolean; retire: boolean }
}
export interface CatalogTypedAttributeProductView {
  source: 'cloudflare'
  product: {
    id: number
    uuid: string
    categoryId: number
    categoryUuid: string
    catalogVersion: number
    status: 'draft' | 'review' | 'published' | 'hidden' | 'discontinued'
  }
  typed: CatalogTypedAttributeValues
  definitions: CatalogTypedAttributeDefinition[]
  capabilities: { read: true; update: boolean }
}
export interface UpdateCatalogTypedAttributeValuesInput {
  expectedVersion: number
  reason: string
  typed: CatalogTypedAttributeValues
}
export interface CatalogTypedAttributeValuesReceipt {
  source: 'cloudflare'
  action: 'update_values'
  commandId: string
  productId: number
  productUuid: string
  catalogVersion: number
  typed: CatalogTypedAttributeValues
  updated: true
}
export type CatalogTypedAttributeDefinitionHttpUpdate =
  | ({ action: 'update' } & UpdateCatalogTypedAttributeDefinitionInput)
  | ({ action: 'retire' } & RetireCatalogTypedAttributeDefinitionInput)

function own(raw: unknown): unknown {
  try {
    return catalogPolicyOwnJson(raw)
  } catch {
    return undefined
  }
}
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const durableId = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  )
const reason = z
  .string()
  .max(500)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
  .transform((value) => value.trim())
  .pipe(z.string().min(3))
const status = z.enum(['draft', 'review', 'published', 'hidden', 'discontinued'])
export const catalogTypedAttributeDefinitionsViewSchema: z.ZodType<CatalogTypedAttributeDefinitionsView, unknown> =
  z.preprocess(
    own,
    z
      .object({
        source: z.literal('cloudflare'),
        categoryId: positive,
        categoryUuid: durableId,
        definitions: z.array(catalogTypedAttributeDefinitionSchema).max(32),
        capabilities: z
          .object({ read: z.literal(true), create: z.boolean(), update: z.boolean(), retire: z.boolean() })
          .strict()
      })
      .strict()
      .refine(
        (view) =>
          new Set(view.definitions.map((definition) => definition.id)).size === view.definitions.length &&
          view.definitions.every(
            (definition) => definition.categoryId === view.categoryId && definition.categoryUuid === view.categoryUuid
          )
      )
  )
export const catalogTypedAttributeProductViewSchema: z.ZodType<CatalogTypedAttributeProductView, unknown> =
  z.preprocess(
    own,
    z
      .object({
        source: z.literal('cloudflare'),
        product: z
          .object({
            id: positive,
            uuid: durableId,
            categoryId: positive,
            categoryUuid: durableId,
            catalogVersion: positive,
            status
          })
          .strict(),
        typed: catalogTypedAttributeValuesSchema,
        definitions: z.array(catalogTypedAttributeDefinitionSchema).max(64),
        capabilities: z.object({ read: z.literal(true), update: z.boolean() }).strict()
      })
      .strict()
      .refine((view) => {
        const revisions = new Set(view.definitions.map((definition) => `${definition.id}:${definition.revision}`))
        return (
          revisions.size === view.definitions.length &&
          view.definitions.every(
            (definition) =>
              definition.categoryId === view.product.categoryId && definition.categoryUuid === view.product.categoryUuid
          ) &&
          view.typed.values.every((value) => revisions.has(`${value.definitionId}:${value.revision}`)) &&
          (!view.capabilities.update || view.product.status === 'draft')
        )
      })
  )
export const updateCatalogTypedAttributeValuesSchema: z.ZodType<UpdateCatalogTypedAttributeValuesInput, unknown> =
  z.preprocess(
    own,
    z
      .object({
        expectedVersion: positive.max(Number.MAX_SAFE_INTEGER - 1),
        reason,
        typed: catalogTypedAttributeValuesSchema
      })
      .strict()
  )
export const catalogTypedAttributeValuesReceiptSchema: z.ZodType<CatalogTypedAttributeValuesReceipt, unknown> =
  z.preprocess(
    own,
    z
      .object({
        source: z.literal('cloudflare'),
        action: z.literal('update_values'),
        commandId: catalogPolicyUuidSchema,
        productId: positive,
        productUuid: durableId,
        catalogVersion: positive.min(2),
        typed: catalogTypedAttributeValuesSchema,
        updated: z.literal(true)
      })
      .strict()
  )
export const catalogTypedAttributeDefinitionHttpUpdateSchema: z.ZodType<
  CatalogTypedAttributeDefinitionHttpUpdate,
  unknown
> = z.preprocess(
  own,
  z.unknown().transform((raw, context) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid definition command' })
      return z.NEVER
    }
    const { action, ...body } = raw as Record<string, unknown>
    if (action === 'update') {
      const parsed = updateCatalogTypedAttributeDefinitionSchema.safeParse(body)
      if (parsed.success) return { action: 'update' as const, ...parsed.data }
    } else if (action === 'retire') {
      const parsed = retireCatalogTypedAttributeDefinitionSchema.safeParse(body)
      if (parsed.success) return { action: 'retire' as const, ...parsed.data }
    }
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid definition command' })
    return z.NEVER
  })
)
