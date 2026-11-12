import { z } from 'zod'
import {
  NOTIFICATION_CATEGORIES,
  notificationCategorySchema,
  type NotificationCategory
} from './multichannel-orchestration'

export { NOTIFICATION_CATEGORIES, notificationCategorySchema, type NotificationCategory }

// Zod 3's uuid validator accepted UUID-shaped values regardless of version and variant bits.
export const notificationUuidSchema = z.string().guid('Invalid uuid')

// Zod 3 counted UTF-16 code units; Zod 4's built-in string limits count code points.
const boundedText = (maximum: number) =>
  z
    .string()
    .max(maximum, `String must contain at most ${maximum} character(s)`)
    .superRefine((value, context) => {
      if (value.length > maximum && Array.from(value).length <= maximum) {
        context.addIssue({
          code: 'too_big',
          origin: 'string',
          maximum,
          inclusive: true,
          message: `String must contain at most ${maximum} character(s)`
        })
      }
    })
const requiredText = (maximum: number) => boundedText(maximum).min(1, 'String must contain at least 1 character(s)')

export const accountNotificationItemSchema = z
  .object({
    id: notificationUuidSchema,
    customerId: notificationUuidSchema,
    category: notificationCategorySchema,
    title: requiredText(200),
    body: requiredText(2000),
    link: boundedText(500).nullable(),
    read: z.boolean(),
    readAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .nullable(),
    mandatory: z.boolean(),
    metadata: z.record(z.string(), z.unknown()),
    dedupKey: boundedText(150).nullable(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()

export type AccountNotificationItem = z.infer<typeof accountNotificationItemSchema>

export const categorySummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    unread: z.number().int().nonnegative()
  })
  .strict()

export const accountNotificationSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    unread: z.number().int().nonnegative(),
    byCategory: z.object({
      pedido: categorySummarySchema,
      factura: categorySummarySchema,
      stock: categorySummarySchema,
      soporte: categorySummarySchema
    })
  })
  .strict()

export type AccountNotificationSummary = z.infer<typeof accountNotificationSummarySchema>

export const createNotificationInputSchema = z
  .object({
    customerId: notificationUuidSchema,
    category: notificationCategorySchema,
    title: requiredText(200),
    body: requiredText(2000),
    link: boundedText(500).optional(),
    mandatory: z.boolean().default(false),
    metadata: z.record(z.string(), z.unknown()).default({}),
    dedupKey: boundedText(150).optional()
  })
  .strict()

export type CreateNotificationInput = z.infer<typeof createNotificationInputSchema>

export const markNotificationsReadInputSchema = z
  .object({
    notificationIds: z.array(notificationUuidSchema).min(1).max(100).optional(),
    all: z.boolean().optional(),
    category: notificationCategorySchema.optional()
  })
  .strict()
  .refine((data) => data.all === true || (Array.isArray(data.notificationIds) && data.notificationIds.length > 0), {
    message: 'Must provide either notificationIds or all: true'
  })

export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadInputSchema>

export const listNotificationsQuerySchema = z
  .object({
    category: z.enum(['all', ...NOTIFICATION_CATEGORIES]).default('all'),
    status: z.enum(['all', 'unread', 'read']).default('all'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0)
  })
  .strict()

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>
