import { z } from 'zod'
import { hazardClassSchema, packingLineSchema, type PackingPlan } from './packing-optimizer'

const commandId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const boxTypeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    widthMm: z.number().int().min(1).max(3000),
    heightMm: z.number().int().min(1).max(3000),
    depthMm: z.number().int().min(1).max(3000),
    tareGrams: z.number().int().min(0).max(100000),
    maxWeightGrams: z.number().int().min(1).max(1000000),
    hazmatAllowed: z.boolean(),
    active: z.boolean(),
    expectedVersion: version
  })
  .strict()
  .refine((v) => v.tareGrams < v.maxWeightGrams, { message: 'tare must be below max weight' })
export type BoxTypeInput = z.infer<typeof boxTypeInputSchema>

export const boxCodeSchema = z.string().regex(/^[A-Z0-9_-]{1,30}$/)

export const productProfileInputSchema = z
  .object({
    weightGrams: z.number().int().min(1).max(1000000),
    widthMm: z.number().int().min(1).max(3000),
    heightMm: z.number().int().min(1).max(3000),
    depthMm: z.number().int().min(1).max(3000),
    hazardClass: hazardClassSchema,
    expectedVersion: version
  })
  .strict()
export type ProductProfileInput = z.infer<typeof productProfileInputSchema>

export const incompatibilityInputSchema = z
  .object({ classA: hazardClassSchema, classB: hazardClassSchema, reason: z.string().trim().min(3).max(200) })
  .strict()
export const incompatibilityDeleteSchema = z.object({ classA: hazardClassSchema, classB: hazardClassSchema }).strict()

export const createSuggestionInputSchema = z
  .object({
    commandId,
    orderId: z.string().min(1).max(64).optional(),
    lines: z.array(packingLineSchema).min(1).max(200).optional()
  })
  .strict()
  .refine((v) => v.lines !== undefined || v.orderId !== undefined, { message: 'lines or orderId required' })
export type CreateSuggestionInput = z.infer<typeof createSuggestionInputSchema>

export const decideSuggestionInputSchema = z
  .object({
    commandId,
    expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    decision: z.enum(['accept', 'reject']),
    actualParcels: z
      .array(
        z
          .object({ parcelIndex: z.number().int().min(0).max(19), weightGrams: z.number().int().min(1).max(1000000) })
          .strict()
      )
      .max(20)
      .optional(),
    note: z.string().trim().max(500).optional()
  })
  .strict()
export type DecideSuggestionInput = z.infer<typeof decideSuggestionInputSchema>

export interface PackingBoxView {
  code: string
  name: string
  widthMm: number
  heightMm: number
  depthMm: number
  tareGrams: number
  maxWeightGrams: number
  hazmatAllowed: boolean
  active: boolean
  version: number
  updatedAt: string
}
export interface PackingProfileView {
  sku: string
  weightGrams: number
  widthMm: number
  heightMm: number
  depthMm: number
  hazardClass: string
  version: number
  updatedAt: string
}
export interface PackingSuggestionView {
  id: string
  orderId: string | null
  status: 'suggested' | 'validated' | 'rejected'
  version: number
  algorithmVersion: string
  lines: Array<{ sku: string; quantity: number; lineIndex?: number }>
  plan: PackingPlan
  orderPackingParcels: Array<{
    weightGrams: number
    widthMm: number
    heightMm: number
    depthMm: number
    contents: Array<{ lineIndex: number; quantity: number }>
  }> | null
  validation: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  validatedAt: string | null
}
export interface PackingConfigView {
  boxes: PackingBoxView[]
  profiles: PackingProfileView[]
  incompatibilities: Array<{ classA: string; classB: string; reason: string }>
  suggestions: Array<
    Pick<PackingSuggestionView, 'id' | 'orderId' | 'status' | 'version' | 'createdAt'> & { parcelCount: number }
  >
}
