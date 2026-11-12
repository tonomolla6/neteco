import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { convertV4MiniflareOptions, Miniflare, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { shippingCalendarIntentHash } from '../../shared/shipping-calendar'
import { supportEscalationIntentHash } from '../../shared/support-escalations'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import worker from '../../workers/canary'
import { createSupportTicket } from '../../workers/support/operations'
import { CONTACT, POLICY } from './d1-support-fixture'
import { testUuid } from '../support/deterministic'

it('persists calendar and internal escalation receipts through canary.fetch and actual workerd D1, without provider or economic effects', async () => {
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'operations-batch-native',
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000079' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
    expect(migrations).toEqual(expect.arrayContaining(['0078_shipping_calendars.sql', '0079_support_escalations.sql']))
    expect(migrations.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: migrations.length }, (_, i) => i + 1)
    )
    for (const name of migrations) {
      const statements = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
      for (let offset = 0; offset < statements.length; offset += 50)
        await database.batch(statements.slice(offset, offset + 50).map((sql) => database.prepare(sql)))
    }
    const now = (await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now").first<{ now: string }>())!
      .now
    const actor = testUuid(),
      session = testUuid()
    await database.batch([
      database.prepare("INSERT INTO roles VALUES('operations-native','Synthetic operations','Synthetic')"),
      database.prepare(
        "INSERT OR IGNORE INTO permissions VALUES('administration.manage','administration','manage','Synthetic'),('support.manage','support','manage','Synthetic')"
      ),
      database.prepare(
        "INSERT INTO role_permissions VALUES('operations-native','administration.manage'),('operations-native','support.manage')"
      ),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,'operations-native@example.invalid','synthetic',?,'active',?,?)"
        )
        .bind(actor, now, now, now),
      database
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'operations-native',?)")
        .bind(actor, now),
      database
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,'2099-01-01T00:00:00Z')"
        )
        .bind(session, actor, now)
    ])
    const origin = 'https://operations-native.neteco.test',
      password = 'synthetic-native-operations-password-over-32'
    const cookie = (await issueD1SessionCookie(
      database,
      { identityId: actor, sessionId: session, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      SUPPORT_ENABLED: 'true',
      DB: database,
      AUTH_ORIGIN: origin,
      SUPPORT_POLICY: JSON.stringify(POLICY),
      NUXT_SESSION_PASSWORD: password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-native-operations-pepper-over-32',
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) }
    } as unknown as CloudflareEnv
    const send = (path: string, input?: unknown, key = testUuid(), hash?: string) =>
      worker.fetch(
        new Request(origin + path, {
          method: input === undefined ? 'GET' : 'POST',
          headers: {
            cookie,
            origin,
            'CF-Connecting-IP': '192.0.2.79',
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
            ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) })
        }),
        env
      )
    const calendarPath = '/api/admin/shipping/calendars',
      calendarKey = testUuid()
    const calendarInput = {
      expectedVersion: 0,
      reason: 'Synthetic native calendar review',
      reviewReference: 'NATIVE-78',
      configuration: {
        timeZone: 'Europe/Madrid',
        preparationBusinessDays: 1,
        cutoffLocalTime: '14:00',
        calendars: [
          {
            code: 'synthetic-native',
            name: 'Synthetic explicit operating calendar',
            scope: 'national',
            stage: 'both',
            operatingWeekdays: [1, 2, 3, 4, 5],
            closedDates: ['2026-10-12'],
            postalPrefixes: [],
            methodCodes: [],
            serviceProfiles: [],
            zoneCodes: []
          }
        ]
      }
    }
    expect(await (await send(calendarPath)).json()).toMatchObject({ version: 0, configuration: null })
    const calendarResponse = await send(calendarPath + '/commands', calendarInput, calendarKey)
    expect(calendarResponse.status).toBe(201)
    const calendarReceipt = await calendarResponse.json()
    expect(
      await (
        await send(
          calendarPath + '/commands/' + calendarKey,
          undefined,
          undefined,
          await shippingCalendarIntentHash(calendarInput)
        )
      ).json()
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt: calendarReceipt })
    expect(await (await send(calendarPath + '/commands', calendarInput, calendarKey)).json()).toEqual(calendarReceipt)
    const ticket = await createSupportTicket(
      database,
      { kind: 'anonymous', claims: null, customerId: null, key: 'anonymous:' + 'a'.repeat(64) },
      CONTACT,
      { idempotencyKey: testUuid(), policy: POLICY }
    )
    const economicTables = [
      'inventory_balances',
      'inventory_movements',
      'orders',
      'order_payment_states',
      'fiscal_invoice_intents',
      'email_outbox_events'
    ]
    const economic = async () =>
      Promise.all(
        economicTables.map(async (table) => ({
          table,
          rows: (await database.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()).results
        }))
      )
    const before = await economic(),
      runbookId = testUuid(),
      runbookPath = '/api/admin/support/escalations/runbooks/' + runbookId + '/commands'
    expect(
      (
        await send(runbookPath, {
          action: 'draft',
          expectedVersion: 0,
          queue: 'payment',
          title: 'Synthetic native internal review',
          body: 'PRIVATE_NATIVE_RUNBOOK Read existing payment evidence. No charges, refunds or communications.',
          reason: 'Synthetic native internal runbook draft'
        })
      ).status
    ).toBe(201)
    expect(
      (
        await send(runbookPath, {
          action: 'approve',
          expectedVersion: 1,
          operationalReference: 'NATIVE-79',
          reviewedAt: now,
          expiresAt: '2099-01-01T00:00:00Z',
          reason: 'Synthetic native explicit runbook review'
        })
      ).status
    ).toBe(201)
    const escalationPath = '/api/admin/support/' + ticket.publicRef + '/escalation',
      key = testUuid()
    const input = {
      action: 'handoff',
      expectedVersion: 0,
      expectedTicketVersion: ticket.version,
      queue: 'payment',
      severity: 'high',
      ownerId: actor,
      runbook: { id: runbookId, version: 2 },
      nextAction: 'PRIVATE_NATIVE_HANDOFF Inspect the existing payment receipt',
      nextActionAt: '2098-01-01T00:00:00Z',
      reason: 'Synthetic native internal escalation review'
    }
    const result = await send(escalationPath + '/commands', input, key)
    expect(result.status).toBe(201)
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    const receipt = await result.json()
    expect(receipt).toMatchObject({
      commandId: key,
      version: 1,
      inventoryEffect: 'none',
      economicEffect: 'none',
      communicationEffect: 'none'
    })
    expect(
      await (
        await send(
          escalationPath + '/commands/' + key,
          undefined,
          undefined,
          await supportEscalationIntentHash(ticket.publicRef, input)
        )
      ).json()
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(await (await send(escalationPath + '/commands', input, key)).json()).toEqual(receipt)
    expect(await economic()).toEqual(before)
    expect(await database.prepare('SELECT count(*) AS n FROM shipping_calendar_commands').first()).toEqual({ n: 1 })
    expect(
      await database
        .prepare("SELECT count(*) AS n FROM support_escalation_commands WHERE target_kind='escalation'")
        .first()
    ).toEqual({ n: 1 })
    await database.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').bind(session).run()
    expect((await send(calendarPath + '/commands', calendarInput, calendarKey)).status).toBe(403)
    expect((await send(escalationPath + '/commands', input, key)).status).toBe(403)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 45000)
