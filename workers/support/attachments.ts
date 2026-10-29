import { z } from 'zod'
import {
  supportUuid,
  supportInstant,
  supportKey,
  supportReceiptSchema,
  supportText
} from '../../shared/support-operations'
import { validateMediaUploadEnvelope, safeMediaFilename } from '../../shared/media-envelope'
import { stripMediaMetadata } from '../../shared/media-metadata'
import { imageDimensions } from '../../shared/media-dimensions'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import {
  SupportError,
  supportClock,
  authorizeSupportTicket,
  recordSupportAttachment,
  supportAttachmentStagingStatement,
  type SupportActor
} from './operations'

export type SupportPrivateStorage = Pick<R2Bucket, 'head' | 'get' | 'put'>
export const supportScanReceiptSchema = z
  .object({
    scope: z.literal('support_attachment'),
    id: supportUuid,
    attachmentId: supportUuid,
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    byteSize: z.number().int().min(1).max(10485760),
    verdict: z.enum(['clean', 'infected']),
    scannerVersion: supportText(1, 100),
    scannedAt: supportInstant,
    expiresAt: supportInstant
  })
  .strict()
export type SupportScanReceipt = z.infer<typeof supportScanReceiptSchema>
/** Trusted adapter must verify scanner signature and audience before returning
 * this receipt. There is no body-controlled "clean" approval or bypass. */
export type SupportScanReceiptVerifier = (
  request: Request,
  body: unknown,
  rawBody: string
) => Promise<SupportScanReceipt | null>
type AttachmentRow = {
  id: string
  ticket_id: string
  actor_id: string
  idempotency_key: string
  payload_hash: string
  object_key: string
  checksum: string
  filename: string
  mime_type: string
  byte_size: number
  visibility: 'public' | 'internal'
  state: 'staging' | 'quarantined'
  stored_at: string | null
  created_at: string
  command_id: string | null
}
async function checksum(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}
async function storedObject(storage: SupportPrivateStorage, row: AttachmentRow) {
  const head = await storage.head(row.object_key)
  if (
    !head ||
    head.size !== row.byte_size ||
    head.customMetadata?.sha256 !== row.checksum ||
    head.customMetadata?.scope !== 'support_attachment'
  )
    throw new SupportError('storage_unconfirmed')
}
export async function uploadSupportAttachment(
  rawDatabase: D1Database,
  storage: SupportPrivateStorage,
  actor: SupportActor,
  ref: string,
  input: {
    bytes: Uint8Array
    declaredType: string
    filename: string
    expectedVersion: number
    visibility: 'public' | 'internal'
  },
  options: { idempotencyKey: string; now?: string }
) {
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(options.now),
    ticket = await authorizeSupportTicket(database, actor, ref, now)
  if (!actor.claims) throw new SupportError('unauthenticated')
  if (ticket.retention_until && ticket.retention_until <= now()) throw new SupportError('retention_expired')
  if (actor.kind === 'customer' && input.visibility !== 'public') throw new SupportError('forbidden')
  if (
    !supportKey.safeParse(options.idempotencyKey).success ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.filename.length > 300 ||
    !input.filename.trim()
  )
    throw new SupportError('invalid_input')
  let bytes: Uint8Array<ArrayBuffer>, mimeType
  try {
    mimeType = validateMediaUploadEnvelope({
      bytes: input.bytes,
      declaredType: input.declaredType,
      maximumBytes: 10485760
    })
    bytes = new Uint8Array(stripMediaMetadata(new Uint8Array(input.bytes), mimeType))
    const dimensions = imageDimensions(bytes, mimeType)
    if (
      dimensions &&
      (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 12000 || dimensions.height > 12000)
    )
      throw new Error('invalid_dimensions')
  } catch {
    throw new SupportError('invalid_file')
  }
  const digest = await checksum(bytes),
    hash = await sha256Hex(
      canonicalJson({
        ref,
        digest,
        mimeType,
        filename: input.filename,
        expectedVersion: input.expectedVersion,
        visibility: input.visibility
      })
    )
  let row = await database
    .prepare('SELECT * FROM support_attachments WHERE actor_id=? AND idempotency_key=?')
    .bind(actor.claims.identityId, options.idempotencyKey)
    .first<AttachmentRow>()
  if (row && (row.payload_hash !== hash || row.ticket_id !== ticket.id)) throw new SupportError('idempotency_conflict')
  if (row?.command_id) {
    const command = await database
      .prepare('SELECT response FROM support_commands WHERE id=? AND ticket_id=?')
      .bind(row.command_id, ticket.id)
      .first<{ response: string }>()
    if (!command) throw new SupportError('history_unconfirmed')
    await authorizeSupportTicket(database, actor, ref, now)
    return supportReceiptSchema.parse(JSON.parse(command.response))
  }
  if (ticket.version !== input.expectedVersion) throw new SupportError('version_conflict')
  if (!row) {
    const id = crypto.randomUUID()
    await authorizeSupportTicket(database, actor, ref, now)
    await supportAttachmentStagingStatement(
      database,
      actor,
      {
        id,
        ticketId: ticket.id,
        version: input.expectedVersion,
        key: options.idempotencyKey,
        hash,
        objectKey: 'support/quarantine/' + id + '/' + digest,
        checksum: digest,
        filename: safeMediaFilename(input.filename, mimeType, id),
        mimeType,
        byteSize: bytes.byteLength,
        visibility: input.visibility,
        createdAt: now()
      },
      options
    ).run()
    await authorizeSupportTicket(database, actor, ref, now)
    row = await database.prepare('SELECT * FROM support_attachments WHERE id=?').bind(id).first<AttachmentRow>()
  }
  if (!row) throw new SupportError('write_unconfirmed')
  await authorizeSupportTicket(database, actor, ref, now)
  const existing = await storage.head(row.object_key)
  if (!existing)
    await storage.put(row.object_key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: mimeType },
      customMetadata: { sha256: digest, scope: 'support_attachment' }
    })
  await storedObject(storage, row)
  // A lost/ambiguous R2 response leaves staging evidence for the same key; it
  // never exposes bytes or overwrites an existing object. Promotion is atomic.
  await authorizeSupportTicket(database, actor, ref, now)
  return recordSupportAttachment(database, actor, ref, row.id, input.expectedVersion, input.visibility, options)
}
export async function receiveSupportScan(
  rawDatabase: D1Database,
  storage: SupportPrivateStorage,
  request: Request,
  raw: unknown,
  verifier: SupportScanReceiptVerifier,
  rawBody: string,
  instant?: string
) {
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(instant),
    verified = await verifier(request, raw, rawBody),
    parsed = supportScanReceiptSchema.safeParse(verified)
  if (!parsed.success) throw new SupportError('invalid_scan_signature')
  const receipt = parsed.data,
    row = await database
      .prepare('SELECT * FROM support_attachments WHERE id=?')
      .bind(receipt.attachmentId)
      .first<AttachmentRow>()
  if (!row || row.state !== 'quarantined') throw new SupportError('not_found')
  if (
    receipt.checksum !== row.checksum ||
    receipt.byteSize !== row.byte_size ||
    !row.stored_at ||
    receipt.scannedAt < row.stored_at ||
    receipt.scannedAt > now() ||
    receipt.expiresAt <= now() ||
    receipt.expiresAt <= receipt.scannedAt
  )
    throw new SupportError('invalid_scan_receipt')
  await storedObject(storage, row)
  const hash = await sha256Hex(canonicalJson(receipt)),
    previous = await database
      .prepare(
        'SELECT id,payload_hash,scanned_at,verdict FROM support_attachment_scans WHERE attachment_id=? ORDER BY seq DESC LIMIT 1'
      )
      .bind(row.id)
      .first<{ id: string; payload_hash: string; scanned_at: string; verdict: string }>()
  const replay = await database
    .prepare('SELECT payload_hash FROM support_attachment_scans WHERE id=?')
    .bind(receipt.id)
    .first<{ payload_hash: string }>()
  if (replay) {
    if (replay.payload_hash !== hash) throw new SupportError('idempotency_conflict')
    return { outcome: 'replayed' as const }
  }
  if (
    previous &&
    (receipt.scannedAt < previous.scanned_at ||
      (receipt.scannedAt === previous.scanned_at &&
        (previous.verdict === 'infected' || receipt.verdict !== 'infected')))
  )
    throw new SupportError('invalid_scan_receipt')
  await database
    .prepare(
      'INSERT INTO support_attachment_scans(id,attachment_id,checksum,byte_size,verdict,scanner_version,scanned_at,expires_at,payload_hash,received_at,seq) ' +
        'SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,COALESCE(MAX(seq),0)+1 FROM support_attachment_scans ' +
        'HAVING NOT EXISTS(SELECT 1 FROM support_attachment_scans WHERE attachment_id=?2 AND ' +
        "(scanned_at>?7 OR (scanned_at=?7 AND (verdict='infected' OR ?5<>'infected'))))"
    )
    .bind(
      receipt.id,
      row.id,
      row.checksum,
      row.byte_size,
      receipt.verdict,
      receipt.scannerVersion,
      receipt.scannedAt,
      receipt.expiresAt,
      hash,
      now()
    )
    .run()
  if (!(await database.prepare('SELECT id FROM support_attachment_scans WHERE id=?').bind(receipt.id).first()))
    throw new SupportError('write_unconfirmed')
  return { outcome: 'stored' as const }
}
export async function downloadSupportAttachment(
  rawDatabase: D1Database,
  storage: SupportPrivateStorage,
  actor: SupportActor,
  ref: string,
  id: string,
  instant?: string
) {
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(instant)
  if (!supportUuid.safeParse(id).success) throw new SupportError('not_found')
  const verify = async () => {
    const ticket = await authorizeSupportTicket(database, actor, ref, now)
    if (ticket.retention_until && ticket.retention_until <= now()) throw new SupportError('retention_expired')
    const row = await database
      .prepare(
        'SELECT * FROM support_attachments WHERE id=?1 AND ticket_id=?2 ' +
          (actor.kind === 'customer' ? "AND visibility='public' " : '') +
          "AND state='quarantined' AND EXISTS(SELECT 1 FROM support_attachment_scans s WHERE s.attachment_id=support_attachments.id " +
          'AND s.seq=(SELECT MAX(seq) FROM support_attachment_scans WHERE attachment_id=support_attachments.id) ' +
          "AND s.verdict='clean' AND s.expires_at>?3 AND s.checksum=support_attachments.checksum AND s.byte_size=support_attachments.byte_size)"
      )
      .bind(id, ticket.id, now())
      .first<AttachmentRow>()
    if (!row) throw new SupportError('attachment_unavailable')
    return row
  }
  const row = await verify()
  await storedObject(storage, row)
  const object = await storage.get(row.object_key)
  if (!object || object.size !== row.byte_size) throw new SupportError('storage_unconfirmed')
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (bytes.byteLength !== row.byte_size || (await checksum(bytes)) !== row.checksum)
    throw new SupportError('storage_unconfirmed')
  await verify()
  return new Response(bytes, {
    headers: {
      'Content-Type': row.mime_type,
      'Content-Disposition': 'attachment; filename="' + row.filename + '"',
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer'
    }
  })
}
