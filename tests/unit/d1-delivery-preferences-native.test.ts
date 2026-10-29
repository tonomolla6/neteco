import { readFile, readdir } from 'node:fs/promises'
import { it, expect, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import worker from '../../workers/canary'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { preferenceSeeds, CLAIMS, ACTOR, BEFORE } from './d1-account-preferences-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  DELIVERY_PREFERENCES_POLICY_VERSION as POLICY,
  deliveryPreferenceIntentHash,
  deliveryPreferencesSnapshotSchema,
  deliveryPreferencesReceiptSchema,
  deliveryPreferencesCommandSchema
} from '../../shared/delivery-preferences'

it('serves delivery choices through actual canary.fetch/workerd D1/all71 with live owner, durable recovery and no sends or critical mutations', async () => {
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'delivery-preferences-native',
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000070' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
    expect(migrations.map((name) => Number(name.slice(0, 4)))).toEqual(Array.from({ length: 71 }, (_, i) => i + 1))
    for (const name of migrations)
      await database.batch(
        splitDemoSql(await readFile('db/d1/migrations/' + name, 'utf8')).map((sql) => database.prepare(sql))
      )
    await database.batch(preferenceSeeds().map((sql) => database.prepare(sql)))
    const otherCustomer = deterministicUuid('delivery-native-other-customer'),
      otherIdentity = deterministicUuid('delivery-native-other-identity'),
      otherSession = deterministicUuid('delivery-native-other-session')
    await database.batch([
      database
        .prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)')
        .bind(otherCustomer, BEFORE, BEFORE),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES(?,'delivery-other@example.invalid','synthetic','active',?,?,?,?)"
        )
        .bind(otherIdentity, BEFORE, otherCustomer, BEFORE, BEFORE),
      database
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,created_at,expires_at) VALUES(?,?,1,?,'2099-01-01T00:00:00Z')"
        )
        .bind(otherSession, otherIdentity, BEFORE)
    ])
    const origin = 'https://delivery-native.neteco.test',
      configuration = { password: 'synthetic-delivery-native-cookie-password-more32', maxAgeSeconds: 3600 }
    const cookie = (await issueD1SessionCookie(database, CLAIMS, configuration))!.split(';')[0]!
    const foreign = (await issueD1SessionCookie(
      database,
      { identityId: otherIdentity, sessionId: otherSession, sessionVersion: 1 },
      configuration
    ))!.split(';')[0]!
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: configuration.password,
      AUTH_TOKEN_PEPPER: 'synthetic-delivery-native-auth-token-pepper-over32',
      AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-delivery-native-edge-pepper-over32',
      AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      DB: database
    } as unknown as CloudflareEnv
    const key = deterministicUuid('delivery-native-command'),
      body = { expectedVersion: 0, deliveryUpdates: false, policyVersion: POLICY },
      hash = await deliveryPreferenceIntentHash(body)
    const dispatch = (tail = '', method = 'GET', credential = cookie, input = body) =>
      worker.fetch(
        new Request(origin + '/api/account/delivery-preferences' + tail, {
          method,
          headers: {
            Origin: origin,
            'CF-Connecting-IP': '192.0.2.70',
            Cookie: credential,
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
            'X-Neteco-Command-Payload-Hash': hash
          },
          ...(method === 'PUT' ? { body: JSON.stringify(input) } : {})
        }),
        env
      )
    const tables = [
      'customers',
      'identities',
      'orders',
      'order_lines',
      'order_payment_states',
      'payment_intents',
      'payment_events',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'newsletter_subscriptions',
      'newsletter_consent_events',
      'transactional_email_deliveries',
      'operational_email_suppressions'
    ]
    const snapshot = () =>
      Promise.all(
        tables.map(async (table) => (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
      )
    const before = await snapshot()
    const initial = await dispatch()
    expect(initial.status).toBe(200)
    expect(deliveryPreferencesSnapshotSchema.parse(await initial.json())).toMatchObject({
      version: 0,
      deliveryUpdates: true,
      updatedAt: null
    })
    const applied = await dispatch('', 'PUT')
    expect(applied.status).toBe(200)
    const receipt = deliveryPreferencesReceiptSchema.parse(await applied.json())
    expect(receipt).toMatchObject({ commandId: key, version: 1, deliveryUpdates: false })
    expect(await (await dispatch('', 'PUT')).json()).toEqual(receipt)
    const recovered = await dispatch('/commands/' + key)
    expect(recovered.status).toBe(200)
    expect(deliveryPreferencesCommandSchema.parse(await recovered.json())).toMatchObject({
      outcome: 'applied',
      receipt
    })
    for (const response of [initial, applied, recovered]) {
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(response.headers.get('Set-Cookie')).toBeNull()
    }
    expect(deliveryPreferencesSnapshotSchema.parse(await (await dispatch()).json())).toMatchObject({
      version: 1,
      deliveryUpdates: false
    })
    expect(await (await dispatch('/commands/' + key, 'GET', foreign)).json()).toMatchObject({
      outcome: 'unknown',
      receipt: null
    })
    expect(await (await dispatch('', 'GET', foreign)).json()).toMatchObject({ version: 0, deliveryUpdates: true })
    expect((await dispatch('', 'GET', '')).status).toBe(401)
    expect(
      await database.prepare('SELECT count(*) n FROM delivery_preference_commands WHERE actor_id=?').bind(ACTOR).first()
    ).toEqual({ n: 1 })
    expect(await snapshot()).toEqual(before)
    const logout = await worker.fetch(
      new Request(origin + '/api/auth/logout', {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'CF-Connecting-IP': '192.0.2.70' }
      }),
      env
    )
    expect(logout.status).toBe(200)
    expect((await dispatch()).status).toBe(401)
    expect((await dispatch('/commands/' + key)).status).toBe(401)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 30_000)
