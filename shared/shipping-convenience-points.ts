import { z } from 'zod'

export const conveniencePointNetworkSchema = z.enum(['inpost', 'correos', 'seur', 'gls'])
export type ConveniencePointNetwork = z.infer<typeof conveniencePointNetworkSchema>

export const conveniencePointStatusSchema = z.enum(['active', 'temporarily_closed'])
export type ConveniencePointStatus = z.infer<typeof conveniencePointStatusSchema>

export const conveniencePointOpeningHoursSchema = z.record(
  z.string(),
  z
    .object({
      open: z.string().regex(/^\d{2}:\d{2}$/),
      close: z.string().regex(/^\d{2}:\d{2}$/)
    })
    .nullable()
)
export type ConveniencePointOpeningHours = z.infer<typeof conveniencePointOpeningHoursSchema>

export const conveniencePointSchema = z
  .object({
    id: z.string().min(1).max(64),
    network: conveniencePointNetworkSchema,
    code: z.string().min(1).max(50),
    name: z.string().min(1).max(150),
    streetAddress: z.string().min(1).max(250),
    postalCode: z.string().regex(/^\d{5}$/),
    city: z.string().min(1).max(100),
    province: z.string().min(1).max(100),
    countryCode: z.literal('ES'),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    openingHours: conveniencePointOpeningHoursSchema.default({}),
    operatingStatus: conveniencePointStatusSchema,
    maxWeightGrams: z.number().int().positive(),
    acceptsReturns: z.boolean(),
    hasLocker: z.boolean(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type ConveniencePoint = z.infer<typeof conveniencePointSchema>

export const searchConveniencePointsQuerySchema = z
  .object({
    postalCode: z.string().regex(/^\d{5}$/),
    network: conveniencePointNetworkSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20)
  })
  .strict()
export type SearchConveniencePointsQuery = z.infer<typeof searchConveniencePointsQuerySchema>

export const selectedConveniencePointSchema = z
  .object({
    id: z.string().min(1).max(64),
    network: conveniencePointNetworkSchema,
    code: z.string().min(1).max(50),
    name: z.string().min(1).max(150),
    streetAddress: z.string().min(1).max(250),
    postalCode: z.string().regex(/^\d{5}$/),
    city: z.string().min(1).max(100)
  })
  .strict()
export type SelectedConveniencePoint = z.infer<typeof selectedConveniencePointSchema>

export const conveniencePointsResponseSchema = z
  .object({
    points: z.array(conveniencePointSchema),
    total: z.number().int().nonnegative(),
    postalCode: z.string().regex(/^\d{5}$/)
  })
  .strict()
export type ConveniencePointsResponse = z.infer<typeof conveniencePointsResponseSchema>
