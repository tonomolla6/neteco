import { z } from 'zod'
import {
  ADMIN_ACTIVITY_ACTIONS,
  ADMIN_ACTIVITY_DESTINATIONS,
  adminActivityResponseSchema,
  type AdminActivityKind,
  type AdminActivityResponse
} from '../../shared/admin-activity'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { readD1AdminCapabilities } from './admin-capabilities'
import type { VerifiedSessionClaims } from '../catalog/authorization'

export class AdminActivityError extends Error {
  constructor(readonly code: 'invalid_input' | 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'forbidden') {
    super(code)
    this.name = 'AdminActivityError'
  }
}
const cursorSchema = z
  .object({
    v: z.literal(1),
    at: catalogPolicyInstantSchema,
    id: z
      .string()
      .max(100)
      .regex(
        /^(catalog_category|catalog_product_status|catalog_policy|cms_draft|cms_publication|inventory|fulfillment|support):[a-f0-9-]{36}$/i
      )
  })
  .strict()
function decodeCursor(value: string | undefined) {
  if (value === undefined) return null
  try {
    if (!/^[A-Za-z0-9_-]{1,768}$/.test(value)) throw new Error('cursor')
    const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    const result = cursorSchema.parse(JSON.parse(raw))
    if (encodeCursor(result.at, result.id) !== value) throw new Error('cursor')
    return result
  } catch {
    throw new AdminActivityError('invalid_input')
  }
}
function encodeCursor(at: string, id: string) {
  return btoa(JSON.stringify({ v: 1, at, id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
type Permission = 'catalog.write' | 'catalog.publish' | 'inventory.read' | 'administration.manage' | 'support.manage'
// Only existing immutable audit tables with a matching durable command. No
// application logs, destination history, inferred activity or free-text data.
const sources: Array<{
  kind: AdminActivityKind
  permission: Permission
  audit: string
  command: string
  action?: string
  proof: string
  extra?: string
}> = [
  {
    kind: 'catalog_category',
    permission: 'catalog.write',
    audit: 'catalog_category_audit',
    command: 'catalog_category_commands',
    proof: 'a.action=c.action AND a.category_uuid=c.category_uuid AND a.result_version=c.result_version'
  },
  {
    kind: 'catalog_product_status',
    permission: 'catalog.write',
    audit: 'catalog_product_status_audit',
    command: 'catalog_product_status_commands',
    action: 'a.after_status',
    proof: 'a.product_id=c.product_id AND a.after_status=c.after_status AND a.after_version=c.result_version'
  },
  {
    kind: 'catalog_policy',
    permission: 'catalog.publish',
    audit: 'catalog_policy_audit',
    command: 'catalog_policy_commands',
    proof: 'a.action=c.action AND a.entity_id=c.entity_id AND a.result_version IS c.result_version'
  },
  {
    kind: 'cms_draft',
    permission: 'catalog.write',
    audit: 'content_draft_audit',
    command: 'content_draft_commands',
    proof: 'a.action=c.action AND a.page_id=c.page_id AND a.result_version=c.result_version'
  },
  {
    kind: 'cms_publication',
    permission: 'catalog.write',
    audit: 'content_publication_audit',
    command: 'content_publication_commands',
    proof: 'a.action=c.action AND a.page_id=c.page_id'
  },
  {
    kind: 'inventory',
    permission: 'inventory.read',
    audit: 'inventory_admin_audit',
    command: 'inventory_admin_commands',
    proof: 'a.action=c.action AND a.variant_id=c.variant_id AND a.result_version=c.result_version'
  },
  {
    kind: 'fulfillment',
    permission: 'administration.manage',
    audit: 'order_fulfillment_audit',
    command: 'order_fulfillment_commands',
    proof: 'a.action=c.action AND a.order_id=c.order_id AND a.to_state=c.to_state AND a.result_version=c.result_version'
  },
  {
    kind: 'support',
    permission: 'support.manage',
    audit: 'support_events',
    command: 'support_commands',
    action: 'a.type',
    proof: 'a.type=c.action AND a.ticket_id=c.ticket_id AND a.state=c.to_state AND a.actor_type=c.actor_type',
    extra: "AND a.actor_type='admin' AND a.actor_id IS NOT NULL"
  }
]
const permissions: Permission[] = [
  'catalog.write',
  'catalog.publish',
  'inventory.read',
  'administration.manage',
  'support.manage'
]
const sourceQueries = sources.map((source) => {
  const action = source.action ?? 'a.action'
  const auditId = source.kind === 'cms_publication' ? 'a.command_id' : 'a.id'
  const commandId = source.kind === 'support' ? 'a.id' : 'a.command_id'
  return `SELECT '${source.kind}:'||${auditId} AS id,'${source.kind}' AS kind,${action} AS action,
    a.created_at AS createdAt,'${ADMIN_ACTIVITY_DESTINATIONS[source.kind]}' AS "to"
    FROM ${source.audit} a JOIN ${source.command} c ON c.id=${commandId}
    AND a.actor_id IS c.actor_id AND a.created_at=c.created_at AND ${source.proof}
    WHERE ?${5 + permissions.indexOf(source.permission)}=1 AND a.created_at<=?1
    AND ${action} IN (${ADMIN_ACTIVITY_ACTIONS[source.kind].map((action) => `'${action}'`).join(',')}) ${source.extra ?? ''}`
})
// D1's compound SELECT limit is lower than desktop SQLite's. Keep every
// compound below that native limit without adding requests or dropping sources.
const activitySql = `WITH editorial AS (${sourceQueries.slice(0, 4).join(' UNION ALL ')}),
  operations AS (${sourceQueries.slice(4).join(' UNION ALL ')}),
  events AS (SELECT * FROM editorial UNION ALL SELECT * FROM operations)
  SELECT id,kind,action,createdAt,"to" FROM events
  WHERE (?2 IS NULL OR createdAt<?2 OR (createdAt=?2 AND id<?3))
  ORDER BY createdAt DESC,id DESC LIMIT ?4`

/** Three reads regardless of item count: capabilities, bounded audit union,
 * then live capabilities again. A grant change rejects the whole snapshot.
 */
export async function readD1AdminActivity(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  options: { limit?: number; cursor?: string; now?: () => string } = {}
): Promise<AdminActivityResponse> {
  const limit = options.limit ?? 10,
    cursor = decodeCursor(options.cursor)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new AdminActivityError('invalid_input')
  const clock = options.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
  async function authority() {
    if (!claims) throw new AdminActivityError('unauthenticated')
    const capabilities = await readD1AdminCapabilities(database, claims, clock())
    if (!capabilities) throw new AdminActivityError('unauthenticated')
    if (capabilities.state !== 'ready') throw new AdminActivityError(capabilities.state)
    return capabilities
  }
  const first = await authority(),
    instant = catalogPolicyInstantSchema.parse(clock())
  const rows = (
    await database
      .prepare(activitySql)
      .bind(
        instant,
        cursor?.at ?? null,
        cursor?.id ?? null,
        limit + 1,
        ...permissions.map((permission) => (first.permissions.includes(permission) ? 1 : 0))
      )
      .all()
  ).results
  const current = await authority()
  if (JSON.stringify(first.permissions) !== JSON.stringify(current.permissions))
    throw new AdminActivityError('forbidden')
  const items = rows.slice(0, limit),
    last = items.at(-1) as { createdAt: string; id: string } | undefined
  return adminActivityResponseSchema.parse({
    source: 'cloudflare',
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null
  })
}
