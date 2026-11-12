import { readFile, readdir } from 'node:fs/promises'
import { buildNativeCanary as build } from '../support/native-canary-build'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  adminAuditCommandSchema,
  adminAuditDetailSchema,
  adminAuditListSchema,
  adminAuditReceiptSchema,
  adminAuditHash
} from '../../shared/admin-audit'
import { adminAuditFixture, ADMIN_AUDIT_CONFIGURATION, ADMIN, RECIPIENT } from './d1-admin-audit-fixture'
import { syncNativeTestClock } from '../support/native-runtime-clock'
import { testUuid, testNow } from '../support/deterministic'

it('reads a real invitation audit source, reviews and exports through canary SOURCE/workerd D1/all current migrations with current authority and zero outbound', async () => {
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
        sourcefile: 'admin-audit-native-entry.ts',
        loader: 'ts'
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      external: ['node:*', 'cloudflare:*'],
      write: false,
      logLevel: 'silent'
    })
    const origin = 'https://audit-native.neteco.test'
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'admin-audit-native',
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
          AUTH_TOKEN_PEPPER: 'synthetic-admin-audit-native-token-pepper-32',
          AUTH_RATE_LIMIT_PEPPER: 'synthetic-admin-audit-native-rate-pepper-32',
          AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64')
        },
        ratelimits: {
          ADMIN_EDGE_LIMIT: { namespace_id: '900084', simple: { limit: 100, period: 60 } },
          AUTH_EDGE_LIMIT: { namespace_id: '910084', simple: { limit: 100, period: 60 } }
        },
        d1Databases: { DB: '00000000-0000-4000-8000-000000000084' },
        outboundService: outbound
      })
    )
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database
    await syncNativeTestClock(db)
    fixture = await adminAuditFixture()
    const files = (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
    expect(files).toContain('0084_admin_audit.sql')
    expect(files).toContain('0085_admin_order_views.sql')
    expect(files.map((name) => Number(name.slice(0, 4)))).toEqual(Array.from({ length: files.length }, (_, i) => i + 1))
    for (const file of files)
      await db.batch(splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => db.prepare(sql)))
    // Only existing synthetic identities, factors and configured role catalog.
    // The source command itself below is created by the actual HTTP API.
    const seedTables = [
      'customers',
      'identities',
      'auth_sessions',
      'identity_mfa',
      'roles',
      'permissions',
      'role_permissions',
      'identity_roles'
    ]
    for (const table of seedTables) {
      const rows = fixture.sqlite.prepare('SELECT * FROM ' + table).all() as Record<string, string | number | null>[]
      for (const row of rows) {
        const columns = Object.keys(row)
        await db
          .prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
          .bind(...columns.map((column) => row[column]))
          .run()
      }
    }
    const cookie = (await issueD1SessionCookie(db, ADMIN, fixture.configuration))!.split(';')[0]!
    const foreign = (await issueD1SessionCookie(db, RECIPIENT, fixture.configuration))!.split(';')[0]!
    const send = (path: string, body?: unknown, key = testUuid(), session = cookie) =>
      runtime!.dispatchFetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: session,
          Origin: origin,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'CF-Connecting-IP': '192.0.2.84'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    const sourceKey = testUuid()
    const created = await send('/api/admin/invitations', fixture.input, sourceKey)
    expect(created.status).toBe(201)
    const eventId = 'admin_invitation:' + sourceKey
    const listResponse = await send('/api/admin/audit?family=admin_invitation')
    expect(listResponse.status).toBe(200)
    const list = adminAuditListSchema.parse(await listResponse.json())
    expect(list.items.map((item) => item.id)).toEqual([eventId])
    const path = '/api/admin/audit/' + encodeURIComponent(eventId)
    const reviewKey = testUuid(),
      body = { expectedVersion: 0, disposition: 'reviewed', reason: 'Revisión sintética explícita del registro.' }
    const reviewResponse = await send(path + '/reviews', body, reviewKey)
    expect(reviewResponse.status).toBe(201)
    const receipt = adminAuditReceiptSchema.parse(await reviewResponse.json())
    expect(receipt).toMatchObject({ action: 'review', commandId: reviewKey, eventId, version: 1 })
    expect(await (await send(path + '/reviews', body, reviewKey)).json()).toEqual(receipt)
    const recovered = adminAuditCommandSchema.parse(
      await (await send(`/api/admin/audit/commands/${reviewKey}?payloadHash=${receipt.payloadHash}`)).json()
    )
    expect(recovered).toMatchObject({ outcome: 'applied', receipt })
    const detail = adminAuditDetailSchema.parse(await (await send(path)).json())
    expect(detail.item.reviewVersion).toBe(1)
    expect(detail.reviews).toHaveLength(1)
    const exportResponse = await send('/api/admin/audit/exports', {
      filters: { family: 'admin_invitation' },
      reason: 'Exportación sintética autorizada del registro.'
    })
    expect(exportResponse.status).toBe(201)
    const exported = adminAuditReceiptSchema.parse(await exportResponse.json())
    expect(exported.action).toBe('export')
    if (exported.action !== 'export') throw new Error('native_export_receipt')
    const protectedTables = [
      'identities',
      'auth_sessions',
      'identity_roles',
      'identity_mfa',
      'customers',
      'orders',
      'order_lines',
      'inventory_balances',
      'inventory_movements',
      'payment_intents',
      'admin_invitation_commands',
      'admin_audit_commands'
    ]
    const snapshot = () =>
      Promise.all(
        protectedTables.map(
          async (table) => (await db.prepare('SELECT * FROM ' + table + ' ORDER BY 1 LIMIT 100').all()).results
        )
      )
    const before = await snapshot()
    const download = await send(`/api/admin/audit/exports/${exported.commandId}/download`)
    expect(download.status).toBe(200)
    expect(download.headers.get('cache-control')).toBe('private, no-store')
    const bytes = new Uint8Array(await download.arrayBuffer()),
      csv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    expect(Array.from(bytes.slice(0, 3))).toEqual([239, 187, 191])
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(bytes.byteLength).toBe(exported.bytes)
    expect(await adminAuditHash(csv)).toBe(exported.digest)
    expect(csv).not.toContain(fixture.input.recipientEmail)
    expect(csv).not.toContain(fixture.input.tokenHash)
    expect(csv).not.toContain(body.reason)
    expect((await send(path, undefined, undefined, foreign)).status).toBe(403)
    expect((await send(path, undefined, undefined, '')).status).toBe(401)
    expect(await snapshot()).toEqual(before)
    await db
      .prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?')
      .bind(new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z'), ADMIN.sessionId)
      .run()
    expect((await send(`/api/admin/audit/exports/${exported.commandId}/download`)).status).toBe(401)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    fixture?.sqlite.close()
    await runtime?.dispose()
  }
}, 120000)
