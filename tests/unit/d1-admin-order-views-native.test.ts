import { readFile, readdir } from 'node:fs/promises'
import { buildNativeCanary as build } from '../support/native-canary-build'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { adminAuditFixture, ADMIN_AUDIT_CONFIGURATION, ADMIN, RECIPIENT, utc } from './d1-admin-audit-fixture'
import { syncNativeTestClock } from '../support/native-runtime-clock'
import { testUuid } from '../support/deterministic'

it('persists private saved views through canary SOURCE and workerd D1, with atomic CAS/replays, live revocation and zero outbound', async () => {
  let fixture: Awaited<ReturnType<typeof adminAuditFixture>> | undefined
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  let runtime: Miniflare | undefined
  try {
    const bundle = await build({
      stdin: {
        contents: "export {default} from './workers/canary'",
        resolveDir: process.cwd(),
        sourcefile: 'order-views-native-entry.ts',
        loader: 'ts'
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      external: ['node:*', 'cloudflare:*'],
      write: false,
      logLevel: 'silent'
    })
    const origin = 'https://order-views-native.neteco.test'
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'order-views-native',
        ...bundle.nativeSource,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        bindings: {
          APP_ENV: 'local',
          AUTH_ENABLED: 'true',
          EMAIL_ENABLED: 'false',
          AUTH_ORIGIN: origin,
          NUXT_SESSION_PASSWORD: ADMIN_AUDIT_CONFIGURATION.password,
          AUTH_TOKEN_PEPPER: 'synthetic-order-views-native-token-pepper-32',
          AUTH_RATE_LIMIT_PEPPER: 'synthetic-order-views-native-rate-pepper-32',
          AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64')
        },
        ratelimits: { ADMIN_EDGE_LIMIT: { namespace_id: '900085', simple: { limit: 100, period: 60 } } },
        d1Databases: { DB: '00000000-0000-4000-8000-000000000085' },
        outboundService: outbound
      })
    )
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database
    await syncNativeTestClock(db)
    fixture = await adminAuditFixture()
    const files = (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
    expect(files).toContain('0085_admin_order_views.sql')
    expect(files.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: files.length }, (_, index) => index + 1)
    )
    for (const file of files)
      await db.batch(splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => db.prepare(sql)))
    for (const table of [
      'customers',
      'identities',
      'auth_sessions',
      'identity_mfa',
      'roles',
      'permissions',
      'role_permissions',
      'identity_roles'
    ]) {
      const rows = fixture.sqlite.prepare('SELECT * FROM ' + table).all() as Record<string, string | number | null>[]
      for (const row of rows)
        await db
          .prepare(
            `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
              .map(() => '?')
              .join(',')})`
          )
          .bind(...Object.values(row))
          .run()
    }
    await db
      .prepare("INSERT INTO identity_roles VALUES(?,'admin',NULL,?,NULL)")
      .bind(RECIPIENT.identityId, utc(-60000))
      .run()
    const cookie = (await issueD1SessionCookie(db, ADMIN, fixture.configuration))!.split(';')[0]!
    const foreignCookie = (await issueD1SessionCookie(db, RECIPIENT, fixture.configuration))!.split(';')[0]!
    const send = (path = '', method = 'GET', body?: unknown, key?: string, identityCookie = cookie) =>
      runtime!.dispatchFetch(origin + '/api/admin/order-views' + path, {
        method,
        headers: {
          cookie: identityCookie,
          origin,
          'CF-Connecting-IP': '192.0.2.85',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    const unchanged = async () => {
      const result = await db.batch(
        ['orders', 'inventory_reservations', 'inventory_movements', 'payment_intents', 'admin_audit_commands'].map(
          (table) => db.prepare('SELECT count(*) AS n FROM ' + table)
        )
      )
      return result.map((item) => item.results)
    }
    const economicBefore = await unchanged()
    const key = testUuid()
    const definition = {
      bucket: 'por_cobrar',
      sortKey: 'createdAt',
      sortDir: 'desc',
      columns: ['createdAt', 'customer', 'total', 'paymentStatus']
    }
    const created = await send('', 'POST', { name: 'Cobros pendientes', definition }, key)
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('private, no-store')
    const originalReceipt = await created.text()
    const receipt = JSON.parse(originalReceipt) as {
      source: string
      action: string
      commandId: string
      viewId: string
      version: number
      payloadHash: string
    }
    expect(receipt).toMatchObject({ source: 'cloudflare', action: 'create', commandId: key, version: 1 })
    expect(receipt.viewId).toMatch(/^[0-9a-f-]{36}$/)
    expect(receipt.payloadHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await (await send('', 'POST', { name: 'Cobros pendientes', definition }, key)).text()).toBe(originalReceipt)
    const recovered = await send('/commands/' + key + '?payloadHash=' + receipt.payloadHash)
    expect(await recovered.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(await (await send()).json()).toMatchObject({
      source: 'cloudflare',
      items: [{ id: receipt.viewId, name: 'Cobros pendientes', definition, version: 1, archived: false }]
    })
    const readOnlyBefore = await db.prepare('SELECT count(*) AS n FROM admin_order_view_commands').first()
    expect((await send('/' + receipt.viewId, 'GET', undefined, undefined, foreignCookie)).status).toBe(404)
    expect(await (await send('', 'GET', undefined, undefined, foreignCookie)).json()).toEqual({
      source: 'cloudflare',
      items: []
    })
    expect(await db.prepare('SELECT count(*) AS n FROM admin_order_view_commands').first()).toEqual(readOnlyBefore)
    const changedKey = testUuid()
    const changed = await send(
      '/' + receipt.viewId,
      'PUT',
      { expectedVersion: 1, name: 'Cola de cobros', definition },
      changedKey
    )
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({
      action: 'update',
      viewId: receipt.viewId,
      version: 2,
      commandId: changedKey
    })
    expect(
      (await send('/' + receipt.viewId, 'PUT', { expectedVersion: 1, name: 'Versión antigua', definition }, testUuid()))
        .status
    ).toBe(409)
    const archivedKey = testUuid()
    const archived = await send('/' + receipt.viewId + '/archive', 'POST', { expectedVersion: 2 }, archivedKey)
    expect(archived.status).toBe(200)
    const archivedReceipt = await archived.json()
    expect(archivedReceipt).toMatchObject({
      action: 'archive',
      viewId: receipt.viewId,
      version: 3,
      commandId: archivedKey
    })
    expect(
      await (await send('/' + receipt.viewId + '/archive', 'POST', { expectedVersion: 2 }, archivedKey)).json()
    ).toEqual(archivedReceipt)
    expect(await (await send()).json()).toEqual({ source: 'cloudflare', items: [] })
    expect(await (await send('/' + receipt.viewId)).json()).toMatchObject({
      source: 'cloudflare',
      view: { id: receipt.viewId, version: 3, archived: true }
    })
    expect(await db.prepare('SELECT count(*) AS n FROM admin_order_views').first()).toEqual({ n: 1 })
    expect(await db.prepare('SELECT count(*) AS n FROM admin_order_view_commands').first()).toEqual({ n: 3 })
    expect(await unchanged()).toEqual(economicBefore)
    await db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(utc(), ADMIN.sessionId).run()
    expect((await send()).status).toBe(401)
    expect((await send('/commands/' + key + '?payloadHash=' + receipt.payloadHash)).status).toBe(401)
    expect(await db.prepare('SELECT count(*) AS n FROM admin_order_view_commands').first()).toEqual({ n: 3 })
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime?.dispose()
    fixture?.sqlite.close()
  }
}, 60_000)
