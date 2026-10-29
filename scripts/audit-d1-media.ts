import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { createEvent, sealSession } from 'h3'
import { Scrypt } from '@adonisjs/hash/drivers/scrypt'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { z } from 'zod'
import { TOTP } from 'otpauth'
import { encryptSecret, hashOpaqueToken } from '../server/utils/secrets'
import { recoveryCodeHashes } from '../server/domain/mfa'

const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), 'neteco-media-audit-'))
let runtime: Miniflare | undefined
const sessionPassword = randomBytes(32).toString('hex')
const tokenPepper = randomBytes(32).toString('hex')
const encryptionKey = randomBytes(32).toString('base64')
try {
  await execute(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      '--no-install',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--config',
      'wrangler.canary.jsonc',
      '--local',
      '--persist-to',
      directory
    ],
    { maxBuffer: 16 * 1024 * 1024 }
  )
  const bundle = await build({
    entryPoints: ['tests/support/media-runtime.ts'],
    bundle: true,
    platform: 'browser',
    external: ['node:crypto', 'node:buffer'],
    format: 'esm',
    write: false
  })
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      bindings: { SESSION_PASSWORD: sessionPassword, AUTH_RATE_LIMIT_PEPPER: tokenPepper, MFA_TEST_KEY: encryptionKey },
      ratelimits: {
        AUTH_EDGE_LIMIT: { namespace_id: '900003', simple: { limit: 30, period: 60 } },
        ADMIN_EDGE_LIMIT: { namespace_id: '900001', simple: { limit: 300, period: 60 } },
        TEST_EDGE_LIMIT: { namespace_id: '900002', simple: { limit: 2, period: 60 } }
      },
      resourcePersistencePath: join(directory, 'v3'),
      d1Databases: { DB: '00000000-0000-0000-0000-000000000000' },
      r2Buckets: { MEDIA: 'neteco-isolated-media-audit' }
    })
  )
  const local = runtime
  async function command(payload: Record<string, string>, cookie?: string) {
    return local.dispatchFetch('https://media-audit.invalid/', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: cookie ? { cookie: `neteco-session=${cookie}` } : {}
    })
  }
  async function sql(statement: string) {
    const response = await command({ operation: 'sql', sql: statement })
    assert.equal(response.status, 200, await response.clone().text())
    return z.object({ results: z.array(z.record(z.string(), z.unknown())) }).parse(await response.json())
  }
  const edgeOutcomes: string[] = []
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await command({ operation: 'edge-check' })
    assert.equal(response.status, 200)
    edgeOutcomes.push(z.object({ outcome: z.enum(['allowed', 'limited']) }).parse(await response.json()).outcome)
  }
  assert.ok(edgeOutcomes.includes('allowed'))
  assert.ok(edgeOutcomes.includes('limited'))
  const legacyPassword = new Scrypt({})
  const syntheticPassword = 'Local-only-password-probe-ñ42'
  const encoded = await legacyPassword.make(syntheticPassword)
  const passwordResponse = await command({ operation: 'password-check', encoded, password: syntheticPassword })
  assert.equal(passwordResponse.status, 200)
  const passwordResult = z
    .object({ verified: z.boolean(), wrong: z.boolean(), generated: z.string() })
    .parse(await passwordResponse.json())
  assert.equal(passwordResult.verified, true)
  assert.equal(passwordResult.wrong, false)
  assert.equal(await legacyPassword.verify(passwordResult.generated, syntheticPassword), true)
  assert.equal(legacyPassword.needsReHash(passwordResult.generated), false)
  // Synthetic MFA account, native workerd crypto and real local D1 batches.
  const mfaIdentity = '10000000-0000-4000-8000-000000000099'
  const mfaNow = '2026-09-08T12:00:00Z'
  const mfaSecret = 'JBSWY3DPEHPK3PXP'
  const recovery = 'ABCD-1234-EFAB-5678'
  await sql(`INSERT INTO identities(id, email, password_hash, status, created_at, updated_at)
    VALUES ('${mfaIdentity}', 'mfa@example.invalid', '${passwordResult.generated}', 'active', '${mfaNow}', '${mfaNow}')`)
  await sql(`INSERT INTO identity_mfa(identity_id, encrypted_secret, recovery_code_hashes, verified_at, updated_at)
    VALUES ('${mfaIdentity}', '${encryptSecret(mfaSecret, encryptionKey)}', '${JSON.stringify(recoveryCodeHashes([recovery], tokenPepper))}', '${mfaNow}', '${mfaNow}')`)
  async function issueMfa() {
    const token = randomBytes(32).toString('base64url')
    await sql(`INSERT INTO mfa_challenges(id, identity_id, session_version, token_hash, created_at, expires_at)
      VALUES ('${crypto.randomUUID()}', '${mfaIdentity}', 1, '${hashOpaqueToken(token, tokenPepper)}', '${mfaNow}', '2026-09-08T12:05:00Z')`)
    return token
  }
  async function finishMfa(challenge: string, code: string) {
    const response = await command({ operation: 'mfa-complete', challenge, code, now: mfaNow })
    assert.equal(response.status, 200, await response.clone().text())
    return z.object({ ok: z.boolean() }).parse(await response.json()).ok
  }
  const totp = new TOTP({ secret: mfaSecret }).generate({ timestamp: Date.parse(mfaNow) })
  const loginResponse = await command({
    operation: 'login',
    email: 'mfa@example.invalid',
    password: syntheticPassword,
    now: mfaNow
  })
  assert.equal(loginResponse.status, 200)
  const loginResult = z
    .object({ ok: z.literal(true), kind: z.literal('mfa_required'), challenge: z.string() })
    .parse(await loginResponse.json())
  assert.equal(
    (await sql(`SELECT count(*) AS n FROM auth_sessions WHERE identity_id = '${mfaIdentity}'`)).results[0]!.n,
    0
  )
  assert.equal(
    (
      await sql(
        `SELECT count(*) AS n FROM mfa_challenges WHERE token_hash = '${hashOpaqueToken(loginResult.challenge, tokenPepper)}'`
      )
    ).results[0]!.n,
    1
  )
  const challenges = await Promise.all(Array.from({ length: 8 }, () => issueMfa()))
  const outcomes = await Promise.all(challenges.map((token) => finishMfa(token, totp)))
  assert.equal(outcomes.filter(Boolean).length, 1)
  assert.equal(await finishMfa(await issueMfa(), totp), false)
  const recoveryChallenges = await Promise.all(Array.from({ length: 8 }, () => issueMfa()))
  const recoveryOutcomes = await Promise.all(recoveryChallenges.map((token) => finishMfa(token, recovery)))
  assert.equal(recoveryOutcomes.filter(Boolean).length, 1)
  assert.equal(
    (await sql(`SELECT count(*) AS n FROM auth_sessions WHERE identity_id = '${mfaIdentity}'`)).results[0]!.n,
    2
  )
  // Actual h3 cookie -> workerd crypto -> actual D1 session and grants.
  // Identities and credentials below are synthetic and stay in this directory.
  const identityId = '10000000-0000-4000-8000-000000000001'
  const sessionId = '20000000-0000-4000-8000-000000000001'
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const expires = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await sql(
    `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES ('${identityId}', 'audit@example.invalid', 'not-a-login-hash', '${timestamp}', 'active', '${timestamp}', '${timestamp}')`
  )
  await sql("INSERT INTO roles VALUES ('catalog_editor', 'Editor', 'Local audit')")
  await sql("INSERT INTO permissions VALUES ('catalog.write', 'catalog', 'write', 'Local audit')")
  await sql("INSERT INTO role_permissions VALUES ('catalog_editor', 'catalog.write')")
  await sql(
    `INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES ('${identityId}', 'catalog_editor', '${timestamp}')`
  )
  await sql(
    `INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES ('${sessionId}', '${identityId}', 1, 1, '${timestamp}', '${expires}')`
  )
  const socket = new Socket()
  let cookie: string
  try {
    const incoming = new IncomingMessage(socket)
    const event = createEvent(incoming, new ServerResponse(incoming))
    event.context.sessions = {
      'neteco-session': {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        data: { sessionId, sessionVersion: 1, user: { id: identityId, roles: ['admin'], mfaVerified: true } }
      }
    }
    cookie = await sealSession(event, { name: 'neteco-session', password: sessionPassword, maxAge: 3600 })
  } finally {
    socket.destroy()
  }
  async function authorization(expected: Record<string, unknown>, value?: string) {
    const response = await command({ operation: 'authorize' }, value)
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), expected)
  }
  await authorization({ allowed: false, code: 'unauthenticated' })
  await authorization({ allowed: true, identityId, sessionId }, cookie)
  await sql('DELETE FROM role_permissions')
  await authorization({ allowed: false, code: 'forbidden' }, cookie)
  await sql("INSERT INTO role_permissions VALUES ('catalog_editor', 'catalog.write')")
  await sql('UPDATE auth_sessions SET mfa_verified = 0')
  await authorization({ allowed: false, code: 'mfa_required' }, cookie)
  await sql('UPDATE auth_sessions SET mfa_verified = 1')
  await sql(`UPDATE auth_sessions SET revoked_at = '${timestamp}'`)
  await authorization({ allowed: false, code: 'unauthenticated' }, cookie)
  await authorization({ allowed: false, code: 'unauthenticated' }, `${cookie.slice(0, -3)}xxx`)

  // Exercise the real multipart HTTP handler, not the privileged upload helper.
  await sql('UPDATE auth_sessions SET revoked_at = NULL')
  function multipart(extra?: string, oversize = false) {
    const form = new FormData()
    form.set(
      'file',
      new File([oversize ? new Uint8Array(10 * 1024 * 1024 + 1) : '%PDF-1.7 local audit original'], 'manual.pdf', {
        type: 'application/pdf'
      })
    )
    form.set('ownerName', 'Local fixture')
    form.set('license', 'Test-only fixture')
    form.set('authorizedAt', timestamp.slice(0, 10))
    form.set('altText', 'Manual de prueba')
    if (extra) form.append(extra, 'untrusted')
    return form
  }
  async function uploadHttp(headers: Record<string, string>, extra?: string, oversize = false) {
    const encoded = new Response(multipart(extra, oversize))
    return local.dispatchFetch('https://media-audit.invalid/api/admin/media', {
      method: 'POST',
      body: await encoded.arrayBuffer(),
      headers: { 'content-type': encoded.headers.get('content-type')!, 'cf-connecting-ip': '192.0.2.1', ...headers }
    })
  }
  const uploadHeaders = {
    cookie: `neteco-session=${cookie}`,
    origin: 'https://media-audit.invalid',
    'idempotency-key': 'http-upload'
  }
  assert.equal((await uploadHttp({ origin: 'https://media-audit.invalid' })).status, 401)
  assert.equal((await uploadHttp({ ...uploadHeaders, origin: 'https://attacker.invalid' })).status, 403)
  assert.equal((await uploadHttp({ ...uploadHeaders, 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await uploadHttp(uploadHeaders, 'actorId')).status, 400)
  assert.equal((await uploadHttp(uploadHeaders, 'ownerName')).status, 400)
  assert.equal((await uploadHttp(uploadHeaders, undefined, true)).status, 413)
  assert.equal((await sql('SELECT COUNT(*) AS n FROM media_uploads')).results[0]?.n, 0)
  const httpUpload = await uploadHttp(uploadHeaders)
  assert.equal(httpUpload.status, 201, await httpUpload.clone().text())
  assert.equal(httpUpload.headers.get('cache-control'), 'no-store')
  const httpReceipt = await httpUpload.text()
  assert.equal(await (await uploadHttp(uploadHeaders)).text(), httpReceipt)
  assert.deepEqual(JSON.parse(httpReceipt), {
    id: JSON.parse(httpReceipt).id,
    quarantineStatus: 'pending',
    rightsStatus: 'pending',
    canApprove: false
  })
  const declaration = (
    await sql("SELECT rights_source, actor_id FROM media_uploads WHERE idempotency_key = 'http-upload'")
  ).results[0]!
  assert.equal(declaration.actor_id, identityId)
  assert.deepEqual(JSON.parse(String(declaration.rights_source)), {
    kind: 'uploader_declaration',
    authorizedAt: timestamp.slice(0, 10),
    reference: null
  })
  await sql(
    "CREATE TRIGGER quota_audit_failure BEFORE UPDATE ON identity_rate_limits BEGIN SELECT RAISE(ABORT, 'quota unavailable'); END"
  )
  const unavailableQuota = await uploadHttp(uploadHeaders)
  assert.equal(unavailableQuota.status, 503)
  assert.deepEqual(await unavailableQuota.json(), { error: { code: 'abuse_control_unavailable' } })
  await sql('DROP TRIGGER quota_audit_failure')
  const usedBefore = Number((await sql('SELECT used FROM identity_rate_limits')).results[0]?.used)
  const burst = await Promise.all(Array.from({ length: 25 }, () => uploadHttp(uploadHeaders)))
  assert.equal(burst.filter((response) => response.status === 201).length, 20 - usedBefore)
  assert.equal(burst.filter((response) => response.status === 429).length, 25 - (20 - usedBefore))
  for (const response of burst) {
    assert.equal(response.headers.get('cache-control'), 'no-store')
    if (response.status === 429) {
      assert.equal(response.headers.get('x-ratelimit-remaining'), '0')
      assert.ok(Number(response.headers.get('retry-after')) > 0)
    }
  }
  assert.equal((await sql('SELECT COUNT(*) AS n FROM media_uploads')).results[0]?.n, 1)

  const first = await command({ operation: 'upload' })
  assert.equal(first.status, 200, await first.clone().text())
  const receipt = await first.text()
  const replay = await command({ operation: 'upload' })
  assert.equal(await replay.text(), receipt)
  const conflict = await command({ operation: 'upload', alt: 'Changed metadata' })
  assert.equal(conflict.status, 500)
  assert.match(await conflict.text(), /media_idempotency_conflict/)

  // Real R2 succeeds while a real D1 trigger aborts the receipt. Retry must use
  // the existing object's checksum and preserve its identity, not overwrite it.
  await sql(
    "CREATE TRIGGER media_audit_crash BEFORE UPDATE ON media_uploads WHEN NEW.idempotency_key = 'crash' BEGIN SELECT RAISE(ABORT, 'audit crash'); END"
  )
  const crashed = await command({ operation: 'upload', key: 'crash' })
  assert.equal(crashed.status, 500)
  assert.match(await crashed.text(), /audit crash/)
  const before = await (await command({ operation: 'objects' })).text()
  assert.equal(
    (await sql("SELECT storage_status FROM media_uploads WHERE idempotency_key = 'crash'")).results[0]?.storage_status,
    'staging'
  )
  await sql('DROP TRIGGER media_audit_crash')
  const resumed = await command({ operation: 'upload', key: 'crash' })
  assert.equal(resumed.status, 200, await resumed.clone().text())
  assert.equal(await (await command({ operation: 'objects' })).text(), before)

  await sql(
    "CREATE TRIGGER media_audit_crash BEFORE UPDATE ON media_uploads WHEN NEW.idempotency_key = 'reconcile' BEGIN SELECT RAISE(ABORT, 'audit crash'); END"
  )
  assert.equal((await command({ operation: 'upload', key: 'reconcile' })).status, 500)
  await sql('DROP TRIGGER media_audit_crash')
  const beforeSweep = await (await command({ operation: 'objects' })).text()
  const sweep = await command({
    operation: 'reconcile',
    now: new Date(Date.now() + 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  })
  assert.equal(sweep.status, 200, await sweep.clone().text())
  assert.deepEqual(await sweep.json(), {
    inspected: 1,
    recovered: 1,
    missing: 0,
    mismatch: 0,
    unavailable: 0,
    raced: 0
  })
  assert.equal(await (await command({ operation: 'objects' })).text(), beforeSweep)

  const concurrent = await Promise.all(
    Array.from({ length: 12 }, () => command({ operation: 'upload', key: 'concurrent' }))
  )
  assert.ok(concurrent.every((response) => response.status === 200))
  const firstConcurrent = await command({ operation: 'upload', key: 'concurrent' })
  const concurrentReceipt = await firstConcurrent.text()
  assert.equal(firstConcurrent.status, 200, concurrentReceipt)
  const replayConcurrent = await command({ operation: 'upload', key: 'concurrent' })
  assert.equal(await replayConcurrent.text(), concurrentReceipt)
  const rows = await sql('SELECT storage_status, rights_status, scan_status FROM media_uploads')
  assert.equal(rows.results.length, 5)
  for (const row of rows.results)
    assert.deepEqual(row, { storage_status: 'quarantined', rights_status: 'pending', scan_status: 'pending' })
  const objects = z
    .array(
      z.object({
        key: z.string(),
        content: z.string(),
        metadata: z.object({ cacheControl: z.string() })
      })
    )
    .parse(await (await command({ operation: 'objects' })).json())
  assert.equal(objects.length, 5)
  for (const object of objects) {
    assert.match(object.key, /^quarantine\//)
    assert.equal(object.content, '%PDF-1.7 local audit original')
    assert.equal(object.metadata.cacheControl, 'no-store')
  }
  // Real authentication HTTP handler: password -> secure cookie -> revocation.
  await sql(`UPDATE identities SET password_hash = '${passwordResult.generated}' WHERE id = '${identityId}'`)
  async function authHttp(path: string, body: unknown, sessionCookie?: string) {
    return local.dispatchFetch(`https://media-audit.invalid${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        origin: 'https://media-audit.invalid',
        'cf-connecting-ip': '192.0.2.88',
        ...(sessionCookie ? { cookie: sessionCookie } : {})
      }
    })
  }
  const httpLogin = await authHttp('/api/auth/login', { email: 'audit@example.invalid', password: syntheticPassword })
  assert.equal(httpLogin.status, 200, await httpLogin.clone().text())
  assert.equal(httpLogin.headers.get('cache-control'), 'no-store')
  const newCookie = httpLogin.headers.get('set-cookie')!
  assert.match(newCookie, /HttpOnly; Secure; SameSite=Lax/)
  let cookiePair = newCookie.split(';')[0]!
  const customerId = '30000000-0000-4000-8000-000000000001'
  const companyId = '40000000-0000-4000-8000-000000000001'
  await sql(
    `INSERT INTO customers(id, name, phone, created_at, updated_at) VALUES ('${customerId}', 'Cliente de auditoria', '+34600111222', '${timestamp}', '${timestamp}')`
  )
  await sql(
    `INSERT INTO companies(id, customer_id, legal_name, country_code, tax_id, created_at, updated_at) VALUES ('${companyId}', '${customerId}', 'Empresa de auditoria SL', 'ES', 'B12345674', '${timestamp}', '${timestamp}')`
  )
  await sql(`UPDATE identities SET customer_id = '${customerId}' WHERE id = '${identityId}'`)
  async function readNuxtSession() {
    const response = await local.dispatchFetch('https://media-audit.invalid/api/_auth/session', {
      headers: { cookie: cookiePair, 'cf-connecting-ip': '192.0.2.88' }
    })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return response.json()
  }
  const publicSession = z
    .object({ user: z.object({ id: z.string(), role: z.string(), mfaVerified: z.boolean() }) })
    .parse(await readNuxtSession())
  assert.equal(publicSession.user.id, identityId)
  assert.equal(publicSession.user.role, 'catalog_editor')
  assert.equal(publicSession.user.mfaVerified, false)
  const businessSession = z
    .object({ user: z.object({ name: z.string(), phone: z.string(), company: z.string() }) })
    .parse(await readNuxtSession())
  assert.equal(businessSession.user.name, 'Cliente de auditoria')
  assert.equal(businessSession.user.phone, '+34600111222')
  assert.equal(businessSession.user.company, 'Empresa de auditoria SL')
  const accountResponse = await local.dispatchFetch('https://media-audit.invalid/api/account', {
    headers: { cookie: cookiePair, 'cf-connecting-ip': '192.0.2.88' }
  })
  assert.equal(accountResponse.status, 200)
  const account = z
    .object({ profile: z.object({ company: z.string(), taxId: z.string() }) })
    .parse(await accountResponse.json())
  assert.equal(account.profile.company, 'Empresa de auditoria SL')
  assert.equal(account.profile.taxId, 'B12345674')
  const profileUpdate = await local.dispatchFetch('https://media-audit.invalid/api/account/profile', {
    method: 'PUT',
    body: JSON.stringify({ name: 'Cliente actualizado', phone: '+34600111222' }),
    headers: {
      cookie: cookiePair,
      'cf-connecting-ip': '192.0.2.88',
      origin: 'https://media-audit.invalid',
      'content-type': 'application/json'
    }
  })
  assert.equal(profileUpdate.status, 200, await profileUpdate.clone().text())
  assert.equal(
    z.object({ user: z.object({ name: z.string() }) }).parse(await profileUpdate.json()).user.name,
    'Cliente actualizado'
  )
  assert.equal(
    (await sql(`SELECT name FROM customers WHERE id = '${customerId}'`)).results[0]!.name,
    'Cliente actualizado'
  )
  const fiscalResponse = await local.dispatchFetch('https://media-audit.invalid/api/account/company', {
    method: 'PUT',
    body: JSON.stringify({
      legalName: 'Empresa de auditoria actualizada SL',
      tradeName: 'Auditoria',
      taxId: 'B12345674',
      countryCode: 'ES',
      currentPassword: syntheticPassword
    }),
    headers: {
      cookie: cookiePair,
      'cf-connecting-ip': '192.0.2.88',
      origin: 'https://media-audit.invalid',
      'content-type': 'application/json'
    }
  })
  assert.equal(fiscalResponse.status, 200, await fiscalResponse.clone().text())
  assert.equal(z.object({ status: z.literal('pending') }).parse(await fiscalResponse.json()).status, 'pending')
  assert.equal(
    (
      await sql(
        `SELECT count(*) AS n FROM company_review_events WHERE company_id = '${companyId}' AND tax_id_suffix = '5674'`
      )
    ).results[0]!.n,
    1
  )
  const addressBody = {
    kind: 'both',
    label: 'Casa',
    recipientName: 'Cliente de auditoria',
    line1: 'Calle de Prueba 12',
    postalCode: '28001',
    city: 'Madrid',
    region: 'Madrid',
    countryCode: 'ES',
    isDefault: true
  }
  async function addressHttp(method: string, path: string, body?: unknown) {
    return local.dispatchFetch(`https://media-audit.invalid${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        cookie: cookiePair,
        origin: 'https://media-audit.invalid',
        'cf-connecting-ip': '192.0.2.88',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      }
    })
  }
  const addressCreated = await addressHttp('POST', '/api/account/addresses', addressBody)
  assert.equal(addressCreated.status, 201, await addressCreated.clone().text())
  const addressId = z.object({ id: z.string().uuid() }).parse(await addressCreated.json()).id
  const addressRead = await addressHttp('GET', '/api/account/addresses')
  assert.equal(addressRead.status, 200, await addressRead.clone().text())
  assert.deepEqual(
    z
      .object({ addresses: z.array(z.object({ id: z.string(), isDefault: z.boolean() })) })
      .parse(await addressRead.json())
      .addresses.map(({ id, isDefault }) => ({ id, isDefault })),
    [{ id: addressId, isDefault: true }]
  )
  const addressUpdated = await addressHttp('PUT', `/api/account/addresses/${addressId}`, {
    ...addressBody,
    label: 'Trabajo',
    isDefault: false
  })
  assert.equal(addressUpdated.status, 200, await addressUpdated.clone().text())
  const addressDeleted = await addressHttp('DELETE', `/api/account/addresses/${addressId}`)
  assert.equal(addressDeleted.status, 200, await addressDeleted.clone().text())
  assert.equal(
    (await sql(`SELECT count(*) AS n FROM customer_address_events WHERE customer_id = '${customerId}'`)).results[0]!.n,
    3
  )
  assert.equal((await sql('SELECT count(*) AS n FROM customer_addresses')).results[0]!.n, 0)
  const secondSession = '20000000-0000-4000-8000-000000000011'
  const thirdSession = '20000000-0000-4000-8000-000000000012'
  await sql(
    `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at, last_seen_at)
    VALUES ('${secondSession}', '${identityId}', 1, '${timestamp}', '${expires}', '${timestamp}')`
  )
  const sessionsBefore = await addressHttp('GET', '/api/account/sessions')
  assert.equal(sessionsBefore.status, 200, await sessionsBefore.clone().text())
  assert.equal(
    z.object({ sessions: z.array(z.object({ id: z.string() })) }).parse(await sessionsBefore.json()).sessions.length,
    3
  )
  const revokedDevice = await addressHttp('DELETE', `/api/account/sessions/${secondSession}`)
  assert.equal(revokedDevice.status, 200, await revokedDevice.clone().text())
  await sql(
    `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at, last_seen_at)
    VALUES ('${thirdSession}', '${identityId}', 1, '${timestamp}', '${expires}', '${timestamp}')`
  )
  const passwordEventsBefore = Number(
    (
      await sql(
        `SELECT count(*) AS n FROM identity_security_events WHERE identity_id = '${identityId}' AND event_type = 'password_changed'`
      )
    ).results[0]!.n
  )
  const oldCookiePair = cookiePair
  const rotatedPassword = `${syntheticPassword}-rotated`
  const passwordChanged = await addressHttp('PUT', '/api/account/password', {
    currentPassword: syntheticPassword,
    newPassword: rotatedPassword
  })
  assert.equal(passwordChanged.status, 200, await passwordChanged.clone().text())
  cookiePair = passwordChanged.headers.get('set-cookie')!.split(';')[0]!
  assert.notEqual(cookiePair, oldCookiePair)
  assert.equal(z.object({ sessionVersion: z.literal(2) }).parse(await passwordChanged.json()).sessionVersion, 2)
  const staleSessions = await local.dispatchFetch('https://media-audit.invalid/api/account/sessions', {
    headers: { cookie: oldCookiePair, 'cf-connecting-ip': '192.0.2.88' }
  })
  assert.equal(staleSessions.status, 401)
  assert.equal(
    z
      .object({ sessions: z.array(z.object({ current: z.boolean() })) })
      .parse(await (await addressHttp('GET', '/api/account/sessions')).json())
      .sessions.filter((session) => session.current).length,
    1
  )
  assert.equal(
    (await sql(`SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id = '${thirdSession}'`)).results[0]!
      .revoked,
    1
  )
  assert.equal(
    (
      await sql(
        `SELECT count(*) AS n FROM identity_security_events WHERE identity_id = '${identityId}' AND event_type = 'password_changed'`
      )
    ).results[0]!.n,
    passwordEventsBefore + 1
  )
  // MFA enrollment runs through the real HTTP handler, workerd crypto and D1.
  const enrollmentSession = '20000000-0000-4000-8000-000000000013'
  await sql(
    `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at, last_seen_at)
    VALUES ('${enrollmentSession}', '${identityId}', 2, '${timestamp}', '${expires}', '${timestamp}')`
  )
  const setup = await addressHttp('POST', '/api/auth/mfa/setup', { currentPassword: rotatedPassword })
  assert.equal(setup.status, 200, await setup.clone().text())
  assert.equal(setup.headers.get('cache-control'), 'no-store')
  const setupBody = z
    .object({ setupId: z.string().uuid(), manualKey: z.string(), uri: z.string(), recoveryCodes: z.array(z.string()) })
    .parse(await setup.json())
  assert.equal(setupBody.recoveryCodes.length, 8)
  const pendingMfa = await sql(
    `SELECT encrypted_secret, recovery_code_hashes FROM mfa_enrollments WHERE id = '${setupBody.setupId}'`
  )
  assert.equal(pendingMfa.results.length, 1)
  assert.notEqual(pendingMfa.results[0]!.encrypted_secret, setupBody.manualKey)
  assert.ok(!JSON.stringify(pendingMfa.results).includes(setupBody.recoveryCodes[0]!))
  const confirmed = await addressHttp('POST', '/api/auth/mfa/verify-setup', {
    setupId: setupBody.setupId,
    code: new TOTP({ secret: setupBody.manualKey, algorithm: 'SHA1', digits: 6, period: 30 }).generate()
  })
  assert.equal(confirmed.status, 200, await confirmed.clone().text())
  assert.deepEqual(await confirmed.json(), { ok: true })
  assert.equal(
    (await sql(`SELECT count(*) AS n FROM mfa_enrollments WHERE identity_id = '${identityId}'`)).results[0]!.n,
    0
  )
  assert.equal(
    (
      await sql(
        `SELECT count(*) AS n FROM identity_mfa WHERE identity_id = '${identityId}' AND verified_at IS NOT NULL`
      )
    ).results[0]!.n,
    1
  )
  assert.equal(
    (await sql(`SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id = '${enrollmentSession}'`))
      .results[0]!.revoked,
    1
  )
  assert.equal(
    z.object({ user: z.object({ mfaVerified: z.literal(true) }) }).parse(await readNuxtSession()).user.mfaVerified,
    true
  )
  assert.equal((await addressHttp('POST', '/api/auth/mfa/setup', { currentPassword: rotatedPassword })).status, 409)
  const revokedBeforeLogout = Number(
    (
      await sql(
        `SELECT count(*) AS n FROM auth_sessions WHERE identity_id = '${identityId}' AND revoked_at IS NOT NULL`
      )
    ).results[0]!.n
  )
  const logout = await authHttp('/api/auth/logout', {}, cookiePair)
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/)
  assert.deepEqual(await readNuxtSession(), {})
  assert.equal(
    (
      await sql(
        `SELECT count(*) AS n FROM auth_sessions WHERE identity_id = '${identityId}' AND revoked_at IS NOT NULL`
      )
    ).results[0]!.n,
    revokedBeforeLogout + 1
  )
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () => authHttp('/api/auth/login', { email: 'audit@example.invalid', password: 'wrong' }))
  )
  assert.equal(attempts.filter((response) => response.status === 401).length, 4)
  assert.equal(attempts.filter((response) => response.status === 429).length, 4)
  console.log(
    'Media/account runtime audit passed: clean migrations, h3 cookie/workerd/D1 authorization and revocation, authenticated multipart/CSRF, 25-request quota burst/fail-closed, D1/R2 upload, replay/conflict, crash recovery, storage reconciliation, 12 concurrent replays, customer/company/address CRUD, device revocation, password rotation and guarded MFA enrollment.'
  )
} finally {
  try {
    await runtime?.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
