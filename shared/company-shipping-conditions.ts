import { z } from 'zod'

export const companyShippingMethodCodeSchema = z.enum(['pickup', 'own_delivery', 'parcel', 'carrier_customer_account'])
export type CompanyShippingMethodCode = z.infer<typeof companyShippingMethodCodeSchema>

export const companyShippingConditionsSchema = z
  .object({
    companyId: z.string().min(1).max(64),
    customMethodsEnabled: z.boolean(),
    allowedMethods: z.array(companyShippingMethodCodeSchema),
    carrierAccountCarrier: z.string().min(2).max(64).nullable(),
    carrierAccountNumber: z.string().min(1).max(64).nullable(),
    warehousePickupAllowed: z.boolean(),
    freeShippingThresholdCents: z.number().int().nonnegative().nullable(),
    customDeliveryInstructions: z.string().max(500).nullable(),
    version: z.number().int().positive(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type CompanyShippingConditions = z.infer<typeof companyShippingConditionsSchema>

export const setCompanyShippingConditionsInputSchema = z
  .object({
    companyId: z.string().min(1).max(64),
    customMethodsEnabled: z.boolean().default(true),
    allowedMethods: z.array(companyShippingMethodCodeSchema).min(1),
    carrierAccountCarrier: z.string().trim().min(2).max(64).nullable().optional(),
    carrierAccountNumber: z.string().trim().min(1).max(64).nullable().optional(),
    warehousePickupAllowed: z.boolean().default(true),
    freeShippingThresholdCents: z.number().int().nonnegative().nullable().optional(),
    customDeliveryInstructions: z.string().trim().max(500).nullable().optional(),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().min(1).max(64)
  })
  .strict()
  .refine(
    (data) => {
      // If carrier_customer_account is in allowedMethods, both carrier and account number should be supplied
      if (data.allowedMethods.includes('carrier_customer_account')) {
        return !!data.carrierAccountCarrier && !!data.carrierAccountNumber
      }
      return true
    },
    {
      message:
        'carrierAccountCarrier and carrierAccountNumber are required when carrier_customer_account method is enabled',
      path: ['carrierAccountNumber']
    }
  )
export type SetCompanyShippingConditionsInput = z.infer<typeof setCompanyShippingConditionsInputSchema>

export const companyShippingConditionsResponseSchema = z
  .object({
    conditions: companyShippingConditionsSchema
  })
  .strict()
export type CompanyShippingConditionsResponse = z.infer<typeof companyShippingConditionsResponseSchema>
