import type { VerifiedSessionClaims } from './authorization'
import { z } from 'zod'
import { defaults, seal, unseal } from 'iron-webcrypto'
import { ironCrypto } from '../auth/iron-crypto'
import { validateSessionCookieConfiguration } from '../auth/session-cookie'
import { AdminInvitationError, authorizeD1AdminInvitationActor } from '../auth/admin-invitations'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import {
  ADMIN_ORDER_CAPABILITIES,
  buildD1AdminOrderReadQuery,
  type AdminOrderList,
  type AdminOrderQuery,
  type AdminReadResult
} from './admin-orders'
import type { AdminOrderSummary } from '../../shared/types/admin'

const PURPOSE = 'neteco-admin-order-cursor-v1'
const TTL = 10 * 60000
const uuid = z.string().uuid()
const tokenSchema = z
  .object({
    purpose: z.literal(PURPOSE),
    identityId: uuid,
    sessionId: uuid,
    sessionVersion: z.number().int().positive(),
    queryHash: z.string().regex(/^[a-f0-9]{64}$/),
    page: z.number().int().min(1).max(1000000),
    side: z.enum(['after', 'before']),
    anchor: z.object({ id: uuid, value: z.union([z.string().max(512), z.number().int().nonnegative()]) }).strict(),
    inclusive: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive()
  })
  .strict()
type CursorToken = z.infer<typeof tokenSchema>

const text = z.string().max(512)
const summarySchema: z.ZodType<AdminOrderSummary> = z
  .object({
    id: uuid,
    status: text,
    orderStatus: text,
    paymentStatus: text,
    fulfillmentStatus: text,
    inventoryStatus: text,
    invoiceStatus: text,
    name: text,
    company: text.nullable(),
    email: text,
    city: text,
    paymentMethod: text,
    shippingMethod: text,
    total: z.number().int().nonnegative(),
    createdAt: text,
    lines: z.number().int().nonnegative(),
    shipmentId: text.nullable(),
    trackingNumber: text.nullable(),
    shipmentStatus: text.nullable()
  })
  .strict()

async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function queryFingerprint(query: AdminOrderQuery) {
  return digest(
    JSON.stringify([
      query.q,
      query.bucket,
      query.sortKey,
      query.sortDir,
      query.perPage,
      query.paymentStatus ?? null,
      query.orderStatus ?? null,
      query.shippingMethod ?? null,
      query.customerType ?? null,
      query.from ?? null,
      query.to ?? null
    ])
  )
}

export interface AdminOrderCursorPage extends Omit<AdminOrderList, 'pagination'> {
  pagination: AdminOrderList['pagination'] & {
    mode: 'cursor'
    nextCursor: string | null
    previousCursor: string | null
  }
}

export class AdminOrderCursorError extends Error {
  constructor(readonly code: 'invalid_cursor' | 'service_unavailable') {
    super(code)
  }
}

export async function listD1AdminOrdersByCursor(
  rawDatabase: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  query: AdminOrderQuery,
  cursor: { password: string; after?: string; before?: string }
): Promise<AdminReadResult<AdminOrderCursorPage>> {
  if (!claims) return { outcome: 'denied', code: 'unauthenticated' }
  const started = Date.now(),
    baseline = Date.parse(now)
  if (!Number.isFinite(baseline) || new Date(baseline).toISOString().replace(/\.\d{3}Z$/, 'Z') !== now)
    throw new AdminOrderCursorError('service_unavailable')
  const instant = () => new Date(baseline + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const database = guardedFiscalDatabase(rawDatabase)
  try {
    // Live enrollment, verified email and current authority are checked before
    // decrypting a token and again after SQL/crypto, before releasing private rows.
    await authorizeD1AdminInvitationActor(database, claims, true, { now: instant() })
    validateSessionCookieConfiguration({ password: cursor.password, maxAgeSeconds: TTL / 1000 })
    if (
      (cursor.after !== undefined && cursor.before !== undefined) ||
      (cursor.after === undefined && cursor.before === undefined && query.page !== 1)
    )
      throw new AdminOrderCursorError('invalid_cursor')
    const raw = cursor.after ?? cursor.before
    const side = cursor.before !== undefined ? 'before' : 'after'
    if (raw !== undefined && (!raw || raw.length > 4096)) throw new AdminOrderCursorError('invalid_cursor')
    const [password, queryHash] = await Promise.all([digest(PURPOSE + ':' + cursor.password), queryFingerprint(query)])
    let token: CursorToken | undefined
    if (raw !== undefined) {
      try {
        token = tokenSchema.parse(await unseal(ironCrypto, raw, password, { ...defaults, ttl: TTL }))
      } catch {
        throw new AdminOrderCursorError('invalid_cursor')
      }
      const at = Date.parse(instant())
      if (
        token.identityId !== claims.identityId ||
        token.sessionId !== claims.sessionId ||
        token.sessionVersion !== claims.sessionVersion ||
        token.queryHash !== queryHash ||
        token.page !== query.page ||
        token.side !== side ||
        token.createdAt > at ||
        token.expiresAt !== token.createdAt + TTL ||
        token.expiresAt <= at ||
        (query.sortKey === 'total' ? typeof token.anchor.value !== 'number' : typeof token.anchor.value !== 'string')
      )
        throw new AdminOrderCursorError('invalid_cursor')
    }
    const read = buildD1AdminOrderReadQuery(instant(), query)
    const reverse = side === 'before'
    const direction = reverse ? (query.sortDir === 'asc' ? 'desc' : 'asc') : query.sortDir
    // The column/direction are finite, validated choices. All values, including
    // the sealed anchor, stay bound; one extra row determines the live boundary.
    const column = { id: 'id', createdAt: 'createdAt', name: 'name', total: 'total' }[query.sortKey]
    const values: (string | number)[] = [...read.parameters]
    let predicate = ''
    if (token) {
      const operator = direction === 'asc' ? '>' : '<'
      values.push(token.anchor.value)
      const value = '?' + values.length
      values.push(token.anchor.id)
      const id = '?' + values.length
      predicate =
        query.sortKey === 'id'
          ? `WHERE id ${operator}${token.inclusive ? '=' : ''} ${id} AND ${value} IS NOT NULL`
          : `WHERE (${column} ${operator} ${value} OR (${column} = ${value} AND id ${operator}${token.inclusive ? '=' : ''} ${id}))`
    }
    values.push(query.perPage + 1)
    // D1's read batch is a single database snapshot. No full result set, client
    // filtering, OFFSET, per-order lookups, or new persistent cursor store.
    const result = await database.batch<Record<string, unknown>>([
      database.prepare(read.countSql).bind(...read.parameters),
      database
        .prepare(
          `WITH source AS (${read.rowsSql}) SELECT * FROM source ${predicate}
        ORDER BY ${column} ${direction}, id ${direction} LIMIT ?${values.length}`
        )
        .bind(...values)
    ])
    const count = z.object({ total: z.number().int().nonnegative() }).strict().parse(result[0]?.results[0])
    const rows = z
      .array(summarySchema)
      .max(query.perPage + 1)
      .parse(result[1]?.results)
    const extra = rows.length > query.perPage
    const items = rows.slice(0, query.perPage)
    if (reverse) items.reverse()
    const tokenAt = Date.parse(instant())
    const encode = async (
      page: number,
      targetSide: CursorToken['side'],
      anchor: CursorToken['anchor'],
      inclusive = false
    ) => {
      const payload = tokenSchema.parse({
        purpose: PURPOSE,
        ...claims,
        queryHash,
        page,
        side: targetSide,
        anchor,
        inclusive,
        createdAt: tokenAt,
        expiresAt: tokenAt + TTL
      })
      return seal(ironCrypto, payload, password, { ...defaults, ttl: TTL })
    }
    const anchor = (row: AdminOrderSummary) => ({ id: row.id, value: row[query.sortKey] })
    const first = items[0],
      last = items.at(-1)
    let nextCursor: string | null = null,
      previousCursor: string | null = null
    if (last && query.page < 1000000 && (reverse || extra))
      nextCursor = await encode(query.page + 1, 'after', anchor(last))
    if (first && query.page > 1 && (!reverse || extra))
      previousCursor = await encode(query.page - 1, 'before', anchor(first))
    // Live deletions/filter-state changes can empty the target page. Preserve a
    // way back around the original boundary, without inventing a frozen page.
    if (!items.length && token) {
      if (side === 'after' && query.page > 1)
        previousCursor = await encode(query.page - 1, 'before', token.anchor, true)
      if (side === 'before' && query.page < 1000000)
        nextCursor = await encode(query.page + 1, 'after', token.anchor, true)
    }
    await authorizeD1AdminInvitationActor(database, claims, true, { now: instant() })
    return {
      outcome: 'found',
      data: {
        source: 'cloudflare',
        items,
        pagination: {
          mode: 'cursor',
          page: query.page,
          perPage: query.perPage,
          total: count.total,
          pages: Math.ceil(count.total / query.perPage),
          nextCursor,
          previousCursor
        },
        capabilities: ADMIN_ORDER_CAPABILITIES
      }
    }
  } catch (error) {
    if (error instanceof AdminOrderCursorError) throw error
    if (
      error instanceof AdminInvitationError &&
      ['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'].includes(error.code)
    )
      return {
        outcome: 'denied',
        code: error.code as 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'forbidden'
      }
    throw new AdminOrderCursorError('service_unavailable')
  }
}
