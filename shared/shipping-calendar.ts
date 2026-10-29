import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'

const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const text = (min: number, max: number) =>
  z
    .string()
    .refine((value) =>
      [...value].every((character) => {
        const point = character.codePointAt(0)!
        return point > 31 && (point < 127 || point > 159) && point !== 0x2028 && point !== 0x2029
      })
    )
    .transform((value) => value.trim().normalize('NFC'))
    .pipe(z.string().min(min).max(max))
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
  })
export const shippingOperatingCalendarSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
    name: text(1, 100),
    scope: z.enum(['national', 'local', 'carrier']),
    stage: z.enum(['preparation', 'transit', 'both']),
    // ISO weekdays: Monday=1, Sunday=7. No implicit weekend policy.
    operatingWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    closedDates: z.array(date).max(366),
    postalPrefixes: z.array(z.string().regex(/^[0-9]{1,5}$/)).max(50),
    methodCodes: z.array(z.enum(['pickup', 'own_delivery', 'parcel'])).max(3),
    serviceProfiles: z.array(z.enum(['parcel', 'pallet', 'adr'])).max(3),
    zoneCodes: z.array(z.string().min(1).max(100)).max(30)
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const field of [
      'operatingWeekdays',
      'closedDates',
      'postalPrefixes',
      'methodCodes',
      'serviceProfiles',
      'zoneCodes'
    ] as const)
      if (new Set<string | number>(value[field]).size !== value[field].length)
        ctx.addIssue({ code: 'custom', path: [field], message: 'Duplicate value' })
    if (value.scope === 'local' && !value.postalPrefixes.length)
      ctx.addIssue({ code: 'custom', path: ['postalPrefixes'], message: 'Local calendar needs destination prefixes' })
    if (
      value.scope === 'national' &&
      (value.postalPrefixes.length ||
        value.methodCodes.length ||
        value.serviceProfiles.length ||
        value.zoneCodes.length)
    )
      ctx.addIssue({ code: 'custom', message: 'National calendar has no route selector' })
    if (value.scope === 'carrier' && !value.methodCodes.length)
      ctx.addIssue({
        code: 'custom',
        path: ['methodCodes'],
        message: 'Carrier calendar needs configured transport methods'
      })
  })
export const shippingCalendarConfigurationSchema = z
  .object({
    timeZone: z.literal('Europe/Madrid'),
    preparationBusinessDays: z.number().int().min(0).max(60),
    cutoffLocalTime: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
    calendars: z.array(shippingOperatingCalendarSchema).min(1).max(20)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.calendars.map((calendar) => calendar.code)).size !== value.calendars.length)
      ctx.addIssue({ code: 'custom', path: ['calendars'], message: 'Duplicate calendar code' })
    if (value.calendars.reduce((sum, calendar) => sum + calendar.closedDates.length, 0) > 2000)
      ctx.addIssue({ code: 'custom', path: ['calendars'], message: 'Maximum 2000 closed dates per configuration' })
  })
export const shippingCalendarInputSchema = z
  .object({
    expectedVersion: version.max(Number.MAX_SAFE_INTEGER - 1),
    configuration: shippingCalendarConfigurationSchema,
    reason: text(10, 500),
    reviewReference: text(3, 200)
  })
  .strict()
export const shippingCalendarSnapshotSchema = z
  .object({
    source: z.literal('cloudflare'),
    version,
    configuration: shippingCalendarConfigurationSchema.nullable(),
    configurationHash: hash.nullable(),
    updatedAt: instant.nullable()
  })
  .strict()
  .refine((value) =>
    value.version === 0
      ? value.configuration === null && value.configurationHash === null && value.updatedAt === null
      : value.configuration !== null && value.configurationHash !== null && value.updatedAt !== null
  )
export const shippingCalendarReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    payloadHash: hash,
    expectedVersion: version,
    version: version.min(1),
    configurationHash: hash,
    recordedAt: instant
  })
  .strict()
  .refine((value) => value.version === value.expectedVersion + 1)
export const shippingCalendarCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: shippingCalendarReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export const shippingCalendarEtaSchema = z
  .discriminatedUnion('status', [
    z
      .object({
        status: z.literal('estimated'),
        from: date,
        to: date,
        configurationVersion: version.min(1),
        configurationHash: hash
      })
      .strict(),
    z
      .object({
        status: z.literal('unknown'),
        reason: z.enum(['calendar_not_configured', 'lead_time_unknown', 'no_operating_window']),
        from: z.null(),
        to: z.null(),
        configurationVersion: version,
        configurationHash: hash.nullable()
      })
      .strict()
  ])
  .refine((value) => value.status !== 'estimated' || value.from <= value.to)
export type ShippingCalendarConfiguration = z.infer<typeof shippingCalendarConfigurationSchema>
export type ShippingCalendarInput = z.infer<typeof shippingCalendarInputSchema>
export type ShippingCalendarSnapshot = z.infer<typeof shippingCalendarSnapshotSchema>
export type ShippingCalendarReceipt = z.infer<typeof shippingCalendarReceiptSchema>
export type ShippingCalendarCommand = z.infer<typeof shippingCalendarCommandSchema>
export type ShippingCalendarEta = z.infer<typeof shippingCalendarEtaSchema>

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function shippingCalendarIntentHash(input: unknown) {
  return digest(shippingCalendarInputSchema.parse(input))
}
export async function shippingCalendarConfigurationHash(input: unknown) {
  return digest(shippingCalendarConfigurationSchema.parse(input))
}
