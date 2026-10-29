import { imageDimensions } from '../../shared/media-dimensions'
import { safeMediaFilename, validateMediaUploadEnvelope } from '../../shared/media-envelope'

export const MAX_MEDIA_UPLOAD_BYTES = 10 * 1024 * 1024

export interface QuarantineUploadInput {
  // Supplied by the authenticated administrative caller, never a body field.
  actorId: string
  idempotencyKey: string
  bytes: Uint8Array
  declaredType?: string
  filename: string
  alt: string
  rights: { owner: string; license: string; source: string }
}

interface UploadRow {
  id: string
  payload_hash: string
  checksum: string
  object_key: string
  storage_status: 'staging' | 'quarantined'
}

function bounded(value: string, maximum: number) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error('invalid_media_metadata')
  }
  return value.trim()
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

/** Internal service: requires an authorised caller and a PRIVATE R2 bucket.
 * Persists original bytes for later analysis, never publishes or approves them.
 * An ambiguous R2/D1 failure leaves a resumable staging record, not a deletion.
 */
export async function quarantineMediaUpload(
  database: D1Database,
  bucket: Pick<R2Bucket, 'head'> & {
    put(key: string, bytes: Uint8Array, options: R2PutOptions & { onlyIf: R2Conditional }): Promise<R2Object | null>
  },
  input: QuarantineUploadInput
) {
  // Validate size before copying. Own the bytes before the first async boundary.
  const type = validateMediaUploadEnvelope({ ...input, maximumBytes: MAX_MEDIA_UPLOAD_BYTES })
  const bytes = new Uint8Array(input.bytes)
  const dimensions = imageDimensions(bytes, type)
  if (
    dimensions &&
    (dimensions.width < 600 || dimensions.height < 600 || dimensions.width > 12000 || dimensions.height > 12000)
  ) {
    throw new Error('invalid_media_dimensions')
  }
  const actorId = bounded(input.actorId, 200)
  const key = bounded(input.idempotencyKey, 200)
  const originalName = bounded(input.filename, 300)
  const alt = bounded(input.alt, 500)
  const owner = bounded(input.rights.owner, 300)
  const license = bounded(input.rights.license, 500)
  const source = bounded(input.rights.source, 2000)
  const checksum = await sha256(bytes)
  const payloadHash = await sha256(
    new TextEncoder().encode(JSON.stringify([checksum, type, originalName, alt, owner, license, source]))
  )
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await database
    .prepare(
      `INSERT INTO media_uploads
    (id, actor_id, idempotency_key, payload_hash, checksum, object_key, filename,
     content_type, byte_size, width, height, alt, rights_owner, rights_license, rights_source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(actor_id, idempotency_key) DO NOTHING`
    )
    .bind(
      id,
      actorId,
      key,
      payloadHash,
      checksum,
      `quarantine/${id}/${checksum}`,
      safeMediaFilename(originalName, type, id),
      type,
      bytes.length,
      dimensions?.width ?? null,
      dimensions?.height ?? null,
      alt,
      owner,
      license,
      source,
      createdAt
    )
    .run()
  const row = await database
    .prepare(
      'SELECT id, payload_hash, checksum, object_key, storage_status FROM media_uploads WHERE actor_id = ? AND idempotency_key = ?'
    )
    .bind(actorId, key)
    .first<UploadRow>()
  if (!row) throw new Error('media_upload_not_persisted')
  if (row.payload_hash !== payloadHash) throw new Error('media_idempotency_conflict')
  if (row.storage_status === 'staging') {
    const stored =
      (await bucket.put(row.object_key, bytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        sha256: checksum,
        httpMetadata: {
          contentType: 'application/octet-stream',
          contentDisposition: 'attachment',
          cacheControl: 'no-store'
        }
      })) ?? (await bucket.head(row.object_key))
    // Conditional replay trusts the server-calculated object checksum, not user metadata.
    if (
      !stored ||
      stored.size !== bytes.length ||
      !stored.checksums.sha256 ||
      hex(stored.checksums.sha256) !== checksum
    ) {
      throw new Error('media_object_integrity_mismatch')
    }
    await database
      .prepare(
        `UPDATE media_uploads SET storage_status = 'quarantined', r2_etag = ?,
      stored_at = MAX(created_at, ?) WHERE id = ? AND storage_status = 'staging'`
      )
      .bind(stored.etag, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), row.id)
      .run()
  }
  // No public URL, storage key, rights approval or malware clearance is returned.
  return {
    id: row.id,
    status: 'quarantined' as const,
    rightsStatus: 'pending' as const,
    scanStatus: 'pending' as const
  }
}

/** Recover receipts without resubmitting original bytes. Missing/corrupt objects
 * remain staging; this sweep never deletes objects or clears security gates.
 */
export async function reconcileMediaStorage(
  database: D1Database,
  bucket: Pick<R2Bucket, 'head'>,
  options: { now?: string; limit?: number } = {}
) {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const instant = Date.parse(now)
  const limit = options.limit ?? 25
  if (!Number.isFinite(instant) || new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z') !== now)
    throw new Error('invalid_media_instant')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_media_batch_limit')
  const cutoff = new Date(instant - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const candidates = await database
    .prepare(
      `SELECT id, object_key, checksum, byte_size FROM media_uploads
    WHERE storage_status = 'staging' AND created_at <= ?
    ORDER BY storage_checked_at, created_at, id LIMIT ?`
    )
    .bind(cutoff, limit)
    .all<{ id: string; object_key: string; checksum: string; byte_size: number }>()
  const report = { inspected: 0, recovered: 0, missing: 0, mismatch: 0, unavailable: 0, raced: 0 }
  for (const row of candidates.results) {
    report.inspected += 1
    let object: R2Object | null = null
    let outcome: 'recovered' | 'missing' | 'mismatch' | 'unavailable'
    try {
      object = await bucket.head(row.object_key)
      outcome = !object
        ? 'missing'
        : object.size === row.byte_size && object.checksums.sha256 && hex(object.checksums.sha256) === row.checksum
          ? 'recovered'
          : 'mismatch'
    } catch {
      outcome = 'unavailable'
    }
    // Gate every write against concurrent completion by the original uploader.
    const updated =
      outcome === 'recovered' && object
        ? await database
            .prepare(
              `UPDATE media_uploads SET storage_status = 'quarantined', r2_etag = ?, stored_at = MAX(created_at, ?),
          storage_checked_at = ?, storage_check_result = 'recovered' WHERE id = ? AND storage_status = 'staging' RETURNING id`
            )
            .bind(object.etag, now, now, row.id)
            .all()
        : await database
            .prepare(
              `UPDATE media_uploads SET storage_checked_at = ?, storage_check_result = ?
          WHERE id = ? AND storage_status = 'staging' RETURNING id`
            )
            .bind(now, outcome, row.id)
            .all()
    if (updated.results.length) report[outcome] += 1
    else report.raced += 1
  }
  return report
}
