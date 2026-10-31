import { z } from 'zod'

export const accountTypeSchema = z.enum(['particular', 'empresa'])
export type AccountType = z.infer<typeof accountTypeSchema>

export const accountSessionSchema = z
  .object({
    identityId: z.string().uuid(),
    sessionId: z.string().uuid(),
    sessionVersion: z.number().int().positive(),
    customerId: z.string().uuid(),
    accountType: accountTypeSchema,
    companyId: z.string().nullable(),
    email: z.string().email()
  })
  .strict()

export type AccountSession = z.infer<typeof accountSessionSchema>

export const accountProfileViewSchema = z
  .object({
    customerId: z.string(),
    email: z.string(),
    accountType: accountTypeSchema,
    companyId: z.string().nullable(),
    cif: z.string().nullable(),
    legalName: z.string().nullable()
  })
  .strict()

export type AccountProfileView = z.infer<typeof accountProfileViewSchema>

export const scopeAssertionInputSchema = z
  .object({
    isMultiSite: z.boolean(),
    buyerRole: z.string().nullable(),
    requiresDepartmentalApproval: z.boolean()
  })
  .strict()

export type ScopeAssertionInput = z.infer<typeof scopeAssertionInputSchema>

export const scopeAssertionResultSchema = z
  .object({
    singleSiteConfirmed: z.boolean(),
    noHierarchyConfirmed: z.boolean()
  })
  .strict()

export type ScopeAssertionResult = z.infer<typeof scopeAssertionResultSchema>
