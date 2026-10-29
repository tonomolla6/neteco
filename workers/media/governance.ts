import { z } from 'zod'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { eligibleMediaEvidenceSql } from './evidence-sql'
import { publicationValidityExpression } from '../catalog/publication-validity'
export { eligibleMediaEvidenceSql } from './evidence-sql'

export interface EligibleMediaPublicationRow {
  id: string
  product_id: string
  variant_id: string | null
  upload_id: string
  role: MediaPublicationRole
  title: string
  alt: string
  language: string
  version: string
  valid_from: string
  valid_until: string | null
  created_at: string
  rights_decision_id: string
  scan_receipt_id: string
  authorized_at: string
  object_key: string
  checksum: string
  byte_size: number
  r2_etag: string
  content_type: 'image/png' | 'image/jpeg' | 'application/pdf'
  filename: string
  width: number | null
  height: number | null
}

export type MediaPublicationRole = 'main' | 'image' | 'datasheet' | 'sds' | 'certificate' | 'label'

/** Read-time public gates, deliberately not a cached publication flag. Every
 * new receipt/rights decision invalidates older pinned mappings immediately.
 * Factoring private evidence must never expose draft products or variants.
 * Preserve the first binding slot, but only an explicit internal test clock
 * pins evidence; production uses the same fresh SQL clock as product policy.
 */
export function eligibleMediaPublicationSql(clockSql?: string) {
  const validity = publicationValidityExpression('product', clockSql)
  const evidence = eligibleMediaEvidenceSql().replace(
    'SELECT ? AS now',
    `SELECT strftime('%Y-%m-%dT%H:%M:%SZ',${clockSql ?? "'now'"}) AS now FROM (SELECT ?1 AS supplied_clock)`
  )
  return `SELECT eligible.* FROM (${evidence}) eligible
    JOIN products product ON product.id = eligible.product_id
    JOIN categories category ON category.id = product.category_id
    LEFT JOIN variants variant ON variant.id = eligible.variant_id AND variant.product_id = product.id
    WHERE product.status = 'published' AND product.legacy_id > 0 AND product.legacy_id <= 9007199254740991
      AND category.status = 'published' AND category.legacy_id > 0 AND category.legacy_id <= 9007199254740991
      AND ${validity}
      AND (eligible.variant_id IS NULL OR (variant.status = 'published' AND variant.legacy_id > 0 AND variant.legacy_id <= 9007199254740991))`
}

export class MediaGovernanceError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'idempotency_conflict'
      | 'rights_evidence_incomplete'
      | 'media_not_publishable'
      | 'scan_unavailable'
      | 'invalid_scan_signature'
      | 'invalid_scan_receipt'
  ) {
    super(code)
  }
}

const text = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) => !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
const utc = z.string().refine((value) => {
  const instant = Date.parse(value)
  return Number.isFinite(instant) && new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z') === value
})
const uuid = z.string().uuid()
const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/)
export const mediaRightsDecisionSchema = z
  .object({ decision: z.enum(['approve', 'reject']), reason: text(3, 500) })
  .strict()
export const mediaPublicationSchema = z
  .object({
    productId: text(1, 200),
    variantId: text(1, 200).nullable().optional(),
    role: z.enum(['main', 'image', 'datasheet', 'sds', 'certificate', 'label']),
    title: text(1, 200),
    altText: text(5, 500),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .max(35),
    version: text(1, 100),
    validFrom: utc,
    validUntil: utc.nullable().optional()
  })
  .strict()
  .refine((value) => !value.validUntil || value.validUntil > value.validFrom)
export const mediaWithdrawalSchema = z.object({ reason: text(3, 500) }).strict()
export const mediaScanReceiptSchema = z
  .object({
    receiptId: uuid,
    uploadId: uuid,
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    objectKey: text(1, 300),
    byteSize: z.number().int().min(1).max(10485760),
    verdict: z.enum(['clean', 'infected']),
    scannerVersion: text(1, 100),
    scannedAt: utc,
    expiresAt: utc
  })
  .strict()

export type MediaPublicationInput = z.infer<typeof mediaPublicationSchema>
export type MediaScanReceipt = z.infer<typeof mediaScanReceiptSchema>

function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new MediaGovernanceError('invalid_input')
  return result.data
}

function nowUtc(input?: string) {
  return parsed(utc, input ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hash(input: string | Uint8Array) {
  return hex(
    await crypto.subtle.digest(
      'SHA-256',
      new Uint8Array(typeof input === 'string' ? new TextEncoder().encode(input) : input)
    )
  )
}

// Production never binds a captured JavaScript instant here. SQLite/D1 checks
// its own clock when the statement actually executes (including the final
// rollback guard). The optional override is internal deterministic-test input;
// HTTP handlers never accept or provide it.
const effectiveNowSql = "COALESCE(?1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
const liveActorSql = `SELECT i.id FROM auth_sessions session
  JOIN identities i ON i.id = session.identity_id AND i.session_version = session.session_version
  WHERE session.id = ?2 AND session.identity_id = ?3 AND session.session_version = ?4
    AND session.revoked_at IS NULL AND session.created_at <= ${effectiveNowSql} AND session.expires_at > ${effectiveNowSql}
    AND session.mfa_verified = 1 AND i.status IN ('pending', 'active')
    AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ${effectiveNowSql}
    AND EXISTS (SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code = assigned.role_code
      WHERE assigned.identity_id = i.id AND granted.permission_code = ?5
        AND assigned.granted_at <= ${effectiveNowSql} AND (assigned.expires_at IS NULL OR assigned.expires_at > ${effectiveNowSql}))`

function actorBinds(claims: VerifiedSessionClaims, testNow?: string, permission = 'catalog.publish') {
  return [testNow ?? null, claims.sessionId, claims.identityId, claims.sessionVersion, permission] as const
}

async function authorize(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  permission = 'catalog.publish'
) {
  if (!claims) throw new MediaGovernanceError('unauthenticated')
  const allowed = await authorizeD1Session(database, claims, permission, { now, requireMfa: true })
  if (!allowed.allowed) throw new MediaGovernanceError(allowed.code)
  return claims
}

function guard(database: D1Database, sql: string, binds: unknown[]) {
  return database
    .prepare(
      `INSERT INTO media_governance_guards(id, satisfied)
    SELECT lower(hex(randomblob(16))), 0 WHERE NOT (${sql})`
    )
    .bind(...binds)
}

function isGuardFailure(error: unknown) {
  return error instanceof Error && /media_governance_guard/.test(error.message)
}

async function guardedBatch(
  database: D1Database,
  claims: VerifiedSessionClaims,
  testNow: string | undefined,
  statements: D1PreparedStatement[]
) {
  try {
    await database.batch(statements)
  } catch (error) {
    if (!isGuardFailure(error)) throw error
    await authorize(database, claims, nowUtc(testNow))
    throw new MediaGovernanceError('conflict')
  }
}

async function commandReplay<T extends { payload_hash: string }>(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options: { idempotencyKey: string; now?: string },
  table: 'media_rights_decisions' | 'product_media_publications' | 'product_media_publication_events',
  payloadHash: string
) {
  const extra =
    table === 'product_media_publications'
      ? ', EXISTS(SELECT 1 FROM product_media_publication_events WHERE publication_id = command.id) AS withdrawn'
      : ''
  const replay = await database
    .prepare(
      `WITH actor AS (${liveActorSql})
    SELECT command.* ${extra} FROM actor JOIN ${table} command ON command.actor_id = actor.id
    WHERE command.idempotency_key = ?6`
    )
    .bind(...actorBinds(claims, options.now), options.idempotencyKey)
    .first<T>()
  if (replay && replay.payload_hash !== payloadHash) throw new MediaGovernanceError('idempotency_conflict')
  return replay
}

function isCommandConflict(error: unknown) {
  return error instanceof MediaGovernanceError && error.code === 'conflict'
}

interface UploadEvidence {
  id: string
  checksum: string
  object_key: string
  byte_size: number
  content_type: string
  rights_owner: string
  rights_license: string
  rights_source: string
  storage_status: string
  stored_at: string | null
}

function rightsEvidence(
  upload: Pick<UploadEvidence, 'rights_owner' | 'rights_license' | 'rights_source'>,
  now: string
) {
  let source: unknown
  try {
    source = JSON.parse(upload.rights_source)
  } catch {
    return null
  }
  const declaration = z
    .object({ kind: z.literal('uploader_declaration'), authorizedAt: z.string(), reference: text(1, 1000) })
    .strict()
    .safeParse(source)
  if (
    !declaration.success ||
    !text(1, 300).safeParse(upload.rights_owner).success ||
    !text(1, 500).safeParse(upload.rights_license).success
  )
    return null
  const { authorizedAt, reference } = declaration.data
  const day = Date.parse(`${authorizedAt}T00:00:00Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(authorizedAt) ||
    !Number.isFinite(day) ||
    new Date(day).toISOString().slice(0, 10) !== authorizedAt ||
    authorizedAt > now.slice(0, 10)
  )
    return null
  return { authorizedAt, reference }
}

async function uploadEvidence(database: D1Database, uploadId: string) {
  const upload = await database
    .prepare('SELECT * FROM media_uploads WHERE id = ?')
    .bind(uploadId)
    .first<UploadEvidence>()
  if (!upload) throw new MediaGovernanceError('not_found')
  return upload
}

/** Only a trusted external scanner holding a separate secret can clear this
 * gate. This service verifies receipts; it does not implement or simulate AV.
 * The signature is HMAC-SHA256 over the exact, bounded HTTP body bytes.
 */
export async function ingestMediaScanReceipt(
  database: D1Database,
  rawBody: Uint8Array,
  signature: string,
  secret: string | null | undefined,
  nowInput?: string
) {
  if (typeof secret !== 'string' || new TextEncoder().encode(secret).length < 32 || secret.length > 4096)
    throw new MediaGovernanceError('scan_unavailable')
  if (!(rawBody instanceof Uint8Array) || rawBody.length < 1 || rawBody.length > 4096)
    throw new MediaGovernanceError('invalid_scan_receipt')
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) throw new MediaGovernanceError('invalid_scan_signature')
  const bytes = new Uint8Array(rawBody)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const signatureBytes = Uint8Array.from(signature.slice(7).match(/.{2}/g)!, (value) => Number.parseInt(value, 16))
  if (!(await crypto.subtle.verify('HMAC', key, signatureBytes, bytes)))
    throw new MediaGovernanceError('invalid_scan_signature')
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new MediaGovernanceError('invalid_scan_receipt')
  }
  const result = mediaScanReceiptSchema.safeParse(body)
  if (!result.success) throw new MediaGovernanceError('invalid_scan_receipt')
  const receipt = result.data
  const payloadHash = await hash(JSON.stringify(receipt))
  const upload = await uploadEvidence(database, receipt.uploadId)
  const previous = await database
    .prepare(
      'SELECT id, payload_hash, scanned_at, verdict FROM media_scan_receipts WHERE upload_id = ? ORDER BY seq DESC LIMIT 1'
    )
    .bind(receipt.uploadId)
    .first<{ id: string; payload_hash: string; scanned_at: string; verdict: 'clean' | 'infected' }>()
  const replay = await database
    .prepare('SELECT payload_hash FROM media_scan_receipts WHERE id = ?')
    .bind(receipt.receiptId)
    .first<{ payload_hash: string }>()
  if (replay && replay.payload_hash !== payloadHash) throw new MediaGovernanceError('idempotency_conflict')
  const now = nowUtc(nowInput)
  if (
    receipt.scannedAt > now ||
    receipt.expiresAt <= now ||
    receipt.expiresAt <= receipt.scannedAt ||
    Date.parse(receipt.expiresAt) - Date.parse(receipt.scannedAt) > 7 * 86400_000 ||
    !upload.stored_at ||
    receipt.scannedAt < upload.stored_at ||
    upload.storage_status !== 'quarantined' ||
    receipt.checksum !== upload.checksum ||
    receipt.objectKey !== upload.object_key ||
    receipt.byteSize !== upload.byte_size ||
    (!replay &&
      previous &&
      (receipt.scannedAt < previous.scanned_at ||
        (receipt.scannedAt === previous.scanned_at &&
          !(receipt.verdict === 'infected' && previous.verdict === 'clean'))))
  )
    throw new MediaGovernanceError('invalid_scan_receipt')
  const insert = database
    .prepare(
      `INSERT INTO media_scan_receipts
    (id, upload_id, checksum, object_key, byte_size, verdict, scanner_version, scanned_at, expires_at, received_at, payload_hash)
    SELECT ?1, upload.id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 FROM media_uploads upload
    WHERE upload.id = ?2 AND upload.storage_status = 'quarantined' AND upload.stored_at <= ?8
      AND upload.checksum = ?3 AND upload.object_key = ?4 AND upload.byte_size = ?5
      AND ?8 <= ?10 AND ?9 > ?10
      AND (?12 IS NOT NULL OR NOT EXISTS (SELECT 1 FROM media_scan_receipts prior WHERE prior.upload_id = upload.id
        AND (prior.scanned_at > ?8 OR (prior.scanned_at = ?8 AND (prior.verdict = 'infected' OR ?6 != 'infected')))))
    ON CONFLICT(id) DO NOTHING`
    )
    .bind(
      receipt.receiptId,
      receipt.uploadId,
      receipt.checksum,
      receipt.objectKey,
      receipt.byteSize,
      receipt.verdict,
      receipt.scannerVersion,
      receipt.scannedAt,
      receipt.expiresAt,
      now,
      payloadHash,
      replay ? receipt.receiptId : null
    )
  try {
    await database.batch([
      insert,
      guard(database, 'EXISTS(SELECT 1 FROM media_scan_receipts WHERE id = ?1 AND payload_hash = ?2)', [
        receipt.receiptId,
        payloadHash
      ])
    ])
  } catch (error) {
    if (isGuardFailure(error)) throw new MediaGovernanceError('conflict')
    throw error
  }
  return {
    receiptId: receipt.receiptId,
    uploadId: receipt.uploadId,
    verdict: receipt.verdict,
    replayed: Boolean(replay)
  }
}

export async function decideMediaRights(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  uploadIdInput: string,
  input: unknown,
  options: { idempotencyKey: string; expectedVersion?: number; now?: string }
) {
  const uploadId = parsed(uuid, uploadIdInput)
  const body = parsed(mediaRightsDecisionSchema, input)
  const idempotencyKey = parsed(keySchema, options.idempotencyKey)
  const claims = await authorize(database, claimsInput, nowUtc(options.now))
  const upload = await uploadEvidence(database, uploadId)
  const evidence = rightsEvidence(upload, nowUtc(options.now))
  if (body.decision === 'approve' && !evidence) throw new MediaGovernanceError('rights_evidence_incomplete')
  const payloadHash = await hash(JSON.stringify([uploadId, body]))
  const replay = await database
    .prepare('SELECT id, payload_hash, seq FROM media_rights_decisions WHERE actor_id = ? AND idempotency_key = ?')
    .bind(claims.identityId, idempotencyKey)
    .first<{ id: string; payload_hash: string; seq: number }>()
  if (replay && replay.payload_hash !== payloadHash) throw new MediaGovernanceError('idempotency_conflict')
  const latest = await database
    .prepare('SELECT COALESCE(MAX(seq), 0) AS version FROM media_rights_decisions WHERE upload_id = ?')
    .bind(uploadId)
    .first<{ version: number }>()
  const expectedVersion = latest?.version ?? 0
  if (
    options.expectedVersion !== undefined &&
    (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 0)
  )
    throw new MediaGovernanceError('conflict')
  if (!replay && options.expectedVersion !== undefined && options.expectedVersion !== expectedVersion) {
    // A matching winner may commit between the absent-key read and the version
    // read, before this caller ever reaches a batch. Recover only the exact
    // immutable command under fresh SQL authorization, never a different edit.
    const concurrent = await commandReplay<{ id: string; seq: number; payload_hash: string }>(
      database,
      claims,
      options,
      'media_rights_decisions',
      payloadHash
    )
    if (!concurrent) throw new MediaGovernanceError('conflict')
    return {
      id: uploadId,
      rightsStatus: body.decision === 'approve' ? ('approved' as const) : ('blocked' as const),
      rightsVersion: concurrent.seq,
      decisionId: concurrent.id,
      replayed: true
    }
  }
  const id = replay?.id ?? crypto.randomUUID()
  const decision = body.decision === 'approve' ? 'approved' : 'rejected'
  try {
    await guardedBatch(database, claims, options.now, [
      database
        .prepare(
          `WITH actor AS (${liveActorSql}) INSERT INTO media_rights_decisions
      (id, upload_id, decision, reason, actor_id, evidence_authorized_at, evidence_reference, rights_owner, rights_license, created_at, idempotency_key, payload_hash)
      SELECT ?6, upload.id, ?7, ?8, actor.id, ?9, ?10, upload.rights_owner, upload.rights_license, ${effectiveNowSql}, ?11, ?12
      FROM actor CROSS JOIN media_uploads upload WHERE upload.id = ?13 AND upload.rights_source = ?14
        AND (?15 = 1 OR (SELECT COALESCE(MAX(seq), 0) FROM media_rights_decisions WHERE upload_id = upload.id) = ?16)
      ON CONFLICT(actor_id, idempotency_key) DO NOTHING`
        )
        .bind(
          ...actorBinds(claims, options.now),
          id,
          decision,
          body.reason,
          evidence?.authorizedAt ?? null,
          evidence?.reference ?? null,
          idempotencyKey,
          payloadHash,
          uploadId,
          upload.rights_source,
          replay ? 1 : 0,
          expectedVersion
        ),
      guard(
        database,
        `EXISTS(${liveActorSql}) AND EXISTS(SELECT 1 FROM media_rights_decisions WHERE id = ?6 AND actor_id = ?3 AND payload_hash = ?7)`,
        [...actorBinds(claims, options.now), id, payloadHash]
      )
    ])
  } catch (error) {
    if (!isCommandConflict(error)) throw error
    const concurrent = await commandReplay<{ id: string; seq: number; payload_hash: string }>(
      database,
      claims,
      options,
      'media_rights_decisions',
      payloadHash
    )
    if (!concurrent) throw error
    return {
      id: uploadId,
      rightsStatus: decision === 'approved' ? ('approved' as const) : ('blocked' as const),
      rightsVersion: concurrent.seq,
      decisionId: concurrent.id,
      replayed: true
    }
  }
  const stored = await database
    .prepare('SELECT seq FROM media_rights_decisions WHERE id = ?')
    .bind(id)
    .first<{ seq: number }>()
  return {
    id: uploadId,
    rightsStatus: decision === 'approved' ? ('approved' as const) : ('blocked' as const),
    rightsVersion: stored!.seq,
    decisionId: id,
    replayed: Boolean(replay)
  }
}

function publicationView(row: PublicationRow) {
  return {
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id,
    uploadId: row.upload_id,
    role: row.role,
    title: row.title,
    altText: row.alt,
    language: row.language,
    version: row.version,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    status: row.withdrawn ? ('withdrawn' as const) : ('active' as const),
    publicationVersion: row.withdrawn ? 2 : 1
  }
}

interface PublicationRow {
  id: string
  product_id: string
  variant_id: string | null
  upload_id: string
  role: MediaPublicationRole
  title: string
  alt: string
  language: string
  version: string
  valid_from: string
  valid_until: string | null
  payload_hash: string
  withdrawn?: number
}

export async function createMediaPublication(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  uploadIdInput: string,
  input: unknown,
  options: { idempotencyKey: string; now?: string }
) {
  const uploadId = parsed(uuid, uploadIdInput)
  const body = parsed(mediaPublicationSchema, input)
  const idempotencyKey = parsed(keySchema, options.idempotencyKey)
  const normalized = { ...body, variantId: body.variantId ?? null, validUntil: body.validUntil ?? null }
  const claims = await authorize(database, claimsInput, nowUtc(options.now))
  const payloadHash = await hash(JSON.stringify([uploadId, normalized]))
  const replay = await database
    .prepare(
      `SELECT publication.*, EXISTS(SELECT 1 FROM product_media_publication_events WHERE publication_id = publication.id) AS withdrawn FROM product_media_publications publication WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, idempotencyKey)
    .first<PublicationRow>()
  if (replay && replay.payload_hash !== payloadHash) throw new MediaGovernanceError('idempotency_conflict')
  const upload = await uploadEvidence(database, uploadId)
  const evidence = await database
    .prepare(
      `SELECT scan.id AS scan_id, rights.id AS rights_id FROM media_scan_receipts scan CROSS JOIN media_rights_decisions rights
    WHERE scan.upload_id = ?1 AND rights.upload_id = ?1
      AND scan.seq = (SELECT MAX(seq) FROM media_scan_receipts WHERE upload_id = ?1)
      AND rights.seq = (SELECT MAX(seq) FROM media_rights_decisions WHERE upload_id = ?1)
      AND scan.verdict = 'clean' AND rights.decision = 'approved'`
    )
    .bind(uploadId)
    .first<{ scan_id: string; rights_id: string }>()
  if (!replay && (!evidence || upload.storage_status !== 'quarantined')) {
    const concurrent = await commandReplay<PublicationRow>(
      database,
      claims,
      options,
      'product_media_publications',
      payloadHash
    )
    if (concurrent) return { publication: publicationView(concurrent), replayed: true }
    throw new MediaGovernanceError('media_not_publishable')
  }
  if (replay) {
    await guardedBatch(database, claims, options.now, [
      guard(database, `EXISTS(${liveActorSql})`, [...actorBinds(claims, options.now)])
    ])
    return { publication: publicationView(replay), replayed: true }
  }
  const id = crypto.randomUUID()
  try {
    await guardedBatch(database, claims, options.now, [
      database
        .prepare(
          `WITH actor AS (${liveActorSql}) INSERT INTO product_media_publications
      (id, product_id, variant_id, upload_id, role, title, alt, language, version, valid_from, valid_until, scan_receipt_id, rights_decision_id, actor_id, created_at, idempotency_key, payload_hash)
      SELECT ?6, product.id, ?7, upload.id, ?8, ?9, ?10, ?11, ?12, ?13, ?14, scan.id, rights.id, actor.id, ${effectiveNowSql}, ?15, ?16
      FROM actor CROSS JOIN media_uploads upload JOIN products product ON product.id = ?17
      JOIN media_scan_receipts scan ON scan.id = ?18 AND scan.upload_id = upload.id
      JOIN media_rights_decisions rights ON rights.id = ?19 AND rights.upload_id = upload.id
      WHERE upload.id = ?20 AND upload.storage_status = 'quarantined' AND upload.stored_at IS NOT NULL
        AND scan.verdict = 'clean' AND scan.scanned_at <= ${effectiveNowSql} AND scan.expires_at > ${effectiveNowSql}
        AND scan.checksum = upload.checksum AND scan.object_key = upload.object_key AND scan.byte_size = upload.byte_size
        AND scan.seq = (SELECT MAX(seq) FROM media_scan_receipts WHERE upload_id = upload.id)
        AND rights.decision = 'approved' AND rights.created_at <= ${effectiveNowSql}
        AND rights.seq = (SELECT MAX(seq) FROM media_rights_decisions WHERE upload_id = upload.id)
        AND (?7 IS NULL OR EXISTS(SELECT 1 FROM variants WHERE id = ?7 AND product_id = product.id))
        AND ((?8 IN ('main', 'image', 'label') AND upload.content_type IN ('image/png', 'image/jpeg'))
          OR (?8 IN ('datasheet', 'sds', 'certificate', 'label') AND upload.content_type = 'application/pdf'))
      ON CONFLICT(actor_id, idempotency_key) DO NOTHING`
        )
        .bind(
          ...actorBinds(claims, options.now),
          id,
          normalized.variantId,
          body.role,
          body.title,
          body.altText,
          body.language,
          body.version,
          body.validFrom,
          normalized.validUntil,
          idempotencyKey,
          payloadHash,
          body.productId,
          evidence!.scan_id,
          evidence!.rights_id,
          uploadId
        ),
      guard(
        database,
        `EXISTS(${liveActorSql}) AND EXISTS(SELECT 1 FROM product_media_publications WHERE id = ?6 AND actor_id = ?3 AND payload_hash = ?7)`,
        [...actorBinds(claims, options.now), id, payloadHash]
      )
    ])
  } catch (error) {
    if (!isCommandConflict(error)) throw error
    const concurrent = await commandReplay<PublicationRow>(
      database,
      claims,
      options,
      'product_media_publications',
      payloadHash
    )
    if (!concurrent) throw error
    return { publication: publicationView(concurrent), replayed: true }
  }
  return {
    publication: publicationView({
      id,
      product_id: body.productId,
      variant_id: normalized.variantId,
      upload_id: uploadId,
      role: body.role,
      title: body.title,
      alt: body.altText,
      language: body.language,
      version: body.version,
      valid_from: body.validFrom,
      valid_until: normalized.validUntil,
      payload_hash: payloadHash
    }),
    replayed: false
  }
}

export async function withdrawMediaPublication(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  publicationIdInput: string,
  input: unknown,
  options: { idempotencyKey: string; expectedVersion?: number; now?: string }
) {
  const publicationId = parsed(uuid, publicationIdInput)
  const body = parsed(mediaWithdrawalSchema, input)
  const idempotencyKey = parsed(keySchema, options.idempotencyKey)
  const claims = await authorize(database, claimsInput, nowUtc(options.now))
  const publication = await database
    .prepare('SELECT id FROM product_media_publications WHERE id = ?')
    .bind(publicationId)
    .first<{ id: string }>()
  if (!publication) throw new MediaGovernanceError('not_found')
  const payloadHash = await hash(JSON.stringify([publicationId, body]))
  const replay = await database
    .prepare('SELECT id, payload_hash FROM product_media_publication_events WHERE actor_id = ? AND idempotency_key = ?')
    .bind(claims.identityId, idempotencyKey)
    .first<{ id: string; payload_hash: string }>()
  if (replay && replay.payload_hash !== payloadHash) throw new MediaGovernanceError('idempotency_conflict')
  if (!replay && options.expectedVersion !== undefined && options.expectedVersion !== 1)
    throw new MediaGovernanceError('conflict')
  const id = replay?.id ?? crypto.randomUUID()
  try {
    await guardedBatch(database, claims, options.now, [
      database
        .prepare(
          `WITH actor AS (${liveActorSql}) INSERT INTO product_media_publication_events
      (id, publication_id, event_type, reason, actor_id, created_at, idempotency_key, payload_hash)
      SELECT ?6, publication.id, 'withdrawn', ?7, actor.id, ${effectiveNowSql}, ?8, ?9
      FROM actor CROSS JOIN product_media_publications publication
      WHERE publication.id = ?10 AND (?11 = 1 OR NOT EXISTS(SELECT 1 FROM product_media_publication_events WHERE publication_id = publication.id))
      ON CONFLICT(actor_id, idempotency_key) DO NOTHING`
        )
        .bind(
          ...actorBinds(claims, options.now),
          id,
          body.reason,
          idempotencyKey,
          payloadHash,
          publicationId,
          replay ? 1 : 0
        ),
      guard(
        database,
        `EXISTS(${liveActorSql}) AND EXISTS(SELECT 1 FROM product_media_publication_events WHERE id = ?6 AND actor_id = ?3 AND payload_hash = ?7)`,
        [...actorBinds(claims, options.now), id, payloadHash]
      )
    ])
  } catch (error) {
    if (!isCommandConflict(error)) throw error
    const concurrent = await commandReplay<{ payload_hash: string }>(
      database,
      claims,
      options,
      'product_media_publication_events',
      payloadHash
    )
    if (!concurrent) throw error
    return { id: publicationId, status: 'withdrawn' as const, publicationVersion: 2, replayed: true }
  }
  return { id: publicationId, status: 'withdrawn' as const, publicationVersion: 2, replayed: Boolean(replay) }
}

interface AdministrativeMediaRow extends UploadEvidence {
  filename: string
  width: number | null
  height: number | null
  alt: string
  created_at: string
  rights_decision: 'approved' | 'rejected' | null
  rights_version: number
  scan_verdict: 'clean' | 'infected' | null
  scan_expires_at: string | null
  scan_scanned_at: string | null
  scan_checksum: string | null
  scan_object_key: string | null
  scan_byte_size: number | null
}

export async function listAdministrativeMedia(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  nowInput?: string
) {
  const now = nowUtc(nowInput)
  const claims = await authorize(database, claimsInput, now, 'catalog.write')
  const result = await database
    .prepare(
      `WITH actor AS (${liveActorSql})
    SELECT upload.*, rights.decision AS rights_decision, COALESCE(rights.seq, 0) AS rights_version,
      scan.verdict AS scan_verdict, scan.expires_at AS scan_expires_at, scan.scanned_at AS scan_scanned_at,
      scan.checksum AS scan_checksum, scan.object_key AS scan_object_key, scan.byte_size AS scan_byte_size
    FROM actor CROSS JOIN media_uploads upload
    LEFT JOIN media_rights_decisions rights ON rights.seq = (SELECT MAX(seq) FROM media_rights_decisions WHERE upload_id = upload.id)
    LEFT JOIN media_scan_receipts scan ON scan.seq = (SELECT MAX(seq) FROM media_scan_receipts WHERE upload_id = upload.id)
    ORDER BY upload.created_at DESC, upload.id DESC LIMIT 300`
    )
    .bind(...actorBinds(claims, nowInput, 'catalog.write'))
    .all<AdministrativeMediaRow>()
  const publications = await database
    .prepare(
      `WITH actor AS (${liveActorSql})
    SELECT publication.*, EXISTS(SELECT 1 FROM product_media_publication_events WHERE publication_id = publication.id) AS withdrawn
    FROM actor CROSS JOIN product_media_publications publication
    WHERE publication.upload_id IN (SELECT id FROM media_uploads ORDER BY created_at DESC, id DESC LIMIT 300)
    ORDER BY publication.created_at DESC, publication.id DESC LIMIT 900`
    )
    .bind(...actorBinds(claims, nowInput, 'catalog.write'))
    .all<PublicationRow>()
  const publish = await authorizeD1Session(database, claims, 'catalog.publish', {
    now: nowUtc(nowInput),
    requireMfa: true
  })
  await authorize(database, claims, nowUtc(nowInput), 'catalog.write')
  const currentNow = nowUtc(nowInput)
  return {
    items: result.results.map((upload) => {
      const evidence = rightsEvidence(upload, currentNow)
      const clean =
        upload.storage_status === 'quarantined' &&
        upload.scan_verdict === 'clean' &&
        !!upload.scan_expires_at &&
        upload.scan_expires_at > currentNow &&
        !!upload.scan_scanned_at &&
        upload.scan_scanned_at <= currentNow &&
        upload.scan_checksum === upload.checksum &&
        upload.scan_object_key === upload.object_key &&
        upload.scan_byte_size === upload.byte_size
      return {
        id: upload.id,
        originalName: upload.filename,
        mimeType: upload.content_type,
        bytes: upload.byte_size,
        width: upload.width,
        height: upload.height,
        ownerName: upload.rights_owner,
        license: upload.rights_license,
        authorizedAt: evidence?.authorizedAt ?? null,
        rightsStatus:
          upload.rights_decision === 'rejected'
            ? ('blocked' as const)
            : (upload.rights_decision ?? ('pending' as const)),
        quarantineStatus:
          upload.scan_verdict === 'infected'
            ? ('infected' as const)
            : clean
              ? ('clean' as const)
              : ('pending' as const),
        altText: upload.alt,
        sourceUrl: null,
        createdAt: upload.created_at,
        rightsVersion: upload.rights_version,
        canApprove: publish.allowed && Boolean(evidence),
        canPublish: publish.allowed && clean && upload.rights_decision === 'approved',
        publications: publications.results
          .filter((publication) => publication.upload_id === upload.id)
          .map(publicationView)
      }
    }),
    capabilities: { canUpload: true, canApprove: publish.allowed, canPublish: publish.allowed }
  }
}
