import { z } from 'zod'

function hasControlCharacters(value: string, allowWhitespace: boolean): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return (code < 32 && !(allowWhitespace && (code === 9 || code === 10 || code === 13))) || code === 127
  })
}

export const recurringFrequencySchema = z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'custom'])
export type RecurringFrequency = z.infer<typeof recurringFrequencySchema>

export const recurringListStatusSchema = z.enum(['active', 'paused', 'archived'])
export type RecurringListStatus = z.infer<typeof recurringListStatusSchema>

export const collaboratorRoleSchema = z.enum(['editor', 'viewer'])
export type CollaboratorRole = z.infer<typeof collaboratorRoleSchema>

export const recurringListCreateInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'name_required')
      .max(100, 'name_too_long')
      .refine((v) => !hasControlCharacters(v, false), 'control_characters_not_allowed'),
    description: z
      .string()
      .trim()
      .max(500, 'description_too_long')
      .refine((v) => !hasControlCharacters(v, true), 'control_characters_not_allowed')
      .optional()
      .nullable(),
    frequency: recurringFrequencySchema,
    frequencyDays: z.number().int().min(1).max(365).optional().nullable(),
    nextSuggestedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date_format')
      .optional()
      .nullable()
  })
  .strict()
  .refine(
    (data) => {
      if (data.frequency === 'custom' && (!data.frequencyDays || data.frequencyDays < 1)) {
        return false
      }
      return true
    },
    { message: 'frequency_days_required_for_custom', path: ['frequencyDays'] }
  )

export type RecurringListCreateInput = z.infer<typeof recurringListCreateInputSchema>

export const recurringListUpdateInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((v) => !hasControlCharacters(v, false))
      .optional(),
    description: z
      .string()
      .trim()
      .max(500)
      .refine((v) => !hasControlCharacters(v, true))
      .optional()
      .nullable(),
    frequency: recurringFrequencySchema.optional(),
    frequencyDays: z.number().int().min(1).max(365).optional().nullable(),
    nextSuggestedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
    status: recurringListStatusSchema.optional(),
    expectedVersion: z.number().int().min(1)
  })
  .strict()

export type RecurringListUpdateInput = z.infer<typeof recurringListUpdateInputSchema>

export const recurringListCollaboratorInviteInputSchema = z
  .object({
    email: z.string().trim().email().max(254),
    role: collaboratorRoleSchema
  })
  .strict()

export type RecurringListCollaboratorInviteInput = z.infer<typeof recurringListCollaboratorInviteInputSchema>

export const recurringListItemSetInputSchema = z
  .object({
    variantId: z.string().min(1).max(64),
    quantity: z.number().int().min(1).max(999),
    expectedUnitGrossCents: z.number().int().min(0).optional().nullable()
  })
  .strict()

export type RecurringListItemSetInput = z.infer<typeof recurringListItemSetInputSchema>

export interface RecurringListItemRevalidated {
  variantId: string
  sku: string
  name: string
  quantity: number
  available: boolean
  reason: 'unpublished' | 'out_of_stock' | 'price_changed' | null
  baselinePriceCents: number
  effectivePriceCents: number
  priceVarianceCents: number
  sellableStock: number
}

export interface RecurringListRevalidationReport {
  listId: string
  listName: string
  frequency: RecurringFrequency
  nextSuggestedDate: string | null
  allAvailable: boolean
  itemCount: number
  availableCount: number
  unavailableCount: number
  priceChangedCount: number
  totalCurrentGrossCents: number
  totalExpectedGrossCents: number
  totalVarianceCents: number
  items: RecurringListItemRevalidated[]
}
