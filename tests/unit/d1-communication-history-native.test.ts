import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { convertV4MiniflareOptions, Miniflare, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import worker from '../../workers/canary'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { createSupportTicket } from '../../workers/support/operations'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { communicationRetryIntentHash } from '../../shared/communication-history'
import { CONTACT, POLICY } from './d1-support-fixture'

it('rearms real support preparation atomically through canary and workerd D1, without sending or allowing revoked replay', async () => {
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'communication-history-native',
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000080' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
    expect(migrations).toContain('0080_communication_history_commands.sql')
    expect(migrations.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: migrations.length }, (_, i) => i + 1)
    )
    for (const name of migrations) {
      const statements = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
      for (let offset = 0; offset < statements.length; offset += 50)
        await database.batch(statements.slice(offset, offset + 50).map((sql) => database.prepare(sql)))
    }
    let now = (await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now").first<{ now: string }>())!
      .now
    const identityId = crypto.randomUUID(),
      sessionId = crypto.randomUUID()
    await database.batch([
      database.prepare(
        "INSERT INTO roles VALUES('communication-native','Synthetic communication operator','Synthetic')"
      ),
      database.prepare(
        "INSERT OR IGNORE INTO permissions VALUES('administration.manage','administration','manage','Synthetic')"
      ),
      database.prepare("INSERT INTO role_permissions VALUES('communication-native','administration.manage')"),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,'communication-native@example.invalid','synthetic',?,'active',?,?)"
        )
        .bind(identityId, now, now, now),
      database
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'communication-native',?)")
        .bind(identityId, now),
      database
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,'2099-01-01T00:00:00Z')"
        )
        .bind(sessionId, identityId, now)
    ])
    const configuration = { password: 'synthetic-communication-native-cookie-password-32', maxAgeSeconds: 3600 }
    const cookie = (await issueD1SessionCookie(
      database,
      { identityId, sessionId, sessionVersion: 1 },
      configuration
    ))!.split(';')[0]!
    const ticket = await createSupportTicket(
      database,
      { kind: 'anonymous', claims: null, customerId: null, key: 'anonymous:' + 'a'.repeat(64) },
      CONTACT,
      { idempotencyKey: crypto.randomUUID(), policy: POLICY }
    )
    now = (await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now").first<{ now: string }>())!.now
    await publishEmailOutbox(
      database,
      {
        send: async (message) => {
          expect(await receiveEmailDispatch(database, message, now)).toBe('stored')
        }
      },
      { now, limit: 100 }
    )
    const eventId = (await database
      .prepare(
        "SELECT e.id FROM email_outbox_events e JOIN support_tickets t ON t.id=e.source_id WHERE t.public_ref=? AND e.event_type='support.ticket.received'"
      )
      .bind(ticket.publicRef)
      .first<{ id: string }>())!.id
    expect(
      await database
        .prepare('SELECT event_id FROM transactional_email_deliveries WHERE event_id=?')
        .bind(eventId)
        .first()
    ).toEqual({ event_id: eventId })
    const availableAt = new Date(Date.parse(now) + 3600000).toISOString().replace('.000Z', 'Z')
    await database
      .prepare(
        "UPDATE transactional_email_deliveries SET attempts=2,available_at=?,last_error_code='preparation_failed' WHERE event_id=?"
      )
      .bind(availableAt, eventId)
      .run()
    const origin = 'https://communication-native.neteco.test',
      env = {
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        EMAIL_ENABLED: 'false',
        SUPPORT_ENABLED: 'true',
        DB: database,
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: configuration.password,
        AUTH_RATE_LIMIT_PEPPER: 'synthetic-communication-native-pepper-32',
        ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) }
      } as unknown as CloudflareEnv
    const input = {
        expectedAttempts: 2,
        expectedAvailableAt: availableAt,
        reason: 'Revisada la preparación local sin contactar al proveedor.'
      },
      key = crypto.randomUUID()
    const hash = await communicationRetryIntentHash(eventId, input),
      base = '/api/admin/communications/history'
    const send = (path: string, body?: unknown) =>
      worker.fetch(
        new Request(origin + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            cookie,
            origin,
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '192.0.2.80',
            'Idempotency-Key': key,
            'X-Neteco-Command-Payload-Hash': hash
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        }),
        env
      )
    const countBefore = await database.prepare('SELECT count(*) AS n FROM email_outbox_events').first()
    const response = await send(base + '/' + encodeURIComponent(eventId) + '/commands', input)
    expect(response.status).toBe(201)
    const receipt = await response.json()
    expect(receipt).toMatchObject({
      commandId: key,
      eventId,
      attempts: 2,
      senderInvoked: false,
      attemptsReset: false,
      preparation: 'retry_requested'
    })
    expect(await (await send(base + '/commands/' + key)).json()).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })
    expect(await (await send(base + '/' + encodeURIComponent(eventId) + '/commands', input)).json()).toEqual(receipt)
    const list = await send(base)
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      items: [expect.objectContaining({ eventId, attempts: 2, status: 'pending' })]
    })
    expect(await database.prepare('SELECT count(*) AS n FROM email_outbox_events').first()).toEqual(countBefore)
    expect(
      await database
        .prepare(
          'SELECT status,attempts,sending_at,provider_message_id FROM transactional_email_deliveries WHERE event_id=?'
        )
        .bind(eventId)
        .first()
    ).toEqual({ status: 'pending', attempts: 2, sending_at: null, provider_message_id: null })
    await database.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(now, sessionId).run()
    expect((await send(base + '/' + encodeURIComponent(eventId) + '/commands', input)).status).toBe(401)
    expect((await send(base + '/commands/' + key)).status).toBe(401)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 120000)
