import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { catalogPublicationIssues, validGtin } from '../../server/domain/catalog-publication'
import {
  readD1CatalogPublicationReadiness,
  type D1CatalogPublicationReadiness
} from '../../workers/catalog/catalog-publication-readiness'
import { eligibleMediaEvidenceSql, eligibleMediaPublicationSql } from '../../workers/media/governance'
import { readPublicProductMedia } from '../../workers/media/public-catalog'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testUuid } from '../support/deterministic'

const NOW = '2026-09-30T10:00:00Z'
const NEXT = '2026-09-30T10:00:01Z'
const IDENTITY = '10000000-0000-4000-8000-000000000035'
const SESSION = '20000000-0000-4000-8000-000000000035'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const CHECKSUM = 'a'.repeat(64)

describe('private advisory D1 publication completeness against real migrations', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    sqlite.exec(`
      INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES ('${IDENTITY}','private-editor@example.invalid','synthetic-unusable-hash','${NOW}','active','${NOW}','${NOW}');
      INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES ('${SESSION}','${IDENTITY}',1,1,'2026-09-30T09:00:00Z','2026-09-30T12:00:00Z');
      INSERT INTO roles VALUES ('editor','Editor','Synthetic fixture'),('customer','Customer','Synthetic fixture'),('publisher','Publisher','Synthetic fixture');
      INSERT INTO permissions VALUES ('catalog.write','catalog','write','Synthetic fixture'),('catalog.read','catalog','read','Synthetic fixture'),('catalog.publish','catalog','publish','Synthetic fixture');
      INSERT INTO role_permissions VALUES ('editor','catalog.write'),('customer','catalog.read'),('publisher','catalog.publish');
      INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES ('${IDENTITY}','editor','${NOW}');
      UPDATE products SET status='draft',brand_id='b1',short_description='Descripción corta suficientemente larga',
        description='Descripción larga de producto completa para comprobación editorial',
        regulatory='{}',attributes='{"image":"/unverified-legacy.webp","imageRights":{"owner":"Not approval","license":"Not approval","authorizedAt":"2026-09-01"}}'
        WHERE id='p-1';
      UPDATE variants SET status='draft',mpn='MPN-READY',minimum_quantity=2,quantity_increment=2,
        weight_grams=1200,width_mm=100,height_mm=200,depth_mm=300 WHERE id='v-1-1';
    `)
    media()
  })

  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // Direct synthetic SQL evidence tests only the reader's attestation predicate.
  // This is neither an authentic AV verdict nor real licensed inventory.
  function media(options: { role?: 'main' | 'image' | 'sds'; product?: string; variant?: string; mime?: string } = {}) {
    const upload = testUuid()
    const scan = testUuid()
    const rights = testUuid()
    const publication = testUuid()
    const objectKey = `quarantine/${upload}/${CHECKSUM}`
    const role = options.role ?? 'main'
    const mime = options.mime ?? (role === 'sds' ? 'application/pdf' : 'image/png')
    sqlite
      .prepare(
        `INSERT INTO media_uploads(id,actor_id,idempotency_key,payload_hash,checksum,object_key,filename,content_type,
        byte_size,width,height,alt,rights_owner,rights_license,rights_source,storage_status,r2_etag,created_at,stored_at)
        VALUES (?,?,?, ?,?,?, 'private-original-name',?,100,?,?, 'Fotografía exacta del producto',
          'Private synthetic owner','Synthetic-only license','Synthetic reference','quarantined','synthetic-etag',?,?)`
      )
      .run(
        upload,
        IDENTITY,
        upload,
        CHECKSUM,
        CHECKSUM,
        objectKey,
        mime,
        mime === 'application/pdf' ? null : 800,
        mime === 'application/pdf' ? null : 600,
        NOW,
        NOW
      )
    sqlite
      .prepare(
        `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,
        scanned_at,expires_at,received_at,payload_hash) VALUES (?,?,?,?,100,'clean','Synthetic-not-antivirus',?, '2026-10-01T10:00:00Z',?,?)`
      )
      .run(scan, upload, CHECKSUM, objectKey, NOW, NOW, CHECKSUM)
    sqlite
      .prepare(
        `INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,evidence_authorized_at,
        evidence_reference,rights_owner,rights_license,created_at,idempotency_key,payload_hash)
        VALUES (?,?,'approved','Synthetic test only',?,'2026-09-01','Private evidence reference',
          'Private synthetic owner','Synthetic-only license',?,?,?)`
      )
      .run(rights, upload, IDENTITY, NOW, rights, CHECKSUM)
    sqlite
      .prepare(
        `INSERT INTO product_media_publications(id,product_id,variant_id,upload_id,role,title,alt,language,version,
        valid_from,scan_receipt_id,rights_decision_id,actor_id,created_at,idempotency_key,payload_hash)
        VALUES (?,?,?,?,?,'Synthetic document title','Fotografía exacta del producto','es','v1',?,?,?,?,?,?,?)`
      )
      .run(
        publication,
        options.product ?? 'p-1',
        options.variant ?? null,
        upload,
        role,
        NOW,
        scan,
        rights,
        IDENTITY,
        NOW,
        publication,
        CHECKSUM
      )
    return { upload, scan, rights, publication, objectKey }
  }

  async function readiness(source = database, id = '1', now = NOW): Promise<D1CatalogPublicationReadiness> {
    const result = await readD1CatalogPublicationReadiness(source, CLAIMS, now, id)
    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') throw new Error('missing advisory fixture')
    return result.data
  }
  async function codes() {
    return (await readiness()).issues.map((issue) => issue.code)
  }
  function update(sql: string, ...parameters: SQLInputValue[]) {
    sqlite.prepare(sql).run(...parameters)
  }
  function batchBoundary(action: () => void): D1Database {
    return withBatch(async <T>(statements: D1PreparedStatement[]) => {
      const result = await database.batch<T>(statements)
      action()
      return result
    })
  }
  // Retain the generated D1 class surface; object spread drops prototype methods
  // from its declared type and is not a sound platform adapter.
  function withBatch(batch: D1Database['batch']): D1Database {
    return new Proxy(database, {
      get(target, key, receiver) {
        return key === 'batch' ? batch : Reflect.get(target, key, receiver)
      }
    })
  }
  function state() {
    return [
      'products',
      'variants',
      'tax_classes',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'inventory_reservation_lines',
      'media_uploads',
      'media_scan_receipts',
      'media_rights_decisions',
      'product_media_publications',
      'product_media_publication_events',
      'catalog_draft_commands',
      'catalog_draft_audit',
      'catalog_draft_guards'
    ].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  }

  it('reports a complete known snapshot without claiming readiness, publication, policy or external acceptance', async () => {
    const original = state()
    const result = await readiness()
    expect(result).toMatchObject({
      source: 'cloudflare',
      advisory: true,
      publicationEnabled: false,
      productId: 1,
      productUuid: 'p-1',
      catalogVersion: 2,
      evaluatedAt: NOW,
      issues: []
    })
    expect(result).not.toHaveProperty('ready')
    expect(result.limitations.map((item) => item.code)).toEqual([
      'policy.product_type',
      'policy.identifier_exceptions',
      'evidence.external_acceptance',
      'evidence.object_availability',
      'advisory.snapshot'
    ])
    expect(state()).toEqual(original)
    expect(await readiness()).toEqual(result)
  })

  it('checks private draft evidence while the public wrapper still excludes drafts', async () => {
    expect(await codes()).not.toContain('media.primary')
    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1'],
      now: NOW,
      validUntil: '2099-01-01T00:00:00Z',
      media: false
    })
    const privateEvidence = await database.prepare(eligibleMediaEvidenceSql()).bind(NOW).all()
    const publicEvidence = await database.prepare(eligibleMediaPublicationSql('?1')).bind(NOW).all()
    expect(privateEvidence.results).toHaveLength(1)
    expect(publicEvidence.results).toHaveLength(0)
    expect((await readPublicProductMedia(database, ['p-1'], NOW)).get('p-1')?.image).toBeUndefined()
    sqlite.exec("UPDATE products SET status='published' WHERE id='p-1'")
    expect((await database.prepare(eligibleMediaPublicationSql('?1')).bind(NOW).all()).results).toHaveLength(1)
  })

  it('keeps draft/hidden/discontinued variants out of public media even when the product is published', async () => {
    const fixture = media({ variant: 'v-1-1', role: 'image' })
    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1'],
      now: NOW,
      validUntil: '2099-01-01T00:00:00Z',
      media: false
    })
    sqlite.exec("UPDATE products SET status='published' WHERE id='p-1'")
    for (const status of ['draft', 'review', 'hidden', 'discontinued']) {
      update("UPDATE variants SET status=? WHERE id='v-1-1'", status)
      const rows = await database.prepare(eligibleMediaPublicationSql('?1')).bind(NOW).all<{ id: string }>()
      expect(rows.results.map((row) => row.id)).not.toContain(fixture.publication)
    }
    sqlite.exec("UPDATE variants SET status='published' WHERE id='v-1-1'")
    expect((await database.prepare(eligibleMediaPublicationSql('?1')).bind(NOW).all()).results).toHaveLength(2)
  })

  it('never projects keys, checksums, identities, original filenames, rights references or metadata values', async () => {
    const serialized = JSON.stringify(await readiness())
    for (const value of [
      'quarantine/',
      CHECKSUM,
      IDENTITY,
      SESSION,
      'private-original-name',
      'Private evidence reference',
      'Private synthetic owner',
      'Synthetic-only license',
      'MPN-READY',
      'SKU-1-1',
      'unverified-legacy'
    ])
      expect(serialized).not.toContain(value)
  })

  it('denies unauthenticated callers before preparing SQL', async () => {
    const prepare = vi.spyOn(database, 'prepare')
    expect(await readD1CatalogPublicationReadiness(database, null, NOW, '1')).toEqual({
      outcome: 'denied',
      code: 'unauthenticated'
    })
    expect(prepare).not.toHaveBeenCalled()
  })
  it.each([
    ["UPDATE auth_sessions SET revoked_at='2026-09-30T10:00:00Z'", 'unauthenticated'],
    ["UPDATE auth_sessions SET expires_at='2026-09-30T10:00:00Z'", 'unauthenticated'],
    ['UPDATE identities SET session_version=2', 'unauthenticated'],
    ["UPDATE identities SET status='disabled'", 'unauthenticated'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ['DELETE FROM identity_roles', 'forbidden'],
    ["UPDATE identity_roles SET role_code='customer'", 'forbidden'],
    ["UPDATE identity_roles SET role_code='publisher'", 'forbidden']
  ])('requires live catalog.write/email/MFA: %s', async (sql, code) => {
    sqlite.exec(sql)
    const batch = vi.spyOn(database, 'batch')
    expect(await readD1CatalogPublicationReadiness(database, CLAIMS, NOW, '1')).toEqual({ outcome: 'denied', code })
    expect(batch).not.toHaveBeenCalled()
  })
  it.each([
    ["UPDATE auth_sessions SET revoked_at='2026-09-30T10:00:00Z'", 'unauthenticated'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ["DELETE FROM role_permissions WHERE permission_code='catalog.write'", 'forbidden']
  ])('rechecks authority after awaited snapshot: %s', async (sql, code) => {
    expect(
      await readD1CatalogPublicationReadiness(
        batchBoundary(() => sqlite.exec(sql)),
        CLAIMS,
        NOW,
        '1'
      )
    ).toEqual({ outcome: 'denied', code })
  })
  it('accounts for elapsed server time when a session expires during the read', async () => {
    sqlite.exec("UPDATE auth_sessions SET expires_at='2026-09-30T10:00:01Z'")
    const result = await readD1CatalogPublicationReadiness(
      batchBoundary(() => vi.setSystemTime(new Date(NEXT))),
      CLAIMS,
      NOW,
      '1'
    )
    expect(result).toEqual({ outcome: 'denied', code: 'unauthenticated' })
  })
  it.each(['0', '01', '1.0', '1e0', '1\n', '1\r', '+1', 'p-1', '9007199254740992', '999'])(
    'does not resolve aliases or unknown IDs: %s',
    async (id) => {
      expect(await readD1CatalogPublicationReadiness(database, CLAIMS, NOW, id)).toEqual({ outcome: 'not_found' })
    }
  )
  it('reauthorizes even absent products after the read', async () => {
    const result = await readD1CatalogPublicationReadiness(
      batchBoundary(() => sqlite.exec('DELETE FROM identity_roles')),
      CLAIMS,
      NOW,
      '999'
    )
    expect(result).toEqual({ outcome: 'denied', code: 'forbidden' })
  })
  it('propagates storage outages rather than fabricate an issue-free snapshot', async () => {
    const failed = withBatch(async () => {
      throw new Error('synthetic storage outage')
    })
    await expect(readD1CatalogPublicationReadiness(failed, CLAIMS, NOW, '1')).rejects.toThrow(
      'synthetic storage outage'
    )
  })
  it('rejects missing batch result parts', async () => {
    const failed = withBatch(async () => [])
    await expect(readD1CatalogPublicationReadiness(failed, CLAIMS, NOW, '1')).rejects.toThrow(
      'catalog_readiness_unavailable'
    )
  })

  it.each([
    ["UPDATE products SET name='ab' WHERE id='p-1'", 'product.name'],
    ["UPDATE products SET short_description='1234567890123456789' WHERE id='p-1'", 'product.short_description'],
    ["UPDATE products SET description='Descripción insuficiente' WHERE id='p-1'", 'product.description'],
    ["UPDATE products SET brand_id=NULL WHERE id='p-1'", 'brand.status'],
    ["UPDATE brands SET status='draft' WHERE id='b1'", 'brand.status'],
    ["UPDATE variants SET ean='1234567890123' WHERE id='v-1-1'", 'variant.ean'],
    ["UPDATE variants SET gtin='01234567890123' WHERE id='v-1-1'", 'variant.gtin'],
    ["UPDATE variants SET mpn=NULL WHERE id='v-1-1'", 'variant.identifier'],
    ["UPDATE variants SET sku='bad sku' WHERE id='v-1-1'", 'variant.sku'],
    ["UPDATE variants SET price_gross_cents=0 WHERE id='v-1-1'", 'variant.price'],
    ["UPDATE variants SET unit_label=' ' WHERE id='v-1-1'", 'variant.unit'],
    ["UPDATE variants SET weight_grams=0 WHERE id='v-1-1'", 'variant.logistics'],
    ["UPDATE variants SET currency='USD' WHERE id='v-1-1'", 'variant.currency'],
    ["UPDATE variants SET legacy_id=NULL WHERE id='v-1-1'", 'variant.mapping'],
    ["UPDATE categories SET legacy_id=NULL WHERE id='c1'", 'category.mapping']
  ])('reuses Node rules and adds D1 mapping checks: %s', async (sql, code) => {
    sqlite.exec(sql)
    expect(await codes()).toContain(code)
  })
  it('matches Node issue order and generic messages rather than duplicate its rules', async () => {
    sqlite.exec(
      "UPDATE products SET name='ab',short_description=NULL,description=NULL WHERE id='p-1'; UPDATE variants SET mpn=NULL,price_gross_cents=0 WHERE id='v-1-1'"
    )
    const expected = catalogPublicationIssues({
      name: 'ab',
      shortDescription: null,
      description: null,
      categoryStatus: 'published',
      brandStatus: 'published',
      image: 'governed-main',
      imageAlt: 'Fotografía exacta del producto',
      imageRightsOwner: 'governed-rights',
      imageRightsLicense: 'governed-rights',
      imageAuthorizedAt: '2026-09-01',
      variants: [
        {
          sku: 'SKU-1-1',
          priceCents: 0,
          unitBase: 'unit',
          unitLabel: 'unidad',
          contentQuantity: 1,
          minimumQuantity: 2,
          quantityIncrement: 2,
          weightGrams: 1200,
          widthMm: 100,
          heightMm: 200,
          depthMm: 300,
          backorderAllowed: false
        }
      ]
    })
    expect((await readiness()).issues).toEqual(expected)
  })
  it('retains the real Node helper rejection of terminal LF instead of duplicating GTIN rules', async () => {
    const hostile = '4006381333931\n'
    expect(validGtin(hostile)).toBe(false)
    expect(validGtin(hostile.trim())).toBe(true)
    update("UPDATE variants SET ean=?,mpn=NULL WHERE id='v-1-1'", hostile)
    expect((await readiness()).issues).toContainEqual(
      expect.objectContaining({ code: 'variant.ean', path: 'variants.0.ean' })
    )
  })
  it('checks every non-discontinued variant including hidden/incomplete ones', async () => {
    sqlite.exec(`INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
      VALUES ('incomplete',12,'p-1','t21','sp1','SKU-INCOMPLETE','Incomplete','hidden',0)`)
    expect((await readiness()).issues).toContainEqual(
      expect.objectContaining({ code: 'variant.price', path: 'variants.1.price' })
    )
    sqlite.exec("UPDATE variants SET status='discontinued' WHERE id='incomplete'")
    expect(await codes()).toEqual([])
  })
  it('reports missing variants rather than hide the product', async () => {
    sqlite.exec("UPDATE variants SET status='discontinued' WHERE product_id='p-1'")
    expect(await codes()).toContain('variant.missing')
  })
  it('uses a bounded variant read and explicitly reports truncation', async () => {
    for (let n = 0; n < 501; n++)
      update(
        `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,
      price_gross_cents,mpn,weight_grams,width_mm,height_mm,depth_mm,backorder_allowed,lead_time_days)
      VALUES (?,?,'p-1','t21','sp1',?,'Fixture','draft',500,'MPN',1,1,1,1,1,1)`,
        `bounded-${n}`,
        1000 + n,
        `BOUNDED-${n}`
      )
    expect(await codes()).toContain('variant.limit')
  })
  it.each(['draft', 'review', 'hidden', 'discontinued'])('requires published category ancestry: %s', async (status) => {
    sqlite.exec(
      "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES ('parent',99,'Parent','parent','published'); UPDATE categories SET parent_id='parent' WHERE id='c1'"
    )
    update("UPDATE categories SET status=? WHERE id='parent'", status)
    expect(await codes()).toContain('category.status')
  })
  it('terminates ancestry cycles without delimiter-dependent ID matching', async () => {
    sqlite.exec(
      "INSERT INTO categories(id,legacy_id,parent_id,name,slug,status) VALUES ('odd,\"[]',99,'c1','Parent','parent','published'); UPDATE categories SET parent_id='odd,\"[]' WHERE id='c1'"
    )
    expect(await codes()).toContain('category.cycle')
  })
  it('blocks ancestry beyond the bounded traversal', async () => {
    let previous = 'c1'
    for (let n = 0; n < 130; n++) {
      update(
        "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES (?,?,'Parent',?,'published')",
        `parent-${n}`,
        100 + n,
        `parent-${n}`
      )
      update('UPDATE categories SET parent_id=? WHERE id=?', `parent-${n}`, previous)
      previous = `parent-${n}`
    }
    expect(await codes()).toContain('category.depth')
  })
  it.each([
    ['2026-09-30T10:00:00Z', null, false],
    ['2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.001Z', false],
    ['2026-09-30T10:00:00.001Z', null, true],
    ['2020-01-01T00:00:00Z', '2026-09-30T10:00:00Z', true],
    ['invalid', null, true]
  ] as const)('checks VAT inclusive start/exclusive end: %s / %s', async (from, to, blocked) => {
    update("UPDATE tax_classes SET valid_from=?,valid_until=?,rate_basis_points=0 WHERE id='t21'", from, to)
    expect((await codes()).includes('variant.tax')).toBe(blocked)
  })
  it('normalizes millisecond VAT/pricing instants while media remains eligible in that same second', async () => {
    sqlite.exec(
      "UPDATE tax_classes SET valid_from='2026-09-30T10:00:00.001Z',valid_until='2026-09-30T10:00:00.501Z' WHERE id='t21'"
    )
    expect((await readiness(database, '1', '2026-09-30T10:00:00.500Z')).issues).toEqual([])
  })
  it('uses the existing effective-price winner and cancellation/base fallback', async () => {
    sqlite.exec(`UPDATE variants SET price_gross_cents=0 WHERE id='v-1-1';
      INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,status,reason,created_at)
      VALUES ('price-now','v-1-1',700,'2026-09-30T10:00:00Z','approved','Synthetic tariff','2026-09-30T10:00:00Z')`)
    expect(await codes()).not.toContain('variant.price')
    sqlite.exec(`UPDATE variant_price_versions SET status='cancelled',cancelled_by='synthetic',cancelled_at='${NOW}',
      cancellation_reason='Synthetic cancellation' WHERE id='price-now'`)
    expect(await codes()).toContain('variant.price')
    sqlite.exec("UPDATE variants SET price_gross_cents=500 WHERE id='v-1-1'")
    expect(await codes()).not.toContain('variant.price')
  })
  it('does not accept a future governed price in place of the current price', async () => {
    sqlite.exec(`UPDATE variants SET price_gross_cents=0 WHERE id='v-1-1';
      INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,status,reason,created_at)
      VALUES ('price-future','v-1-1',700,'2026-09-30T10:00:01Z','approved','Synthetic tariff','2026-09-30T10:00:00Z')`)
    expect(await codes()).toContain('variant.price')
  })
  it('subtracts blocked/safety/reserved quantities and does not silently release overdue reservations', async () => {
    sqlite.exec(`UPDATE inventory_balances SET physical_quantity=10,blocked_quantity=2 WHERE variant_id='v-1-1';
      UPDATE variants SET safety_stock=3 WHERE id='v-1-1';
      INSERT INTO inventory_reservations(id,idempotency_key,payload_hash,status,correlation_id,expires_at,created_at,updated_at)
      VALUES ('reservation','reservation','${CHECKSUM}','reserved','synthetic','2026-09-30T09:00:00Z','2026-09-30T08:00:00Z','2026-09-30T08:00:00Z');
      INSERT INTO inventory_reservation_lines VALUES ('reservation','v-1-1','loc-main',4)`)
    expect(await codes()).toContain('variant.stock')
    sqlite.exec(
      "UPDATE inventory_reservations SET status='released',released_at='2026-09-30T10:00:00Z' WHERE id='reservation'"
    )
    expect(await codes()).not.toContain('variant.stock')
  })
  it.each([
    "DELETE FROM inventory_locations WHERE id='loc-main'",
    "UPDATE inventory_locations SET active=0 WHERE id='loc-main'",
    "UPDATE inventory_locations SET kind='store' WHERE id='loc-main'",
    "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES ('second','SECOND','Foreign','warehouse',1,'2026-09-30T10:00:00Z')"
  ])('fails closed on unknown warehouse scope: %s', async (sql) => {
    if (sql.startsWith('DELETE')) sqlite.exec('PRAGMA foreign_keys=OFF')
    sqlite.exec(sql)
    expect(await codes()).toContain('inventory.scope')
  })
  it('accepts explicit backorder with a known valid lead time, not missing time', async () => {
    sqlite.exec(
      "UPDATE inventory_balances SET physical_quantity=0 WHERE variant_id='v-1-1'; UPDATE variants SET backorder_allowed=1,lead_time_days=0 WHERE id='v-1-1'"
    )
    expect(await codes()).not.toContain('variant.stock')
    expect(await codes()).not.toContain('variant.lead_time')
    sqlite.exec("UPDATE variants SET lead_time_days=NULL WHERE id='v-1-1'")
    expect(await codes()).toContain('variant.lead_time')
  })

  it('does not use legacy rights declarations, generic images or other product mappings as the main image', async () => {
    const main = sqlite.prepare('SELECT id FROM product_media_publications').get()!
    update(
      `INSERT INTO product_media_publication_events(id,publication_id,event_type,reason,actor_id,created_at,idempotency_key,payload_hash)
      VALUES (?,?,'withdrawn','Synthetic withdrawal',?,?,?,?)`,
      testUuid(),
      String(main.id),
      IDENTITY,
      NOW,
      testUuid(),
      CHECKSUM
    )
    media({ role: 'image' })
    media({ product: 'p-2' })
    media({ variant: 'v-1-1' })
    expect(await codes()).toContain('media.primary')
  })
  it.each([
    ["UPDATE media_scan_receipts SET verdict='infected'", 'scan'],
    ["UPDATE media_scan_receipts SET scanned_at='2026-09-29T10:00:00Z',expires_at='2026-09-30T10:00:00Z'", 'scan'],
    ["UPDATE media_scan_receipts SET checksum='" + 'b'.repeat(64) + "'", 'scan'],
    ["UPDATE media_scan_receipts SET object_key='foreign-object'", 'scan'],
    ['UPDATE media_scan_receipts SET byte_size=101', 'scan'],
    ["UPDATE media_rights_decisions SET decision='rejected'", 'rights'],
    ["UPDATE product_media_publications SET valid_from='2026-09-30T10:00:01Z'", 'publication'],
    [
      "UPDATE product_media_publications SET valid_until='2026-09-30T10:00:01Z',valid_from='2026-09-29T10:00:00Z'",
      'publication'
    ]
  ])('retains the private attestation gate: %s', async (sql, table) => {
    // Deliberate corrupt historical evidence is not possible through APIs. Drop
    // only this ephemeral fixture's immutable update trigger to probe the read.
    sqlite.exec(
      `DROP TRIGGER ${table === 'scan' ? 'media_scan_receipts_no_update' : table === 'rights' ? 'media_rights_decisions_no_update' : 'product_media_publications_no_update'}`
    )
    sqlite.exec(sql)
    const result = await readiness(database, '1', table === 'publication' && sql.includes('valid_until') ? NEXT : NOW)
    expect(result.issues.map((issue) => issue.code)).toContain('media.primary')
  })
  it('invalidates a pinned mapping when a later scan or rights decision supersedes it', async () => {
    const original = sqlite.prepare('SELECT * FROM media_scan_receipts').get()!
    update(
      `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,
      scanned_at,expires_at,received_at,payload_hash) VALUES (?,?,?,?,100,'infected','Synthetic-not-antivirus',?,'2026-10-01T10:00:00Z',?,?)`,
      testUuid(),
      String(original.upload_id),
      CHECKSUM,
      String(original.object_key),
      NOW,
      NOW,
      CHECKSUM
    )
    expect(await codes()).toContain('media.primary')
  })
  it('invalidates even an approved pinned mapping when a later human rejection exists', async () => {
    const original = sqlite.prepare('SELECT * FROM media_rights_decisions').get()!
    const decision = testUuid()
    update(
      `INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,rights_owner,rights_license,
        created_at,idempotency_key,payload_hash) VALUES (?,?,'rejected','Synthetic rejection',?,
        'Private synthetic owner','Synthetic-only license',?,?,?)`,
      decision,
      String(original.upload_id),
      IDENTITY,
      NOW,
      decision,
      CHECKSUM
    )
    expect(await codes()).toContain('media.primary')
  })
  it('requires confirmed storage even when a mapping and clean scan exist', async () => {
    sqlite.exec('DROP TRIGGER media_uploads_receipt_immutable')
    sqlite.exec("UPDATE media_uploads SET storage_status='staging',stored_at=NULL,r2_etag=NULL")
    expect(await codes()).toContain('media.primary')
  })
  it('requires an SDS association with a document MIME and current evidence', async () => {
    sqlite.exec("UPDATE products SET regulatory='{\"requiresSds\":true}' WHERE id='p-1'")
    const fixture = media({ role: 'sds', mime: 'image/png' })
    expect(await codes()).toContain('regulatory.sds')
    sqlite.exec('DROP TRIGGER product_media_publications_no_update')
    update("UPDATE product_media_publications SET role='main' WHERE id=?", fixture.publication)
    media({ role: 'sds' })
    expect(await codes()).not.toContain('regulatory.sds')
  })
  it('cannot accept cross-product variant mappings even in corrupted historical rows', async () => {
    const fixture = media({ variant: 'v-1-1' })
    sqlite.exec('DROP TRIGGER product_media_publications_no_update')
    update('UPDATE product_media_publications SET variant_id=? WHERE id=?', 'v-2-1', fixture.publication)
    const result = await database.prepare(eligibleMediaEvidenceSql()).bind(NOW).all<{ id: string }>()
    expect(result.results.map((row) => row.id)).not.toContain(fixture.publication)
  })
  it.each(['[]', 'null', 'true', '"value"', '{"requiresSds":"true"}', '{"requiresSds":1}', '{"requiresSds":null}'])(
    'fails closed on invalid regulatory shape/applicability: %s',
    async (json) => {
      update("UPDATE products SET regulatory=? WHERE id='p-1'", json)
      expect((await codes()).some((code) => code.startsWith('regulatory.'))).toBe(true)
    }
  )
  it.each(['{}', '{"requiresSds":false}', '{"__proto__":{"requiresSds":true},"unknown":"preserved"}'])(
    'does not invent an SDS requirement: %s',
    async (json) => {
      update("UPDATE products SET regulatory=? WHERE id='p-1'", json)
      expect(await codes()).not.toContain('regulatory.sds')
    }
  )
  it('requires a current exact-product SDS only for explicit true applicability', async () => {
    sqlite.exec("UPDATE products SET regulatory='{\"requiresSds\":true}' WHERE id='p-1'")
    expect(await codes()).toContain('regulatory.sds')
    media({ role: 'sds', product: 'p-2' })
    expect(await codes()).toContain('regulatory.sds')
    media({ role: 'sds' })
    expect(await codes()).not.toContain('regulatory.sds')
  })
})
