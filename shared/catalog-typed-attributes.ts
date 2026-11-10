import { z } from 'zod'
import { catalogPolicyCodeSchema, catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const CATALOG_TYPED_ATTRIBUTE_KINDS = ['text', 'number', 'unit', 'boolean', 'list', 'reference'] as const
export const CATALOG_TYPED_ATTRIBUTE_UNITS = {
  ml: 'Mililitros',
  l: 'Litros',
  g: 'Gramos',
  kg: 'Kilogramos',
  mm: 'Milímetros',
  cm: 'Centímetros',
  m: 'Metros',
  m2: 'Metros cuadrados',
  m3: 'Metros cúbicos',
  um: 'Micrómetros',
  ud: 'Unidades',
  percent: 'Porcentaje'
} as const
export const CATALOG_TYPED_ATTRIBUTE_MAX_DEFINITIONS = 32
export const CATALOG_TYPED_ATTRIBUTE_MAX_OPTIONS = 100
export const CATALOG_TYPED_ATTRIBUTE_MAX_SELECTIONS = 16
export type CatalogTypedAttributeKind = (typeof CATALOG_TYPED_ATTRIBUTE_KINDS)[number]
export type CatalogTypedAttributeUnit = keyof typeof CATALOG_TYPED_ATTRIBUTE_UNITS
export type CatalogTypedAttributeStatus = 'active' | 'retired'
export interface CatalogTypedAttributeOption {
  code: string
  label: string
  status: CatalogTypedAttributeStatus
}
export interface CatalogTypedAttributeConfigs {
  text: { maxLength: number }
  number: { precision: number; min?: number; max?: number }
  unit: { precision: number; min?: number; max?: number; units: CatalogTypedAttributeUnit[] }
  boolean: Record<string, never>
  list: { options: CatalogTypedAttributeOption[] }
  reference: Record<string, never>
}
interface DefinitionIdentity {
  id: string
  categoryId: number
  categoryUuid: string
  code: string
  label: string
  revision: number
  status: CatalogTypedAttributeStatus
}
export type CatalogTypedAttributeDefinition = {
  [K in CatalogTypedAttributeKind]: DefinitionIdentity & { kind: K; config: CatalogTypedAttributeConfigs[K] }
}[CatalogTypedAttributeKind]
export type CreateCatalogTypedAttributeDefinitionInput = {
  [K in CatalogTypedAttributeKind]: {
    categoryId: number
    code: string
    kind: K
    label: string
    config: CatalogTypedAttributeConfigs[K]
    expectedVersion: 0
    reason: string
  }
}[CatalogTypedAttributeKind]
export interface UpdateCatalogTypedAttributeDefinitionInput {
  label: string
  config: CatalogTypedAttributeConfigs[CatalogTypedAttributeKind]
  expectedVersion: number
  reason: string
}
export interface RetireCatalogTypedAttributeDefinitionInput {
  expectedVersion: number
  reason: string
}
export type CatalogTypedAttributeValue =
  string | number | boolean | string[] | { quantity: number; unit: CatalogTypedAttributeUnit }
export interface CatalogTypedAttributeValues {
  version: 1
  values: Array<{ definitionId: string; revision: number; value: CatalogTypedAttributeValue }>
}
export type CatalogTypedAttributeDefinitionAction = 'create' | 'update' | 'retire'
export interface CatalogTypedAttributeReceipt {
  source: 'cloudflare'
  action: CatalogTypedAttributeDefinitionAction
  commandId: string
  definition: CatalogTypedAttributeDefinition
  updated: true
}
export interface CatalogTypedAttributeValidationContext {
  categoryId: number
  mode: 'write' | 'historical'
  productId?: string
}
export type CatalogTypedAttributeValidationIssueCode =
  | 'invalid_input'
  | 'definition_unavailable'
  | 'category_mismatch'
  | 'revision_conflict'
  | 'definition_retired'
  | 'invalid_value'
  | 'self_reference'
export type CatalogTypedAttributeValidationResult =
  | { success: true; data: CatalogTypedAttributeValues }
  | {
      success: false
      issues: Array<{ index: number; definitionId?: string; code: CatalogTypedAttributeValidationIssueCode }>
    }

function own(value: unknown): unknown {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const safeText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    // Zod 4 counts code points; keep the UTF-16 length limit enforced by D1 and by Zod 3.
    .refine((value) => value.length <= maximum)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        [...value].every((character) => {
          const code = character.codePointAt(0)!
          return code > 31 && code !== 127
        })
    )
const positive = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1)
const numeric = z.number().finite().min(-1e9).max(1e9)
const status = z.enum(['active', 'retired'])
const unit = z.enum(
  Object.keys(CATALOG_TYPED_ATTRIBUTE_UNITS) as [CatalogTypedAttributeUnit, ...CatalogTypedAttributeUnit[]]
)
const range = (value: { min?: number; max?: number }) =>
  value.min === undefined || value.max === undefined || value.min <= value.max
const numericConfig = z
  .object({ precision: z.number().int().min(0).max(6), min: numeric.optional(), max: numeric.optional() })
  .strict()
const configs = {
  text: z.object({ maxLength: z.number().int().min(1).max(500) }).strict(),
  number: numericConfig.refine(range),
  unit: numericConfig
    .extend({
      units: z
        .array(unit)
        .min(1)
        .max(12)
        .refine((items) => new Set(items).size === items.length)
    })
    .strict()
    .refine(range),
  boolean: z.object({}).strict(),
  list: z
    .object({
      options: z
        .array(z.object({ code: catalogPolicyCodeSchema, label: safeText(160), status }).strict())
        .min(1)
        .max(CATALOG_TYPED_ATTRIBUTE_MAX_OPTIONS)
        .refine((items) => new Set(items.map((item) => item.code)).size === items.length)
    })
    .strict(),
  reference: z.object({}).strict()
}
const identity = {
  id: catalogPolicyUuidSchema,
  categoryId: positive,
  categoryUuid: safeText(200),
  code: catalogPolicyCodeSchema,
  label: safeText(160),
  revision: positive,
  status
}
const definition = z.discriminatedUnion('kind', [
  z.object({ ...identity, kind: z.literal('text'), config: configs.text }).strict(),
  z.object({ ...identity, kind: z.literal('number'), config: configs.number }).strict(),
  z.object({ ...identity, kind: z.literal('unit'), config: configs.unit }).strict(),
  z.object({ ...identity, kind: z.literal('boolean'), config: configs.boolean }).strict(),
  z.object({ ...identity, kind: z.literal('list'), config: configs.list }).strict(),
  z.object({ ...identity, kind: z.literal('reference'), config: configs.reference }).strict()
])
export const catalogTypedAttributeDefinitionSchema: z.ZodType<CatalogTypedAttributeDefinition, unknown> = z.preprocess(
  own,
  definition
)
const reason = safeText(500).refine((value) => value.trim().length >= 3)
const creation = {
  categoryId: positive,
  code: catalogPolicyCodeSchema,
  label: safeText(160),
  expectedVersion: z.literal(0),
  reason
}
export const createCatalogTypedAttributeDefinitionSchema: z.ZodType<
  CreateCatalogTypedAttributeDefinitionInput,
  unknown
> = z.preprocess(
  own,
  z.discriminatedUnion('kind', [
    z.object({ ...creation, kind: z.literal('text'), config: configs.text }).strict(),
    z.object({ ...creation, kind: z.literal('number'), config: configs.number }).strict(),
    z.object({ ...creation, kind: z.literal('unit'), config: configs.unit }).strict(),
    z.object({ ...creation, kind: z.literal('boolean'), config: configs.boolean }).strict(),
    z.object({ ...creation, kind: z.literal('list'), config: configs.list }).strict(),
    z.object({ ...creation, kind: z.literal('reference'), config: configs.reference }).strict()
  ])
)
export const updateCatalogTypedAttributeDefinitionSchema: z.ZodType<
  UpdateCatalogTypedAttributeDefinitionInput,
  unknown
> = z.preprocess(
  own,
  z
    .object({
      label: safeText(160),
      config: z.union([configs.text, configs.number, configs.unit, configs.boolean, configs.list]),
      expectedVersion: positive,
      reason
    })
    .strict()
)
export const retireCatalogTypedAttributeDefinitionSchema: z.ZodType<
  RetireCatalogTypedAttributeDefinitionInput,
  unknown
> = z.preprocess(own, z.object({ expectedVersion: positive, reason }).strict())
const selection = z
  .array(catalogPolicyCodeSchema)
  .max(CATALOG_TYPED_ATTRIBUTE_MAX_SELECTIONS)
  .refine((items) => new Set(items).size === items.length)
const value = z.union([safeText(500), numeric, z.boolean(), selection, z.object({ quantity: numeric, unit }).strict()])
export const catalogTypedAttributeValuesSchema: z.ZodType<CatalogTypedAttributeValues, unknown> = z.preprocess(
  own,
  z
    .object({
      version: z.literal(1),
      values: z
        .array(z.object({ definitionId: catalogPolicyUuidSchema, revision: positive, value }).strict())
        .max(CATALOG_TYPED_ATTRIBUTE_MAX_DEFINITIONS)
        .refine((items) => new Set(items.map((item) => item.definitionId)).size === items.length)
    })
    .strict()
)
export const catalogTypedAttributeReceiptSchema: z.ZodType<CatalogTypedAttributeReceipt, unknown> = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      action: z.enum(['create', 'update', 'retire']),
      commandId: catalogPolicyUuidSchema,
      definition,
      updated: z.literal(true)
    })
    .strict()
)

/** Same numeric rule as SQLite round(n,p)=n; no coercion, epsilon or conversion. */
export function typedAttributeNumberMatchesPrecision(value: number, precision: number): boolean {
  return (
    Number.isFinite(value) &&
    Math.abs(value) <= 1e9 &&
    Number.isInteger(precision) &&
    precision >= 0 &&
    precision <= 6 &&
    Math.round(value * 10 ** precision) / 10 ** precision === value
  )
}
function validNumber(value: unknown, config: CatalogTypedAttributeConfigs['number']): boolean {
  return (
    typeof value === 'number' &&
    typedAttributeNumberMatchesPrecision(value, config.precision) &&
    (config.min === undefined || value >= config.min) &&
    (config.max === undefined || value <= config.max)
  )
}
function validValue(
  value: CatalogTypedAttributeValue,
  definition: CatalogTypedAttributeDefinition,
  mode: 'write' | 'historical'
): boolean {
  switch (definition.kind) {
    case 'text':
      return typeof value === 'string' && safeText(definition.config.maxLength).safeParse(value).success
    case 'number':
      return validNumber(value, definition.config)
    case 'unit':
      return (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        validNumber(value.quantity, definition.config) &&
        definition.config.units.includes(value.unit)
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'list':
      return (
        Array.isArray(value) &&
        selection.safeParse(value).success &&
        value.every((code) =>
          definition.config.options.some(
            (option) => option.code === code && (mode === 'historical' || option.status === 'active')
          )
        )
      )
    case 'reference':
      return catalogPolicyUuidSchema.safeParse(value).success
  }
}
export function validateTypedAttributeValues(
  raw: unknown,
  definitionsInput: readonly CatalogTypedAttributeDefinition[],
  contextInput: CatalogTypedAttributeValidationContext
): CatalogTypedAttributeValidationResult {
  const parsed = catalogTypedAttributeValuesSchema.safeParse(raw)
  const context = z
    .preprocess(
      own,
      z
        .object({
          categoryId: positive,
          mode: z.enum(['write', 'historical']),
          productId: catalogPolicyUuidSchema.optional()
        })
        .strict()
    )
    .safeParse(contextInput)
  const definitions = z.preprocess(own, z.array(definition).max(1000)).safeParse(definitionsInput)
  if (!parsed.success || !context.success || !definitions.success)
    return { success: false, issues: [{ index: -1, code: 'invalid_input' }] }
  const byId = new Map<string, Map<number, CatalogTypedAttributeDefinition>>()
  for (const item of definitions.data) {
    const revisions = byId.get(item.id) ?? new Map<number, CatalogTypedAttributeDefinition>()
    if (revisions.has(item.revision)) return { success: false, issues: [{ index: -1, code: 'invalid_input' }] }
    revisions.set(item.revision, item)
    byId.set(item.id, revisions)
  }
  const issues: Array<{ index: number; definitionId: string; code: CatalogTypedAttributeValidationIssueCode }> = []
  parsed.data.values.forEach((entry, index) => {
    const revisions = byId.get(entry.definitionId),
      item = revisions?.get(entry.revision)
    let code: CatalogTypedAttributeValidationIssueCode | undefined
    if (!revisions) code = 'definition_unavailable'
    else if (!item) code = 'revision_conflict'
    else if (item.categoryId !== context.data.categoryId) code = 'category_mismatch'
    else if (context.data.mode === 'write' && entry.revision !== Math.max(...revisions.keys()))
      code = 'revision_conflict'
    else if (context.data.mode === 'write' && item.status !== 'active') code = 'definition_retired'
    else if (!validValue(entry.value, item, context.data.mode)) code = 'invalid_value'
    else if (item.kind === 'reference' && entry.value === context.data.productId) code = 'self_reference'
    if (code) issues.push({ index, definitionId: entry.definitionId, code })
  })
  return issues.length ? { success: false, issues } : { success: true, data: parsed.data }
}
