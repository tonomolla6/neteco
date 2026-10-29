import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { listPublishedProducts } from '../../workers/catalog/products'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { executeD1CatalogTypedAttributeDefinitionCommand } from '../../workers/catalog/typed-attribute-definitions'
import { deterministicTestData } from '../fixtures/deterministic'
import { searchPublishedProducts } from '../../workers/catalog/search'
import { createSearchSynonymPreview, executeSearchSynonymCommand } from '../../workers/catalog/search-synonyms'

describe('actual workerd D1 product search and typed facets SQL', () => {
  it('executes search with fixed and typed facets without weakening publication authority', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'product-search-native-regression',
        script: 'export default {fetch(){return new Response("isolated")}}',
        modules: true,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000061' },
        outboundService: () => {
          throw new Error('unexpected_outbound')
        }
      })
    )
    try {
      const database = await runtime.getD1Database('DB')
      for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
        const sql = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
        for (let index = 0; index < sql.length; index += 50)
          await database.batch(sql.slice(index, index + 50).map((statement) => database.prepare(statement)))
      }
      await database.batch(
        [
          "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES ('category',1,'Synthetic','synthetic','published')",
          "INSERT INTO brands(id,name,slug,status) VALUES ('brand','Synthetic','synthetic','published')",
          "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES ('tax','TEST','Synthetic',2100,'2020-01-01T00:00:00Z')",
          "INSERT INTO shipping_profiles(id,code,name,kind) VALUES ('shipping','TEST','Synthetic','parcel')",
          "INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status) VALUES ('10000000-0000-4000-8000-000000000061',1,'category','brand','native typed synthetic','native-typed-synthetic','published')",
          "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents,mpn) VALUES ('20000000-0000-4000-8000-000000000061',1,'10000000-0000-4000-8000-000000000061','tax','shipping','SYNTHETIC','Unit','published',500,'SYNTHETIC')"
        ].map((statement) => database.prepare(statement))
      )
      await provisionPublicationValidityFixture(database as unknown as D1Database, {
        productIds: ['10000000-0000-4000-8000-000000000061'],
        now: '2026-10-08T12:00:00Z'
      })
      await database.batch([
        database.prepare(
          "INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status) VALUES ('10000000-0000-4000-8000-000000000062',2,'category','brand','Other public target','other-public-target','published')"
        ),
        database.prepare(
          "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents,mpn) VALUES ('20000000-0000-4000-8000-000000000062',2,'10000000-0000-4000-8000-000000000062','tax','shipping','TARGET','Unit','published',500,'TARGET')"
        )
      ])
      await provisionPublicationValidityFixture(database as unknown as D1Database, {
        productIds: ['10000000-0000-4000-8000-000000000062'],
        now: '2026-10-08T12:00:00Z'
      })
      const data = deterministicTestData('native-products-search'),
        identity = data.uuid(),
        session = data.uuid()
      await database.batch([
        database
          .prepare(
            "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'native-search@example.invalid','synthetic','2020-01-01T00:00:00Z','active','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
          )
          .bind(identity),
        database.prepare("INSERT INTO roles VALUES ('native_search','Synthetic','Synthetic')"),
        database.prepare("INSERT OR IGNORE INTO permissions VALUES ('catalog.write','catalog','write','Synthetic')"),
        database.prepare("INSERT INTO role_permissions VALUES ('native_search','catalog.write')"),
        database.prepare(
          "INSERT OR IGNORE INTO permissions VALUES ('administration.manage','administration','manage','Synthetic')"
        ),
        database.prepare("INSERT INTO role_permissions VALUES ('native_search','administration.manage')"),
        database
          .prepare(
            "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'native_search','2020-01-01T00:00:00Z')"
          )
          .bind(identity),
        database
          .prepare(
            "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
          )
          .bind(session, identity)
      ])
      const values = []
      for (const [kind, config, value] of [
        ['text', { maxLength: 500 }, '<strong>Ñ texto literal</strong>'],
        ['boolean', {}, false],
        ['number', { precision: 2, min: -10, max: 10 }, 0],
        ['unit', { precision: 2, units: ['ml', 'l'] }, { quantity: 0, unit: 'ml' }],
        ['list', { options: [{ code: 'blue', label: 'Azul', status: 'active' }] }, ['blue']],
        ['reference', {}, '10000000-0000-4000-8000-000000000062']
      ] as const) {
        const result = await executeD1CatalogTypedAttributeDefinitionCommand(
          database as unknown as D1Database,
          { identityId: identity, sessionId: session, sessionVersion: 1 },
          'create',
          {},
          { categoryId: 1, code: kind, kind, label: kind, config, expectedVersion: 0, reason: 'Synthetic native test' },
          { idempotencyKey: data.uuid(), now: '2026-10-08T12:00:00Z' }
        )
        values.push({ definitionId: result.definition.id, revision: result.definition.revision, value })
        if (kind === 'reference')
          await executeD1CatalogTypedAttributeDefinitionCommand(
            database as unknown as D1Database,
            { identityId: identity, sessionId: session, sessionVersion: 1 },
            'update',
            { definitionId: result.definition.id },
            {
              label: 'Reference revised',
              config: {},
              expectedVersion: 1,
              reason: 'Synthetic historical reference test'
            },
            { idempotencyKey: data.uuid(), now: '2026-10-08T12:00:00Z' }
          )
      }
      await database
        .prepare(
          "UPDATE products SET attributes=json_set(attributes,'$.typed',json(?)) WHERE id='10000000-0000-4000-8000-000000000061'"
        )
        .bind(JSON.stringify({ version: 1, values }))
        .run()
      const result = await listPublishedProducts(
        database as unknown as D1Database,
        { search: 'native typed synthetic', facets: true, page: 1, limit: 50, sort: 'default' },
        { instant: '2026-10-08T12:00:00Z' }
      )
      expect(result).toMatchObject({ total: 1 })
      expect(result?.facets?.typed).toHaveLength(5)
      const native = database as unknown as D1Database,
        instant = { instant: '2026-10-08T12:00:00Z' }
      const failures: string[] = []
      for (const q of ['missing'.repeat(8), 'x'.repeat(60) + '%_\\', 'z'.repeat(160)]) {
        try {
          expect(
            (
              await listPublishedProducts(
                native,
                { search: q, facets: true, page: 1, limit: 50, sort: 'default' },
                instant
              )
            )?.total
          ).toBe(0)
        } catch (error) {
          failures.push('list:' + String(error))
        }
        try {
          expect((await searchPublishedProducts(native, q, instant)).items).toEqual([])
        } catch (error) {
          failures.push('suggestions:' + String(error))
        }
      }
      expect(failures).toEqual([])
      const literal = 'literal%_\\' + 'x'.repeat(55)
      await database
        .prepare("UPDATE variants SET sku=? WHERE product_id='10000000-0000-4000-8000-000000000061'")
        .bind(literal)
        .run()
      expect(
        (
          await listPublishedProducts(
            native,
            { search: literal, facets: true, page: 1, limit: 50, sort: 'default' },
            instant
          )
        )?.total
      ).toBe(1)
      expect((await searchPublishedProducts(native, literal, instant)).items.map((item) => item.slug)).toEqual([
        'native-typed-synthetic'
      ])
      const claims = { identityId: identity, sessionId: session, sessionVersion: 1 }
      const preview = await createSearchSynonymPreview(native, claims, {
        draft: {
          id: null,
          expectedVersion: 0,
          sourceTerm: 'shortalias',
          replacements: [literal],
          active: true,
          reason: 'Synthetic long literal alias',
          action: 'save'
        },
        query: 'shortalias'
      })
      await executeSearchSynonymCommand(
        native,
        claims,
        { previewId: preview.previewId, previewHash: preview.previewHash },
        { idempotencyKey: data.uuid() }
      )
      expect(
        (
          await listPublishedProducts(
            native,
            { search: 'shortalias', facets: true, page: 1, limit: 50, sort: 'default' },
            instant
          )
        )?.total
      ).toBe(1)
      expect((await searchPublishedProducts(native, 'shortalias', instant)).items.map((item) => item.slug)).toEqual([
        'native-typed-synthetic'
      ])
    } finally {
      await runtime.dispose()
    }
  }, 30000)
})
