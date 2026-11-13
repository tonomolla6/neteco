import postgres from 'postgres'
import * as OTPAuth from 'otpauth'
import { z } from 'zod'
import { decryptSecret } from '../../server/utils/secrets'
import type { DeterministicTestData } from '../fixtures/deterministic'

interface FixtureRequest {
  post(
    url: string,
    options: { data: Record<string, unknown>; headers: Record<string, string> }
  ): Promise<{
    status(): number
    json(): Promise<unknown>
  }>
  storageState(): Promise<{ cookies: Array<{ name: string; value: string; domain: string; path: string }> }>
}

/** Normal auth APIs issue every cookie. Only the synthetic account's role is
 * provisioned directly, inside the run-e2e disposable PostgreSQL clone. */
export async function createUiStatePostgresSession(input: {
  audience: 'admin' | 'customer'
  origin: string
  connection: string
  appEnv: string
  encryptionKey: string
  request: FixtureRequest
  data: DeterministicTestData
}) {
  const origin = new URL(input.origin)
  const database = new URL(input.connection)
  const loopback = ['127.0.0.1', 'localhost', '[::1]']
  if (
    input.appEnv !== 'test' ||
    origin.origin !== input.origin ||
    origin.protocol !== 'http:' ||
    !loopback.includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !loopback.includes(database.hostname) ||
    !/^\/neteco_it_[a-z0-9_]+$/.test(database.pathname) ||
    Buffer.from(input.encryptionKey, 'base64').byteLength !== 32
  )
    throw new Error('UI state sessions require an isolated test origin and database')

  const sql = postgres(input.connection, { max: 1, connect_timeout: 10 })
  const headers = { origin: input.origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
  const post = async (path: string, data: Record<string, unknown>, expected = 200) => {
    const response = await input.request.post(input.origin + path, { data, headers })
    if (response.status() !== expected) throw new Error(`UI state fixture ${path} failed: ${response.status()}`)
    return response.json()
  }
  const user = z.object({ user: z.object({ id: z.uuid(), emailVerified: z.literal(true), mfaVerified: z.boolean() }) })
  try {
    const email = input.data.email('route-' + input.audience)
    const password = `UiRoute1-${input.data.token('route-password')}`
    await post(
      '/api/auth/register',
      {
        name: 'Ephemeral UI route account',
        email,
        password,
        phone: '600000000',
        company: 'Isolated UI acceptance',
        termsAccepted: true,
        newsletter: false
      },
      201
    )
    const [identity] = await sql<{ id: string }[]>`SELECT id FROM identities WHERE email = ${email}`
    const identityId = z.uuid().parse(identity?.id)
    const [verification] = await sql<{ tokenEnvelope: string }[]>`
      SELECT payload ->> 'tokenEnvelope' AS "tokenEnvelope" FROM outbox_events
      WHERE aggregate_id = ${identityId} AND event_type = 'identity.verification.requested'
      ORDER BY created_at DESC LIMIT 1
    `
    if (!verification?.tokenEnvelope) throw new Error('UI state fixture verification token unavailable')
    await post('/api/auth/verify-email', { token: decryptSecret(verification.tokenEnvelope, input.encryptionKey) })
    if (input.audience === 'admin') {
      await sql`INSERT INTO identity_roles(identity_id, role_code) VALUES (${identityId}, 'admin')`
    }
    const login = user.parse(await post('/api/auth/login', { email, password }))
    if (login.user.id !== identityId) throw new Error('UI state fixture identity mismatch')
    if (input.audience === 'admin') {
      const enrollment = z
        .object({ manualKey: z.string().min(16), recoveryCodes: z.array(z.string().min(16)).min(1) })
        .parse(await post('/api/auth/mfa/setup', {}))
      const totp = new OTPAuth.TOTP({
        issuer: 'NETECO',
        label: email,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(enrollment.manualKey)
      })
      await post('/api/auth/mfa/verify-setup', { code: totp.generate() })
      await post('/api/auth/logout', {})
      const challenge = z
        .object({ mfaRequired: z.literal(true), challenge: z.string().min(16) })
        .parse(await post('/api/auth/login', { email, password }))
      const body = { challenge: challenge.challenge, code: enrollment.recoveryCodes[0]! }
      const completed = user.parse(await post('/api/auth/mfa/complete', body))
      if (completed.user.id !== identityId || !completed.user.mfaVerified)
        throw new Error('UI state fixture MFA was not verified')
      const replay = await input.request.post(input.origin + '/api/auth/mfa/complete', { data: body, headers })
      if (![400, 401].includes(replay.status())) throw new Error('UI state fixture MFA replay was not rejected')
    }
    const cookie = (await input.request.storageState()).cookies.find(
      (entry) =>
        entry.name === 'neteco-session' && entry.domain.replace(/^\./, '') === origin.hostname && entry.path === '/'
    )
    if (!cookie || !/^[^;\r\n]{1,16384}$/.test(cookie.value))
      throw new Error('UI state fixture authentication cookie unavailable')
    return `neteco-session=${cookie.value}`
  } finally {
    await sql.end({ timeout: 5 })
  }
}
