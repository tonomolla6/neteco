import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import {
  type AccountNotificationItem,
  type AccountNotificationSummary,
  type CreateNotificationInput,
  type MarkNotificationsReadInput,
  createNotificationInputSchema,
  listNotificationsQuerySchema,
  markNotificationsReadInputSchema,
  accountNotificationItemSchema
} from '../../shared/account-notifications'

export class AccountNotificationError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'unavailable'
  ) {
    super(code)
    this.name = 'AccountNotificationError'
  }
}

function fail(code: AccountNotificationError['code']): never {
  throw new AccountNotificationError(code)
}

export interface AccountNotificationOptions {
  now?: () => string
}

function currentUtc(options?: AccountNotificationOptions): string {
  return options?.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function resolveCustomerId(db: D1Database, identityId: string): Promise<string> {
  const row = await db
    .prepare("SELECT customer_id FROM identities WHERE id = ? AND status = 'active'")
    .bind(identityId)
    .first<{ customer_id: string }>()

  if (!row?.customer_id) {
    fail('unauthenticated')
  }
  return row.customer_id
}

interface NotificationRow {
  id: string
  customer_id: string
  category: 'pedido' | 'factura' | 'stock' | 'soporte'
  title: string
  body: string
  link: string | null
  read_status: number
  read_at: string | null
  mandatory: number
  metadata: string
  dedup_key: string | null
  created_at: string
  updated_at: string
}

function mapNotificationRow(row: NotificationRow): AccountNotificationItem {
  return accountNotificationItemSchema.parse({
    id: row.id,
    customerId: row.customer_id,
    category: row.category,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.read_status === 1,
    readAt: row.read_at,
    mandatory: row.mandatory === 1,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    dedupKey: row.dedup_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

export async function createAccountNotification(
  db: D1Database,
  id: string,
  rawInput: CreateNotificationInput | unknown,
  options?: AccountNotificationOptions
): Promise<AccountNotificationItem> {
  if (!z.string().uuid().safeParse(id).success) fail('invalid_input')
  const parsed = createNotificationInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  const now = currentUtc(options)

  if (input.dedupKey) {
    const existing = await db
      .prepare('SELECT * FROM customer_notifications WHERE customer_id = ? AND dedup_key = ?')
      .bind(input.customerId, input.dedupKey)
      .first<NotificationRow>()

    if (existing) {
      return mapNotificationRow(existing)
    }
  }

  await db
    .prepare(
      `INSERT INTO customer_notifications(
        id, customer_id, category, title, body, link, read_status, read_at,
        mandatory, metadata, dedup_key, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.customerId,
      input.category,
      input.title,
      input.body,
      input.link ?? null,
      input.mandatory ? 1 : 0,
      JSON.stringify(input.metadata),
      input.dedupKey ?? null,
      now,
      now
    )
    .run()

  return {
    id,
    customerId: input.customerId,
    category: input.category,
    title: input.title,
    body: input.body,
    link: input.link ?? null,
    read: false,
    readAt: null,
    mandatory: input.mandatory,
    metadata: input.metadata,
    dedupKey: input.dedupKey ?? null,
    createdAt: now,
    updatedAt: now
  }
}

export async function listAccountNotifications(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  rawQuery: unknown
): Promise<{ total: number; items: AccountNotificationItem[] }> {
  if (!claims) fail('unauthenticated')
  const customerId = await resolveCustomerId(db, claims.identityId)

  const parsed = listNotificationsQuerySchema.safeParse(rawQuery)
  if (!parsed.success) fail('invalid_input')
  const query = parsed.data

  let countSql = 'SELECT COUNT(*) as count FROM customer_notifications WHERE customer_id = ?'
  let selectSql = 'SELECT * FROM customer_notifications WHERE customer_id = ?'
  const params: unknown[] = [customerId]

  if (query.category !== 'all') {
    countSql += ' AND category = ?'
    selectSql += ' AND category = ?'
    params.push(query.category)
  }

  if (query.status === 'unread') {
    countSql += ' AND read_status = 0'
    selectSql += ' AND read_status = 0'
  } else if (query.status === 'read') {
    countSql += ' AND read_status = 1'
    selectSql += ' AND read_status = 1'
  }

  selectSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'

  const totalRow = await db
    .prepare(countSql)
    .bind(...params)
    .first<{ count: number }>()

  const total = totalRow?.count ?? 0

  const rows = await db
    .prepare(selectSql)
    .bind(...params, query.limit, query.offset)
    .all<NotificationRow>()

  const items = (rows.results ?? []).map(mapNotificationRow)
  return { total, items }
}

export async function markAccountNotificationsRead(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  rawInput: MarkNotificationsReadInput | unknown,
  options?: AccountNotificationOptions
): Promise<{ affectedCount: number }> {
  if (!claims) fail('unauthenticated')
  if (!z.string().uuid().safeParse(commandId).success) fail('invalid_input')
  const customerId = await resolveCustomerId(db, claims.identityId)

  const parsed = markNotificationsReadInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  const now = currentUtc(options)

  const payloadHash = await sha256Hex(
    canonicalJson({
      commandId,
      customerId,
      actorId: claims.identityId,
      input,
      now
    })
  )

  // Idempotency check
  const existingCmd = await db
    .prepare('SELECT * FROM customer_notification_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ command_id: string; affected_count: number }>()

  if (existingCmd) {
    return { affectedCount: existingCmd.affected_count }
  }

  let affectedCount = 0

  if (input.all) {
    let countSql = 'SELECT COUNT(*) as count FROM customer_notifications WHERE customer_id = ? AND read_status = 0'
    const countParams: unknown[] = [customerId]
    if (input.category) {
      countSql += ' AND category = ?'
      countParams.push(input.category)
    }
    const countRow = await db
      .prepare(countSql)
      .bind(...countParams)
      .first<{ count: number }>()
    affectedCount = countRow?.count ?? 0

    if (affectedCount > 0) {
      let updateSql =
        'UPDATE customer_notifications SET read_status = 1, read_at = ?, updated_at = ? WHERE customer_id = ? AND read_status = 0'
      const updateParams: unknown[] = [now, now, customerId]
      if (input.category) {
        updateSql += ' AND category = ?'
        updateParams.push(input.category)
      }
      await db
        .prepare(updateSql)
        .bind(...updateParams)
        .run()
    }
  } else if (input.notificationIds && input.notificationIds.length > 0) {
    const placeholders = input.notificationIds.map(() => '?').join(',')
    const countSql = `SELECT COUNT(*) as count FROM customer_notifications
      WHERE customer_id = ? AND read_status = 0 AND id IN (${placeholders})`
    const countRow = await db
      .prepare(countSql)
      .bind(customerId, ...input.notificationIds)
      .first<{ count: number }>()
    affectedCount = countRow?.count ?? 0

    if (affectedCount > 0) {
      const updateSql = `UPDATE customer_notifications SET read_status = 1, read_at = ?, updated_at = ?
        WHERE customer_id = ? AND read_status = 0 AND id IN (${placeholders})`
      await db
        .prepare(updateSql)
        .bind(now, now, customerId, ...input.notificationIds)
        .run()
    }
  }

  await db
    .prepare(
      `INSERT INTO customer_notification_commands(
        command_id, customer_id, action, notification_ids, actor_id,
        affected_count, payload_hash, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      commandId,
      customerId,
      input.all ? 'mark_all_read' : 'mark_read',
      JSON.stringify(input.notificationIds ?? []),
      claims.identityId,
      affectedCount,
      payloadHash,
      now
    )
    .run()

  return { affectedCount }
}

export async function getAccountNotificationSummary(
  db: D1Database,
  claims: VerifiedSessionClaims | null
): Promise<AccountNotificationSummary> {
  if (!claims) fail('unauthenticated')
  const customerId = await resolveCustomerId(db, claims.identityId)

  const rows = await db
    .prepare(
      `SELECT category, read_status, COUNT(*) as count
       FROM customer_notifications
       WHERE customer_id = ?
       GROUP BY category, read_status`
    )
    .bind(customerId)
    .all<{ category: 'pedido' | 'factura' | 'stock' | 'soporte'; read_status: number; count: number }>()

  const summary: AccountNotificationSummary = {
    total: 0,
    unread: 0,
    byCategory: {
      pedido: { total: 0, unread: 0 },
      factura: { total: 0, unread: 0 },
      stock: { total: 0, unread: 0 },
      soporte: { total: 0, unread: 0 }
    }
  }

  for (const row of rows.results ?? []) {
    const cat = row.category
    if (summary.byCategory[cat]) {
      summary.byCategory[cat].total += row.count
      summary.total += row.count
      if (row.read_status === 0) {
        summary.byCategory[cat].unread += row.count
        summary.unread += row.count
      }
    }
  }

  return summary
}
