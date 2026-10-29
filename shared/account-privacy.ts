import { z } from 'zod'
import { catalogPolicyInstantSchema as instant } from './catalog-publication-policy'
const uuid = z.string().uuid()
export const accountPrivacyInputSchema = z
  .object({ requestType: z.enum(['export', 'anonymize']), idempotencyKey: uuid })
  .strict()
export const accountPrivacyRequestSchema = z
  .object({
    id: uuid,
    commandId: uuid,
    requestType: z.enum(['export', 'anonymize']),
    status: z.enum(['requested', 'completed']),
    requestedAt: instant,
    dueAt: instant,
    completedAt: instant.nullable()
  })
  .strict()
  .refine(
    (r) =>
      r.dueAt >= r.requestedAt &&
      (r.requestType === 'export'
        ? r.status === 'completed' && r.completedAt === r.requestedAt
        : r.status === 'requested' && r.completedAt === null)
  )
export const accountPrivacyResponseSchema = z
  .object({ source: z.literal('cloudflare'), requests: z.array(accountPrivacyRequestSchema).max(200) })
  .strict()
export const accountPrivacyCommandSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    outcome: z.enum(['applied', 'unknown']),
    receipt: accountPrivacyRequestSchema.nullable()
  })
  .strict()
  .refine((r) => (r.outcome === 'applied') === (r.receipt !== null))
const text = z.string(),
  nullable = text.nullable()
export const accountPrivacyExportSchema = z
  .object({
    schemaVersion: z.literal(1),
    exportedAt: instant,
    securityNotices: z
      .array(
        z
          .object({
            kind: z.enum(['password_changed', 'mfa_enabled', 'email_changed', 'fiscal_details_submitted']),
            recipient: z.string().email().max(254),
            audience: z.enum(['current', 'previous']),
            createdAt: instant
          })
          .strict()
      )
      .max(1000),
    deliveryPreferences: z
      .object({ version: z.number().int().positive().safe(), deliveryUpdates: z.boolean(), updatedAt: instant })
      .strict()
      .nullable(),
    accountPreferences: z
      .object({
        version: z.number().int().positive().safe(),
        product_updates: z.boolean(),
        replenishment: z.boolean(),
        updatedAt: instant
      })
      .strict()
      .nullable(),
    profile: z
      .object({
        email: z.string().email(),
        name: nullable,
        phone: nullable,
        status: z.literal('active'),
        createdAt: instant
      })
      .strict(),
    addresses: z
      .array(
        z
          .object({
            kind: text,
            label: text,
            recipientName: text,
            companyName: nullable,
            taxId: nullable,
            line1: text,
            line2: nullable,
            postalCode: text,
            city: text,
            region: text,
            countryCode: text,
            phone: nullable,
            instructions: nullable,
            isDefault: z.boolean()
          })
          .strict()
      )
      .max(1000),
    orders: z
      .array(
        z
          .object({
            id: uuid,
            orderStatus: text,
            totalCents: z.number().int().nonnegative().safe(),
            currency: z.literal('EUR'),
            createdAt: instant
          })
          .strict()
      )
      .max(1000),
    consents: z
      .array(
        z
          .object({
            purpose: text,
            action: text,
            policyVersion: text,
            consentText: text,
            source: text,
            occurredAt: z.number().int().positive()
          })
          .strict()
      )
      .max(1000),
    preferences: z
      .array(
        z
          .object({
            status: z.enum(['pending', 'confirmed', 'unsubscribed', 'suppressed']),
            frequency: nullable,
            topics: z.array(text).nullable(),
            locale: nullable,
            updatedAt: instant.nullable()
          })
          .strict()
      )
      .max(1),
    favorites: z
      .array(
        z.object({ listName: text, sku: text, quantity: z.number().int().positive(), createdAt: instant }).strict()
      )
      .max(1000)
  })
  .strict()
export type AccountPrivacyRequest = z.infer<typeof accountPrivacyRequestSchema>
export type AccountPrivacyExport = z.infer<typeof accountPrivacyExportSchema>
