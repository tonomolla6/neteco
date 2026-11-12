import { readFile, readdir } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { ADMIN, RECIPIENT, utc } from './d1-admin-invitations-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { emitSecurityAnomalySignal, securityAnomalyIntentHash } from '../../workers/auth/security-anomalies'
import { testNow, testUuid } from '../support/deterministic'

vi.mock('../support/d1-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/d1-sqlite')>()
  return {
    ...original,
    openMigratedDatabase: async (...args: Parameters<typeof original.openMigratedDatabase>) => {
      const sqlite = await original.openMigratedDatabase(...args)
      sqlite.function('synthetic_security_anomaly_clock', () => {
        const clock = vi.getMockedSystemTime()
        if (!clock) throw new Error('missing_synthetic_security_anomaly_clock')
        return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      const exec = sqlite.exec.bind(sqlite)
      sqlite.exec = (sql: string) => exec(sql.replaceAll("'now'", 'synthetic_security_anomaly_clock()'))
      return sqlite
    },
    d1OverSqlite: (sqlite: Parameters<typeof original.d1OverSqlite>[0]) => {
      const database = original.d1OverSqlite(sqlite),
        prepare = database.prepare.bind(database)
      database.prepare = (sql: string) => prepare(sql.replaceAll("'now'", 'synthetic_security_anomaly_clock()'))
      return database
    }
  }
})

const ORIGIN = 'https://security.neteco.test'

const SECURITY_READER = {
  identityId: '33333333-3333-4333-8333-333333333391',
  sessionId: '33333333-3333-4333-8333-333333333392',
  sessionVersion: 1
}

const NON_SECURITY_ADMIN = {
  identityId: '44444444-4444-4444-8444-444444444491',
  sessionId: '44444444-4444-4444-8444-444444444492',
  sessionVersion: 1
}

async function securityAnomaliesHttpFixture() {
  const sqlite = await openMigratedDatabase()
  const database = d1OverSqlite(sqlite)
  const directory = new URL('../../db/d1/migrations/', import.meta.url)
  const files = (await readdir(directory))
    .filter((file) => {
      const number = Number(file.slice(0, 4))
      return number >= 63 && number <= 93 && number !== 91 && file.endsWith('.sql')
    })
    .sort()
  const statements = await Promise.all(files.map((file) => readFile(new URL(file, directory), 'utf8')))
  sqlite.exec(`BEGIN;\n${statements.join('\n')}\nCOMMIT;`)

  const past = utc(-120000)
  const future = utc(8 * 86400000)

  for (const [claims, email, isCustomer] of [
    [ADMIN, 'sec-admin@example.invalid', false],
    [SECURITY_READER, 'sec-reader@example.invalid', false],
    [NON_SECURITY_ADMIN, 'non-sec-admin@example.invalid', false],
    [RECIPIENT, 'customer@example.invalid', true]
  ] as const) {
    const customerId = isCustomer ? testUuid() : null
    if (customerId) {
      sqlite
        .prepare("INSERT INTO customers(id,status,created_at,updated_at) VALUES(?,'active',?,?)")
        .run(customerId, past, past)
    }
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,session_version,customer_id,created_at,updated_at) VALUES(?,?,'synthetic-password',?,'active',1,?,?,?)"
      )
      .run(claims.identityId, email, past, customerId, past, past)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
      )
      .run(claims.sessionId, claims.identityId, past, future)
    sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-not-production','[]',?,?)"
      )
      .run(claims.identityId, past, past)
  }

  sqlite.exec(`
    INSERT INTO roles VALUES
      ('security_admin','Security Admin','Full security anomaly management'),
      ('security_reader','Security Reader','Read-only security anomaly access'),
      ('general_admin','General Admin','Non-security administrative role');
    INSERT INTO permissions VALUES
      ('security.read','security','read','Read security anomalies'),
      ('security.manage','security','manage','Manage security anomalies'),
      ('administration.manage','administration','manage','General administration');
    INSERT INTO role_permissions VALUES
      ('security_admin','security.read'),
      ('security_admin','security.manage'),
      ('security_admin','administration.manage'),
      ('security_reader','security.read'),
      ('general_admin','administration.manage');
  `)

  sqlite.prepare("INSERT INTO identity_roles VALUES(?,'security_admin',NULL,?,NULL)").run(ADMIN.identityId, past)
  sqlite
    .prepare("INSERT INTO identity_roles VALUES(?,'security_reader',NULL,?,NULL)")
    .run(SECURITY_READER.identityId, past)
  sqlite
    .prepare("INSERT INTO identity_roles VALUES(?,'general_admin',NULL,?,NULL)")
    .run(NON_SECURITY_ADMIN.identityId, past)

  const configuration = {
    password: 'synthetic-security-anomalies-cookie-password-0123456789',
    maxAgeSeconds: 3600
  }
  const cookie = async (claims = ADMIN) => (await issueD1SessionCookie(database, claims, configuration))!.split(';')[0]!

  return { sqlite, database, configuration, cookie }
}

describe('SEC-035 HTTP admin security anomaly inbox mounted on workers/canary.ts', () => {
  let f: Awaited<ReturnType<typeof securityAnomaliesHttpFixture>>
  let signalId: string
  let env: CloudflareEnv

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow() + 1000)
    f = await securityAnomaliesHttpFixture()
    const emitted = await emitSecurityAnomalySignal(f.database, {
      sourceKey: 'http-seed-signal-1',
      type: 'admin_new_device_login',
      severity: 'high',
      reasonCode: 'admin_login_new_device_fingerprint',
      actorId: ADMIN.identityId,
      actorSessionId: ADMIN.sessionId,
      objectType: 'auth_session',
      objectId: ADMIN.sessionId,
      ipHash: 'a'.repeat(64),
      userAgentHash: 'b'.repeat(64),
      context: {
        knownDeviceCountBefore: 1,
        ip: '198.51.100.42',
        userAgent: 'RawSecretBrowser/1.0'
      }
    })
    signalId = emitted.signal.id

    env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      EMAIL_ENABLED: 'false',
      DB: f.database,
      AUTH_ORIGIN: ORIGIN,
      NUXT_SESSION_PASSWORD: f.configuration.password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-security-anomalies-rate-pepper-32',
      AUTH_TOKEN_PEPPER: 'synthetic-security-anomalies-token-pepper-32',
      AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) }
    } as unknown as CloudflareEnv
  })

  afterEach(() => {
    f?.sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  async function send(
    path = '/api/admin/security/anomalies',
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
    claims = ADMIN,
    environment = env
  ) {
    return worker.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          cookie: headers.cookie ?? (await f.cookie(claims)),
          'CF-Connecting-IP': '198.51.100.77',
          'User-Agent': 'NetEcoSecurityConsole/1.0',
          ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
          ...headers
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
      }),
      environment
    )
  }

  function expectPrivateHeaders(response: Response) {
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
    expect(response.headers.get('set-cookie')).toBeNull()
  }

  it('lists and inspects security anomalies over GET with private headers and zero raw PII', async () => {
    const listResponse = await send('/api/admin/security/anomalies?severity=high&type=admin_new_device_login&limit=5')
    expect(listResponse.status).toBe(200)
    expectPrivateHeaders(listResponse)
    const listBody = (await listResponse.json()) as {
      source: string
      items: Array<{ id: string; type: string; severity: string; status: string }>
      nextCursor: string | null
    }
    expect(listBody.source).toBe('cloudflare')
    expect(listBody.items.map((item) => item.id)).toEqual([signalId])

    const detailResponse = await send(`/api/admin/security/anomalies/${signalId}`)
    expect(detailResponse.status).toBe(200)
    expectPrivateHeaders(detailResponse)
    const detailBody = (await detailResponse.json()) as {
      source: string
      item: { id: string; status: string; version: number }
      transitions: unknown[]
    }
    expect(detailBody.item).toMatchObject({
      id: signalId,
      status: 'open',
      version: 1
    })
    const rawJson = JSON.stringify({ listBody, detailBody })
    expect(rawJson).not.toContain('198.51.100.42')
    expect(rawJson).not.toContain('RawSecretBrowser')
    expect(rawJson).not.toContain('198.51.100.77')
  })

  it('acknowledges once, replays the exact receipt on retry, and recovers the command via GET without re-writing', async () => {
    const key = testUuid()
    const input = {
      expectedVersion: 1,
      note: 'Señal reconocida por el equipo de seguridad en turno.'
    }
    const ackResponse = await send(`/api/admin/security/anomalies/${signalId}/acknowledge`, 'POST', input, {
      'Idempotency-Key': key
    })
    expect(ackResponse.status).toBe(201)
    expectPrivateHeaders(ackResponse)
    const receipt = (await ackResponse.json()) as {
      action: string
      commandId: string
      signalId: string
      status: string
      version: number
      payloadHash: string
    }
    const expectedHash = await securityAnomalyIntentHash('acknowledge', signalId, input)
    expect(receipt).toMatchObject({
      action: 'acknowledge',
      commandId: key,
      signalId,
      status: 'acknowledged',
      version: 2,
      payloadHash: expectedHash
    })

    // Exact idempotent replay
    const replayResponse = await send(`/api/admin/security/anomalies/${signalId}/acknowledge`, 'POST', input, {
      'Idempotency-Key': key
    })
    expect(replayResponse.status).toBe(201)
    expect(await replayResponse.json()).toEqual(receipt)

    // Command recovery via GET
    const commandResponse = await send(`/api/admin/security/anomalies/commands/${key}?payloadHash=${expectedHash}`)
    expect(commandResponse.status).toBe(200)
    expect(await commandResponse.json()).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })

    // Verify stored transition hashed the request IP and User-Agent rather than storing raw headers
    const cmdRow = f.sqlite
      .prepare('SELECT ip_hash, user_agent_hash FROM security_anomaly_commands WHERE command_id=?')
      .get(key) as { ip_hash: string; user_agent_hash: string }
    expect(cmdRow.ip_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(cmdRow.user_agent_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('resolves a signal with a mandatory note and rejects missing note, stale CAS version, or same-key payload conflict', async () => {
    // Missing note on resolve -> 400 invalid_input
    const badNote = await send(
      `/api/admin/security/anomalies/${signalId}/resolve`,
      'POST',
      { expectedVersion: 1, note: 'ab' },
      { 'Idempotency-Key': testUuid() }
    )
    expect(badNote.status).toBe(400)
    expect(await badNote.json()).toEqual({ error: { code: 'invalid_input' } })

    // Stale version -> 409 version_conflict
    const staleVersion = await send(
      `/api/admin/security/anomalies/${signalId}/resolve`,
      'POST',
      { expectedVersion: 99, note: 'Intento con versión errónea.' },
      { 'Idempotency-Key': testUuid() }
    )
    expect(staleVersion.status).toBe(409)
    expect(await staleVersion.json()).toEqual({ error: { code: 'version_conflict' } })

    // Valid resolve from open (version 1 -> 2)
    const resolveKey = testUuid()
    const resolveInput = {
      expectedVersion: 1,
      note: 'Resuelta tras comprobar con el usuario la huella del navegador.'
    }
    const resolveResponse = await send(`/api/admin/security/anomalies/${signalId}/resolve`, 'POST', resolveInput, {
      'Idempotency-Key': resolveKey
    })
    expect(resolveResponse.status).toBe(201)
    const resolveReceipt = (await resolveResponse.json()) as { status: string; version: number }
    expect(resolveReceipt).toMatchObject({ status: 'resolved', version: 2 })

    // Reusing same Idempotency-Key with different note -> 409 idempotency_conflict
    const conflictResponse = await send(
      `/api/admin/security/anomalies/${signalId}/resolve`,
      'POST',
      { expectedVersion: 1, note: 'Nota diferente reutilizando la misma clave.' },
      { 'Idempotency-Key': resolveKey }
    )
    expect(conflictResponse.status).toBe(409)
    expect(await conflictResponse.json()).toEqual({ error: { code: 'idempotency_conflict' } })

    // Trying to acknowledge after resolved -> 409 invalid_transition
    const invalidTransition = await send(
      `/api/admin/security/anomalies/${signalId}/acknowledge`,
      'POST',
      { expectedVersion: 2, note: 'Intentando reconocer tras resolver.' },
      { 'Idempotency-Key': testUuid() }
    )
    expect(invalidTransition.status).toBe(409)
    expect(await invalidTransition.json()).toEqual({ error: { code: 'invalid_transition' } })
  })

  it('enforces specific security permissions: security.read can GET but not POST, administration.manage alone is forbidden', async () => {
    // security_reader (has security.read, not security.manage) can GET list and detail
    const readerList = await send('/api/admin/security/anomalies', 'GET', undefined, {}, SECURITY_READER)
    expect(readerList.status).toBe(200)
    const readerDetail = await send(`/api/admin/security/anomalies/${signalId}`, 'GET', undefined, {}, SECURITY_READER)
    expect(readerDetail.status).toBe(200)

    // security_reader cannot POST acknowledge or resolve
    const readerAck = await send(
      `/api/admin/security/anomalies/${signalId}/acknowledge`,
      'POST',
      { expectedVersion: 1, note: 'Lectura intentando escribir.' },
      { 'Idempotency-Key': testUuid() },
      SECURITY_READER
    )
    expect(readerAck.status).toBe(403)
    expect(await readerAck.json()).toEqual({ error: { code: 'forbidden' } })

    // general_admin (has administration.manage, not security.read/security.manage) is denied on GET and POST
    const generalGet = await send('/api/admin/security/anomalies', 'GET', undefined, {}, NON_SECURITY_ADMIN)
    expect(generalGet.status).toBe(403)
    expect(await generalGet.json()).toEqual({ error: { code: 'forbidden' } })

    // Customer identity is denied
    const customerGet = await send('/api/admin/security/anomalies', 'GET', undefined, {}, RECIPIENT)
    expect(customerGet.status).toBe(403)
    expect(await customerGet.json()).toEqual({ error: { code: 'forbidden' } })

    // Unauthenticated request (empty cookie) -> 401
    const unauth = await send('/api/admin/security/anomalies', 'GET', undefined, { cookie: '' })
    expect(unauth.status).toBe(401)
    expect(await unauth.json()).toEqual({ error: { code: 'unauthenticated' } })

    // Missing MFA enrollment -> 403 mfa_required
    f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(SECURITY_READER.identityId)
    const mfaMissing = await send('/api/admin/security/anomalies', 'GET', undefined, {}, SECURITY_READER)
    expect(mfaMissing.status).toBe(403)
    expect(await mfaMissing.json()).toEqual({ error: { code: 'mfa_required' } })
  })

  it.each([
    [
      'cross-origin POST',
      () =>
        send(
          `/api/admin/security/anomalies/${signalId}/acknowledge`,
          'POST',
          { expectedVersion: 1 },
          { origin: 'https://evil.example', 'Idempotency-Key': testUuid() }
        ),
      403,
      'invalid_origin'
    ],
    [
      'wrong content-type on POST',
      () =>
        send(
          `/api/admin/security/anomalies/${signalId}/acknowledge`,
          'POST',
          { expectedVersion: 1 },
          { 'content-type': 'text/plain', 'Idempotency-Key': testUuid() }
        ),
      415,
      'unsupported_media_type'
    ],
    [
      'missing Idempotency-Key on POST',
      () => send(`/api/admin/security/anomalies/${signalId}/acknowledge`, 'POST', { expectedVersion: 1 }),
      400,
      'invalid_input'
    ],
    [
      'malformed JSON body on POST',
      () =>
        send(`/api/admin/security/anomalies/${signalId}/acknowledge`, 'POST', '{bad-json', {
          'Idempotency-Key': testUuid()
        }),
      400,
      'invalid_json'
    ],
    [
      'oversized JSON body on POST',
      () =>
        send(
          `/api/admin/security/anomalies/${signalId}/acknowledge`,
          'POST',
          { expectedVersion: 1, note: 'x'.repeat(5000) },
          { 'Idempotency-Key': testUuid() }
        ),
      413,
      'payload_too_large'
    ],
    ['unknown signal UUID on GET detail', () => send(`/api/admin/security/anomalies/${testUuid()}`), 404, 'not_found'],
    [
      'invalid signal ID format on GET detail',
      () => send('/api/admin/security/anomalies/not-a-uuid'),
      400,
      'invalid_input'
    ],
    [
      'unknown nested route under /api/admin/security/anomalies',
      () => send(`/api/admin/security/anomalies/${signalId}/unknown-action`, 'POST', {}),
      404,
      'not_found'
    ],
    [
      'unsupported DELETE method',
      () => send(`/api/admin/security/anomalies/${signalId}`, 'DELETE'),
      405,
      'method_not_allowed'
    ]
  ])('rejects %s with HTTP %s (%s)', async (_label, execute, expectedStatus, expectedCode) => {
    const response = await execute()
    expect(response.status).toBe(expectedStatus)
    expectPrivateHeaders(response)
    if (expectedStatus === 405) {
      expect(response.headers.get('allow')).toBe('GET, POST')
    }
    expect(await response.json()).toEqual({ error: { code: expectedCode } })
  })

  it('enforces edge rate limiting with 429 and Retry-After header', async () => {
    const limitedEnv = {
      ...env,
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: false }) }
    } as unknown as CloudflareEnv
    const response = await send('/api/admin/security/anomalies', 'GET', undefined, {}, ADMIN, limitedEnv)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(await response.json()).toEqual({ error: { code: 'rate_limited' } })
  })
})
