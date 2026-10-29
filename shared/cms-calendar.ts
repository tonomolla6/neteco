import { z } from 'zod'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from './catalog-publication-policy'
import {
  BUSINESS_TIME_ZONE,
  madridDateKey,
  madridDateTimeParts,
  madridTimeKey,
  madridLocalDateTimeToInstant
} from '../server/utils/madrid-calendar'

const own = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
export const cmsCalendarMonthSchema = z.string().regex(/^(20[0-9]{2})-(0[1-9]|1[0-2])$/)
export const cmsCalendarQuerySchema = z.preprocess(
  own,
  z
    .object({
      month: cmsCalendarMonthSchema.optional(),
      page: z.number().int().min(1).max(1_000_000).default(1),
      perPage: z.number().int().min(1).max(100).default(25)
    })
    .strict()
)
export type CmsCalendarQuery = z.infer<typeof cmsCalendarQuerySchema>

/** Month boundaries are Madrid midnight, not browser-local or UTC midnight.
 * Reuse the already tested DST-aware CMS scheduler conversion. */
export function cmsCalendarRange(month: string) {
  cmsCalendarMonthSchema.parse(month)
  const [year, index] = month.split('-').map(Number),
    next = new Date(Date.UTC(year!, index!, 1)).toISOString().slice(0, 7)
  return {
    start: madridLocalDateTimeToInstant(`${month}-01T00:00:00`)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z'),
    end: madridLocalDateTimeToInstant(`${next}-01T00:00:00`)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
  }
}
export function cmsCalendarLocalTime(value: string) {
  const date = new Date(instant.parse(value)),
    parts = madridDateTimeParts(date)
  return {
    localDateTime: `${madridDateKey(date)}T${madridTimeKey(date)}`,
    utcOffsetMinutes:
      (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime()) /
      60000
  }
}
export const cmsCalendarEventSchema = z
  .object({
    scheduleId: uuid,
    pageId: uuid,
    versionId: uuid,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    title: z.string().trim().min(1).max(160),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(160),
    phase: z.enum(['publish', 'unpublish']),
    scheduledAt: instant,
    localDateTime: z.string().regex(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/),
    utcOffsetMinutes: z.number().int().min(-840).max(840),
    status: z.enum(['scheduled', 'due', 'applied', 'blocked', 'cancelled', 'superseded']),
    active: z.boolean(),
    code: z.string().min(1).max(100).nullable(),
    recordedAt: instant.nullable()
  })
  .strict()
  .superRefine((event, context) => {
    const local = cmsCalendarLocalTime(event.scheduledAt)
    if (
      local.localDateTime !== event.localDateTime ||
      local.utcOffsetMinutes !== event.utcOffsetMinutes ||
      (event.status === 'blocked') !== (event.code !== null) ||
      ['applied', 'blocked', 'cancelled'].includes(event.status) !== (event.recordedAt !== null) ||
      (['scheduled', 'due'].includes(event.status) && !event.active)
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed editorial calendar event' })
  })
export type CmsCalendarEvent = z.infer<typeof cmsCalendarEventSchema>

export const cmsEditorialCalendarSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      timeZone: z.literal(BUSINESS_TIME_ZONE),
      month: cmsCalendarMonthSchema,
      rangeStart: instant,
      rangeEnd: instant,
      asOf: instant,
      events: z.array(cmsCalendarEventSchema).max(100),
      pagination: z
        .object({
          page: z.number().int().min(1).max(1_000_000),
          perPage: z.number().int().min(1).max(100),
          total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          hasMore: z.boolean()
        })
        .strict(),
      alerts: z
        .object({
          blockedCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          dueCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          blockedEvents: z.array(cmsCalendarEventSchema).max(10),
          hasMore: z.boolean()
        })
        .strict()
    })
    .strict()
    .superRefine((data, context) => {
      const range = cmsCalendarRange(data.month),
        { page, perPage, total, hasMore } = data.pagination,
        keys = data.events.map((event) => `${event.scheduleId}:${event.phase}`),
        alertKeys = data.alerts.blockedEvents.map((event) => `${event.scheduleId}:${event.phase}`)
      const timeMatches = (event: CmsCalendarEvent) =>
        event.status === 'due'
          ? event.scheduledAt <= data.asOf
          : event.status !== 'scheduled' || event.scheduledAt > data.asOf
      if (
        range.start !== data.rangeStart ||
        range.end !== data.rangeEnd ||
        data.events.length !== Math.min(perPage, Math.max(0, total - (page - 1) * perPage)) ||
        hasMore !== page * perPage < total ||
        new Set(keys).size !== keys.length ||
        new Set(alertKeys).size !== alertKeys.length ||
        data.events.some(
          (event) => event.scheduledAt < range.start || event.scheduledAt >= range.end || !timeMatches(event)
        ) ||
        [...data.events, ...data.alerts.blockedEvents].some(
          (event) => event.recordedAt !== null && event.recordedAt > data.asOf
        ) ||
        data.alerts.dueCount < data.events.filter((event) => event.active && event.status === 'due').length ||
        data.alerts.blockedCount < data.events.filter((event) => event.active && event.status === 'blocked').length ||
        data.events.some(
          (event, index) =>
            index > 0 &&
            `${data.events[index - 1]!.scheduledAt}:${keys[index - 1]}` >= `${event.scheduledAt}:${keys[index]}`
        ) ||
        data.alerts.blockedEvents.length !== Math.min(10, data.alerts.blockedCount) ||
        data.alerts.hasMore !== data.alerts.blockedCount > 10 ||
        data.alerts.blockedEvents.some((event) => event.status !== 'blocked' || !event.active)
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed editorial calendar snapshot' })
    })
)
export type CmsEditorialCalendar = z.infer<typeof cmsEditorialCalendarSchema>
