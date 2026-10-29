import { quarantineMediaUpload } from '../../workers/catalog/media'
import {
  createMediaPublication,
  decideMediaRights,
  ingestMediaScanReceipt,
  withdrawMediaPublication,
  type MediaScanReceipt
} from '../../workers/media/governance'

// Test-only synthetic signer and human reviewer. These exercise the attestation
// protocol and D1 authority, not an antivirus or a real external provider.
const SCAN_SECRET = 'synthetic-local-scan-attestation-fixture-only'
const CLAIMS = {
  identityId: '70000000-0000-4000-8000-000000000001',
  sessionId: '70000000-0000-4000-8000-000000000002',
  sessionVersion: 1
}

function hex(value: ArrayBuffer) {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function pngHeader() {
  // Typed-transformer fixture only, not a decodable image acceptance fixture.
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, 800)
  view.setUint32(20, 600)
  return bytes
}

/** Caller pins the test clock to `now`, including the quarantine uploader's
 * server timestamps. Privileged fixture provisioning never ships in a Worker.
 */
export async function publishMediaFixture(
  database: D1Database,
  options: { now: string; productId: string; variantId?: string | null; imageAlt?: string; version?: string }
) {
  const expiresAt = new Date(Date.parse(options.now) + 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO identities
      (id, email, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES (?, 'media-fixture@example.invalid', 'test-only-not-a-password', ?, 'active', ?, ?)`
      )
      .bind(CLAIMS.identityId, options.now, options.now, options.now),
    database
      .prepare(
        `INSERT OR IGNORE INTO auth_sessions
      (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES (?, ?, 1, 1, ?, ?)`
      )
      .bind(CLAIMS.sessionId, CLAIMS.identityId, options.now, expiresAt),
    database.prepare(
      "INSERT OR IGNORE INTO roles(code, name, description) VALUES ('media_fixture_publisher', 'Synthetic reviewer', 'Local test only')"
    ),
    database.prepare(
      "INSERT OR IGNORE INTO permissions(code, resource, action, description) VALUES ('catalog.publish', 'catalog', 'publish', 'Local test only')"
    ),
    database.prepare(
      "INSERT OR IGNORE INTO role_permissions(role_code, permission_code) VALUES ('media_fixture_publisher', 'catalog.publish')"
    ),
    database
      .prepare(
        "INSERT OR IGNORE INTO identity_roles(identity_id, role_code, granted_at) VALUES (?, 'media_fixture_publisher', ?)"
      )
      .bind(CLAIMS.identityId, options.now)
  ])
  const bucket = {
    async put(key: string, bytes: Uint8Array) {
      const checksum = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
      return {
        key,
        size: bytes.length,
        etag: hex(checksum),
        httpEtag: `"${hex(checksum)}"`,
        version: 'fixture',
        uploaded: new Date(options.now),
        storageClass: 'Standard' as const,
        checksums: { sha256: checksum, toJSON: () => ({}) },
        writeHttpMetadata: () => {}
      } satisfies R2Object
    },
    async head() {
      return null
    }
  }
  const imageAlt = options.imageAlt ?? `Fotografía aprobada de ${options.variantId ?? options.productId}`
  const upload = await quarantineMediaUpload(database, bucket, {
    actorId: CLAIMS.identityId,
    idempotencyKey: crypto.randomUUID(),
    bytes: pngHeader(),
    declaredType: 'image/png',
    filename: 'fixture.png',
    alt: imageAlt,
    rights: {
      owner: 'Synthetic test owner',
      license: 'Local test-only authorization',
      source: JSON.stringify({
        kind: 'uploader_declaration',
        authorizedAt: options.now.slice(0, 10),
        reference: 'Private synthetic evidence'
      })
    }
  })
  const original = await database
    .prepare('SELECT checksum, object_key, byte_size FROM media_uploads WHERE id = ?')
    .bind(upload.id)
    .first<{ checksum: string; object_key: string; byte_size: number }>()
  if (!original) throw new Error('missing media fixture upload')
  const receipt: MediaScanReceipt = {
    receiptId: crypto.randomUUID(),
    uploadId: upload.id,
    checksum: original.checksum,
    objectKey: original.object_key,
    byteSize: original.byte_size,
    verdict: 'clean',
    scannerVersion: 'synthetic-fixture-not-antivirus',
    scannedAt: options.now,
    expiresAt
  }
  const raw = new TextEncoder().encode(JSON.stringify(receipt))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SCAN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = `sha256=${hex(await crypto.subtle.sign('HMAC', key, raw))}`
  await ingestMediaScanReceipt(database, raw, signature, SCAN_SECRET, options.now)
  await decideMediaRights(
    database,
    CLAIMS,
    upload.id,
    { decision: 'approve', reason: 'Synthetic human review of test evidence' },
    { idempotencyKey: crypto.randomUUID(), now: options.now }
  )
  const result = await createMediaPublication(
    database,
    CLAIMS,
    upload.id,
    {
      productId: options.productId,
      variantId: options.variantId ?? null,
      role: options.variantId ? 'image' : 'main',
      title: 'Fotografía gobernada de prueba',
      altText: imageAlt,
      language: 'es',
      version: options.version ?? 'v1',
      validFrom: options.now
    },
    { idempotencyKey: crypto.randomUUID(), now: options.now }
  )
  return {
    id: result.publication.id,
    uploadId: upload.id,
    image: `/media/${result.publication.id}/image?w=800&format=jpeg`,
    imageAlt,
    withdraw: () =>
      withdrawMediaPublication(
        database,
        CLAIMS,
        result.publication.id,
        { reason: 'Synthetic publication withdrawal' },
        { idempotencyKey: crypto.randomUUID(), now: options.now }
      )
  }
}

/** Executes a local adversarial change only after real eligibility SQL resolves. */
export function afterPublicMediaRead(database: D1Database, after: () => void | Promise<void>): D1Database {
  return {
    ...database,
    prepare(sql: string) {
      const statement = database.prepare(sql)
      if (sql.includes('WITH supplied_now AS')) {
        const all = statement.all.bind(statement)
        statement.all = async <T>() => {
          const result = await all<T>()
          await after()
          return result
        }
      }
      return statement
    }
  } as unknown as D1Database
}

export type JsonTestResponse<T> = Omit<Response, 'json'> & { json(): Promise<T> }
