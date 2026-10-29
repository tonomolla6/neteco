import { z } from 'zod'

export const REQUIRED_PUBLICATION_FIELDS = [
  'usage',
  'series',
  'regulatory.requiresSds',
  'regulatory.safetyInstructions',
  'regulatory.hazardStatements',
  'regulatory.precautionaryStatements',
  'regulatory.manufacturer'
] as const
export const PUBLICATION_DOCUMENT_ROLES = ['datasheet', 'sds', 'certificate', 'label'] as const
export const REQUIRED_CATALOG_POLICY_FIELDS = REQUIRED_PUBLICATION_FIELDS
export const CATALOG_POLICY_DOCUMENT_ROLES = PUBLICATION_DOCUMENT_ROLES
export const catalogPolicyActionSchema = z.enum([
  'policy_create',
  'policy_withdraw',
  'policy_assign',
  'exception_create',
  'exception_withdraw'
])
export type CatalogPolicyAction = z.infer<typeof catalogPolicyActionSchema>
export const catalogPolicyUuidSchema = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
export const catalogPolicyCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]{0,63}$/)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
export const catalogPolicyInstantSchema = z
  .string()
  .length(20)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z') === value
  )
export const catalogPolicyStatusSchema = z.enum(['draft', 'review', 'published', 'hidden', 'discontinued'])
const positiveId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const productVersion = positiveId.max(Number.MAX_SAFE_INTEGER - 1)
const text = (minimum: number, maximum: number, multiline = false) =>
  z
    .string()
    .refine((value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code !== 127 && (code >= 32 || (multiline && [9, 10, 13].includes(code)))
      })
    )
    .transform((value) => value.trim())
    .pipe(z.string().min(minimum).max(maximum))
const reason = text(10, 500)

/** JSON own-data boundary before Zod: never execute accessors, inherited keys,
 * coercion hooks or optional-own undefined. Arrays must be dense and ordinary.
 * Copies retain key presence while removing Object.prototype inheritance. */
export function catalogPolicyOwnJson(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (depth > 10) throw new Error('invalid_catalog_policy_data')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('invalid_catalog_policy_data')
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new Error('invalid_catalog_policy_data')
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) throw new Error('invalid_catalog_policy_data')
  const length: unknown = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : undefined
  if (array && (typeof length !== 'number' || length > 1000 || keys.length !== length + 1))
    throw new Error('invalid_catalog_policy_data')
  seen.add(value)
  const output: Record<string, unknown> = Object.create(null)
  const items: unknown[] = []
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error('invalid_catalog_policy_data')
    if (array && key === 'length') continue
    const descriptor = descriptors[key]!
    if (
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= Number(length))) ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )
      throw new Error('invalid_catalog_policy_data')
    const item = catalogPolicyOwnJson(descriptor.value, depth + 1, seen)
    if (array) items[Number(key)] = item
    else output[key] = item
  }
  seen.delete(value)
  return array ? items : output
}
function data(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const uniqueFields = z
  .array(z.enum(REQUIRED_PUBLICATION_FIELDS))
  .max(REQUIRED_PUBLICATION_FIELDS.length)
  .refine((values) => new Set(values).size === values.length)
  .transform((values) => [...values].sort())
const uniqueRoles = z
  .array(z.enum(PUBLICATION_DOCUMENT_ROLES))
  .max(PUBLICATION_DOCUMENT_ROLES.length)
  .refine((values) => new Set(values).size === values.length)
  .transform((values) => [...values].sort())
const window = (value: { validFrom: string; validUntil: string | null }) =>
  value.validUntil === null || value.validUntil > value.validFrom
export const policyCreateInputSchema = z.preprocess(
  data,
  z
    .object({
      code: catalogPolicyCodeSchema,
      name: text(3, 160),
      expectedVersion: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 1),
      requiredFields: uniqueFields,
      requiredMediaRoles: uniqueRoles,
      identifierExceptionsAllowed: z.boolean(),
      validFrom: catalogPolicyInstantSchema,
      validUntil: catalogPolicyInstantSchema.nullable(),
      reason
    })
    .strict()
    .refine(window)
)
export const policyWithdrawInputSchema = z.preprocess(data, z.object({ expectedVersion: positiveId, reason }).strict())
export const policyRegulatoryInputSchema = z
  .object({
    productType: catalogPolicyCodeSchema,
    requiresSds: z.boolean(),
    safetyInstructions: text(0, 2000, true).optional(),
    hazardStatements: text(0, 2000, true).optional(),
    precautionaryStatements: text(0, 2000, true).optional(),
    manufacturer: text(1, 160).optional()
  })
  .strict()
export const policyAssignInputSchema = z.preprocess(
  data,
  z
    .object({
      expectedVersion: productVersion,
      policyId: catalogPolicyUuidSchema,
      regulatory: policyRegulatoryInputSchema,
      reason
    })
    .strict()
)
export const exceptionCreateInputSchema = z.preprocess(
  data,
  z
    .object({
      expectedVersion: productVersion,
      variantId: catalogPolicyUuidSchema,
      reason,
      evidenceReference: text(3, 200),
      validFrom: catalogPolicyInstantSchema,
      validUntil: catalogPolicyInstantSchema.nullable()
    })
    .strict()
    .refine(window)
)
export const exceptionWithdrawInputSchema = z.preprocess(
  data,
  z.object({ expectedVersion: productVersion, reason }).strict()
)
export type PolicyCreateInput = z.infer<typeof policyCreateInputSchema>
export type PolicyWithdrawInput = z.infer<typeof policyWithdrawInputSchema>
export type PolicyAssignInput = z.infer<typeof policyAssignInputSchema>
export type ExceptionCreateInput = z.infer<typeof exceptionCreateInputSchema>
export type ExceptionWithdrawInput = z.infer<typeof exceptionWithdrawInputSchema>
export const catalogPolicyReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    action: catalogPolicyActionSchema,
    entityId: catalogPolicyUuidSchema,
    resourceId: catalogPolicyUuidSchema,
    policyVersion: positiveId.nullable(),
    productId: positiveId.nullable(),
    productUuid: catalogPolicyUuidSchema.nullable(),
    catalogVersion: positiveId.nullable(),
    updated: z.literal(true)
  })
  .strict()
export type CatalogPolicyReceipt = z.infer<typeof catalogPolicyReceiptSchema>
export interface CatalogPublicationPolicyView {
  id: string
  code: string
  version: number
  name: string
  requiredFields: (typeof REQUIRED_PUBLICATION_FIELDS)[number][]
  requiredMediaRoles: (typeof PUBLICATION_DOCUMENT_ROLES)[number][]
  identifierExceptionsAllowed: boolean
  validFrom: string
  validUntil: string | null
  current: boolean
  withdrawn: boolean
  assignedProductCount: number
  publishedProductCount: number
}
export interface CatalogPoliciesView {
  source: 'cloudflare'
  capabilities: { publicationPoliciesRead: true; publicationPoliciesWrite: true }
  items: CatalogPublicationPolicyView[]
  pagination: { page: number; perPage: number; total: number; pages: number }
  evaluatedAt: string
}
export interface ProductPublicationPolicyView {
  source: 'cloudflare'
  capabilities: {
    productPublicationPolicyRead: true
    productPublicationPolicyWrite: true
    productIdentifierExceptionsWrite: true
  }
  productId: number
  productUuid: string
  catalogVersion: number
  status: z.infer<typeof catalogPolicyStatusSchema>
  regulatory: {
    productType: string | null
    requiresSds: boolean | null
    safetyInstructions: string | null
    hazardStatements: string | null
    precautionaryStatements: string | null
    manufacturer: string | null
  }
  policy: CatalogPublicationPolicyView | null
  variants: {
    id: string
    legacyId: number | null
    status: z.infer<typeof catalogPolicyStatusSchema>
    ean: string | null
    gtin: string | null
    mpn: string | null
    identifierException: null | {
      id: string
      reason: string
      evidenceReference: string
      validFrom: string
      validUntil: string | null
    }
  }[]
  evaluatedAt: string
}
