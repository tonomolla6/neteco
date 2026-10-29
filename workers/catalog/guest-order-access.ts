import { z } from 'zod'
import { defaults, seal, unseal } from 'iron-webcrypto'
import { ironCrypto } from '../auth/iron-crypto'
import { validateSessionCookieConfiguration, type SessionCookieConfiguration } from '../auth/session-cookie'
import { catalogPolicyInstantSchema as instant } from '../../shared/catalog-publication-policy'
import { sha256Hex } from './inventory'
import { ORDER_VIEW_COLUMNS, loadOrderView } from './checkout'

export const GUEST_ORDER_COOKIE = 'neteco-guest-order-access-v1'
export interface GuestOrderAccessOptions {
  now?: () => string
}
export class GuestOrderAccessError extends Error {
  constructor(readonly code: 'not_found' | 'configuration_unavailable') {
    super(code)
  }
}
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  grantSchema = z
    .object({
      purpose: z.literal('guest-order-access:v1'),
      orderId: uuid,
      tokenHash: hash,
      issuedAt: instant,
      expiresAt: instant,
      nonce: uuid
    })
    .strict()
    .refine((g) => g.expiresAt > g.issuedAt && Date.parse(g.expiresAt) - Date.parse(g.issuedAt) <= 1800000)
type GuestGrant = z.infer<typeof grantSchema>
function validateConfiguration(configuration: SessionCookieConfiguration) {
  try {
    validateSessionCookieConfiguration(configuration)
  } catch {
    throw new GuestOrderAccessError('configuration_unavailable')
  }
}
async function credential(request: Request, configuration: SessionCookieConfiguration): Promise<GuestGrant | null> {
  validateConfiguration(configuration)
  const header = request.headers.get('cookie')
  if (!header || header.length > 16384) return null
  const cookies = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(GUEST_ORDER_COOKIE + '='))
  if (cookies.length !== 1) return null
  try {
    const value = decodeURIComponent(cookies[0]!.slice(GUEST_ORDER_COOKIE.length + 1))
    if (!value || value.length > 4096) return null
    const decoded: unknown = await unseal(ironCrypto, value, configuration.password, {
      ...defaults,
      ttl: Math.min(1800, configuration.maxAgeSeconds) * 1000
    })
    const parsed = grantSchema.safeParse(decoded)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
/** The clock and immutable original grant are checked in each single SELECT.
 * The cookie is only a sealed proof of prior possession, never payment/session authority. */
async function header(
  database: D1Database,
  orderId: string,
  tokenHash: string,
  options: GuestOrderAccessOptions,
  grant?: GuestGrant
) {
  const override = options.now?.() ?? null
  if (override !== null) instant.parse(override)
  return database
    .prepare(
      `WITH clock AS MATERIALIZED(
    SELECT COALESCE(?3,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now)
    SELECT ${ORDER_VIEW_COLUMNS},(SELECT now FROM clock) authorityNow,
      strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+24 hours') originalExpiresAt
    FROM orders WHERE id=?1 AND token_hash=?2 AND access_revoked_at IS NULL
      AND created_at<=(SELECT now FROM clock)
      AND strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+24 hours')>(SELECT now FROM clock)
      AND (?4 IS NULL OR (?5<=(SELECT now FROM clock) AND ?4>(SELECT now FROM clock)
        AND ?4<=strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+24 hours')
        AND ?4<=strftime('%Y-%m-%dT%H:%M:%SZ',?5,'+30 minutes')))`
    )
    .bind(orderId, tokenHash, override, grant?.expiresAt ?? null, grant?.issuedAt ?? null)
    .first<Record<string, unknown>>()
}
const linkMessage = (orderId: string, tokenHash: string) =>
  new TextEncoder().encode(`neteco:guest-order-link:v1\u0000${orderId}\u0000${tokenHash}`)
const linkKey = (configuration: SessionCookieConfiguration) =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(configuration.password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
async function signLink(orderId: string, tokenHash: string, configuration: SessionCookieConfiguration) {
  const signed = await crypto.subtle.sign('HMAC', await linkKey(configuration), linkMessage(orderId, tokenHash))
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export interface GuestOrderEmailLinkConfiguration {
  publicOrigin: string
  sessionCookieConfiguration: SessionCookieConfiguration
}
/** Server-only preparation proof, never a Queue/outbox payload or HTTP DTO. */
export interface GuestOrderEmailLink {
  url: string
  orderId: string
  tokenHash: string
}
// The trusted email issuer is a separate authority from bearer possession:
// only the exact durable, confirmed checkout occurrence may issue a view link.
// No caller-provided order/hash can replace this proof.
const emailSource = `FROM email_outbox_events guest_event
  JOIN order_events e ON e.id=guest_event.source_event_id AND e.order_id=guest_event.source_id
  JOIN orders o ON o.id=e.order_id
  JOIN checkout_attempts attempt ON attempt.id=o.attempt_id
  WHERE guest_event.id=?1 AND guest_event.schema_version=1
    AND guest_event.event_type='order.created' AND guest_event.source_kind='order'
    AND e.event_type='order.created' AND e.created_at=o.created_at AND guest_event.created_at=e.created_at
    AND attempt.order_id=o.id AND attempt.state='completed' AND attempt.cart_id=o.cart_id
    AND attempt.reservation_id=o.reservation_id
    AND EXISTS(SELECT 1 FROM checkout_commands c WHERE c.cart_id=o.cart_id
      AND c.kind='checkout' AND c.response_status=200 AND c.payload_hash=attempt.payload_hash
      AND c.created_at=e.created_at AND c.correlation_id=e.correlation_id
      AND json_extract(c.response_body,'$.outcome')='order_created'
      AND json_extract(c.response_body,'$.body.id')=o.id)`
const emailLive = `o.access_revoked_at IS NULL
  AND o.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  AND strftime('%Y-%m-%dT%H:%M:%SZ',o.created_at,'+24 hours')>strftime('%Y-%m-%dT%H:%M:%SZ','now')`

/** INTERNAL only: reconstruct from the confirmed outbox occurrence. No bearer,
 * link, body or recipient is persisted; the URL exists only in the prepared mail. */
export async function issueD1GuestOrderEmailLink(
  database: D1Database,
  eventId: string,
  configuration: GuestOrderEmailLinkConfiguration
): Promise<GuestOrderEmailLink | null> {
  validateConfiguration(configuration.sessionCookieConfiguration)
  let origin: URL
  try {
    origin = new URL(configuration.publicOrigin)
    if (origin.protocol !== 'https:' || origin.origin !== configuration.publicOrigin) throw new Error('invalid_origin')
  } catch {
    throw new GuestOrderAccessError('configuration_unavailable')
  }
  if (!/^email:[a-f0-9]{64}$/.test(eventId)) throw new GuestOrderAccessError('not_found')
  const select = () =>
    database
      .prepare(`SELECT o.id,o.token_hash,o.customer_id,(${emailLive}) AS live ${emailSource}`)
      .bind(eventId)
      .first<{ id: string; token_hash: string; customer_id: string | null; live: number }>()
  const source = await select()
  if (
    !source ||
    !uuid.safeParse(source.id).success ||
    !hash.safeParse(source.token_hash).success ||
    ![0, 1].includes(source.live)
  )
    throw new GuestOrderAccessError('not_found')
  // Existing account authority is unchanged. Old/revoked guest receipts remain
  // useful without adding a dead link or extending the original access window.
  if (source.customer_id !== null || source.live !== 1) return null
  const claim = await signLink(source.id, source.token_hash, configuration.sessionCookieConfiguration)
  const current = await select()
  if (!current) throw new GuestOrderAccessError('not_found')
  if (current.customer_id !== null || current.live !== 1) return null
  if (current.id !== source.id || current.token_hash !== source.token_hash) throw new GuestOrderAccessError('not_found')
  return {
    url: `${origin.origin}/pedido/${source.id}?token=${claim}`,
    orderId: source.id,
    tokenHash: source.token_hash
  }
}

/** Atomic final authority check in the existing durable sending marker. SQL's
 * clock is fresh at execution (not dispatch start). Zero rows means NO send;
 * the pre-send lease may retry and reconstruct a receipt without a stale URL. */
export function prepareGuestOrderEmailSendingStatement(
  database: D1Database,
  input: { eventId: string; leaseToken: string; now: string; leaseUntil: string; to: string; link: GuestOrderEmailLink }
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE transactional_email_deliveries
    SET status = 'sending', sending_at = ?3, lease_until = ?4, last_error_code = NULL
    WHERE event_id=?1 AND status='leased' AND lease_token=?2
      AND EXISTS(SELECT 1 ${emailSource}
        AND o.id=?5 AND o.token_hash=?6 AND o.contact_email=?7 AND o.customer_id IS NULL AND ${emailLive})
    RETURNING event_id`
    )
    .bind(
      input.eventId,
      input.leaseToken,
      input.now,
      input.leaseUntil,
      input.link.orderId,
      input.link.tokenHash,
      input.to
    )
}
/** INTERNAL issuer only. The caller must possess the original live checkout
 * bearer; no HTTP endpoint exposes this token or accepts client-supplied hashes. */
export async function issueD1GuestOrderLinkClaim(
  database: D1Database,
  orderId: string,
  orderToken: string,
  configuration: SessionCookieConfiguration,
  options: GuestOrderAccessOptions = {}
): Promise<string> {
  validateConfiguration(configuration)
  if (!uuid.safeParse(orderId).success || !hash.safeParse(orderToken).success)
    throw new GuestOrderAccessError('not_found')
  const tokenHash = await sha256Hex(orderToken)
  if (!(await header(database, orderId, tokenHash, options))) throw new GuestOrderAccessError('not_found')
  const signed = await signLink(orderId, tokenHash, configuration)
  if (!(await header(database, orderId, tokenHash, options))) throw new GuestOrderAccessError('not_found')
  return signed
}
/** Raw URL claims are never stored or returned by HTTP. Re-exchange is allowed only
 * inside the immutable original 24-hour grant; no schema or new credential ledger. */
export async function exchangeD1GuestOrderAccess(
  database: D1Database,
  request: Request,
  orderId: string,
  token: string,
  configuration: SessionCookieConfiguration,
  options: GuestOrderAccessOptions = {}
): Promise<string | null> {
  validateConfiguration(configuration)
  if (!uuid.safeParse(orderId).success || !hash.safeParse(token).success) throw new GuestOrderAccessError('not_found')
  const override = options.now?.() ?? null
  if (override !== null) instant.parse(override)
  const source = await database
    .prepare(
      `WITH clock AS MATERIALIZED(
    SELECT COALESCE(?2,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now)
    SELECT token_hash FROM orders WHERE id=?1 AND access_revoked_at IS NULL
      AND created_at<=(SELECT now FROM clock)
      AND strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+24 hours')>(SELECT now FROM clock)`
    )
    .bind(orderId, override)
    .first<{ token_hash: string }>()
  const tokenHash = source?.token_hash ?? '0'.repeat(64),
    signature = Uint8Array.from(token.match(/../g)!, (pair) => Number.parseInt(pair, 16)),
    valid = await crypto.subtle.verify('HMAC', await linkKey(configuration), signature, linkMessage(orderId, tokenHash))
  if (!valid || !source) throw new GuestOrderAccessError('not_found')
  const original = await header(database, orderId, tokenHash, options)
  if (!original) throw new GuestOrderAccessError('not_found')
  const previous = await credential(request, configuration)
  if (
    previous?.orderId === orderId &&
    previous.tokenHash === tokenHash &&
    (await header(database, orderId, tokenHash, options, previous))
  )
    return null
  const issuedAt = instant.parse(original.authorityNow),
    originalExpiry = instant.parse(original.originalExpiresAt),
    expiresAt = new Date(
      Math.min(Date.parse(issuedAt) + Math.min(1800, configuration.maxAgeSeconds) * 1000, Date.parse(originalExpiry))
    )
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z'),
    grant = grantSchema.parse({
      purpose: 'guest-order-access:v1',
      orderId,
      tokenHash,
      issuedAt,
      expiresAt,
      nonce: crypto.randomUUID()
    })
  const encoded = await seal(ironCrypto, grant, configuration.password, {
    ...defaults,
    ttl: Date.parse(expiresAt) - Date.parse(issuedAt)
  })
  const current = await header(database, orderId, tokenHash, options, grant)
  if (!current) throw new GuestOrderAccessError('not_found')
  const remaining = Math.floor((Date.parse(expiresAt) - Date.parse(instant.parse(current.authorityNow))) / 1000)
  if (remaining < 1) throw new GuestOrderAccessError('not_found')
  return `${GUEST_ORDER_COOKIE}=${encodeURIComponent(encoded)}; Max-Age=${remaining}; Path=/; HttpOnly; Secure; SameSite=Lax`
}
export async function readD1GuestOrderView(
  database: D1Database,
  request: Request,
  orderId: string,
  configuration: SessionCookieConfiguration,
  options: GuestOrderAccessOptions = {}
): Promise<Record<string, unknown> | null> {
  const grant = await credential(request, configuration)
  if (!grant || grant.orderId !== orderId) return null
  const authorized = await header(database, orderId, grant.tokenHash, options, grant)
  if (!authorized) return null
  const { authorityNow: _clock, originalExpiresAt: _expiry, ...safeHeader } = authorized
  const view = await loadOrderView(database, orderId, safeHeader)
  return (await header(database, orderId, grant.tokenHash, options, grant)) ? view : null
}

/** Called only after the logout facade's existing CSRF checks. Revokes the
 * original link and every guest cookie for this order, without touching money. */
export async function revokeD1GuestOrderAccess(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  options: GuestOrderAccessOptions = {}
): Promise<string> {
  const grant = await credential(request, configuration)
  if (grant) {
    const current = await header(database, grant.orderId, grant.tokenHash, options, grant)
    if (current)
      await database
        .prepare(
          `WITH clock AS MATERIALIZED(
      SELECT COALESCE(?3,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now)
      UPDATE orders SET access_revoked_at=(SELECT now FROM clock)
      WHERE id=?1 AND token_hash=?2 AND access_revoked_at IS NULL
        AND created_at<=(SELECT now FROM clock)
        AND strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+24 hours')>(SELECT now FROM clock)
        AND ?4>(SELECT now FROM clock) AND ?5<=(SELECT now FROM clock)`
        )
        .bind(grant.orderId, grant.tokenHash, options.now?.() ?? null, grant.expiresAt, grant.issuedAt)
        .run()
  }
  return `${GUEST_ORDER_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
}
