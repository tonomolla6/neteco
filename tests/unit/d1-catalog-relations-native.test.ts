import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  adminCatalogRelationsSchema,
  catalogRelationsReceiptSchema,
  catalogRelationsCommandSchema,
  publicCatalogRelationsSchema,
  catalogRelationsIntentHash
} from '../../shared/catalog-relations'

it('serves real catalog relations via canary and workerd D1 with authenticated replay and live public withdrawal', async () => {
  const origin = 'https://catalog-relations-native.neteco.test',
    password = randomBytes(32).toString('hex')
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'catalog-relations-native-entry.ts',
      loader: 'ts',
      contents: "export { default } from './workers/canary'"
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    external: ['node:*', 'cloudflare:*'],
    write: false,
    logLevel: 'silent'
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'catalog-relations-native',
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      bindings: {
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: password,
        AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
        AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        AUTH_RATE_LIMIT_PEPPER: randomBytes(32).toString('hex')
      },
      ratelimits: {
        AUTH_EDGE_LIMIT: { namespace_id: '900761', simple: { limit: 100, period: 60 } },
        CART_EDGE_LIMIT: { namespace_id: '900762', simple: { limit: 100, period: 60 } },
        ADMIN_EDGE_LIMIT: { namespace_id: '900763', simple: { limit: 100, period: 60 } }
      },
      d1Databases: { DB: '00000000-0000-4000-8000-000000000076' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const files = (await readdir('db/d1/migrations'))
      .filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= 76)
      .sort()
    for (const file of files)
      await database.batch(
        splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => database.prepare(sql))
      )
    const seed: D1PreparedStatement[] = []
    seedInventoryFixture({
      exec(sql: string) {
        seed.push(...splitDemoSql(sql).map((text) => database.prepare(text)))
      },
      prepare(sql: string) {
        return {
          run(...args: unknown[]) {
            seed.push(database.prepare(sql).bind(...args))
          }
        }
      }
    } as unknown as DatabaseSync)
    await database.batch(seed)
    const now = (await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') now").first<{ now: string }>())!
      .now
    await provisionPublicationValidityFixture(database, { productIds: ['p-1', 'p-2'], now })
    const identityId = randomUUID(),
      sessionId = randomUUID()
    await database.batch([
      database.prepare("INSERT INTO roles VALUES('relations-editor','Synthetic editor','Synthetic')"),
      database.prepare("INSERT OR IGNORE INTO permissions VALUES('catalog.write','catalog','write','Synthetic')"),
      database.prepare("INSERT INTO role_permissions VALUES('relations-editor','catalog.write')"),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,'relations-native@example.invalid','synthetic',?,'active',?,?)"
        )
        .bind(identityId, now, now, now),
      database
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 hour'))"
        )
        .bind(sessionId, identityId, now, now),
      database
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'relations-editor',?)")
        .bind(identityId, now)
    ])
    const cookie = (await issueD1SessionCookie(
      database,
      { identityId, sessionId, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!
    const root = '/api/admin/products/1/relations',
      key = randomUUID()
    const body = {
      expectedVersion: 0,
      relations: [{ targetProductId: 2, kind: 'compatible' }],
      reason: 'Synthetic reviewed catalog relationship',
      reviewReference: 'synthetic-native-review'
    }
    const call = (path: string, method = 'GET', value: unknown = body, Cookie = cookie, hash?: string) =>
      runtime.dispatchFetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          Cookie,
          'CF-Connecting-IP': '192.0.2.197',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(value) })
      })
    const empty = await call(root)
    expect(empty.status).toBe(200)
    expect(adminCatalogRelationsSchema.parse(await empty.json()).items).toEqual([])
    expect(files).toHaveLength(76)
    const created = await call(root + '/commands', 'POST')
    expect(created.status).toBe(201)
    const receipt = catalogRelationsReceiptSchema.parse(await created.json())
    expect(receipt.payloadHash).toBe(await catalogRelationsIntentHash(1, body))
    expect(await (await call(root + '/commands', 'POST')).json()).toEqual(receipt)
    const recovered = await call(root + '/commands/' + key, 'GET', undefined, cookie, receipt.payloadHash)
    expect(recovered.status).toBe(200)
    expect(catalogRelationsCommandSchema.parse(await recovered.json())).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })
    const publicPath = '/api/product-relations?slugs=producto-1'
    const visible = await call(publicPath, 'GET', undefined, '')
    expect(visible.status).toBe(200)
    expect(publicCatalogRelationsSchema.parse(await visible.json()).groups[0]?.items).toEqual([
      expect.objectContaining({ kind: 'compatible', productId: 2, minPrice: 500 })
    ])
    await database.prepare("UPDATE products SET status='draft' WHERE id='p-2'").run()
    expect(
      publicCatalogRelationsSchema
        .parse(await (await call(publicPath, 'GET', undefined, '')).json())
        .groups.flatMap((group) => group.items)
    ).toEqual([])
    expect((await call(root, 'GET', undefined, '')).status).toBe(401)
    await database.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(now, sessionId).run()
    expect((await call(root + '/commands/' + key, 'GET', undefined, cookie, receipt.payloadHash)).status).toBe(401)
    expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 120000)
