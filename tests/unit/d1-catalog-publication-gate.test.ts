import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import {
  createD1CatalogPublicationGate,
  publicationDependencySnapshotSql
} from '../../workers/catalog/catalog-publication-gate'
import { updateD1ProductStatus } from '../../workers/catalog/admin-catalog-status'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { executeD1CatalogTypedAttributeDefinitionCommand } from '../../workers/catalog/typed-attribute-definitions'
import { readD1CatalogPublicationReadiness } from '../../workers/catalog/catalog-publication-readiness'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const NOW = '2026-09-30T10:00:00Z'
const IDENTITY = '10000000-0000-4000-8000-000000000036'
const SESSION = '20000000-0000-4000-8000-000000000036'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const PRODUCT = { productId: 1, productUuid: 'p-1' }
const TABLES = [
  'catalog_publication_policies',
  'catalog_publication_policy_withdrawals',
  'catalog_product_publication_policies',
  'catalog_variant_identifier_exceptions',
  'catalog_variant_identifier_exception_withdrawals'
] as const

function png() {
  // Synthetic envelope only, NOT image decoding/AV/licensing acceptance.
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  new DataView(bytes.buffer).setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(bytes.buffer).setUint32(16, 800)
  new DataView(bytes.buffer).setUint32(20, 600)
  return bytes
}
function hex(value: ArrayBuffer) {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('authoritative publication policy, original bytes and D1 transactional dependency gate', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let objects: Map<string, { bytes: Uint8Array; metadata: R2Object }>
  let onRead: (key: string) => void | Promise<void>
  let reads: string[]

  const bucket = {
    async get(key: string): Promise<R2ObjectBody | null> {
      reads.push(key)
      await onRead(key)
      const object = objects.get(key)
      if (!object) return null
      const bytes = new Uint8Array(object.bytes)
      return {
        ...object.metadata,
        writeHttpMetadata: object.metadata.writeHttpMetadata.bind(object.metadata),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          }
        }),
        bodyUsed: false,
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
        bytes: async () => new Uint8Array(bytes),
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
        blob: async () => new Blob([new Uint8Array(bytes)])
      }
    }
  }
  function update(sql: string, ...parameters: SQLInputValue[]) {
    sqlite.prepare(sql).run(...parameters)
  }
  function policy(options: { fields?: string[]; roles?: string[]; exceptions?: boolean; code?: string } = {}) {
    const id = crypto.randomUUID()
    update(
      `INSERT INTO catalog_publication_policies(id,code,version,name,required_fields,required_media_roles,
      identifier_exceptions_allowed,actor_id,reason,valid_from,created_at) VALUES (?,?,1,'Synthetic type policy',?,?,?,?, 'Synthetic review, not legal approval',?,?)`,
      id,
      options.code ?? 'test_type',
      JSON.stringify(options.fields ?? []),
      JSON.stringify(options.roles ?? []),
      options.exceptions ? 1 : 0,
      IDENTITY,
      NOW,
      NOW
    )
    update(
      `INSERT INTO catalog_product_publication_policies(id,product_id,policy_id,actor_id,reason,created_at)
      VALUES (?,'p-1',?,?,'Synthetic assignment, not real product approval',?)`,
      crypto.randomUUID(),
      id,
      IDENTITY,
      NOW
    )
    return id
  }
  async function media(role: 'main' | 'sds' | 'datasheet' = 'main', variant: string | null = null) {
    const upload = crypto.randomUUID(),
      scan = crypto.randomUUID(),
      rights = crypto.randomUUID(),
      publication = crypto.randomUUID()
    const bytes = role === 'main' ? png() : new TextEncoder().encode('%PDF-1.7\nSynthetic envelope only\n%%EOF')
    const checksum = hex(await crypto.subtle.digest('SHA-256', bytes))
    const key = `quarantine/${upload}/${checksum}`
    const mime = role === 'main' ? 'image/png' : 'application/pdf'
    objects.set(key, {
      bytes,
      metadata: {
        key,
        size: bytes.length,
        etag: checksum,
        httpEtag: `"${checksum}"`,
        version: 'synthetic-v1',
        uploaded: new Date(NOW),
        storageClass: 'Standard',
        checksums: { toJSON: () => ({}) },
        writeHttpMetadata: () => {}
      }
    })
    update(
      `INSERT INTO media_uploads(id,actor_id,idempotency_key,payload_hash,checksum,object_key,filename,content_type,
      byte_size,width,height,alt,rights_owner,rights_license,rights_source,storage_status,r2_etag,created_at,stored_at)
      VALUES (?,?,?,?,?,?,'private-synthetic-original',?,?,?,?,'Fotografía exacta del producto',
        'Synthetic owner','Synthetic local-only license','Synthetic reference','quarantined',?,?,?)`,
      upload,
      IDENTITY,
      upload,
      checksum,
      checksum,
      key,
      mime,
      bytes.length,
      role === 'main' ? 800 : null,
      role === 'main' ? 600 : null,
      checksum,
      NOW,
      NOW
    )
    update(
      `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,
      scanned_at,expires_at,received_at,payload_hash) VALUES (?,?,?,?,?,'clean','Synthetic-not-antivirus',?,'2026-10-01T10:00:00Z',?,?)`,
      scan,
      upload,
      checksum,
      key,
      bytes.length,
      NOW,
      NOW,
      checksum
    )
    update(
      `INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,evidence_authorized_at,
      evidence_reference,rights_owner,rights_license,created_at,idempotency_key,payload_hash)
      VALUES (?,?,'approved','Synthetic test only',?,'2026-09-01','Synthetic private evidence reference',
      'Synthetic owner','Synthetic local-only license',?,?,?)`,
      rights,
      upload,
      IDENTITY,
      NOW,
      rights,
      checksum
    )
    update(
      `INSERT INTO product_media_publications(id,product_id,variant_id,upload_id,role,title,alt,language,version,
      valid_from,scan_receipt_id,rights_decision_id,actor_id,created_at,idempotency_key,payload_hash)
      VALUES (?,'p-1',?,?,?,'Synthetic title','Fotografía exacta del producto','es','v1',?,?,?,?,?,?,?)`,
      publication,
      variant,
      upload,
      role,
      NOW,
      scan,
      rights,
      IDENTITY,
      NOW,
      publication,
      checksum
    )
    return { key, upload, publication, scan }
  }
  function exception() {
    const id = crypto.randomUUID()
    update(
      `INSERT INTO catalog_variant_identifier_exceptions(id,variant_id,actor_id,reason,evidence_reference,valid_from,created_at)
      VALUES (?,'v-1-1',?,'Synthetic reviewed exception, not commercial approval','Synthetic reference',?,?)`,
      id,
      IDENTITY,
      NOW,
      NOW
    )
    return id
  }
  function gate(now: string = NOW) {
    return createD1CatalogPublicationGate({ bucket, enabled: true, now })
  }
  async function prepare() {
    return gate().prepare(database, PRODUCT, CLAIMS)
  }
  async function eligible(prepared: Awaited<ReturnType<typeof prepare>>, clock?: string) {
    const predicate = prepared.condition(16)
    const parameters = [...predicate.parameters]
    if (clock) parameters[0] = clock // internal SQL-clock boundary probe only
    const row = await database
      .prepare(`SELECT (${predicate.sql}) AS eligible`)
      .bind(...Array(16).fill(null), ...parameters)
      .first<{ eligible: number }>()
    return row?.eligible
  }
  async function publish(key = crypto.randomUUID()) {
    const row = sqlite.prepare("SELECT catalog_version FROM products WHERE id='p-1'").get()!
    return updateD1ProductStatus(
      database,
      CLAIMS,
      '1',
      { status: 'published', expectedVersion: row.catalog_version, reason: 'Synthetic publication test' },
      { idempotencyKey: key, now: NOW, publicationGate: gate() }
    )
  }
  function counts() {
    return ['catalog_product_status_commands', 'catalog_product_status_audit', 'catalog_product_status_guards'].map(
      (table) => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n
    )
  }
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    objects = new Map()
    reads = []
    onRead = () => {}
    sqlite.exec(`
      INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES ('${IDENTITY}','publisher@example.invalid','synthetic-unusable-hash','${NOW}','active','${NOW}','${NOW}');
      INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES ('${SESSION}','${IDENTITY}',1,1,'2026-09-30T09:00:00Z','2026-09-30T12:00:00Z');
      INSERT INTO roles VALUES ('publisher','Publisher','Synthetic test only');
      INSERT INTO permissions VALUES ('catalog.publish','catalog','publish','Synthetic test only');
      INSERT INTO role_permissions VALUES ('publisher','catalog.publish');
      INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES ('${IDENTITY}','publisher','${NOW}');
      UPDATE products SET status='review',brand_id='b1',short_description='Descripción corta suficientemente larga',
        description='Descripción larga y suficientemente completa del producto editorial',
        regulatory='{"productType":"test_type","requiresSds":false}',attributes='{}' WHERE id='p-1';
      UPDATE variants SET status='review',mpn='MPN-READY',weight_grams=1200,width_mm=100,height_mm=200,depth_mm=300
        WHERE id='v-1-1';
    `)
    await media()
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function typedFixture(kind = 'boolean', config: unknown = {}) {
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_typed_attribute_definitions'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0058_catalog_typed_attributes.sql', import.meta.url), 'utf8')
      )
    for (const permission of ['administration.manage', 'catalog.write']) {
      const [resource, action] = permission.split('.')
      update(
        'INSERT OR IGNORE INTO permissions VALUES(?,?,?,?)',
        permission,
        resource!,
        action!,
        'Synthetic typed publication fixture'
      )
      update("INSERT OR IGNORE INTO role_permissions VALUES('publisher',?)", permission)
    }
    return (
      await executeD1CatalogTypedAttributeDefinitionCommand(
        database,
        CLAIMS,
        'create',
        {},
        {
          categoryId: 7,
          code: 'typed_publication',
          kind,
          config,
          label: 'Synthetic typed publication',
          expectedVersion: 0,
          reason: 'Synthetic typed publication fixture'
        },
        { idempotencyKey: 'typed-publication-definition', now: NOW }
      )
    ).definition
  }
  function setTyped(value: unknown) {
    update(
      "UPDATE products SET attributes=json_set(attributes,'$.typed',json(?)) WHERE id='p-1'",
      JSON.stringify(value)
    )
  }
  it.each(['envelope', 'definition', 'value'])(
    'typed publication rejects invalid %s before reading originals',
    async (cause) => {
      const definition = await typedFixture()
      policy()
      const typed =
        cause === 'envelope'
          ? { version: 2, values: [] }
          : {
              version: 1,
              values: [
                {
                  definitionId: cause === 'definition' ? crypto.randomUUID() : definition.id,
                  revision: 1,
                  value: cause === 'value' ? 'false' : false
                }
              ]
            }
      setTyped(typed)
      await expect(prepare()).rejects.toMatchObject({
        code: 'publication_blocked',
        issues: expect.arrayContaining([expect.objectContaining({ code: 'product.typed' })])
      })
      expect(reads).toEqual([])
      expect(counts()).toEqual([0, 0, 0])
    }
  )
  it('typed publication preserves pinned historical false after definition retirement without reinterpreting it', async () => {
    const definition = await typedFixture()
    policy()
    const typed = { version: 1, values: [{ definitionId: definition.id, revision: 1, value: false }] }
    setTyped(typed)
    expect(await eligible(await prepare())).toBe(1)
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CLAIMS,
      'retire',
      { definitionId: definition.id },
      {
        expectedVersion: 1,
        reason: 'Synthetic definition retirement'
      },
      { idempotencyKey: 'typed-publication-retire', now: NOW }
    )
    expect(await eligible(await prepare())).toBe(1)
    expect(
      JSON.parse(String(sqlite.prepare("SELECT attributes FROM products WHERE id='p-1'").get()!.attributes)).typed
    ).toEqual(typed)
  })
  it('typed reference withdrawal during R2 reads invalidates the final transactional publication guard', async () => {
    const definition = await typedFixture('reference')
    const reference = '10000000-0000-4000-8000-000000000060'
    update(
      "INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status) VALUES(?,60,'c1','b1','Synthetic typed reference','typed-publication-reference','published')",
      reference
    )
    update(
      "INSERT INTO variants(id,product_id,legacy_id,sku,format,status,tax_class_id,shipping_profile_id,price_gross_cents,mpn) VALUES('typed-publication-ref-variant',?,600,'TYPED-PUB-REF','Unit','published','t21','sp1',500,'TYPED-PUB-REF')",
      reference
    )
    await provisionPublicationValidityFixture(database, { productIds: [reference], now: NOW })
    policy()
    setTyped({ version: 1, values: [{ definitionId: definition.id, revision: 1, value: reference }] })
    const prepared = await prepare()
    expect(await eligible(prepared)).toBe(1)
    const before = sqlite.prepare("SELECT status,catalog_version FROM products WHERE id='p-1'").get()
    onRead = () => update("UPDATE products SET status='hidden' WHERE id=?", reference)
    await expect(publish()).rejects.toMatchObject({ code: 'publication_blocked' })
    expect(await eligible(prepared)).toBe(0)
    expect(sqlite.prepare("SELECT status,catalog_version FROM products WHERE id='p-1'").get()).toEqual(before)
    expect(counts()).toEqual([0, 0, 0])
  })
  it('typed publication readiness reports invalid values without manufacturing publication authority', async () => {
    const definition = await typedFixture()
    setTyped({ version: 1, values: [{ definitionId: definition.id, revision: 1, value: 0 }] })
    const readiness = await readD1CatalogPublicationReadiness(database, CLAIMS, NOW, '1')
    expect(readiness.outcome).toBe('found')
    if (readiness.outcome !== 'found') throw new Error('Missing synthetic readiness')
    expect(readiness.data.publicationEnabled).toBe(false)
    expect(readiness.data.issues).toContainEqual(expect.objectContaining({ code: 'product.typed' }))
  })

  it('does not seed guessed regulatory policies or synthetic production acceptance', async () => {
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_publication_policies').get()!.n).toBe(0)
    await expect(publish()).rejects.toMatchObject({ code: 'publication_blocked', issues: [{ code: 'policy.missing' }] })
    expect(counts()).toEqual([0, 0, 0])
    expect(reads).toEqual([])
  })
  it('policy assignment sequence cannot be supplied as a negative replacement escape', () => {
    const id = policy()
    expect(() =>
      update(
        `INSERT INTO catalog_product_publication_policies(seq,id,product_id,policy_id,actor_id,reason,created_at)
      VALUES (-2,?,'p-1',?,?,'Synthetic invalid negative sequence',?)`,
        crypto.randomUUID(),
        id,
        IDENTITY,
        NOW
      )
    ).toThrow(/CHECK/)
  })
  it('publishes complete explicitly governed data, audits and replays original receipt without touching R2 again', async () => {
    policy()
    const key = crypto.randomUUID()
    const first = await publish(key)
    expect(first).toMatchObject({
      source: 'cloudflare',
      productId: 1,
      productUuid: 'p-1',
      status: 'published',
      active: true,
      updated: true
    })
    expect(counts()).toEqual([1, 1, 0])
    expect(reads).toHaveLength(1)
    const audit = sqlite.prepare('SELECT gate_fingerprint,after_version FROM catalog_product_status_audit').get()!
    expect(audit.gate_fingerprint).toMatch(/^[a-f0-9]{64}$/)
    const replay = await updateD1ProductStatus(
      database,
      CLAIMS,
      '1',
      { status: 'published', expectedVersion: first.catalogVersion - 1, reason: 'Synthetic publication test' },
      {
        idempotencyKey: key,
        now: NOW,
        publicationGate: {
          prepare: async () => {
            throw new Error('must not reevaluate a completed command')
          }
        }
      }
    )
    expect(replay).toEqual(first)
    expect(counts()).toEqual([1, 1, 0])
    expect(reads).toHaveLength(1)
  })
  it('fingerprint remains eligible after only command-owned status and timestamp changes', async () => {
    policy()
    const prepared = await prepare()
    expect(await eligible(prepared)).toBe(1)
    update("UPDATE products SET status='published',updated_at='2026-09-30T10:00:01Z' WHERE id='p-1'")
    update("UPDATE variants SET status='published',updated_at='2026-09-30T10:00:01Z' WHERE id='v-1-1'")
    expect(await eligible(prepared)).toBe(1)
    expect(prepared.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(() => prepared.condition(-1)).toThrow()
    expect(() => publicationDependencySnapshotSql(0, 2)).toThrow()
  })
  it.each([
    "UPDATE products SET name='Changed product' WHERE id='p-1'",
    "UPDATE products SET regulatory='{}' WHERE id='p-1'",
    "UPDATE categories SET status='hidden' WHERE id='c1'",
    "UPDATE categories SET legacy_id=NULL WHERE id='c1'",
    "UPDATE brands SET status='archived' WHERE id='b1'",
    "UPDATE variants SET mpn='Changed identifier' WHERE id='v-1-1'",
    "UPDATE variants SET price_gross_cents=999 WHERE id='v-1-1'",
    "UPDATE variants SET maximum_quantity=999 WHERE id='v-1-1'",
    "UPDATE tax_classes SET rate_basis_points=1000 WHERE id='t21'",
    "UPDATE tax_classes SET valid_until='2026-09-30T10:00:00Z' WHERE id='t21'",
    "UPDATE inventory_balances SET blocked_quantity=24 WHERE variant_id='v-1-1'",
    "UPDATE variants SET safety_stock=24 WHERE id='v-1-1'",
    "UPDATE inventory_locations SET active=0 WHERE id='loc-main'",
    "UPDATE variants SET status='discontinued' WHERE id='v-1-1'"
  ])('invalidates transactional evidence after independent dependency drift: %s', async (sql) => {
    policy()
    const prepared = await prepare()
    expect(await eligible(prepared)).toBe(1)
    sqlite.exec(sql)
    expect(await eligible(prepared)).toBe(0)
  })
  it('new price winner with identical amount and precision at exact expiry is not silently equivalent', async () => {
    policy()
    const prepared = await prepare()
    update(
      `INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,status,reason,created_at)
      VALUES ('new-winner','v-1-1',500,?,'approved','Synthetic new price version',?)`,
      NOW,
      NOW
    )
    expect(await eligible(prepared)).toBe(0)
  })
  it('rechecks stock reservations even when product catalog_version has not changed', async () => {
    policy()
    const prepared = await prepare()
    update(
      `INSERT INTO inventory_reservations(id,idempotency_key,payload_hash,status,correlation_id,expires_at,created_at,updated_at)
      VALUES ('reservation','reservation',?,'reserved','synthetic','2026-10-01T00:00:00Z',?,?)`,
      'a'.repeat(64),
      NOW,
      NOW
    )
    update(`INSERT INTO inventory_reservation_lines(reservation_id,variant_id,location_id,quantity)
      VALUES ('reservation','v-1-1','loc-main',24)`)
    expect(await eligible(prepared)).toBe(0)
  })
  it('a governed ID equal to the public legacy marker still invalidates at its exact expiry', async () => {
    policy()
    update(
      `INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,valid_until,status,reason,created_at)
      VALUES ('legacy:v-1-1','v-1-1',500,?,'2026-09-30T10:00:01Z','approved','Synthetic marker collision',?)`,
      NOW,
      NOW
    )
    const prepared = await prepare()
    expect(await eligible(prepared)).toBe(1)
    expect(await eligible(prepared, '2026-09-30T10:00:01Z')).toBe(0)
  })
  it('text requirements cannot be fulfilled by booleans, but reviewed text works', async () => {
    policy({ fields: ['regulatory.manufacturer'] })
    update(
      "UPDATE products SET regulatory=? WHERE id='p-1'",
      JSON.stringify({ productType: 'test_type', requiresSds: false, manufacturer: false })
    )
    await expect(prepare()).rejects.toMatchObject({
      code: 'publication_blocked',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'policy.field' })])
    })
    update(
      "UPDATE products SET regulatory=? WHERE id='p-1'",
      JSON.stringify({ productType: 'test_type', requiresSds: false, manufacturer: 'Synthetic manufacturer' })
    )
    await prepare()
  })
  it('fresh policy assignment and withdrawals invalidate captured approval', async () => {
    const id = policy()
    const prepared = await prepare()
    update(
      `INSERT INTO catalog_publication_policy_withdrawals VALUES (?,?,?,'Synthetic withdrawal of policy approval',?)`,
      crypto.randomUUID(),
      id,
      IDENTITY,
      NOW
    )
    expect(await eligible(prepared)).toBe(0)
    await expect(prepare()).rejects.toMatchObject({ code: 'publication_blocked', issues: [{ code: 'policy.missing' }] })
  })
  it.each([
    [{ fields: ['not_supported'] }, 'policy.invalid'],
    [{ fields: ['usage', 'usage'] }, 'policy.invalid'],
    [{ roles: ['not_supported'] }, 'policy.invalid'],
    [{ fields: ['usage'] }, 'policy.field'],
    [{ roles: ['datasheet'] }, 'policy.document'],
    [{ code: 'other_type' }, 'policy.invalid']
  ])('requires supported explicit product-type rules: %j', async (options, code) => {
    policy(options)
    await expect(prepare()).rejects.toMatchObject({
      code: 'publication_blocked',
      issues: expect.arrayContaining([expect.objectContaining({ code })])
    })
    expect(reads).toEqual([])
  })
  it.each(['{}', '{"productType":"test_type"}', '{"productType":"test_type","requiresSds":"false"}'])(
    'never interprets absent or invalid SDS applicability as not required: %s',
    async (regulatory) => {
      policy()
      update("UPDATE products SET regulatory=? WHERE id='p-1'", regulatory)
      await expect(prepare()).rejects.toMatchObject({
        code: 'publication_blocked',
        issues: [{ code: 'policy.invalid' }]
      })
    }
  )
  it('SDS can cover every sellable variant and is byte-verified in addition to the main image', async () => {
    policy()
    update(
      "UPDATE products SET regulatory=? WHERE id='p-1'",
      JSON.stringify({ productType: 'test_type', requiresSds: true })
    )
    await expect(prepare()).rejects.toMatchObject({ code: 'publication_blocked' })
    await media('sds', 'v-1-1')
    await prepare()
    expect(reads).toHaveLength(2)
  })
  it('a PDF required by type is not satisfied by the legacy attributes URL or another product', async () => {
    policy({ roles: ['datasheet'] })
    update("UPDATE products SET attributes=? WHERE id='p-1'", '{"datasheet":"https://example.invalid/unsafe.pdf"}')
    await expect(prepare()).rejects.toMatchObject({ code: 'publication_blocked' })
    await media('datasheet')
    await prepare()
    expect(reads).toHaveLength(2)
  })
  it('identifier exceptions require explicit policy permission and reviewed current evidence', async () => {
    policy()
    update("UPDATE variants SET mpn=NULL WHERE id='v-1-1'")
    const id = exception()
    await expect(prepare()).rejects.toMatchObject({ code: 'publication_blocked' })
    policy({ code: 'exception_type', exceptions: true })
    update("UPDATE products SET regulatory=? WHERE id='p-1'", '{"productType":"exception_type","requiresSds":false}')
    const prepared = await prepare()
    expect(await eligible(prepared)).toBe(1)
    update(
      `INSERT INTO catalog_variant_identifier_exception_withdrawals VALUES (?,?,?,'Synthetic reviewed exception withdrawn',?)`,
      crypto.randomUUID(),
      id,
      IDENTITY,
      NOW
    )
    expect(await eligible(prepared)).toBe(0)
    await expect(prepare()).rejects.toMatchObject({ code: 'publication_blocked' })
  })
  it.each(['missing', 'etag', 'size', 'checksum', 'type', 'truncated', 'oversized'] as const)(
    'rejects absent or mismatched original bytes: %s',
    async (mode) => {
      policy()
      const [key, object] = [...objects.entries()][0]!
      if (mode === 'missing') objects.delete(key)
      if (mode === 'etag' || mode === 'size')
        object.metadata = {
          ...object.metadata,
          writeHttpMetadata: object.metadata.writeHttpMetadata.bind(object.metadata),
          ...(mode === 'etag' ? { etag: 'wrong-etag' } : { size: object.metadata.size + 1 })
        }
      if (mode === 'checksum') object.bytes[32] = 255
      if (mode === 'type') object.bytes[0] = 0
      if (mode === 'truncated') object.bytes = object.bytes.slice(0, -1)
      if (mode === 'oversized') object.bytes = new Uint8Array(object.bytes.length + 1)
      await expect(publish()).rejects.toMatchObject({ code: 'publication_blocked' })
      expect(counts()).toEqual([0, 0, 0])
    }
  )
  it('a genuine provider outage propagates, not a disguised completeness conflict', async () => {
    policy()
    onRead = () => {
      throw new Error('synthetic R2 provider outage')
    }
    await expect(publish()).rejects.toThrow('synthetic R2 provider outage')
    expect(counts()).toEqual([0, 0, 0])
  })
  it('missing feature flags or binding fail closed without original reads', async () => {
    policy()
    await expect(
      createD1CatalogPublicationGate({ enabled: false, bucket, now: NOW }).prepare(database, PRODUCT, CLAIMS)
    ).rejects.toMatchObject({ code: 'publication_blocked' })
    await expect(
      createD1CatalogPublicationGate({ enabled: true, now: NOW }).prepare(database, PRODUCT, CLAIMS)
    ).rejects.toMatchObject({ code: 'publication_blocked' })
    expect(reads).toEqual([])
  })
  it.each([
    "DELETE FROM identity_roles WHERE identity_id='" + IDENTITY + "'",
    "UPDATE auth_sessions SET revoked_at='" + NOW + "' WHERE id='" + SESSION + "'",
    "UPDATE auth_sessions SET mfa_verified=0 WHERE id='" + SESSION + "'",
    "UPDATE identities SET email_verified_at=NULL WHERE id='" + IDENTITY + "'"
  ])('rechecks live authority after asynchronous R2: %s', async (sql) => {
    policy()
    onRead = () => sqlite.exec(sql)
    await expect(publish()).rejects.toMatchObject({
      code: expect.stringMatching(/forbidden|unauthenticated|mfa_required|email_unverified/)
    })
    expect(counts()).toEqual([0, 0, 0])
  })
  it('dependency change after R2 validation rolls back the full command/audit batch', async () => {
    policy()
    onRead = () => update("UPDATE inventory_balances SET blocked_quantity=24 WHERE variant_id='v-1-1'")
    const before = sqlite.prepare("SELECT status,catalog_version FROM products WHERE id='p-1'").get()
    await expect(publish()).rejects.toMatchObject({ code: 'publication_blocked' })
    expect(sqlite.prepare("SELECT status,catalog_version FROM products WHERE id='p-1'").get()).toEqual(before)
    expect(counts()).toEqual([0, 0, 0])
  })
  it.each(TABLES)('schema keeps the governed ledger append-only: %s', (table) => {
    expect(() => sqlite.exec(`UPDATE ${table} SET id=id`)).not.toThrow() // empty tables do not invoke row triggers
    const id = policy({ exceptions: true })
    exception()
    update(
      `INSERT INTO catalog_publication_policy_withdrawals VALUES (?,?,?,'Synthetic withdrawal of policy approval',?)`,
      crypto.randomUUID(),
      id,
      IDENTITY,
      NOW
    )
    const exceptionId = sqlite.prepare('SELECT id FROM catalog_variant_identifier_exceptions').get()!.id
    update(
      `INSERT INTO catalog_variant_identifier_exception_withdrawals VALUES (?,?,?,'Synthetic exception withdrawal',?)`,
      crypto.randomUUID(),
      exceptionId!,
      IDENTITY,
      NOW
    )
    expect(() => sqlite.exec(`UPDATE ${table} SET id=id`)).toThrow(/immutable/)
    expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow(/immutable/)
    sqlite.exec('PRAGMA recursive_triggers=OFF')
    expect(() => sqlite.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(/immutable/)
  })
})
