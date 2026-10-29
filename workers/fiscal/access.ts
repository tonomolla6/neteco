import { z } from 'zod'
import type { FiscalOrderView, PrivateFiscalStorage } from '../../shared/fiscal-issuance'
import { fiscalUuid, fiscalHash, fiscalReceiptSchema, FISCAL_MAX_PDF_BYTES } from '../../shared/fiscal-issuance'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { sha256Hex } from '../catalog/inventory'
import { checksumFiscalPdf, fiscalClock, FiscalIssuanceError } from './issuance'
import { guardedFiscalDatabase } from './d1-boundary'

export type FiscalOrderAccess =
  | { kind: 'admin'; claims: VerifiedSessionClaims }
  | { kind: 'customer'; claims: VerifiedSessionClaims }
  | { kind: 'guest'; orderId: string; token: string }

/** Only the EXISTING HttpOnly guest order cookie is recognized. No URL query,
 * header bearer, plaintext body token or new credential exchange is added. */
export function fiscalGuestCookie(request: Request): FiscalOrderAccess | null {
  const cookies = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('neteco-order-access-v2='))
  if (cookies.length !== 1) return null
  const match = /^neteco-order-access-v2=v1\.([0-9a-f-]{36})\.([0-9a-f]{64})$/i.exec(cookies[0]!)
  if (!match || !fiscalUuid.safeParse(match[1]).success) return null
  return { kind: 'guest', orderId: match[1]!.toLowerCase(), token: match[2]! }
}
export async function authorizeFiscalOrder(
  database: D1Database,
  access: FiscalOrderAccess,
  orderId: string,
  now: string
): Promise<void> {
  database = guardedFiscalDatabase(database)
  if (!fiscalUuid.safeParse(orderId).success) throw new FiscalIssuanceError('not_found')
  if (access.kind === 'admin') {
    const result = await authorizeD1Session(database, access.claims, 'administration.manage', { now, requireMfa: true })
    if (!result.allowed) throw new FiscalIssuanceError(result.code)
    if (result.identityId !== access.claims.identityId || result.sessionId !== access.claims.sessionId)
      throw new FiscalIssuanceError('read_unconfirmed')
    const row = await database.prepare('SELECT id FROM orders WHERE id=?1').bind(orderId).first()
    if (row === null) throw new FiscalIssuanceError('not_found')
    try {
      z.object({ id: z.literal(orderId) })
        .strict()
        .parse(row)
    } catch {
      throw new FiscalIssuanceError('read_unconfirmed')
    }
    return
  }
  if (access.kind === 'customer') {
    const customerId = await activeOrderCustomerId(database, access.claims, now)
    if (!customerId) throw new FiscalIssuanceError('unauthenticated')
    const row = await database
      .prepare('SELECT id FROM orders WHERE id=?1 AND customer_id=?2')
      .bind(orderId, customerId)
      .first()
    if (row === null) throw new FiscalIssuanceError('not_found')
    try {
      z.object({ id: z.literal(orderId) })
        .strict()
        .parse(row)
    } catch {
      throw new FiscalIssuanceError('read_unconfirmed')
    }
    return
  }
  if (access.orderId !== orderId || !/^[0-9a-f]{64}$/i.test(access.token)) throw new FiscalIssuanceError('not_found')
  const hash = await sha256Hex(access.token)
  const found = await database
    .prepare(
      `SELECT id FROM orders WHERE id=?1 AND token_hash=?2 AND access_revoked_at IS NULL
    AND created_at<=?3 AND created_at>strftime('%Y-%m-%dT%H:%M:%SZ',?3,'-24 hours')`
    )
    .bind(orderId, hash, now)
    .first()
  if (found === null) throw new FiscalIssuanceError('not_found')
  try {
    z.object({ id: z.literal(orderId) })
      .strict()
      .parse(found)
  } catch {
    throw new FiscalIssuanceError('read_unconfirmed')
  }
}
const rowSchema = z
  .object({
    id: fiscalUuid,
    intentId: fiscalUuid.nullable(),
    status: z
      .enum(['queued', 'leased', 'issuing', 'uncertain', 'reconciling', 'completed', 'manual_review'])
      .nullable(),
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
    provider: z.enum(['local_fake', 'beply']).nullable(),
    validationOnly: z.union([z.literal(0), z.literal(1)]).nullable(),
    code: z.string().min(1).max(100).nullable(),
    fiscalStatus: z.enum(['issued', 'fiscal_pending']).nullable(),
    amountCents: z.number().int().min(1).max(1000000000).nullable(),
    pdfId: fiscalUuid.nullable(),
    lastErrorCode: z.string().min(1).max(80).nullable()
  })
  .strict()
export async function readD1FiscalOrder(
  database: D1Database,
  access: FiscalOrderAccess,
  orderId: string,
  options: { now: string; appEnvironment: 'local' | 'preview' | 'production' }
): Promise<FiscalOrderView> {
  database = guardedFiscalDatabase(database)
  const now = fiscalClock(options.now)
  await authorizeFiscalOrder(database, access, orderId, now())
  const raw = await database
    .prepare(
      `SELECT o.id,i.id AS intentId,w.status,w.generation,i.provider,
    i.validation_only AS validationOnly,r.code,r.fiscal_status AS fiscalStatus,i.amount_gross_cents AS amountCents,d.id AS pdfId,w.last_error_code AS lastErrorCode
    FROM orders o LEFT JOIN fiscal_invoice_intents i ON i.order_id=o.id AND i.kind='ordinary' AND i.fiscal_version=1
    LEFT JOIN fiscal_issuance_work w ON w.intent_id=i.id LEFT JOIN fiscal_provider_receipts r ON r.intent_id=i.id
    LEFT JOIN fiscal_documents d ON d.intent_id=i.id WHERE o.id=?1`
    )
    .bind(orderId)
    .first()
  await authorizeFiscalOrder(database, access, orderId, now())
  if (raw === null) throw new FiscalIssuanceError('not_found')
  let row: z.infer<typeof rowSchema>
  try {
    row = rowSchema.parse(catalogPolicyOwnJson(raw))
  } catch {
    throw new FiscalIssuanceError('read_unconfirmed')
  }
  if (
    row.id !== orderId ||
    (row.intentId === null) !== (row.status === null) ||
    (row.intentId !== null && row.generation === null) ||
    (row.provider !== null && row.validationOnly !== (row.provider === 'local_fake' ? 1 : 0)) ||
    (row.status === 'completed' && row.pdfId === null)
  )
    throw new FiscalIssuanceError('read_unconfirmed')
  return {
    orderId: row.id,
    intentId: row.intentId,
    status: row.status ?? 'blocked_policy',
    generation: row.generation,
    provider: row.provider,
    validationOnly: row.validationOnly === 1,
    code: row.code,
    fiscalStatus: row.fiscalStatus,
    amountCents: row.amountCents,
    currency: 'EUR',
    pdfAvailable:
      row.pdfId !== null &&
      row.status === 'completed' &&
      (row.validationOnly !== 1 || options.appEnvironment === 'local'),
    lastErrorCode: access.kind === 'admin' ? row.lastErrorCode : null,
    capabilities: {
      reconcile: access.kind === 'admin' && row.status === 'uncertain',
      edit: false,
      issueRetry: false,
      creditNote: false
    }
  }
}
const pdfRowSchema = z
  .object({
    storage_key: z.string().regex(/^fiscal\/[0-9a-f-]{36}\/[0-9a-f]{64}\.pdf$/),
    pdf_checksum: fiscalHash,
    pdf_size: z.number().int().min(16).max(FISCAL_MAX_PDF_BYTES),
    validation_only: z.union([z.literal(0), z.literal(1)]),
    provider_invoice_id: z.string().min(1).max(200),
    code: z.string().min(1).max(100),
    fiscal_status: z.enum(['issued', 'fiscal_pending']),
    amount_gross_cents: z.number().int().min(1).max(1000000000),
    currency: z.literal('EUR')
  })
  .strict()
export async function readPrivateFiscalPdf(
  database: D1Database,
  access: FiscalOrderAccess,
  orderId: string,
  storage: PrivateFiscalStorage,
  options: { now: string; appEnvironment: 'local' | 'preview' | 'production' }
): Promise<Uint8Array> {
  database = guardedFiscalDatabase(database)
  const now = fiscalClock(options.now)
  await authorizeFiscalOrder(database, access, orderId, now())
  const raw = await database
    .prepare(
      `SELECT d.storage_key,d.pdf_checksum,d.pdf_size,i.validation_only,
    r.provider_invoice_id,r.code,r.fiscal_status,r.amount_gross_cents,r.currency FROM fiscal_documents d
    JOIN fiscal_invoice_intents i ON i.id=d.intent_id JOIN fiscal_provider_receipts r ON r.intent_id=i.id
    JOIN fiscal_issuance_work w ON w.intent_id=i.id AND w.status='completed'
    WHERE d.order_id=?1 AND i.kind='ordinary' AND i.fiscal_version=1`
    )
    .bind(orderId)
    .first()
  if (raw === null) throw new FiscalIssuanceError('not_found')
  let row: z.infer<typeof pdfRowSchema>
  try {
    row = pdfRowSchema.parse(catalogPolicyOwnJson(raw))
    fiscalReceiptSchema.parse({
      providerId: row.provider_invoice_id,
      code: row.code,
      status: row.fiscal_status,
      amountCents: row.amount_gross_cents,
      currency: row.currency
    })
  } catch {
    throw new FiscalIssuanceError('read_unconfirmed')
  }
  if (row.validation_only === 1 && options.appEnvironment !== 'local') throw new FiscalIssuanceError('not_found')
  const bytes = await storage.get(row.storage_key)
  await authorizeFiscalOrder(database, access, orderId, now())
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length !== row.pdf_size ||
    (await checksumFiscalPdf(bytes)) !== row.pdf_checksum
  )
    throw new FiscalIssuanceError('pdf_unconfirmed')
  // Digest itself awaits: perform a final live read before releasing bytes.
  await authorizeFiscalOrder(database, access, orderId, now())
  return Uint8Array.from(bytes)
}
