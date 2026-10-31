import { readFile, readdir } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { build } from 'esbuild'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { adminAuditFixture, ADMIN, utc } from './d1-admin-audit-fixture'
import { createPackingOrder, REASON } from './d1-order-packing-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  adminOrderBulkPreviewSchema,
  adminOrderBulkReceiptSchema,
  adminOrderBulkGroupSchema,
  adminOrderBulkIntentHash
} from '../../shared/admin-order-bulk'

it('runs bounded bulk preparation and cursor pages through actual canary SOURCE with workerd D1/all86 and no outbound', async () => {
  const fixture = await adminAuditFixture(),
    outbound = vi.fn(() => {
      throw new Error('outbound_forbidden')
    })
  let runtime: Miniflare | undefined
  try {
    const origin = 'https://bulk-native.neteco.test'
    // Test-only queue transport invokes the actual canary handler INSIDE workerd.
    // It observes ACK/retry/send, never fabricates core receipts or HTTP DTOs.
    const bundle = await build({
      stdin: {
        contents: `import worker from './workers/canary';
    export default {async fetch(request,env,ctx){
      if(new URL(request.url).pathname!=='/__test_bulk_queue')return worker.fetch(request,env,ctx);
      const body=await request.json(),sent=[];let acks=0,retries=0;
      await worker.queue({queue:'synthetic-bulk',messages:[{id:crypto.randomUUID(),timestamp:new Date(),body,attempts:1,ack(){acks++},retry(){retries++}}],ackAll(){throw new Error('unexpected_ackAll')},retryAll(){throw new Error('unexpected_retryAll')}},{...env,ASYNC_JOBS:{async send(value){sent.push(value)}}},ctx);
      return Response.json({acks,retries,sent});
    }};`,
        resolveDir: process.cwd(),
        sourcefile: 'bulk-native-entry.ts',
        loader: 'ts'
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      external: ['node:*', 'cloudflare:*'],
      write: false,
      logLevel: 'silent'
    })
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'bulk-native',
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
          NUXT_SESSION_PASSWORD: fixture.configuration.password,
          AUTH_RATE_LIMIT_PEPPER: 'synthetic-bulk-native-rate-pepper-0123456789'
        },
        ratelimits: { ADMIN_EDGE_LIMIT: { namespace_id: '900086', simple: { limit: 100, period: 60 } } },
        d1Databases: { DB: '00000000-0000-4000-8000-000000000086' },
        outboundService: outbound
      })
    )
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const files = (await readdir('db/d1/migrations')).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort()
    expect(files).toHaveLength(152)
    expect(files.map((file) => Number(file.slice(0, 4)))).toEqual(Array.from({ length: 152 }, (_, index) => index + 1))
    for (const file of files)
      await database.batch(
        splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => database.prepare(sql))
      )
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
        await database
          .prepare(
            `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
              .map(() => '?')
              .join(',')})`
          )
          .bind(...Object.values(row))
          .run()
    }
    const seeds: D1PreparedStatement[] = []
    seedInventoryFixture({
      exec(sql: string) {
        for (const statement of splitDemoSql(sql)) seeds.push(database.prepare(statement))
      },
      prepare(sql: string) {
        return {
          run(...args: unknown[]) {
            seeds.push(database.prepare(sql).bind(...args))
          }
        }
      }
    } as unknown as DatabaseSync)
    await database.batch(seeds)
    await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: utc(-60000) })
    await database.batch([
      database
        .prepare(
          "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('bulk-native-pickup','bulk-native-pickup','Synthetic pickup','warehouse_pickup','[]',1,?)"
        )
        .bind(utc(-60000)),
      database
        .prepare(
          "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('bulk-native-rate','bulk-native-pickup','pickup','parcel',0,2100,0,0,1,1,?)"
        )
        .bind(utc(-60000))
    ])
    const first = await createPackingOrder(database, { method: 'pickup', stage: 'pending' }),
      second = await createPackingOrder(database, { method: 'pickup', stage: 'pending' })
    const cookie = (await issueD1SessionCookie(database, ADMIN, fixture.configuration))!.split(';')[0]!
    const send = (path: string, method = 'GET', body?: unknown, key?: string) =>
      runtime!.dispatchFetch(origin + path, {
        method,
        headers: {
          cookie,
          origin,
          'CF-Connecting-IP': '192.0.2.86',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    const cursorFirst = await send('/api/admin/orders?pagination=cursor&perPage=1')
    expect(cursorFirst.status).toBe(200)
    const page1 = (await cursorFirst.json()) as {
      items: Array<{ id: string }>
      pagination: { mode: string; nextCursor: string | null }
    }
    expect(page1.items).toHaveLength(1)
    expect(page1.pagination.mode).toBe('cursor')
    expect(page1.pagination.nextCursor).toEqual(expect.any(String))
    const cursorSecond = await send(
      '/api/admin/orders?pagination=cursor&perPage=1&page=2&after=' + encodeURIComponent(page1.pagination.nextCursor!)
    )
    expect(cursorSecond.status).toBe(200)
    const page2 = (await cursorSecond.json()) as { items: Array<{ id: string }> }
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id)
    const economy = async () => {
      const result = await database.batch(
        [
          'orders',
          'order_lines',
          'order_payment_states',
          'payment_intents',
          'inventory_balances',
          'inventory_movements',
          'inventory_reservations',
          'inventory_reservation_lines'
        ].map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`))
      )
      return result.map((item) => item.results)
    }
    const before = await economy(),
      base = '/api/admin/orders/bulk-fulfillment'
    const previewResponse = await send(base + '/preview', 'POST', {
      action: 'picking',
      orderIds: [first, second, crypto.randomUUID()],
      reason: REASON
    })
    expect(previewResponse.status).toBe(200)
    const preview = adminOrderBulkPreviewSchema.parse(await previewResponse.json())
    expect(preview).toMatchObject({ eligible: 2, blocked: 1 })
    const input = {
        action: preview.action,
        orders: preview.rows.map(({ orderId, expectedVersion }) => ({ orderId, expectedVersion })),
        reason: REASON,
        previewHash: preview.previewHash
      },
      key = crypto.randomUUID()
    const created = await send(base + '/commands', 'POST', input, key)
    expect(created.status).toBe(201)
    const receipt = adminOrderBulkReceiptSchema.parse(await created.json())
    expect(await (await send(base + '/commands', 'POST', input, key)).json()).toEqual(receipt)
    expect(
      await (await send(base + '/commands/' + key + '?payloadHash=' + (await adminOrderBulkIntentHash(input)))).json()
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    const messageBody = { type: 'admin.order-bulk.requested', groupId: receipt.groupId, dispatchId: receipt.dispatchId }
    async function deliver(body: unknown) {
      const response = await runtime!.dispatchFetch(origin + '/__test_bulk_queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      expect(response.status).toBe(200)
      const result = (await response.json()) as { acks: number; retries: number; sent: unknown[] }
      expect(result.acks + result.retries).toBe(1)
      expect(result.acks).toBeGreaterThanOrEqual(0)
      expect(result.retries).toBeGreaterThanOrEqual(0)
      return result
    }
    const initial = await deliver(messageBody)
    expect(initial).toMatchObject({ acks: 1, retries: 0 })
    expect(initial.sent).toContainEqual(messageBody)
    const concurrent = await Promise.all([deliver(messageBody), deliver(messageBody)])
    expect(concurrent.some((result) => result.acks === 1)).toBe(true)
    const groupResponse = await send(base + '/' + receipt.groupId)
    expect(groupResponse.status).toBe(200)
    const group = adminOrderBulkGroupSchema.parse(await groupResponse.json())
    expect(group).toMatchObject({ status: 'completed', selected: 3, completed: 3, remaining: 0 })
    expect(group.rows.filter((row) => row.status === 'applied')).toHaveLength(2)
    expect(group.rows.filter((row) => row.status === 'not_attempted')).toHaveLength(1)
    expect(await economy()).toEqual(before)
    expect(await database.prepare('SELECT count(*) n FROM order_fulfillment_commands').first()).toEqual({ n: 2 })
    await database.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(utc(), ADMIN.sessionId).run()
    expect(
      (await send(base + '/commands/' + key + '?payloadHash=' + (await adminOrderBulkIntentHash(input)))).status
    ).toBe(401)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime?.dispose()
    fixture.sqlite.close()
  }
}, 120000)
