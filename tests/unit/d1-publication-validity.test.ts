import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  assertCurrentPublicationValidity,
  publicationValidityExpression,
  publicationValidityWithClock
} from '../../workers/catalog/publication-validity'
import { eligibleMediaEvidenceSql } from '../../workers/media/evidence-sql'
import { eligibleMediaPublicationSql } from '../../workers/media/governance'
import { readPublicProductMedia } from '../../workers/media/public-catalog'
import { listPublishedProducts } from '../../workers/catalog/products'
import { getPublishedProductDetail } from '../../workers/catalog/product-detail'
import { searchPublishedProducts } from '../../workers/catalog/search'
import { handleD1SeoRequest } from '../../workers/catalog/seo-http'
import { publicationDependencySnapshotSql } from '../../workers/catalog/catalog-publication-gate'
import { updateD1ProductStatus, type CatalogPublicationGate } from '../../workers/catalog/admin-catalog-status'
import { validGtin } from '../../server/domain/catalog-publication'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testUuid } from '../support/deterministic'

const NOW = '2026-09-30T10:00:00Z',
  NEXT = '2026-09-30T10:00:01Z',
  FUTURE = '2099-01-01T00:00:00Z'
const ACTOR = '70000000-0000-4000-8000-000000000038',
  CHECKSUM = 'f'.repeat(64)
const REASON = 'Synthetic local evidence, not legal or antivirus approval'

describe('current D1 publication governing evidence', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    // Match the expression-depth ceiling reproduced in local workerd D1;
    // node:sqlite otherwise accepts much deeper queries and hid this failure.
    sqlite.limits.exprDepth = 100
  })
  afterEach(() => sqlite.close())
  function eligible(now = NOW, productId = 'p-1') {
    return sqlite
      .prepare(`SELECT ${publicationValidityExpression('p', '?1')} AS valid FROM products p WHERE id=?2`)
      .get(now, productId)?.valid
  }
  function provision(options: Omit<Parameters<typeof provisionPublicationValidityFixture>[1], 'productIds'> = {}) {
    return provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: NOW, ...options })
  }
  function withdrawPolicy(id: string) {
    sqlite
      .prepare(
        `INSERT INTO catalog_publication_policy_withdrawals(id,policy_id,actor_id,reason,created_at) VALUES (?,?,?,?,?)`
      )
      .run(testUuid(), id, ACTOR, REASON, NOW)
  }
  function withdrawMedia(id: string) {
    const eventId = testUuid()
    sqlite
      .prepare(
        `INSERT INTO product_media_publication_events(id,publication_id,event_type,reason,actor_id,created_at,idempotency_key,payload_hash)
      VALUES (?,?,'withdrawn',?,?,?,?,?)`
      )
      .run(eventId, id, REASON, ACTOR, NOW, eventId, CHECKSUM)
  }
  // D1-only synthetic attestations, not stored originals or authentic scans.
  function media(
    options: {
      role?: 'main' | 'sds' | 'datasheet' | 'certificate' | 'label'
      variantId?: string | null
      alt?: string
      validFrom?: string
      validUntil?: string | null
      scanUntil?: string
      storedAt?: string
    } = {}
  ) {
    const id = testUuid(),
      uploadId = testUuid(),
      scanId = testUuid(),
      rightsId = testUuid()
    const role = options.role ?? 'main',
      image = role === 'main' || role === 'label',
      key = `quarantine/${uploadId}/${CHECKSUM}`
    sqlite
      .prepare(
        `INSERT INTO media_uploads(id,actor_id,idempotency_key,payload_hash,checksum,object_key,filename,content_type,byte_size,width,height,
      alt,rights_owner,rights_license,rights_source,storage_status,r2_etag,created_at,stored_at)
      VALUES (?,?,?,?,?,?,'synthetic-validity',?,33,?,?,?,'Synthetic owner','Synthetic license','Synthetic reference','quarantined',?,?,?)`
      )
      .run(
        uploadId,
        ACTOR,
        uploadId,
        CHECKSUM,
        CHECKSUM,
        key,
        image ? 'image/png' : 'application/pdf',
        image ? 800 : null,
        image ? 600 : null,
        options.alt ?? 'Synthetic exact image',
        CHECKSUM,
        NOW,
        options.storedAt ?? NOW
      )
    sqlite
      .prepare(
        `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,scanned_at,expires_at,received_at,payload_hash)
      VALUES (?,?,?,?,33,'clean','Synthetic-not-antivirus',?,?,?,?)`
      )
      .run(scanId, uploadId, CHECKSUM, key, NOW, options.scanUntil ?? FUTURE, NOW, CHECKSUM)
    sqlite
      .prepare(
        `INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,evidence_authorized_at,evidence_reference,rights_owner,
      rights_license,created_at,idempotency_key,payload_hash) VALUES (?,?,'approved',?,?,?,'Synthetic reference','Synthetic owner','Synthetic license',?,?,?)`
      )
      .run(rightsId, uploadId, REASON, ACTOR, NOW.slice(0, 10), NOW, rightsId, CHECKSUM)
    sqlite
      .prepare(
        `INSERT INTO product_media_publications(id,product_id,variant_id,upload_id,role,title,alt,language,version,valid_from,valid_until,
      scan_receipt_id,rights_decision_id,actor_id,created_at,idempotency_key,payload_hash)
      VALUES (?,'p-1',?,?,?,'Synthetic selected media',?,'es','synthetic-v1',?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        options.variantId ?? null,
        uploadId,
        role,
        options.alt ?? 'Synthetic exact image',
        options.validFrom ?? NOW,
        options.validUntil ?? null,
        scanId,
        rightsId,
        ACTOR,
        NOW,
        id,
        CHECKSUM
      )
    return { id, uploadId, scanId, rightsId, key }
  }
  function exception(
    options: { validFrom?: string; validUntil?: string | null; reason?: string; reference?: string } = {}
  ) {
    const id = testUuid()
    sqlite
      .prepare(
        `INSERT INTO catalog_variant_identifier_exceptions(id,variant_id,actor_id,reason,evidence_reference,valid_from,valid_until,created_at)
      VALUES (?,'v-1-1',?,?,?,?,?,?)`
      )
      .run(
        id,
        ACTOR,
        options.reason ?? REASON,
        options.reference ?? 'Synthetic reference',
        options.validFrom ?? NOW,
        options.validUntil ?? null,
        NOW
      )
    return id
  }
  function afterMedia(onRead: () => void): D1Database {
    let changed = false
    return new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            const original = target.prepare(sql)
            if (!sql.includes('ORDER BY CASE role')) return original
            const guard = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(inner, property, innerReceiver) {
                  if (property === 'bind') return (...args: unknown[]) => guard(inner.bind(...args))
                  if (property === 'all')
                    return async <T>() => {
                      const result = await inner.all<T>()
                      if (!changed) {
                        onRead()
                        changed = true
                      }
                      return result
                    }
                  const value: unknown = Reflect.get(inner, property, innerReceiver)
                  return typeof value === 'function' ? value.bind(inner) : value
                }
              })
            return guard(original)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  it('has no published-state exemption for absent policy', () => expect(eligible()).toBe(0))
  it.each(['draft', 'review', 'published', 'hidden', 'discontinued'])(
    'governance is independent of editorial state %s',
    async (status) => {
      await provision()
      sqlite.prepare("UPDATE products SET status=? WHERE id='p-1'").run(status)
      expect(eligible()).toBe(1)
    }
  )
  it('only explicit selected products gain synthetic governance', async () => {
    await provision()
    expect(eligible()).toBe(1)
    expect(eligible(NOW, 'p-2')).toBe(0)
  })
  it('validity is not an object-existence, stock or frozen-price assertion', async () => {
    await provision()
    sqlite.exec(
      "UPDATE inventory_balances SET physical_quantity=0 WHERE variant_id='v-1-1'; UPDATE variants SET price_gross_cents=777 WHERE id='v-1-1'"
    )
    expect(eligible()).toBe(1)
  })
  it('policy windows are half-open', async () => {
    await provision({ validUntil: NEXT })
    expect(eligible('2026-09-30T09:59:59Z')).toBe(0)
    expect(eligible()).toBe(1)
    expect(eligible(NEXT)).toBe(0)
  })
  it('withdrawal invalidates a still-published product', async () => {
    const fixture = await provision()
    withdrawPolicy(fixture.policyId)
    expect(eligible()).toBe(0)
    expect(sqlite.prepare("SELECT status FROM products WHERE id='p-1'").get()?.status).toBe('published')
  })
  it('does not fall back from the latest unavailable assignment', async () => {
    await provision()
    const fixture = await provision({ validUntil: NEXT })
    expect(eligible(NEXT)).toBe(0)
    withdrawPolicy(fixture.policyId)
    expect(eligible()).toBe(0)
  })
  it.each([
    'null',
    '[]',
    'true',
    '"classification"',
    '{}',
    '{"productType":"wrong","requiresSds":false}',
    '{"productType":"local_fixture"}',
    '{"productType":"local_fixture","requiresSds":null}',
    '{"productType":"local_fixture","requiresSds":"false"}',
    '{"productType":"local_fixture","requiresSds":0}'
  ])('classification fails closed for %s', async (raw) => {
    await provision()
    sqlite.prepare("UPDATE products SET regulatory=? WHERE id='p-1'").run(raw)
    expect(eligible()).toBe(0)
  })
  it('imageRights attributes are not governed approval', async () => {
    await provision({ media: false })
    sqlite.exec(
      `UPDATE products SET attributes='{"imageRights":{"owner":"fake","license":"fake","authorizedAt":"2020-01-01"}}' WHERE id='p-1'`
    )
    expect(eligible()).toBe(0)
    media()
    expect(eligible()).toBe(1)
  })
  it.each([
    'usage',
    'series',
    'regulatory.manufacturer',
    'regulatory.safetyInstructions',
    'regulatory.hazardStatements',
    'regulatory.precautionaryStatements'
  ] as const)('policy-required %s is evaluated on current data', async (field) => {
    await provision({ requiredFields: [field] })
    expect(eligible()).toBe(0)
    if (field.startsWith('regulatory.'))
      sqlite
        .prepare("UPDATE products SET regulatory=json_set(regulatory,?,?) WHERE id='p-1'")
        .run(`$.${field.slice(11)}`, 'Synthetic required content')
    else sqlite.prepare(`UPDATE products SET ${field}=? WHERE id='p-1'`).run('Synthetic required content')
    expect(eligible()).toBe(1)
  })
  it.each([' ', '\t\n\r', '\u00a0', '\u2002\u2003', '\ufeff', '\u2028\u2029'])(
    'required text rejects JS-trim whitespace %j',
    async (value) => {
      await provision({ requiredFields: ['usage', 'regulatory.manufacturer'] })
      sqlite
        .prepare("UPDATE products SET usage=?,regulatory=json_set(regulatory,'$.manufacturer',?) WHERE id='p-1'")
        .run(value, value)
      expect(eligible()).toBe(0)
    }
  )
  it.each(['hidden', 'draft'])('unpublished category ancestors block %s', async (status) => {
    await provision()
    sqlite
      .prepare("INSERT INTO categories(id,legacy_id,name,slug,status) VALUES ('ancestor',77,'Ancestor','ancestor',?)")
      .run(status)
    sqlite.exec("UPDATE categories SET parent_id='ancestor' WHERE id='c1'")
    expect(eligible()).toBe(0)
  })
  it('category cycles fail closed', async () => {
    await provision()
    sqlite.exec("UPDATE categories SET parent_id='c1' WHERE id='c1'")
    expect(eligible()).toBe(0)
  })
  it('missing safe category mappings fail closed', async () => {
    await provision()
    sqlite.exec("UPDATE categories SET legacy_id=NULL WHERE id='c1'")
    expect(eligible()).toBe(0)
  })
  it('archived brands cannot remain valid', async () => {
    await provision()
    sqlite.exec("UPDATE brands SET status='archived' WHERE id='b1'")
    expect(eligible()).toBe(0)
  })
  it.each([
    '96385074',
    '036000291452',
    '4006381333931',
    '10012345000017',
    '12345670',
    '12345678',
    'bad',
    '4006381333932',
    '4006381333931\n'
  ])('EAN checksum has parity with domain validGtin: %j', async (value) => {
    await provision()
    sqlite.prepare("UPDATE variants SET ean=? WHERE id='v-1-1'").run(value)
    expect(eligible()).toBe(validGtin(value) ? 1 : 0)
  })
  it('invalid GTIN cannot be excused by a valid MPN', async () => {
    await provision()
    sqlite.exec("UPDATE variants SET gtin='4006381333932',mpn='SYNTHETIC-MPN' WHERE id='v-1-1'")
    expect(eligible()).toBe(0)
  })
  it('balanced fixed checksum retains domain parity for every supported length and leading digits', async () => {
    await provision()
    const update = sqlite.prepare("UPDATE variants SET ean=? WHERE id='v-1-1'")
    for (const length of [8, 12, 13, 14]) {
      for (let seed = 0; seed < 10; seed++) {
        const body = Array.from({ length: length - 1 }, (_, i) => `${(i + seed) % 10}`).join('')
        const valid = Array.from({ length: 10 }, (_, check) => `${body}${check}`).find(validGtin)!
        const invalid = `${body}${(Number(valid.at(-1)) + 1) % 10}`
        for (const value of [valid, invalid]) {
          update.run(value)
          expect(eligible(), value).toBe(validGtin(value) ? 1 : 0)
        }
      }
    }
  })
  it.each(['', ' ', '\t\n', '\u00a0', '\ufeff'])('whitespace-only MPN is absent: %j', async (value) => {
    await provision()
    sqlite.prepare("UPDATE variants SET ean=NULL,gtin=NULL,mpn=? WHERE id='v-1-1'").run(value)
    expect(eligible()).toBe(0)
  })
  it('only policy-permitted current exceptions supply identifiers', async () => {
    await provision({ identifierExceptionsAllowed: true })
    sqlite.exec("UPDATE variants SET ean=NULL,gtin=NULL,mpn=NULL WHERE id='v-1-1'")
    exception({ validUntil: NEXT })
    expect(eligible()).toBe(1)
    expect(eligible(NEXT)).toBe(0)
  })
  it('exceptions do not override a forbidding policy', async () => {
    await provision()
    sqlite.exec("UPDATE variants SET ean=NULL,gtin=NULL,mpn=NULL WHERE id='v-1-1'")
    exception()
    expect(eligible()).toBe(0)
  })
  it('withdrawn exception history is preserved but not governing', async () => {
    await provision({ identifierExceptionsAllowed: true })
    sqlite.exec("UPDATE variants SET ean=NULL,gtin=NULL,mpn=NULL WHERE id='v-1-1'")
    const id = exception()
    sqlite
      .prepare(
        'INSERT INTO catalog_variant_identifier_exception_withdrawals(id,exception_id,actor_id,reason,created_at) VALUES (?,?,?,?,?)'
      )
      .run(testUuid(), id, ACTOR, REASON, NOW)
    expect(eligible()).toBe(0)
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_variant_identifier_exceptions').get()?.total).toBe(1)
  })
  it('latest whitespace-only exception evidence cannot fall back', async () => {
    await provision({ identifierExceptionsAllowed: true })
    sqlite.exec("UPDATE variants SET ean=NULL,gtin=NULL,mpn=NULL WHERE id='v-1-1'")
    exception()
    exception({ validFrom: NEXT, reason: '\n'.repeat(10), reference: '\n'.repeat(3) })
    expect(eligible(NEXT)).toBe(0)
  })
  it('zero IVA is valid and millisecond expiry is half-open', async () => {
    await provision()
    sqlite.exec("UPDATE tax_classes SET rate_basis_points=0,valid_until='2026-09-30T10:00:00.500Z' WHERE id='t21'")
    expect(eligible('2026-09-30T10:00:00.499Z')).toBe(1)
    expect(eligible('2026-09-30T10:00:00.500Z')).toBe(0)
  })
  it('a missing tax association blocks', async () => {
    await provision()
    sqlite.exec(
      "PRAGMA foreign_keys=OFF; UPDATE variants SET tax_class_id='missing-tax' WHERE id='v-1-1'; PRAGMA foreign_keys=ON"
    )
    expect(eligible()).toBe(0)
  })
  it('incomplete non-discontinued variants cannot be hidden from governance', async () => {
    await provision()
    sqlite.exec(
      "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents) VALUES ('extra',888,'p-1','t21','sp1','SYNTHETIC-EXTRA','Synthetic','draft',500)"
    )
    expect(eligible()).toBe(0)
    sqlite.exec("UPDATE variants SET status='discontinued' WHERE id='extra'")
    expect(eligible()).toBe(1)
  })
  it('requires at least one non-discontinued variant', async () => {
    await provision()
    sqlite.exec("UPDATE variants SET status='discontinued' WHERE product_id='p-1'")
    expect(eligible()).toBe(0)
  })
  it('SDS follows explicit true, not an implicit regulatory default', async () => {
    await provision()
    expect(eligible()).toBe(1)
    sqlite.exec("UPDATE products SET regulatory=json_set(regulatory,'$.requiresSds',json('true')) WHERE id='p-1'")
    expect(eligible()).toBe(0)
    media({ role: 'sds' })
    expect(eligible()).toBe(1)
  })
  it.each(['datasheet', 'sds', 'certificate', 'label'] as const)(
    'required document %s needs exact current evidence',
    async (role) => {
      await provision({ requiredMediaRoles: [role] })
      expect(eligible()).toBe(0)
      const document = media({ role })
      expect(eligible()).toBe(1)
      withdrawMedia(document.id)
      expect(eligible()).toBe(0)
    }
  )
  it('per-variant documents must cover every non-discontinued variant', async () => {
    await provision({ requiredMediaRoles: ['sds'] })
    media({ role: 'sds', variantId: 'v-1-1' })
    expect(eligible()).toBe(1)
    sqlite.exec(
      "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,mpn,price_gross_cents) VALUES ('extra',888,'p-1','t21','sp1','SYNTHETIC-EXTRA','Synthetic','review','SYNTHETIC-MPN',500)"
    )
    expect(eligible()).toBe(0)
    media({ role: 'sds', variantId: 'extra' })
    expect(eligible()).toBe(1)
  })
  it('variant main does not replace the product exact main', async () => {
    await provision({ media: false })
    media({ variantId: 'v-1-1' })
    expect(eligible()).toBe(0)
  })
  it.each(['abc', '\n\n\n\n\n', '\u00a0\u00a0\u00a0\u00a0\u00a0', '  x  '])(
    'main alt must be useful: %j',
    async (alt) => {
      await provision({ media: false })
      media({ alt })
      expect(eligible()).toBe(0)
    }
  )
  it('main publication and confirmed storage windows remain authoritative', async () => {
    await provision({ media: false })
    media({ validFrom: NEXT, validUntil: '2026-09-30T10:00:02Z', storedAt: NEXT })
    expect(eligible()).toBe(0)
    expect(eligible(NEXT)).toBe(1)
    expect(eligible('2026-09-30T10:00:02Z')).toBe(0)
  })
  it('scan expiry independently invalidates an otherwise current publication', async () => {
    await provision({ media: false })
    media({ scanUntil: NEXT })
    expect(eligible()).toBe(1)
    expect(eligible(NEXT)).toBe(0)
  })
  it('main withdrawal invalidates metadata and retained URL eligibility', async () => {
    const fixture = await provision(),
      main = fixture.mainPublications.get('p-1')!
    withdrawMedia(main.id)
    expect(eligible()).toBe(0)
    expect(
      sqlite.prepare(`SELECT id FROM (${eligibleMediaPublicationSql('?1')}) WHERE id=?2`).all(NOW, main.id)
    ).toEqual([])
  })
  it('production ignores captured binding time for an expired optional publication', async () => {
    const fixture = await provision(),
      main = fixture.mainPublications.get('p-1')!,
      imageId = testUuid()
    sqlite
      .prepare(
        `INSERT INTO product_media_publications(id,product_id,variant_id,upload_id,role,title,alt,language,version,valid_from,valid_until,
      scan_receipt_id,rights_decision_id,actor_id,created_at,idempotency_key,payload_hash)
      SELECT ?,product_id,'v-1-1',upload_id,'image',title,alt,language,version,valid_from,?,
        scan_receipt_id,rights_decision_id,actor_id,created_at,?,payload_hash FROM product_media_publications WHERE id=?`
      )
      .run(imageId, NEXT, imageId, main.id)
    expect(eligible()).toBe(1)
    expect(sqlite.prepare(`SELECT id FROM (${eligibleMediaPublicationSql()}) WHERE id=?2`).all(NOW, imageId)).toEqual(
      []
    )
    expect(
      sqlite.prepare(`SELECT id FROM (${eligibleMediaPublicationSql('?1')}) WHERE id=?2`).all(NOW, imageId)
    ).toHaveLength(1)
    expect((await readPublicProductMedia(database, ['p-1'])).get('p-1')?.variants.has('v-1-1')).toBe(false)
    expect((await readPublicProductMedia(database, ['p-1'], NOW)).get('p-1')?.variants.has('v-1-1')).toBe(true)
  })
  it.each(['clean', 'infected'] as const)(
    'newest %s scan cannot leave an old pinned receipt current',
    async (verdict) => {
      const fixture = await provision(),
        main = fixture.mainPublications.get('p-1')!
      sqlite
        .prepare(
          `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,scanned_at,expires_at,received_at,payload_hash)
      SELECT ?,upload_id,checksum,object_key,byte_size,?,'Synthetic latest receipt',scanned_at,expires_at,received_at,payload_hash
      FROM media_scan_receipts WHERE id=?`
        )
        .run(testUuid(), verdict, main.scanId)
      expect(eligible()).toBe(0)
    }
  )
  it.each(['approved', 'rejected'] as const)(
    'newest %s rights invalidate the old pinned publication',
    async (decision) => {
      const fixture = await provision(),
        main = fixture.mainPublications.get('p-1')!,
        id = testUuid()
      sqlite
        .prepare(
          `INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,evidence_authorized_at,evidence_reference,rights_owner,rights_license,created_at,idempotency_key,payload_hash)
      SELECT ?,upload_id,?,reason,actor_id,evidence_authorized_at,evidence_reference,rights_owner,rights_license,created_at,?,payload_hash
      FROM media_rights_decisions WHERE id=?`
        )
        .run(id, decision, id, main.rightsId)
      expect(eligible()).toBe(0)
    }
  )
  it('private draft evidence is reusable but public wrapper never exposes drafts', async () => {
    const fixture = await provision(),
      id = fixture.mainPublications.get('p-1')!.id
    sqlite.exec("UPDATE products SET status='draft' WHERE id='p-1'")
    expect(sqlite.prepare(`SELECT id FROM (${eligibleMediaEvidenceSql()}) WHERE id=?2`).all(NOW, id)).toHaveLength(1)
    expect(sqlite.prepare(`SELECT id FROM (${eligibleMediaPublicationSql('?1')}) WHERE id=?2`).all(NOW, id)).toEqual([])
  })
  it.each(['p; DROP TABLE products', 'p.id', 'p\n', 'p\0', '', 'a'.repeat(65)])(
    'rejects unsafe SQL alias %j',
    (alias) => {
      expect(() => publicationValidityExpression(alias)).toThrow('invalid_publication_product_alias')
    }
  )
  it.each([
    "'2026-01-01'",
    '?0',
    '?101',
    '?1\n',
    "COALESCE(?1,'now');SELECT 1",
    '(SELECT now FROM user_clock)',
    'now',
    ''
  ])('rejects unsafe clock SQL %j', (clock) =>
    expect(() => publicationValidityExpression('p', clock)).toThrow('invalid_publication_clock_sql')
  )
  it('clock validation never coerces objects', () => {
    let touched = false
    const input: unknown = {
      toString() {
        touched = true
        return '?1'
      }
    }
    expect(() => Reflect.apply(publicationValidityExpression, undefined, ['p', input])).toThrow(
      'invalid_publication_clock_sql'
    )
    expect(touched).toBe(false)
  })
  it('test-clock fragments bind each repeated clock without injecting SQL', async () => {
    await provision()
    const fragment = publicationValidityWithClock('p', NOW)
    expect(fragment.parameters).toHaveLength(2)
    expect(fragment.sql).not.toContain('?1')
    expect(
      sqlite.prepare(`SELECT ${fragment.sql} AS valid FROM products p WHERE id='p-1'`).get(...fragment.parameters)
        ?.valid
    ).toBe(1)
    expect(publicationValidityWithClock('p').parameters).toEqual([])
    expect(() => publicationValidityWithClock('p', "2026-01-01';SELECT 1")).toThrow()
  })
  it('invalid internal clock fails closed', async () => {
    await provision()
    expect(eligible('invalid-clock')).toBe(0)
  })
  it('final authority checks policy and bounded inputs', async () => {
    const fixture = await provision()
    await expect(assertCurrentPublicationValidity(database, ['p-1', 'p-1'], NOW)).resolves.toBeUndefined()
    withdrawPolicy(fixture.policyId)
    await expect(assertCurrentPublicationValidity(database, ['p-1'], NOW)).rejects.toThrow(
      'publication_validity_changed'
    )
    await expect(assertCurrentPublicationValidity(database, ['p-1\n'], NOW)).rejects.toThrow(
      'invalid_publication_validity_ids'
    )
    await expect(
      assertCurrentPublicationValidity(
        database,
        Array.from({ length: 1001 }, (_, i) => `product-${i}`),
        NOW
      )
    ).rejects.toThrow('invalid_publication_validity_ids')
  })
  it('list/count/facets, detail and search suppress missing-policy seeded products', async () => {
    const list = await listPublishedProducts(database, { page: 1, limit: 20, sort: 'default', facets: true })
    expect(list?.items).toEqual([])
    expect(list?.total).toBe(0)
    expect(await getPublishedProductDetail(database, 'producto-1')).toBeNull()
    expect((await searchPublishedProducts(database, 'Producto')).items).toEqual([])
  })
  it('depth-100 positive list/facets/PDP/search/media and final guards preserve authority after withdrawal', async () => {
    const fixture = await provision()
    expect(sqlite.limits.exprDepth).toBe(100)
    const list = await listPublishedProducts(database, { page: 1, limit: 24, sort: 'default', facets: true })
    expect(list?.items).toHaveLength(1)
    expect(list?.total).toBe(1)
    expect(await getPublishedProductDetail(database, 'producto-1')).not.toBeNull()
    expect((await searchPublishedProducts(database, 'Producto')).items).toHaveLength(1)
    expect((await readPublicProductMedia(database, ['p-1'])).get('p-1')?.image).toBeDefined()
    withdrawPolicy(fixture.policyId)
    expect((await listPublishedProducts(database, { page: 1, limit: 24, sort: 'default', facets: true }))?.total).toBe(
      0
    )
    expect(await getPublishedProductDetail(database, 'producto-1')).toBeNull()
    expect((await searchPublishedProducts(database, 'Producto')).items).toEqual([])
    expect((await readPublicProductMedia(database, ['p-1'])).get('p-1')?.image).toBeUndefined()
  })
  it('depth-100 authoritative gate snapshot/read/condition execute without bypassing governing evidence', async () => {
    const fixture = await provision()
    const snapshotSql = publicationDependencySnapshotSql(1, 2)
    const row = sqlite
      .prepare(
        `SELECT ${snapshotSql} AS snapshot,${publicationValidityExpression('p', "COALESCE(?1,'now')")} AS valid
        FROM products p WHERE p.id=?2`
      )
      .get(NOW, 'p-1')
    expect(row?.valid).toBe(1)
    expect(typeof row?.snapshot).toBe('string')
    const guard = sqlite.prepare(`SELECT (${snapshotSql}=?3 AND EXISTS(SELECT 1 FROM products fresh WHERE fresh.id=?2
      AND ${publicationValidityExpression('fresh', "COALESCE(?1,'now')")})) AS valid`)
    expect(guard.get(NOW, 'p-1', row!.snapshot)?.valid).toBe(1)
    withdrawPolicy(fixture.policyId)
    expect(guard.get(NOW, 'p-1', row!.snapshot)?.valid).toBe(0)
  })
  it('depth-100 real status batch envelopes preserve exact replay and roll back a new withdrawn-policy publication', async () => {
    const fixture = await provision(),
      sessionId = '71000000-0000-4000-8000-000000000038',
      claims = { identityId: ACTOR, sessionId, sessionVersion: 1 }
    sqlite.exec(`INSERT INTO roles VALUES ('validity_depth_editor','Synthetic editor','Depth-only local fixture');
      INSERT OR IGNORE INTO permissions VALUES ('catalog.publish','catalog','publish','Synthetic test only');
      INSERT INTO role_permissions VALUES ('validity_depth_editor','catalog.publish');
      UPDATE products SET status='review' WHERE id='p-1'`)
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'validity_depth_editor',?)")
      .run(ACTOR, NOW)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(sessionId, ACTOR, NOW, FUTURE)
    // This test hook exercises the real gate's exact SQL envelopes only. The
    // synthetic D1 evidence does not prove R2 bytes, a scanner or legal rights.
    const gate: CatalogPublicationGate = {
      async prepare(db, product) {
        const row = await db
          .prepare(`SELECT ${publicationDependencySnapshotSql(1, 2)} AS snapshot`)
          .bind(null, product.productUuid)
          .first<{ snapshot: string }>()
        if (!row) throw new Error('missing_depth_snapshot')
        return {
          fingerprint: CHECKSUM,
          condition(offset) {
            return {
              sql: `${publicationDependencySnapshotSql(offset + 1, offset + 2)}=?${offset + 3}
                AND EXISTS(SELECT 1 FROM products fresh WHERE fresh.id=?${offset + 2}
                  AND ${publicationValidityExpression('fresh', `COALESCE(?${offset + 1},'now')`)})`,
              parameters: [null, product.productUuid, row.snapshot]
            }
          }
        }
      }
    }
    const version = Number(sqlite.prepare("SELECT catalog_version FROM products WHERE id='p-1'").get()?.catalog_version)
    const body = { status: 'published', expectedVersion: version, reason: REASON }
    const options = { idempotencyKey: 'synthetic-depth-publication', publicationGate: gate }
    const receipt = await updateD1ProductStatus(database, claims, '1', body, options)
    expect(receipt.status).toBe('published')
    withdrawPolicy(fixture.policyId)
    expect(await updateD1ProductStatus(database, claims, '1', body, options)).toEqual(receipt)
    const hidden = await updateD1ProductStatus(
      database,
      claims,
      '1',
      { status: 'hidden', expectedVersion: receipt.catalogVersion, reason: REASON },
      { idempotencyKey: 'synthetic-depth-hide' }
    )
    const commands = sqlite.prepare('SELECT count(*) AS count FROM catalog_product_status_commands').get()?.count
    await expect(
      updateD1ProductStatus(
        database,
        claims,
        '1',
        { status: 'published', expectedVersion: hidden.catalogVersion, reason: REASON },
        { idempotencyKey: 'synthetic-depth-republication', publicationGate: gate }
      )
    ).rejects.toMatchObject({ code: 'publication_blocked' })
    expect(sqlite.prepare('SELECT count(*) AS count FROM catalog_product_status_commands').get()?.count).toBe(commands)
    expect(sqlite.prepare("SELECT status,catalog_version FROM products WHERE id='p-1'").get()).toMatchObject({
      status: 'hidden',
      catalog_version: hidden.catalogVersion
    })
  })
  it('dynamic product sitemap emits only current products and is not cached', async () => {
    const fixture = await provision(),
      deps = { database, origin: 'https://neteco.example.com', environment: 'production' as const }
    const first = await handleD1SeoRequest(new Request('https://neteco.example.com/sitemaps/products.xml'), deps)
    expect(first?.status).toBe(200)
    expect(first?.headers.get('cache-control')).toBe('private, no-store')
    expect(first?.headers.get('cdn-cache-control')).toBe('no-store')
    expect(await first?.text()).toContain('/producto/producto-1')
    withdrawPolicy(fixture.policyId)
    const second = await handleD1SeoRequest(new Request('https://neteco.example.com/sitemaps/products.xml'), deps)
    expect(second?.status).toBe(200)
    expect(await second?.text()).not.toContain('/producto/producto-1')
  })
  it.each(['before', 'after'] as const)(
    'keeps list/count/media/facets coherent for policy withdrawal %s its atomic snapshot',
    async (phase) => {
      const fixture = await provision()
      const query = { page: 1, limit: 20, sort: 'default' as const, facets: true }
      const baseline = await listPublishedProducts(database, query)
      expect(baseline?.total).toBe(1)
      expect(baseline?.items[0]?.image).toMatch(/^\/media\//)
      expect(baseline?.facets?.brands).toEqual([{ value: 'NETECO', n: 1 }])
      let changed = false
      const guarded = new Proxy(database, {
        get(target, key, receiver) {
          if (key === 'batch')
            return async <T>(statements: D1PreparedStatement[]) => {
              expect(changed).toBe(false)
              if (phase === 'before') withdrawPolicy(fixture.policyId)
              const result = await target.batch<T>(statements)
              if (phase === 'after') withdrawPolicy(fixture.policyId)
              changed = true
              return result
            }
          const value: unknown = Reflect.get(target, key, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      const result = await listPublishedProducts(guarded, query)
      expect(changed).toBe(true)
      if (phase === 'after') expect(result).toEqual(baseline)
      else {
        expect(result?.items).toEqual([])
        expect(result?.total).toBe(0)
        expect(result?.facets).toEqual({
          brands: [],
          categories: [],
          envases: [],
          capacidades: [],
          tallas: [],
          colores: [],
          medidas: [],
          acabados: [],
          badges: [],
          inStock: 0,
          price: null,
          typed: []
        })
      }
      // A response may represent the completed snapshot, never persistent cache:
      // the next read must reflect the withdrawal for every projection.
      const fresh = await listPublishedProducts(database, query)
      expect(fresh?.items).toEqual([])
      expect(fresh?.total).toBe(0)
      expect(fresh?.facets?.brands).toEqual([])
      expect(fresh?.facets?.inStock).toBe(0)
      expect(eligible()).toBe(0)
    }
  )

  it.each(['detail', 'search'] as const)('late policy withdrawal cannot leave a stale %s DTO', async (consumer) => {
    const fixture = await provision(),
      guarded = afterMedia(() => withdrawPolicy(fixture.policyId))
    const read =
      consumer === 'detail'
        ? getPublishedProductDetail(guarded, 'producto-1')
        : searchPublishedProducts(guarded, 'Producto')
    await expect(read).rejects.toThrow('publication_validity_changed')
  })
  it('PDP cannot return a variant hidden during media await', async () => {
    await provision()
    const guarded = afterMedia(() => sqlite.exec("UPDATE variants SET status='hidden' WHERE id='v-1-1'"))
    await expect(getPublishedProductDetail(guarded, 'producto-1')).rejects.toThrow('publication_validity_changed')
    expect(eligible()).toBe(1)
  })
  it('PDP cannot return a withdrawn optional variant image while main remains valid', async () => {
    const fixture = await provision(),
      main = fixture.mainPublications.get('p-1')!,
      imageId = testUuid()
    sqlite
      .prepare(
        `INSERT INTO product_media_publications(id,product_id,variant_id,upload_id,role,title,alt,language,version,valid_from,valid_until,
      scan_receipt_id,rights_decision_id,actor_id,created_at,idempotency_key,payload_hash)
      SELECT ?,product_id,'v-1-1',upload_id,'image',title,alt,language,version,valid_from,valid_until,
        scan_receipt_id,rights_decision_id,actor_id,created_at,?,payload_hash FROM product_media_publications WHERE id=?`
      )
      .run(imageId, imageId, main.id)
    const guarded = afterMedia(() => withdrawMedia(imageId))
    await expect(getPublishedProductDetail(guarded, 'producto-1')).rejects.toThrow('publication_validity_changed')
    expect(eligible()).toBe(1)
  })
  it('product sitemap does not emit a URL when policy is withdrawn as its batch resolves', async () => {
    const fixture = await provision()
    const guarded = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async <T>(statements: D1PreparedStatement[]) => {
            const result = await target.batch<T>(statements)
            withdrawPolicy(fixture.policyId)
            return result
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const result = await handleD1SeoRequest(new Request('https://neteco.example.com/sitemaps/products.xml'), {
      database: guarded,
      origin: 'https://neteco.example.com',
      environment: 'production'
    })
    expect(result?.status).toBe(503)
    expect(await result?.text()).not.toContain('/producto/producto-1')
  })
})
