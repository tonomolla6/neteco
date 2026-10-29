import { z } from 'zod'
import {
  cmsCalendarQuerySchema,
  cmsCalendarRange,
  cmsCalendarLocalTime,
  cmsEditorialCalendarSchema,
  type CmsCalendarEvent
} from '../../shared/cms-calendar'
import {
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from '../../shared/catalog-publication-policy'
import { BUSINESS_TIME_ZONE, madridDateKey } from '../../server/utils/madrid-calendar'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { cmsNow, cmsSource, CmsPublicationError, type CmsPublicationDependencies } from './publication-gate'

// One phase per scheduled action, including immutable historical outcomes.
// Labels come from the APPROVED version, never the mutable draft head.
const phases = `WITH phases AS (
  SELECT id AS schedule_id,page_id,version_id,'publish' AS phase,publish_at AS scheduled_at FROM content_schedules WHERE publish_at IS NOT NULL
  UNION ALL
  SELECT id,page_id,version_id,'unpublish',unpublish_at FROM content_schedules WHERE unpublish_at IS NOT NULL
), calendar AS (
  SELECT p.schedule_id,p.page_id,p.version_id,v.version,
    json_extract(v.document,'$.title') AS title,json_extract(v.document,'$.slug') AS slug,
    p.phase,p.scheduled_at,
    CASE WHEN h.schedule_id=p.schedule_id AND cp.status='draft' AND cancellation.id IS NULL THEN 1 ELSE 0 END AS active,
    CASE WHEN e.outcome IN ('applied','blocked') THEN e.outcome
      WHEN cancellation.id IS NOT NULL THEN 'cancelled'
      WHEN h.schedule_id IS NOT p.schedule_id OR cp.status<>'draft' THEN 'superseded'
      WHEN p.scheduled_at<=?1 THEN 'due' ELSE 'scheduled' END AS status,
    e.code,COALESCE(e.created_at,cancellation.created_at) AS recorded_at
  FROM phases p JOIN content_versions v ON v.id=p.version_id AND v.page_id=p.page_id
  JOIN content_pages cp ON cp.id=p.page_id
  LEFT JOIN content_publication_states h ON h.page_id=p.page_id
  LEFT JOIN content_schedule_events e ON e.schedule_id=p.schedule_id AND e.phase=p.phase
  LEFT JOIN content_schedule_events cancellation ON cancellation.schedule_id=p.schedule_id AND cancellation.phase='cancel'
)`
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const rowSchema = z
  .object({
    schedule_id: uuid,
    page_id: uuid,
    version_id: uuid,
    version: count.min(1),
    title: z.string().trim().min(1).max(160),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(160),
    phase: z.enum(['publish', 'unpublish']),
    scheduled_at: instant,
    active: z.union([z.literal(0), z.literal(1)]),
    status: z.enum(['scheduled', 'due', 'applied', 'blocked', 'cancelled', 'superseded']),
    code: z.string().min(1).max(100).nullable(),
    recorded_at: instant.nullable()
  })
  .strict()
function event(row: z.infer<typeof rowSchema>): CmsCalendarEvent {
  return {
    scheduleId: row.schedule_id,
    pageId: row.page_id,
    versionId: row.version_id,
    version: row.version,
    title: row.title,
    slug: row.slug,
    phase: row.phase,
    scheduledAt: row.scheduled_at,
    ...cmsCalendarLocalTime(row.scheduled_at),
    status: row.status,
    active: row.active === 1,
    code: row.code,
    recordedAt: row.recorded_at
  }
}
async function authorize(deps: CmsPublicationDependencies, claims: VerifiedSessionClaims) {
  const result = await authorizeD1Session(deps.database, claims, 'catalog.write', { requireMfa: true })
  if (!result.allowed) throw new CmsPublicationError(result.code)
}
/** Read-only atomic D1 snapshot. Global blocked/due alerts are not filtered by
 * selected month; browsing another month must not hide an unresolved failure. */
export async function readCmsEditorialCalendar(
  deps: CmsPublicationDependencies,
  claims: VerifiedSessionClaims,
  input: unknown
) {
  await authorize(deps, claims)
  if (!deps.enabled) throw new CmsPublicationError('feature_unavailable')
  const query = cmsCalendarQuerySchema.safeParse(input)
  if (!query.success) throw new CmsPublicationError('invalid_input')
  const asOf = cmsNow(deps),
    month = query.data.month ?? madridDateKey(new Date(asOf)).slice(0, 7),
    range = cmsCalendarRange(month),
    { page, perPage } = query.data,
    monthFilter = 'scheduled_at>=?2 AND scheduled_at<?3',
    database = deps.database
  const results = await database.batch([
    database
      .prepare(`${phases} SELECT count(*) AS total FROM calendar WHERE ${monthFilter}`)
      .bind(asOf, range.start, range.end),
    database
      .prepare(
        `${phases} SELECT * FROM calendar WHERE ${monthFilter} ORDER BY scheduled_at,schedule_id,phase LIMIT ?4 OFFSET ?5`
      )
      .bind(asOf, range.start, range.end, perPage, (page - 1) * perPage),
    database
      .prepare(
        `${phases} SELECT count(CASE WHEN active=1 AND status='blocked' THEN 1 END) AS blocked_count,count(CASE WHEN active=1 AND status='due' THEN 1 END) AS due_count FROM calendar`
      )
      .bind(asOf),
    database
      .prepare(
        `${phases} SELECT * FROM calendar WHERE active=1 AND status='blocked' ORDER BY recorded_at,schedule_id,phase LIMIT 10`
      )
      .bind(asOf)
  ])
  if (results.length !== 4 || results.some((result) => result.success !== true))
    throw new CmsPublicationError('read_unconfirmed')
  const total = cmsSource(z.array(z.object({ total: count }).strict()).length(1), results[0]!.results)[0]!.total,
    rows = cmsSource(z.array(rowSchema).max(perPage), results[1]!.results),
    alerts = cmsSource(
      z.array(z.object({ blocked_count: count, due_count: count }).strict()).length(1),
      results[2]!.results
    )[0]!,
    blocked = cmsSource(z.array(rowSchema).max(10), results[3]!.results)
  const snapshot = cmsSource(cmsEditorialCalendarSchema, {
    source: 'cloudflare',
    timeZone: BUSINESS_TIME_ZONE,
    month,
    rangeStart: range.start,
    rangeEnd: range.end,
    asOf,
    events: rows.map(event),
    pagination: { page, perPage, total, hasMore: page * perPage < total },
    alerts: {
      blockedCount: alerts.blocked_count,
      dueCount: alerts.due_count,
      blockedEvents: blocked.map(event),
      hasMore: alerts.blocked_count > 10
    }
  })
  await authorize(deps, claims)
  return snapshot
}
