import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { quarantineMediaUpload } from '../../workers/catalog/media'
import {
  createMediaPublication,
  decideMediaRights,
  ingestMediaScanReceipt,
  withdrawMediaPublication,
  type MediaPublicationInput,
  type MediaScanReceipt
} from '../../workers/media/governance'
import {
  handlePublicMediaHttp,
  isPublicMediaPath,
  PUBLIC_MEDIA_IMAGE_FORMATS,
  PUBLIC_MEDIA_IMAGE_WIDTHS,
  type PublicMediaDependencies
} from '../../workers/media/public-delivery'
import { readPublicProductMedia } from '../../workers/media/public-catalog'
import { listPublishedProducts } from '../../workers/catalog/products'
import { searchPublishedProducts } from '../../workers/catalog/search'
import { getPublishedProductDetail } from '../../workers/catalog/product-detail'
import worker from '../../workers/canary'

const NOW = '2026-09-30T10:00:00Z'
const NEXT = '2026-09-30T10:00:01Z'
const EXPIRY = '2026-10-01T10:00:00Z'
// Synthetic local signer only. An authentic test receipt exercises ingestion,
// not an antivirus implementation or proof that a real file has been scanned.
const SCAN_SECRET = 'local-public-media-test-signing-secret-only'
const CLAIMS = {
  identityId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  sessionVersion: 1
}
const PDF = new TextEncoder().encode('%PDF-1.7\nSynthetic technical document fixture\n%%EOF')

function headerOnlyPng() {
  // Header-only fixture for the typed transformer stub. Actual decoding is
  // intentionally a separate offline Images runtime acceptance test.
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, 800)
  view.setUint32(20, 600)
  return bytes
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function receiptSignature(bytes: Uint8Array) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SCAN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, new Uint8Array(bytes)))}`
}

function privateBucket() {
  const objects = new Map<string, { bytes: Uint8Array; metadata: R2Object }>()
  const body = (key: string): R2ObjectBody | null => {
    const stored = objects.get(key)
    if (!stored) return null
    return {
      ...stored.metadata,
      writeHttpMetadata: stored.metadata.writeHttpMetadata.bind(stored.metadata),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(stored.bytes))
          controller.close()
        }
      }),
      bodyUsed: false,
      arrayBuffer: async () => new Uint8Array(stored.bytes).buffer,
      bytes: async () => new Uint8Array(stored.bytes),
      text: async () => new TextDecoder().decode(stored.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(stored.bytes)),
      blob: async () => new Blob([new Uint8Array(stored.bytes)])
    }
  }
  const put = vi.fn(async (key: string, bytes: Uint8Array, options: R2PutOptions & { onlyIf: R2Conditional }) => {
    expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' })
    if (objects.has(key)) return null
    const checksum = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
    const metadata: R2Object = {
      key,
      size: bytes.length,
      etag: hex(checksum),
      httpEtag: `"${hex(checksum)}"`,
      version: 'local-test-version',
      uploaded: new Date(NOW),
      storageClass: 'Standard',
      checksums: { sha256: checksum, toJSON: () => ({}) },
      // Object headers must never determine the public download policy.
      httpMetadata: { contentType: 'text/html', contentDisposition: 'inline', cacheControl: 'public, max-age=99999' },
      writeHttpMetadata: () => {}
    }
    objects.set(key, { bytes: new Uint8Array(bytes), metadata })
    return metadata
  })
  return {
    objects,
    body,
    put,
    head: vi.fn(async (key: string) => objects.get(key)?.metadata ?? null),
    get: vi.fn(async (key: string) => body(key))
  }
}

function imagesStub() {
  const received: Uint8Array[] = []
  const output = vi.fn(async (options: ImageOutputOptions, width: number) => {
    const response = () =>
      new Response(`${options.format}:${width}`, {
        headers: {
          'content-type': options.format,
          'cache-control': 'public, max-age=99999',
          'x-source-private': 'must-not-be-copied'
        }
      })
    return { response, contentType: () => options.format, image: () => response().body! }
  })
  const transform = vi.fn((options: ImageTransform) => options)
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => {
    let width = 0
    const transformer: ImageTransformer = {
      transform(options) {
        transform(options)
        width = options.width ?? 0
        return transformer
      },
      draw() {
        throw new Error('No public image draw contract')
      },
      async output(options) {
        received.push(new Uint8Array(await new Response(stream).arrayBuffer()))
        return output(options, width)
      }
    }
    return transformer
  })
  return { input, transform, output, received } satisfies Pick<ImagesBinding, 'input'> & {
    input: typeof input
    transform: typeof transform
    output: typeof output
    received: Uint8Array[]
  }
}

describe('authoritative D1 public media', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let bucket: ReturnType<typeof privateBucket>
  let images: ReturnType<typeof imagesStub>
  let clock: string
  let deps: PublicMediaDependencies

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    clock = NOW
    sqlite = await openMigratedDatabase()
    // Test-local execution clock: reads still evaluate it afresh after awaits.
    // Production SQL/adapter and the authenticated scanner lifetime are unchanged.
    sqlite.function('synthetic_publication_clock', () => {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(clock) ||
        new Date(clock).toISOString().replace(/\.\d{3}Z$/, 'Z') !== clock
      )
        throw new Error('invalid_synthetic_publication_clock')
      return clock
    })
    seedInventoryFixture(sqlite)
    sqlite.exec(`INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES ('${CLAIMS.identityId}', 'media-test@example.invalid', 'synthetic-not-a-password', '${NOW}', 'active', '${NOW}', '${NOW}');
      INSERT INTO roles(code, name, description) VALUES ('media-test-publisher', 'Local publisher', 'Test only');
      INSERT INTO permissions(code, resource, action, description) VALUES ('catalog.publish', 'catalog', 'publish', 'Test only');
      INSERT INTO role_permissions(role_code, permission_code) VALUES ('media-test-publisher', 'catalog.publish');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES ('${CLAIMS.identityId}', 'media-test-publisher', '${NOW}');
      INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES ('${CLAIMS.sessionId}', '${CLAIMS.identityId}', 1, 1, '${NOW}', '2026-10-02T10:00:00Z')`)
    const nativeDatabase = d1OverSqlite(sqlite)
    database = new Proxy(nativeDatabase, {
      get(target, property, receiver) {
        if (property === 'prepare')
          return (sql: string) => target.prepare(sql.replaceAll("'now'", 'synthetic_publication_clock()'))
        return Reflect.get(target, property, receiver)
      }
    })
    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z',
      media: false
    })
    bucket = privateBucket()
    images = imagesStub()
    deps = { database, bucket, images, enabled: true, now: () => clock }
  })

  afterEach(() => {
    sqlite?.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function attest(uploadId: string, overrides: Partial<MediaScanReceipt> = {}) {
    const upload = sqlite
      .prepare('SELECT checksum, object_key, byte_size FROM media_uploads WHERE id = ?')
      .get(uploadId)!
    const receipt: MediaScanReceipt = {
      receiptId: crypto.randomUUID(),
      uploadId,
      checksum: String(upload.checksum),
      objectKey: String(upload.object_key),
      byteSize: Number(upload.byte_size),
      verdict: 'clean',
      scannerVersion: 'synthetic-local-attestation-fixture',
      scannedAt: clock,
      expiresAt: EXPIRY,
      ...overrides
    }
    const bytes = new TextEncoder().encode(JSON.stringify(receipt))
    return ingestMediaScanReceipt(database, bytes, await receiptSignature(bytes), SCAN_SECRET, clock)
  }

  async function publish(overrides: Partial<MediaPublicationInput> = {}) {
    const role = overrides.role ?? 'datasheet'
    const bytes = role === 'main' || role === 'image' ? headerOnlyPng() : PDF
    const upload = await quarantineMediaUpload(database, bucket, {
      actorId: CLAIMS.identityId,
      idempotencyKey: crypto.randomUUID(),
      bytes,
      declaredType: role === 'main' || role === 'image' ? 'image/png' : 'application/pdf',
      filename: '../../original.pdf',
      alt: 'Texto alternativo técnico de prueba',
      rights: {
        owner: 'Titular privado de prueba',
        license: 'Licencia documental de prueba',
        source: JSON.stringify({
          kind: 'uploader_declaration',
          authorizedAt: '2026-09-20',
          reference: 'Expediente privado'
        })
      }
    })
    await attest(upload.id)
    await decideMediaRights(
      database,
      CLAIMS,
      upload.id,
      { decision: 'approve', reason: 'Revisión humana de evidencia de prueba' },
      { idempotencyKey: crypto.randomUUID(), now: clock }
    )
    const created = await createMediaPublication(
      database,
      CLAIMS,
      upload.id,
      {
        productId: 'p-1',
        role,
        title: 'Ficha "Técnica" / Série (ñ)!',
        altText: 'Fotografía alternativa de producto',
        language: 'es',
        version: 'v1',
        validFrom: NOW,
        ...overrides
      },
      { idempotencyKey: crypto.randomUUID(), now: clock }
    )
    return { id: created.publication.id, uploadId: upload.id, bytes }
  }

  function request(id: string, suffix = 'document', init?: RequestInit) {
    return new Request(`https://neteco.invalid/media/${id}/${suffix}`, init)
  }

  async function deliver(id: string, suffix = 'document', init?: RequestInit) {
    const response = await handlePublicMediaHttp(request(id, suffix, init), deps)
    expect(response).not.toBeNull()
    return response!
  }

  async function withdraw(id: string) {
    return withdrawMediaPublication(
      database,
      CLAIMS,
      id,
      { reason: 'Retirada documental de prueba' },
      { idempotencyKey: crypto.randomUUID(), now: clock }
    )
  }

  async function publicApi<T>(path: string): Promise<T> {
    const response = await worker.fetch(new Request(`https://neteco.invalid${path}`), {
      DB: database,
      AUTH_ENABLED: 'false',
      MEDIA_PUBLIC_ENABLED: 'true',
      MEDIA: bucket,
      IMAGES: images,
      APP_ENV: 'canary',
      PUBLIC_SITE_ORIGIN: 'https://neteco.invalid'
    } as unknown as CloudflareEnv)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('cdn-cache-control')).toBe('no-store')
    return response.json() as Promise<T>
  }

  async function catalogMedia() {
    sqlite.exec(`UPDATE products SET series = 'governed-media-series',
      attributes = '{"image":"https://legacy.invalid/product.jpg","datasheet":"https://legacy.invalid/private.pdf"}'
      WHERE id IN ('p-1', 'p-2');
      UPDATE variants SET image = '/img/products/legacy-variant.jpg' WHERE product_id IN ('p-1', 'p-2')`)
    const primary = await publish({ role: 'main' })
    const variant = await publish({ role: 'image', variantId: 'v-1-1' })
    const document = await publish({ role: 'datasheet' })
    const sibling = await publish({ role: 'main', productId: 'p-2' })
    // These products participate in related/list counts and own their evidence.
    for (const productId of ['p-3', 'p-4', 'p-5', 'p-6']) await publish({ role: 'main', productId })
    return { primary, variant, document, sibling }
  }

  it('downloads only attested, human-approved technical bytes with safe private headers', async () => {
    const publication = await publish()
    await publish({ role: 'main' })
    const response = await deliver(publication.id)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-length')).toBe(String(PDF.length))
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('accept-ranges')).toBe('none')
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="[A-Za-z0-9_-]+\.pdf"; filename\*=UTF-8''/
    )
    expect(response.headers.get('content-disposition')).toContain('%C3%A9')
    expect(response.headers.get('content-disposition')).not.toContain('\r')
    expect(images.input).not.toHaveBeenCalled()
    expect(bucket.get).toHaveBeenCalledWith(
      String(sqlite.prepare('SELECT object_key FROM media_uploads WHERE id=?').get(publication.uploadId)!.object_key)
    )
    expect(JSON.stringify([...response.headers])).not.toMatch(/quarantine|Expediente|Titular privado|original\.pdf/)
  })

  it('rechecks authoritative eligibility for HEAD and matching validators, with no shared cache bypass', async () => {
    const publication = await publish()
    await publish({ role: 'main' })
    const prepare = vi.spyOn(database, 'prepare')
    const first = await deliver(publication.id)
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('supplied_now'))).toHaveLength(2)
    prepare.mockClear()
    const head = await deliver(publication.id, 'document', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe(String(PDF.length))
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('supplied_now'))).toHaveLength(2)
    const conditional = await deliver(publication.id, 'document', { headers: { 'if-none-match': `W/${etag}` } })
    expect(conditional.status).toBe(304)
    expect(await conditional.text()).toBe('')
    expect(conditional.headers.get('cache-control')).toBe('private, no-store')
    await withdraw(publication.id)
    expect((await deliver(publication.id, 'document', { headers: { 'if-none-match': etag } })).status).toBe(404)
  })

  it('never turns an integrity failure into 304 based on D1 or metadata alone', async () => {
    const publication = await publish()
    await publish({ role: 'main' })
    const first = await deliver(publication.id)
    const stored = [...bucket.objects.values()][0]!
    stored.bytes.fill(0)
    const response = await deliver(publication.id, 'document', {
      headers: { 'if-none-match': first.headers.get('etag')! }
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'media_not_found' } })
  })

  it.each(PUBLIC_MEDIA_IMAGE_FORMATS)(
    'passes owned originals through the binding for %s at every bounded width',
    async (format) => {
      const publication = await publish({ role: 'main' })
      const etags = new Set<string>()
      for (const width of PUBLIC_MEDIA_IMAGE_WIDTHS) {
        const response = await deliver(publication.id, `image?w=${width}&format=${format}`)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe(`image/${format}`)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(response.headers.has('x-source-private')).toBe(false)
        expect(await response.text()).toBe(`image/${format}:${width}`)
        etags.add(response.headers.get('etag')!)
      }
      expect(etags.size).toBe(PUBLIC_MEDIA_IMAGE_WIDTHS.length)
      expect(images.transform.mock.calls.map(([options]) => options)).toEqual(
        PUBLIC_MEDIA_IMAGE_WIDTHS.map((width) => ({ width }))
      )
      expect(
        images.output.mock.calls.every(
          ([options]) => JSON.stringify(options) === JSON.stringify({ format: `image/${format}` })
        )
      ).toBe(true)
      expect(images.received.every((bytes) => Buffer.from(bytes).equals(Buffer.from(publication.bytes)))).toBe(true)
    }
  )

  it('uses distinct validators for output format and publication version', async () => {
    const one = await publish({ role: 'image', version: 'v1' })
    const two = await publish({ role: 'image', version: 'v2' })
    await publish({ role: 'main' })
    const etags = new Set<string>()
    for (const format of PUBLIC_MEDIA_IMAGE_FORMATS) {
      etags.add((await deliver(one.id, `image?w=800&format=${format}`)).headers.get('etag')!)
      etags.add((await deliver(two.id, `image?w=800&format=${format}`)).headers.get('etag')!)
    }
    expect(etags.size).toBe(6)
  })

  it('serves HEAD and 304 images only after owned-original verification and two fresh gates', async () => {
    const publication = await publish({ role: 'image' })
    await publish({ role: 'main' })
    const first = await deliver(publication.id, 'image?w=400&format=webp')
    images.output.mockClear()
    const prepare = vi.spyOn(database, 'prepare')
    const conditional = await deliver(publication.id, 'image?w=400&format=webp', {
      headers: { 'if-none-match': first.headers.get('etag')! }
    })
    expect(conditional.status).toBe(304)
    expect(images.output).not.toHaveBeenCalled()
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('supplied_now'))).toHaveLength(2)
    const head = await deliver(publication.id, 'image?w=400&format=webp', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-type')).toBe('image/webp')
    expect(images.output).toHaveBeenCalledOnce()
    const stored = [...bucket.objects.values()][0]!
    stored.bytes[27] = 1
    images.input.mockClear()
    const corrupt = await deliver(publication.id, 'image?w=400&format=webp', {
      headers: { 'if-none-match': first.headers.get('etag')! }
    })
    expect(corrupt.status).toBe(404)
    expect(images.input).not.toHaveBeenCalled()
  })

  it('allows label PDFs and images only through their matching public route', async () => {
    const pdf = await publish({ role: 'label' })
    const image = await publish({ role: 'image' })
    const primary = await publish({ role: 'main' })
    const label = await createMediaPublication(
      database,
      CLAIMS,
      image.uploadId,
      {
        productId: 'p-1',
        role: 'label',
        title: 'Etiqueta imagen',
        altText: 'Etiqueta técnica del producto',
        language: 'es',
        version: 'v1',
        validFrom: NOW
      },
      { idempotencyKey: crypto.randomUUID(), now: clock }
    )
    expect((await deliver(pdf.id)).status).toBe(200)
    expect((await deliver(pdf.id, 'image?w=800&format=jpeg')).status).toBe(404)
    expect((await deliver(label.publication.id)).status).toBe(404)
    expect((await deliver(label.publication.id, 'image?w=800&format=jpeg')).status).toBe(200)
    const media = (await readPublicProductMedia(database, ['p-1'], clock)).get('p-1')!
    expect(media.documents).toHaveLength(1)
    expect(media.documents[0]).toMatchObject({ id: pdf.id, role: 'label' })
    expect(media.image).toContain(primary.id)
    expect(media.image).not.toContain(label.publication.id)
  })

  it('fails closed when disabled, missing dependencies or decoding fails, with no original fallback', async () => {
    const document = await publish()
    const image = await publish({ role: 'main' })
    for (const options of [{ enabled: false }, { bucket: undefined }]) {
      const response = await handlePublicMediaHttp(request(document.id), { ...deps, ...options })
      expect(response!.status).toBe(503)
    }
    const missing = await handlePublicMediaHttp(request(image.id, 'image?w=800&format=webp'), {
      ...deps,
      images: undefined
    })
    expect(missing!.status).toBe(503)
    const pdfWithoutImages = await handlePublicMediaHttp(request(document.id), { ...deps, images: undefined })
    expect(pdfWithoutImages!.status).toBe(200)
    images.output.mockRejectedValueOnce(new Error('Provider down: private details'))
    const failed = await deliver(image.id, 'image?w=800&format=avif')
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ error: { code: 'media_unavailable' } })
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('accepts no %s public media mutation', async (method) => {
    const response = await deliver('00000000-0000-4000-8000-000000000009', 'document', { method })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(bucket.get).not.toHaveBeenCalled()
  })

  it.each([
    'document?url=https://attacker.invalid/private',
    'document?x=1',
    'image?w=800&format=jpeg&format=avif',
    'image?w=800&w=64&format=jpeg',
    'image?w=800&format=jpeg&url=https://attacker.invalid',
    'image?w=800&format=jpeg&height=800',
    'image?w=0800&format=jpeg',
    'image?w=801&format=jpeg',
    'image?w=1601&format=jpeg',
    'image?w=1e3&format=jpeg',
    'image?w=-64&format=jpeg',
    'image?w=800&format=png',
    'image?w=800&format=JPEG',
    'image?w=800',
    'image',
    'original',
    'invoice',
    'document%2Fextra',
    'document/extra'
  ])('rejects aliases or uncontrolled query costs: %s', async (suffix) => {
    const response = await deliver('00000000-0000-4000-8000-000000000009', suffix)
    expect(response.status).toBe(404)
    expect(bucket.get).not.toHaveBeenCalled()
    expect(images.input).not.toHaveBeenCalled()
  })

  it('reserves encoded separators and identifiers without falling through to assets', async () => {
    for (const path of [
      '/media',
      '/media/',
      '/media%2F00000000-0000-4000-8000-000000000009/document',
      '/media/00000000-0000-4000-8000-000000000009%2Fdocument',
      '/%6dedia/00000000-0000-4000-8000-000000000009/document',
      '/%256dedia/00000000-0000-4000-8000-000000000009/document',
      '/MEDIA/00000000-0000-4000-8000-000000000009/document',
      '/media/%30%30%30%30/document'
    ]) {
      expect(isPublicMediaPath(path)).toBe(true)
      const response = await handlePublicMediaHttp(new Request(`https://neteco.invalid${path}`), deps)
      expect(response!.status).toBe(404)
    }
    expect(await handlePublicMediaHttp(new Request('https://neteco.invalid/catalogo'), deps)).toBeNull()
  })

  it('keeps nonexistent, wrong-role and unapproved assets uniformly private 404', async () => {
    const pdf = await publish()
    const image = await publish({ role: 'main' })
    for (const [id, suffix] of [
      [crypto.randomUUID(), 'document'],
      [pdf.uploadId, 'document'],
      [pdf.id, 'image?w=800&format=jpeg'],
      [image.id, 'document']
    ]) {
      const response = await deliver(id!, suffix!)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: 'media_not_found' } })
    }
  })

  it.each([
    "UPDATE products SET status = 'hidden' WHERE id = 'p-1'",
    "UPDATE products SET legacy_id = NULL WHERE id = 'p-1'",
    "UPDATE categories SET status = 'draft' WHERE id = 'c1'",
    "UPDATE categories SET legacy_id = NULL WHERE id = 'c1'",
    "UPDATE variants SET status = 'hidden' WHERE id = 'v-1-1'",
    "UPDATE variants SET legacy_id = NULL WHERE id = 'v-1-1'",
    "UPDATE variants SET product_id = 'p-2' WHERE id = 'v-1-1'"
  ])('rechecks current source eligibility: %s', async (sql) => {
    const publication = await publish({ variantId: 'v-1-1' })
    await publish({ role: 'main' })
    sqlite.exec(sql)
    const response = await deliver(publication.id)
    expect(response.status).toBe(404)
    expect(bucket.get).not.toHaveBeenCalled()
    expect((await readPublicProductMedia(database, ['p-1'], clock)).get('p-1')!.documents).toEqual([])
  })

  it('blocks future validity windows and expired scan receipts without touching R2', async () => {
    const future = await publish({ validFrom: NEXT })
    await publish({ role: 'main' })
    expect((await deliver(future.id)).status).toBe(404)
    clock = EXPIRY
    expect((await deliver(future.id)).status).toBe(404)
    expect(bucket.get).not.toHaveBeenCalled()
  })

  it('blocks any newer scan or human rights decision rather than reusing pinned prior approval', async () => {
    const publication = await publish()
    await publish({ role: 'main' })
    clock = NEXT
    await attest(publication.uploadId, { verdict: 'infected' })
    expect((await deliver(publication.id)).status).toBe(404)
    const approved = await publish()
    await decideMediaRights(
      database,
      CLAIMS,
      approved.uploadId,
      { decision: 'reject', reason: 'Permiso retirado' },
      { idempotencyKey: crypto.randomUUID(), now: clock }
    )
    expect((await deliver(approved.id)).status).toBe(404)
    expect(bucket.get).not.toHaveBeenCalled()
  })

  it('requires a fresh publication pin even when a newer authentic receipt is also clean', async () => {
    const publication = await publish()
    await publish({ role: 'main' })
    clock = NEXT
    await attest(publication.uploadId)
    expect((await deliver(publication.id)).status).toBe(404)
    expect((await readPublicProductMedia(database, ['p-1'], clock)).get('p-1')!.documents).toEqual([])
    expect(bucket.get).not.toHaveBeenCalled()
  })

  it.each(['withdrawal', 'hidden product', 'expired scan', 'expired publication', 'rights rejection'])(
    'rechecks authority after asynchronous R2 work: %s',
    async (race) => {
      const publication = await publish({ validUntil: NEXT })
      await publish({ role: 'main' })
      bucket.get.mockImplementationOnce(async (key) => {
        const object = bucket.body(key)
        if (race === 'withdrawal') await withdraw(publication.id)
        if (race === 'hidden product') sqlite.exec("UPDATE products SET status = 'hidden' WHERE id = 'p-1'")
        if (race === 'expired scan') clock = EXPIRY
        if (race === 'expired publication') clock = NEXT
        if (race === 'rights rejection')
          await decideMediaRights(
            database,
            CLAIMS,
            publication.uploadId,
            { decision: 'reject', reason: 'Cambio durante lectura' },
            { idempotencyKey: crypto.randomUUID(), now: clock }
          )
        return object
      })
      const response = await deliver(publication.id)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: 'media_not_found' } })
    }
  )

  it('rechecks withdrawal after the asynchronous image decoder finishes', async () => {
    const publication = await publish({ role: 'main' })
    const normal = images.output.getMockImplementation()!
    images.output.mockImplementationOnce(async (options, width) => {
      await withdraw(publication.id)
      return normal(options, width)
    })
    const response = await deliver(publication.id, 'image?w=800&format=webp')
    expect(response.status).toBe(404)
  })

  it('rechecks withdrawal after consuming transformed output, before any bytes response', async () => {
    const publication = await publish({ role: 'main' })
    images.output.mockImplementationOnce(async (options) => ({
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await withdraw(publication.id)
              controller.enqueue(new TextEncoder().encode('transformed'))
              controller.close()
            }
          }),
          { headers: { 'content-type': options.format } }
        ),
      contentType: () => options.format,
      image: () => {
        throw new Error('not used')
      }
    }))
    expect((await deliver(publication.id, 'image?w=800&format=jpeg')).status).toBe(404)
  })

  it.each([
    'etag',
    'checksum',
    'size',
    'key',
    'missing checksum',
    'missing object',
    'truncated',
    'oversized',
    'forged bytes'
  ])('blocks altered originals before returning bytes: %s', async (corruption) => {
    const publication = await publish()
    await publish({ role: 'main' })
    const cancelled = vi.fn()
    bucket.get.mockImplementationOnce(async (key) => {
      const object = { ...bucket.body(key)!, writeHttpMetadata: () => {} }
      if (corruption === 'missing object') return null
      if (corruption === 'etag') return { ...object, etag: 'different-etag' }
      if (corruption === 'checksum')
        return { ...object, checksums: { sha256: new ArrayBuffer(32), toJSON: () => ({}) } }
      if (corruption === 'missing checksum') return { ...object, checksums: { toJSON: () => ({}) } }
      if (corruption === 'size') return { ...object, size: PDF.length + 1 }
      if (corruption === 'key') return { ...object, key: 'quarantine/another-object/key' }
      const altered =
        corruption === 'truncated'
          ? PDF.subarray(0, -1)
          : corruption === 'oversized'
            ? new Uint8Array(PDF.length + 1)
            : new Uint8Array(PDF.length)
      return {
        ...object,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(altered)
            if (corruption !== 'oversized') controller.close()
          },
          cancel: cancelled
        })
      }
    })
    const response = await deliver(publication.id)
    expect(response.status).toBe(404)
    expect(images.input).not.toHaveBeenCalled()
    if (corruption === 'oversized') expect(cancelled).toHaveBeenCalledOnce()
  })

  it('copies each original chunk before later provider mutation', async () => {
    const publication = await publish()
    await publish({ role: 'main' })
    bucket.get.mockImplementationOnce(async (key) => {
      const object = { ...bucket.body(key)!, writeHttpMetadata: () => {} }
      const borrowed = new Uint8Array(PDF)
      let reads = 0
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (reads++ === 0) controller.enqueue(borrowed.subarray(0, 10))
            else {
              borrowed.subarray(0, 10).fill(0)
              controller.enqueue(borrowed.subarray(10))
              controller.close()
            }
          }
        },
        { highWaterMark: 0 }
      )
      return { ...object, body }
    })
    const response = await deliver(publication.id)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF)
  })

  it('does not decode image originals whose actual bytes differ from server checksum metadata', async () => {
    const publication = await publish({ role: 'main' })
    const stored = [...bucket.objects.values()][0]!
    stored.bytes[27] = 1
    expect((await deliver(publication.id, 'image?w=800&format=avif')).status).toBe(404)
    expect(images.input).not.toHaveBeenCalled()
  })

  it('sanitizes D1, R2 and transformer failures instead of leaking SQL or private keys', async () => {
    const publication = await publish()
    await publish({ role: 'main' })
    const prepare = database.prepare.bind(database)
    database.prepare = () => {
      throw new Error('SQL SELECT object_key FROM media_uploads, private token')
    }
    const d1Failure = await deliver(publication.id)
    expect(d1Failure.status).toBe(503)
    expect(await d1Failure.text()).toBe('{"error":{"code":"media_unavailable"}}')
    database.prepare = prepare
    bucket.get.mockRejectedValueOnce(new Error('R2 private quarantine/key'))
    const r2Failure = await deliver(publication.id)
    expect(r2Failure.status).toBe(503)
    expect(await r2Failure.text()).toBe('{"error":{"code":"media_unavailable"}}')
  })

  it('does not support byte ranges and still gates range requests against publication', async () => {
    const publication = await publish()
    await publish({ role: 'main' })
    const response = await deliver(publication.id, 'document', { headers: { range: 'bytes=0-10' } })
    expect(response.status).toBe(416)
    expect(bucket.get).not.toHaveBeenCalled()
    await withdraw(publication.id)
    expect((await deliver(publication.id, 'document', { headers: { range: 'bytes=0-10' } })).status).toBe(404)
  })

  it('projects governed primary, variant and documents in one query without legacy/PII fallbacks', async () => {
    sqlite.exec(
      `UPDATE products SET attributes = '{"image":"https://legacy.invalid/image.jpg","datasheet":"https://legacy.invalid/private.pdf"}' WHERE id = 'p-1'`
    )
    const empty = await readPublicProductMedia(database, ['p-1'], clock)
    expect(empty.get('p-1')).toEqual({ variants: new Map(), documents: [] })
    const primary = await publish({ role: 'main' })
    const variant = await publish({ role: 'image', variantId: 'v-1-1' })
    const document = await publish({ role: 'sds' })
    const prepare = vi.spyOn(database, 'prepare')
    const media = await readPublicProductMedia(database, ['p-1', 'p-1', 'p-2', 'p-3'], clock)
    expect(prepare).toHaveBeenCalledOnce()
    expect(media.size).toBe(3)
    expect(media.get('p-1')).toEqual({
      image: `/media/${primary.id}/image?w=800&format=jpeg`,
      imageAlt: 'Fotografía alternativa de producto',
      variants: new Map([
        [
          'v-1-1',
          { image: `/media/${variant.id}/image?w=800&format=jpeg`, imageAlt: 'Fotografía alternativa de producto' }
        ]
      ]),
      documents: [
        {
          id: document.id,
          role: 'sds',
          name: 'Ficha "Técnica" / Série (ñ)!',
          url: `/media/${document.id}/document`,
          version: 'v1',
          language: 'es',
          authorizedAt: '2026-09-20'
        }
      ]
    })
    expect(media.get('p-2')).toEqual({ variants: new Map(), documents: [] })
    expect(JSON.stringify([...media])).not.toMatch(
      /legacy|quarantine|object_key|checksum|Titular|Expediente|rights_owner|scan_receipt/
    )
    await withdraw(document.id)
    expect((await readPublicProductMedia(database, ['p-1'], clock)).get('p-1')!.documents).toEqual([])
  })

  it('returns an empty map without SQL and rejects malformed trusted projection inputs', async () => {
    const prepare = vi.spyOn(database, 'prepare')
    expect(await readPublicProductMedia(database, [], 'not-a-date')).toEqual(new Map())
    expect(prepare).not.toHaveBeenCalled()
    await expect(readPublicProductMedia(database, ['p-1'], 'not-a-date')).rejects.toThrow('invalid_media_instant')
    await expect(readPublicProductMedia(database, ['bad\nproduct'], clock)).rejects.toThrow('invalid_media_product_ids')
    await expect(
      readPublicProductMedia(
        database,
        Array.from({ length: 1001 }, () => 'p-1'),
        clock
      )
    ).rejects.toThrow('invalid_media_product_ids')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('uses bounded parameter batches for larger internal projection consumers', async () => {
    const publication = await publish()
    await publish({ role: 'main' })
    const prepare = vi.spyOn(database, 'prepare')
    const ids = ['p-1', ...Array.from({ length: 90 }, (_, index) => `missing-product-${index}`)]
    const media = await readPublicProductMedia(database, ids, clock)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(media.size).toBe(ids.length)
    expect(media.get('p-1')!.documents[0]!.id).toBe(publication.id)
    expect(media.get('missing-product-89')).toEqual({ variants: new Map(), documents: [] })
  })

  it('deterministically selects the latest currently valid primary relation', async () => {
    await publish({ role: 'main' })
    clock = NEXT
    const latest = await publish({ role: 'main', version: 'v2', validFrom: NEXT })
    await publish({ role: 'image', version: 'gallery-v1', validFrom: NEXT })
    const media = (await readPublicProductMedia(database, ['p-1'], clock)).get('p-1')!
    expect(media.image).toBe(`/media/${latest.id}/image?w=800&format=jpeg`)
  })

  it('serves governed list, search and PDP HTTP contracts including own variant, sibling, related and document media', async () => {
    const media = await catalogMedia()
    const list =
      await publicApi<NonNullable<Awaited<ReturnType<typeof listPublishedProducts>>>>('/api/products?limit=24')
    const search = await publicApi<Awaited<ReturnType<typeof searchPublishedProducts>>>('/api/search?q=Producto')
    const detail =
      await publicApi<NonNullable<Awaited<ReturnType<typeof getPublishedProductDetail>>>>('/api/products/producto-1')
    const mainImage = `/media/${media.primary.id}/image?w=800&format=jpeg`
    const siblingImage = `/media/${media.sibling.id}/image?w=800&format=jpeg`
    expect(list.items).toHaveLength(6)
    expect(search.items).toHaveLength(6)
    expect(list.items.find((item) => item.id === 1)).toMatchObject({
      image: mainImage,
      imageAlt: 'Fotografía alternativa de producto'
    })
    expect(list.items.find((item) => item.id === 2)).toMatchObject({ image: siblingImage })
    expect(search.items.find((item) => item.slug === 'producto-1')).toMatchObject({ image: mainImage })
    expect(search.items.find((item) => item.slug === 'producto-2')).toMatchObject({ image: siblingImage })
    expect(detail).toMatchObject({
      image: mainImage,
      imageAlt: 'Fotografía alternativa de producto',
      datasheet: `/media/${media.document.id}/document`
    })
    expect(detail.variants.find((item) => item.uuid === 'v-1-1')).toMatchObject({
      image: `/media/${media.variant.id}/image?w=800&format=jpeg`,
      imageAlt: 'Fotografía alternativa de producto'
    })
    expect(detail.siblings.find((item) => item.slug === 'producto-2')).toMatchObject({ image: siblingImage })
    expect(detail.related.find((item) => item.slug === 'producto-2')).toMatchObject({ image: siblingImage })
    expect(detail.documents).toEqual([
      {
        id: media.document.id,
        role: 'datasheet',
        name: 'Ficha "Técnica" / Série (ñ)!',
        url: `/media/${media.document.id}/document`,
        version: 'v1',
        language: 'es',
        authorizedAt: '2026-09-20'
      }
    ])
    const serialized = JSON.stringify({ list, search, detail })
    expect(serialized).not.toMatch(
      /legacy\.invalid|\/img\/products|quarantine|checksum|object_key|rights_owner|Expediente|Titular privado|scan_receipt/
    )
    for (const publication of Object.values(media)) expect(serialized).not.toContain(publication.uploadId)
  })

  it.each(['withdrawal', 'rights rejection', 'infected receipt'])(
    'immediately removes governed image and document projections from every public API after %s',
    async (revocation) => {
      const media = await catalogMedia()
      for (const publication of Object.values(media)) {
        if (revocation === 'withdrawal') await withdraw(publication.id)
        if (revocation === 'rights rejection')
          await decideMediaRights(
            database,
            CLAIMS,
            publication.uploadId,
            {
              decision: 'reject',
              reason: 'Permiso documental retirado para prueba de API'
            },
            { idempotencyKey: crypto.randomUUID(), now: clock }
          )
        if (revocation === 'infected receipt') {
          clock = NEXT
          await attest(publication.uploadId, { verdict: 'infected' })
        }
      }
      vi.setSystemTime(new Date(clock))
      const list =
        await publicApi<NonNullable<Awaited<ReturnType<typeof listPublishedProducts>>>>('/api/products?limit=24')
      const search = await publicApi<Awaited<ReturnType<typeof searchPublishedProducts>>>('/api/search?q=Producto')
      expect(list.items.map((item) => item.id)).toEqual([3, 4, 5, 6])
      expect(search.items.map((item) => item.slug)).toEqual(['producto-3', 'producto-4', 'producto-5', 'producto-6'])
      expect(await getPublishedProductDetail(database, 'producto-1', { instant: clock })).toBeNull()
      const missing = await worker.fetch(new Request('https://neteco.invalid/api/products/producto-1'), {
        DB: database,
        AUTH_ENABLED: 'false'
      } as CloudflareEnv)
      expect(missing.status).toBe(404)
      const projection = await readPublicProductMedia(database, ['p-1', 'p-2'], clock)
      expect([...projection.values()]).toEqual([
        { variants: new Map(), documents: [] },
        { variants: new Map(), documents: [] }
      ])
      expect(JSON.stringify({ list, search, projection: [...projection] })).not.toMatch(
        /legacy\.invalid|\/img\/products|quarantine/
      )
      for (const publication of Object.values(media))
        expect(
          (await deliver(publication.id, publication === media.document ? 'document' : 'image?w=800&format=jpeg'))
            .status
        ).toBe(404)
    }
  )

  it('batches one governed-media query per list, search and detail regardless of result/variant/related counts', async () => {
    await catalogMedia()
    const prepare = vi.spyOn(database, 'prepare')
    const batch = vi.spyOn(database, 'batch')
    for (const limit of [1, 24]) {
      prepare.mockClear()
      batch.mockClear()
      const listed = await listPublishedProducts(database, { page: 1, limit, sort: 'default' }, { instant: clock })
      expect(listed!.items.length).toBe(Math.min(limit, 6))
      expect(prepare).toHaveBeenCalledTimes(2)
      expect(batch).toHaveBeenCalledTimes(1)
      expect(batch.mock.calls[0]![0]).toHaveLength(2)
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("ORDER BY CASE role WHEN 'main'"))).toHaveLength(1)
    }
    for (const query of ['SKU-1-1', 'Producto']) {
      prepare.mockClear()
      const result = await searchPublishedProducts(database, query, { instant: clock })
      expect(result.items).not.toEqual([])
      expect(prepare).toHaveBeenCalledTimes(3)
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("ORDER BY CASE role WHEN 'main'"))).toHaveLength(1)
    }
    prepare.mockClear()
    const detail = await getPublishedProductDetail(database, 'producto-1', { instant: clock })
    expect(detail!.siblings).toHaveLength(1)
    expect(detail!.related).toHaveLength(4)
    expect(prepare).toHaveBeenCalledTimes(7)
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("ORDER BY CASE role WHEN 'main'"))).toHaveLength(1)
  })
})
