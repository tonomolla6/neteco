import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEMO_IDENTITIES } from '../../shared/demo-access'
import { provisionDemoDataset, type DemoDatasetSummary } from '../../scripts/lib/demo-dataset'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { listPublishedProducts } from '../../workers/catalog/products'
import { publicationValidityExpression } from '../../workers/catalog/publication-validity'
import { authorizeD1Session } from '../../workers/catalog/authorization'

const utc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
async function world() {
  const sqlite = await openMigratedDatabase()
  sqlite.limits.exprDepth = 100
  sqlite.limits.variableNumber = 100
  sqlite.limits.functionArg = 32
  const executed: string[] = []
  const database: D1Database = {
    ...d1OverSqlite(sqlite),
    exec: async (query) => {
      executed.push(query)
      if (/^\s*(?:BEGIN|COMMIT)\b/m.test(query)) throw new Error('explicit_d1_transaction_forbidden')
      sqlite.exec(query)
      return { count: 1, duration: 0 }
    }
  }
  const objects = new Map<string, Uint8Array>()
  const bucket: Pick<R2Bucket, 'put'> = {
    async put(key, value, options) {
      if (!(value instanceof Uint8Array)) throw new Error('test_expected_owned_png_bytes')
      const bytes = new Uint8Array(value)
      const hash = createHash('sha256').update(bytes).digest('hex')
      expect(options?.sha256).toBe(hash)
      expect(options?.onlyIf).toEqual({ etagDoesNotMatch: '*' })
      expect(options?.httpMetadata).toEqual({
        contentType: 'application/octet-stream',
        contentDisposition: 'attachment',
        cacheControl: 'no-store'
      })
      if (objects.has(key)) return null
      objects.set(key, bytes)
      const checksum = await crypto.subtle.digest('SHA-256', bytes)
      return {
        key,
        version: 'synthetic-memory-r2-v1',
        size: bytes.length,
        etag: hash,
        httpEtag: `"${hash}"`,
        uploaded: new Date(),
        storageClass: 'Standard',
        checksums: { sha256: checksum, toJSON: () => ({}) },
        writeHttpMetadata() {}
      }
    }
  }
  return { sqlite, database, bucket, objects, executed }
}

describe('offline reproducible dedicated demo dataset over all 52 D1 migrations', () => {
  let fixture: Awaited<ReturnType<typeof world>>
  let summary: DemoDatasetSummary
  let now: string
  const extraDatabases: DatabaseSync[] = []
  beforeAll(async () => {
    fixture = await world()
    now = utc()
    const forbiddenProvider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('demo_external_io_forbidden'))
    try {
      summary = await provisionDemoDataset(fixture.database, fixture.bucket, now)
      expect(forbiddenProvider).not.toHaveBeenCalled()
    } finally {
      forbiddenProvider.mockRestore()
    }
  }, 30_000)
  afterAll(() => {
    fixture?.sqlite.close()
    for (const sqlite of extraDatabases) sqlite.close()
  })

  it('public product reader confirms all 20 products, governed media and 50 variants', async () => {
    const catalog = await listPublishedProducts(fixture.database, { page: 1, limit: 24, sort: 'default' })
    expect(catalog?.total).toBe(20)
    expect(catalog?.items).toHaveLength(20)
    expect(
      catalog?.items.every(
        (product) =>
          product.name.startsWith('DEMO · ') && product.badges.includes('DEMO') && product.image?.startsWith('/media/')
      )
    ).toBe(true)
    expect(summary).toMatchObject({ products: 20, variants: 50, categories: 45, stockLocations: 1 })
    expect(fixture.executed).toHaveLength(4)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM catalog_product_publication_policies').get()).toEqual({
      n: 20
    })
    expect(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM variants WHERE mpn LIKE 'SYNTHETIC-VALIDITY-%'").get()
    ).toEqual({ n: 50 })
  })

  it('R2 original is decodable PNG artwork with an exact durable SHA256/size/etag', async () => {
    expect(fixture.objects.size).toBe(1)
    const object = [...fixture.objects.entries()][0]!
    const metadata = await sharp(object[1]).metadata()
    expect(metadata).toMatchObject({ format: 'png', width: 800, height: 800 })
    const checksum = createHash('sha256').update(object[1]).digest('hex')
    expect(
      fixture.sqlite
        .prepare('SELECT object_key,checksum,byte_size,r2_etag,content_type,storage_status FROM media_uploads')
        .get()
    ).toEqual({
      object_key: object[0],
      checksum,
      byte_size: object[1].length,
      r2_etag: checksum,
      content_type: 'image/png',
      storage_status: 'quarantined'
    })
    expect(fixture.sqlite.prepare('SELECT scanner_version,expires_at FROM media_scan_receipts').get()).toEqual({
      scanner_version: 'SYNTHETIC-DEMO-FIXTURE-NOT-PRODUCTION-ANTIVIRUS',
      expires_at: summary.mediaExpiresAt
    })
    expect(Date.parse(summary.mediaExpiresAt) - Date.parse(now)).toBe(7 * 86400_000)
    expect(
      fixture.sqlite
        .prepare("SELECT count(*) AS n FROM products WHERE json_extract(attributes,'$.image') IS NOT NULL")
        .get()
    ).toEqual({ n: 0 })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM product_media_publications').get()).toEqual({ n: 20 })
  })

  it('both demo identities have fixed ownership, unusable passwords and no seeded MFA or live sessions', () => {
    for (const identity of Object.values(DEMO_IDENTITIES)) {
      expect(
        fixture.sqlite
          .prepare('SELECT customer_id,email,password_hash,status FROM identities WHERE id=?')
          .get(identity.identityId)
      ).toEqual({
        customer_id: identity.customerId,
        email: identity.email,
        password_hash: 'DEMO-OFFLINE-IDENTITY-NOT-A-PASSWORD-HASH',
        status: 'active'
      })
      expect(
        fixture.sqlite.prepare('SELECT count(*) AS n FROM identity_mfa WHERE identity_id=?').get(identity.identityId)
      ).toEqual({ n: 0 })
      expect(
        fixture.sqlite
          .prepare('SELECT count(*) AS n FROM auth_sessions WHERE identity_id=? AND revoked_at IS NULL')
          .get(identity.identityId)
      ).toEqual({ n: 0 })
    }
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({
      n: 0
    })
    expect(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM identity_roles WHERE role_code='demo_bootstrap'").get()
    ).toEqual({ n: 0 })
    expect(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM role_permissions WHERE role_code='demo_bootstrap'").get()
    ).toEqual({ n: 0 })
  })

  it('normal admin authorization cannot use the revoked internal bootstrap MFA session', async () => {
    const session = fixture.sqlite.prepare('SELECT id,identity_id FROM auth_sessions WHERE mfa_verified=1').get()
    expect(session).toBeTruthy()
    if (!session || typeof session.id !== 'string' || typeof session.identity_id !== 'string')
      throw new Error('missing_bootstrap_history')
    expect(
      await authorizeD1Session(
        fixture.database,
        { sessionId: session.id, identityId: session.identity_id, sessionVersion: 1 },
        'catalog.publish',
        { now: utc() }
      )
    ).toEqual({ allowed: false, code: 'unauthenticated' })
  })

  it('six real contractual pending orders belong to the customer with three genuine quoted methods and stock reservations', () => {
    expect(
      fixture.sqlite.prepare('SELECT status,customer_id,count(*) AS n FROM orders GROUP BY status,customer_id').all()
    ).toEqual([{ status: 'awaiting_payment', customer_id: DEMO_IDENTITIES.customer.customerId, n: 6 }])
    expect(
      fixture.sqlite
        .prepare(
          'SELECT shipping_method_code AS method,count(*) AS n FROM orders GROUP BY shipping_method_code ORDER BY method'
        )
        .all()
    ).toEqual([
      { method: 'own_delivery', n: 2 },
      { method: 'parcel', n: 2 },
      { method: 'pickup', n: 2 }
    ])
    expect(fixture.sqlite.prepare('SELECT count(*) AS n,sum(quantity) AS q FROM order_lines').get()).toEqual({
      n: 12,
      q: 18
    })
    expect(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM inventory_reservations WHERE status='reserved'").get()
    ).toEqual({ n: 6 })
    expect(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM order_events WHERE event_type='order.created'").get()
    ).toEqual({ n: 6 })
    expect(
      fixture.sqlite
        .prepare('SELECT count(*) AS n FROM orders WHERE total_net_cents+total_tax_cents<>total_gross_cents')
        .get()
    ).toEqual({ n: 0 })
    expect(
      fixture.sqlite
        .prepare('SELECT count(*) AS n FROM inventory_balances WHERE physical_quantity<20 OR physical_quantity>50')
        .get()
    ).toEqual({ n: 0 })
  })

  it('published CMS pages are genuine versioned commands, noindex and text-only; the third remains private draft', () => {
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM content_pages').get()).toEqual({ n: 3 })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM content_publications').get()).toEqual({ n: 2 })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM content_publication_audit').get()).toEqual({ n: 2 })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM content_draft_audit').get()).toEqual({ n: 3 })
    expect(
      fixture.sqlite
        .prepare("SELECT count(*) AS n FROM content_versions WHERE json_extract(document,'$.seo.noindex')=1")
        .get()
    ).toEqual({ n: 3 })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM content_media_links').get()).toEqual({ n: 0 })
    expect(
      fixture.sqlite
        .prepare("SELECT count(*) AS n FROM content_publications WHERE slug='borrador-editorial-demo'")
        .get()
    ).toEqual({ n: 0 })
  })

  it('two support tickets have immutable commands, owned order contexts and no invented retention/SLA policy', () => {
    expect(
      fixture.sqlite
        .prepare(
          'SELECT count(*) AS n FROM support_tickets WHERE customer_id=? AND policy IS NULL AND retention_until IS NULL AND sla_due_at IS NULL'
        )
        .get(DEMO_IDENTITIES.customer.customerId)
    ).toEqual({ n: 2 })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual({ n: 2 })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM support_events').get()).toEqual({ n: 2 })
    expect(
      fixture.sqlite
        .prepare(
          'SELECT count(*) AS n FROM support_tickets t JOIN orders o ON o.id=t.order_id AND o.customer_id=t.customer_id'
        )
        .get()
    ).toEqual({ n: 2 })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM support_attachments').get()).toEqual({ n: 0 })
  })

  it('no payment, paid state, fiscal, marketing consent, provider receipt or accepted email exists', () => {
    for (const table of [
      'payment_intents',
      'payment_events',
      'order_payment_states',
      'fiscal_invoice_intents',
      'fiscal_provider_receipts',
      'fiscal_documents',
      'refund_receipts',
      'fiscal_credit_receipts',
      'newsletter_subscriptions',
      'newsletter_editorial_deliveries',
      'newsletter_editorial_fake_receipts',
      'analytics_commerce_facts'
    ]) {
      expect(fixture.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 })
    }
    expect(summary.externalProviderCalls).toBe(0)
  })

  it('returns only nonsensitive aggregate JSON, not account identifiers, tokens, secrets or media paths', () => {
    expect(summary).toMatchObject({
      schemaVersion: 1,
      validationOnly: true,
      customers: 2,
      demoIdentities: 2,
      pendingOrders: 6,
      cmsPublishedPages: 2,
      cmsDraftPages: 1,
      supportTickets: 2,
      mediaObjects: 1,
      externalProviderCalls: 0
    })
    expect(JSON.stringify(summary)).not.toMatch(/@|password|cookie|token|secret|quarantine\/|d3100000/i)
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary)
  })

  it('refuses reseeding a populated database before any exec, R2 overwrite or live data mutation', async () => {
    const before = fixture.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id').all()
    const put = vi.spyOn(fixture.bucket, 'put')
    try {
      await expect(provisionDemoDataset(fixture.database, fixture.bucket, utc())).rejects.toThrow(
        'demo_database_not_empty'
      )
      expect(put).not.toHaveBeenCalled()
      expect(fixture.executed).toHaveLength(4)
      expect(fixture.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id').all()).toEqual(before)
    } finally {
      put.mockRestore()
    }
  })

  it.each(['2026-02-30T12:00:00Z', '2026-10-03T12:00:00.000Z', '2026-10-03T14:00:00+02:00'])(
    'rejects noncanonical or invalid clock %s before writes',
    async (invalid) => {
      await expect(provisionDemoDataset(fixture.database, fixture.bucket, invalid)).rejects.toThrow()
      expect(fixture.executed).toHaveLength(4)
    }
  )

  it('R2 uncertainty leaves no fabricated media approval, pending order or live bootstrap authority', async () => {
    const failure = await world()
    extraDatabases.push(failure.sqlite)
    await expect(provisionDemoDataset(failure.database, { put: async () => null }, utc())).rejects.toThrow(
      'demo_media_storage_unconfirmed'
    )
    for (const table of [
      'media_uploads',
      'media_scan_receipts',
      'media_rights_decisions',
      'product_media_publications',
      'orders'
    ])
      expect(failure.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    expect(failure.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({
      n: 0
    })
    expect(
      failure.sqlite.prepare('SELECT count(*) AS n FROM products p WHERE ' + publicationValidityExpression('p')).get()
    ).toEqual({ n: 0 })
  }, 15_000)

  it('publication validity fails closed at the explicit seven-day expiry, without extending or mutating receipts', () => {
    const valid = fixture.sqlite.prepare(
      'SELECT count(*) AS n FROM products p WHERE ' + publicationValidityExpression('p', '?1')
    )
    expect(valid.get(now)).toEqual({ n: 20 })
    expect(valid.get(summary.mediaExpiresAt)).toEqual({ n: 0 })
    expect(fixture.sqlite.prepare('SELECT expires_at FROM media_scan_receipts').get()).toEqual({
      expires_at: summary.mediaExpiresAt
    })
  })
})
