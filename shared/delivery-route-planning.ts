import { z } from 'zod'

export const deliveryVehicleStatusSchema = z.enum(['active', 'maintenance', 'inactive'])
export type DeliveryVehicleStatus = z.infer<typeof deliveryVehicleStatusSchema>

export const deliveryVehicleSchema = z
  .object({
    id: z.string().min(1).max(36),
    name: z.string().min(1).max(100),
    registrationPlate: z.string().min(1).max(20),
    maxWeightGrams: z.number().int().positive(),
    maxParcels: z.number().int().positive(),
    status: deliveryVehicleStatusSchema,
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type DeliveryVehicle = z.infer<typeof deliveryVehicleSchema>

export const deliveryDriverStatusSchema = z.enum(['active', 'off_duty'])
export type DeliveryDriverStatus = z.infer<typeof deliveryDriverStatusSchema>

export const deliveryDriverSchema = z
  .object({
    id: z.string().min(1).max(36),
    identityId: z.string().min(1).max(36).nullable().optional(),
    name: z.string().min(1).max(100),
    phone: z.string().min(6).max(30),
    licenseNumber: z.string().min(1).max(50),
    status: deliveryDriverStatusSchema,
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type DeliveryDriver = z.infer<typeof deliveryDriverSchema>

export const deliveryRouteStopStatusSchema = z.enum(['pending', 'in_progress', 'delivered', 'failed'])
export type DeliveryRouteStopStatus = z.infer<typeof deliveryRouteStopStatusSchema>

export const deliveryRouteStopSchema = z
  .object({
    id: z.string().min(1).max(36),
    routeId: z.string().min(1).max(36),
    sequenceIndex: z.number().int().nonnegative(),
    orderId: z.string().nullable().optional(),
    recipientName: z.string().min(1),
    streetAddress: z.string().min(1),
    postalCode: z.string().regex(/^\d{5}$/),
    city: z.string().min(1),
    parcelCount: z.number().int().positive(),
    weightGrams: z.number().int().nonnegative(),
    timeWindowStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    timeWindowEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    status: deliveryRouteStopStatusSchema,
    failureReason: z.string().nullable().optional(),
    completedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .nullable()
      .optional()
  })
  .strict()
export type DeliveryRouteStop = z.infer<typeof deliveryRouteStopSchema>

export const deliveryRouteStatusSchema = z.enum(['draft', 'planned', 'in_progress', 'completed', 'cancelled'])
export type DeliveryRouteStatus = z.infer<typeof deliveryRouteStatusSchema>

export const deliveryRouteSchema = z
  .object({
    id: z.string().min(1).max(36),
    routeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    vehicleId: z.string().nullable().optional(),
    driverId: z.string().nullable().optional(),
    status: deliveryRouteStatusSchema,
    windowStart: z.string().regex(/^\d{2}:\d{2}$/),
    windowEnd: z.string().regex(/^\d{2}:\d{2}$/),
    totalStops: z.number().int().nonnegative(),
    totalParcels: z.number().int().nonnegative(),
    totalWeightGrams: z.number().int().nonnegative(),
    maxWeightGrams: z.number().int().nonnegative().optional(),
    maxParcels: z.number().int().nonnegative().optional(),
    version: z.number().int().positive(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    vehicle: deliveryVehicleSchema.nullable().optional(),
    driver: deliveryDriverSchema.nullable().optional(),
    stops: z.array(deliveryRouteStopSchema).default([])
  })
  .strict()
export type DeliveryRoute = z.infer<typeof deliveryRouteSchema>

export const createDeliveryRouteInputSchema = z
  .object({
    routeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    vehicleId: z.string().min(1).max(36).optional(),
    driverId: z.string().min(1).max(36).optional(),
    windowStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default('08:00'),
    windowEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default('16:00'),
    commandId: z.string().min(1).max(64)
  })
  .strict()
export type CreateDeliveryRouteInput = z.infer<typeof createDeliveryRouteInputSchema>

export const assignRouteResourcesInputSchema = z
  .object({
    vehicleId: z.string().min(1).max(36),
    driverId: z.string().min(1).max(36),
    expectedVersion: z.number().int().positive(),
    commandId: z.string().min(1).max(64)
  })
  .strict()
export type AssignRouteResourcesInput = z.infer<typeof assignRouteResourcesInputSchema>

export const addRouteStopInputSchema = z
  .object({
    orderId: z.string().min(1).optional(),
    recipientName: z.string().trim().min(1).max(100),
    streetAddress: z.string().trim().min(1).max(200),
    postalCode: z.string().regex(/^\d{5}$/),
    city: z.string().trim().min(1).max(100),
    parcelCount: z.number().int().positive().default(1),
    weightGrams: z.number().int().nonnegative().default(1000),
    timeWindowStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    timeWindowEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    expectedVersion: z.number().int().positive(),
    commandId: z.string().min(1).max(64)
  })
  .strict()
export type AddRouteStopInput = z.infer<typeof addRouteStopInputSchema>

export const reoptimizeDeliveryRouteInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    commandId: z.string().min(1).max(64),
    optimizationStrategy: z.enum(['balanced', 'window_priority', 'distance_priority']).default('window_priority')
  })
  .strict()
export type ReoptimizeDeliveryRouteInput = z.infer<typeof reoptimizeDeliveryRouteInputSchema>

export const reoptimizeDeliveryRouteResultSchema = z
  .object({
    routeId: z.string(),
    newVersion: z.number().int().positive(),
    resequencedStopsCount: z.number().int().nonnegative(),
    totalStops: z.number().int().nonnegative(),
    totalWeightGrams: z.number().int().nonnegative(),
    totalParcels: z.number().int().nonnegative(),
    capacityOk: z.boolean(),
    route: deliveryRouteSchema
  })
  .strict()
export type ReoptimizeDeliveryRouteResult = z.infer<typeof reoptimizeDeliveryRouteResultSchema>
