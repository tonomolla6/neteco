import { z } from 'zod'

export const MULTICHANNEL_POLICY_VERSION = 'multichannel-2026-10-29'

export const MULTICHANNEL_CHANNELS = ['email', 'sms', 'whatsapp'] as const
export type MultichannelChannel = (typeof MULTICHANNEL_CHANNELS)[number]

export const NOTIFICATION_CATEGORIES = ['pedido', 'factura', 'stock', 'soporte'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export const MULTICHANNEL_STATUSES = ['delivered', 'suppressed', 'fallback', 'failed', 'skipped'] as const
export type MultichannelStatus = (typeof MULTICHANNEL_STATUSES)[number]

export const DEFAULT_CHANNEL_PRIORITY: MultichannelChannel[] = ['whatsapp', 'sms', 'email']

export const multichannelChannelSchema = z.enum(MULTICHANNEL_CHANNELS)
export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES)
export const multichannelStatusSchema = z.enum(MULTICHANNEL_STATUSES)

export const priorityOrderSchema = z
  .array(multichannelChannelSchema)
  .min(1)
  .max(3)
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'Channels in priority order must be unique'
  })

export const customerChannelPreferencesSchema = z
  .object({
    customerId: z.string().uuid(),
    priorityOrder: priorityOrderSchema,
    emailEnabled: z.boolean(),
    smsEnabled: z.boolean(),
    whatsappEnabled: z.boolean(),
    version: z.number().int().min(0),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    commandId: z.string().uuid()
  })
  .strict()

export type CustomerChannelPreferences = z.infer<typeof customerChannelPreferencesSchema>

export const updateChannelPreferencesInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    priorityOrder: priorityOrderSchema.optional(),
    emailEnabled: z.boolean().optional(),
    smsEnabled: z.boolean().optional(),
    whatsappEnabled: z.boolean().optional()
  })
  .strict()

export type UpdateChannelPreferencesInput = z.infer<typeof updateChannelPreferencesInputSchema>

export const channelAttemptResultSchema = z
  .object({
    channel: multichannelChannelSchema,
    status: z.enum(['delivered', 'failed', 'suppressed', 'skipped']),
    cause: z.string().min(1).max(120),
    detail: z.string().optional(),
    providerMessageId: z.string().optional(),
    timestamp: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()

export type ChannelAttemptResult = z.infer<typeof channelAttemptResultSchema>

export const orchestrateMultichannelInputSchema = z
  .object({
    customerId: z.string().uuid(),
    dedupKey: z.string().min(1).max(150),
    category: notificationCategorySchema,
    eventType: z.string().min(1).max(80),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(2000),
    link: z.string().max(500).optional(),
    mandatory: z.boolean().default(false),
    overridePriority: priorityOrderSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    inAppCenter: z.boolean().default(true)
  })
  .strict()

export type OrchestrateMultichannelInput = z.infer<typeof orchestrateMultichannelInputSchema>

export const orchestrateMultichannelResultSchema = z
  .object({
    commandId: z.string().uuid(),
    customerId: z.string().uuid(),
    dedupKey: z.string().min(1).max(150),
    category: notificationCategorySchema,
    eventType: z.string().min(1).max(80),
    selectedChannel: multichannelChannelSchema.nullable(),
    priorityOrder: priorityOrderSchema,
    status: multichannelStatusSchema,
    cause: z.string().min(1).max(120),
    results: z.array(channelAttemptResultSchema),
    mandatory: z.boolean(),
    inAppNotificationId: z.string().uuid().nullable(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()

export type OrchestrateMultichannelResult = z.infer<typeof orchestrateMultichannelResultSchema>
