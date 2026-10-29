import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleSecurityControlsHttp,
  ownsSecurityControlsNamespace
} from '../../workers/security/security-controls-http'
import { ABUSE_RULES } from '../../shared/security-abuse-detection'
import {
  IDS,
  MASTER_KEY,
  NOW,
  PEPPER,
  openSecurityControlsDatabase,
  uuid,
  type SecurityWorld
} from '../support/security-controls-fixture'

const sessionCookieConfiguration = { password: randomBytes(32).toString('hex'), maxAgeSeconds: 3600 }
const secrets = { apiKeyPepper: PEPPER, offlineMasterKey: MASTER_KEY, abuseSubjectPepper: PEPPER }
const BASE = 'https://neteco.invalid'
let n = 1300
const cmd = () => uuid(++n)
const GOOD = { diskEncrypted: true, screenLockEnabled: true, passcodeLength: 6, jailbroken: false }

describe('SEC-038/039/040 HTTP', () => {
  let world: SecurityWorld
  let cookies: Record<'admin' | 'worker1' | 'worker2' | 'plain', string>

  const call = (
    path: string,
    init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {},
    over: Record<string, unknown> = {}
  ) =>
    handleSecurityControlsHttp(
      new Request(`${BASE}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...(init.body !== undefined || init.raw ? { 'content-type': 'application/json' } : {}),
          ...init.headers
        },
        body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
      }),
      { database: world.db, sessionCookieConfiguration, secrets, ...over }
    )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (response: Response | null) => (await response!.json()) as Record<string, any>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    world = await openSecurityControlsDatabase()
    const issue = async (sessionId: string, identityId: string) =>
      (await issueD1SessionCookie(
        world.db,
        { sessionId, identityId, sessionVersion: 1 },
        sessionCookieConfiguration
      ))!.split(';')[0]!
    cookies = {
      admin: await issue(IDS.adminSession, IDS.admin),
      worker1: await issue(IDS.worker1Session, IDS.worker1),
      worker2: await issue(IDS.worker2Session, IDS.worker2),
      plain: await issue(IDS.plainSession, IDS.plain)
    }
  })
  afterEach(() => vi.useRealTimers())

  const createKey = async (over: Record<string, unknown> = {}) => {
    const response = await call('/api/admin/security-controls/api-keys', {
      method: 'POST',
      cookie: cookies.admin,
      body: {
        commandId: cmd(),
        companyId: IDS.company,
        name: 'ERP',
        scopes: ['catalog:read'],
        expiresAt: '2027-01-15T00:00:00Z',
        ...over
      }
    })
    return { response: response!, body: await json(response) }
  }

  it('reclama solo sus espacios de nombres', async () => {
    expect(ownsSecurityControlsNamespace('/api/admin/security-controls/api-keys')).toBe(true)
    expect(ownsSecurityControlsNamespace('/api/b2b/v1/ping')).toBe(true)
    expect(ownsSecurityControlsNamespace('/api/devices/v1/x/checkin')).toBe(true)
    expect(ownsSecurityControlsNamespace('/api/admin/security/anomalies')).toBe(false)
    expect(ownsSecurityControlsNamespace('/api/edi/v1/orders')).toBe(false)
    expect(await call('/api/other')).toBeNull()
  })

  it('admin: sin sesión 401, sin permiso 403, sin configuración 503', async () => {
    expect((await call('/api/admin/security-controls/api-keys'))!.status).toBe(401)
    const forbidden = await call('/api/admin/security-controls/api-keys', { cookie: cookies.plain })
    expect(forbidden!.status).toBe(403)
    expect((await json(forbidden)).error.code).toBe('forbidden')
    expect(
      (await call(
        '/api/admin/security-controls/api-keys',
        { cookie: cookies.admin },
        { sessionCookieConfiguration: null }
      ))!.status
    ).toBe(503)
    expect(
      (await call(
        '/api/admin/security-controls/api-keys',
        { method: 'POST', cookie: cookies.admin, body: {} },
        { secrets: { ...secrets, apiKeyPepper: undefined } }
      ))!.status
    ).toBe(503)
  })

  it('admin: permisos retirados o sesión revocada tras emitir la cookie se respetan al instante', async () => {
    world.sqlite.prepare(`DELETE FROM identity_roles WHERE identity_id=?`).run(IDS.admin)
    expect((await call('/api/admin/security-controls/api-keys', { cookie: cookies.admin }))!.status).toBe(403)
    world.sqlite
      .prepare(`INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES (?, 'admin', ?)`)
      .run(IDS.admin, NOW)
    world.sqlite.prepare(`UPDATE auth_sessions SET revoked_at=? WHERE id=?`).run(NOW, IDS.adminSession)
    expect((await call('/api/admin/security-controls/api-keys', { cookie: cookies.admin }))!.status).toBe(401)
  })

  it('crea claves con respuesta no cacheable, secreto una vez y valida cuerpo', async () => {
    const { response, body } = await createKey()
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(body.secret).toMatch(/^ntk_/)
    expect(body.key.status).toBe('active')
    expect(JSON.stringify(body.key)).not.toContain(body.secret)
    const bad = await createKey({ scopes: ['root'] })
    expect(bad.response.status).toBe(400)
    expect(bad.body.error.code).toBe('invalid_input')
    expect(
      (await call('/api/admin/security-controls/api-keys', { method: 'POST', cookie: cookies.admin, raw: '{nope' }))!
        .status
    ).toBe(400)
    expect(
      (await call('/api/admin/security-controls/api-keys', { method: 'DELETE', cookie: cookies.admin }))!.status
    ).toBe(405)
    expect((await call('/api/admin/security-controls/nope', { cookie: cookies.admin }))!.status).toBe(404)
  })

  it('lista claves sin hash, rota, revoca y consulta auditoría', async () => {
    const { body } = await createKey()
    const list = await json(await call('/api/admin/security-controls/api-keys', { cookie: cookies.admin }))
    expect(list.keys).toHaveLength(1)
    expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{64}/)
    const rotate = await call(`/api/admin/security-controls/api-keys/${body.key.id}/rotate`, {
      method: 'POST',
      cookie: cookies.admin,
      body: { commandId: cmd(), expectedVersion: 1, graceSeconds: 600 }
    })
    expect(rotate!.status).toBe(200)
    const rotated = await json(rotate)
    expect(rotated.secret).toMatch(/^ntk_/)
    const stale = await call(`/api/admin/security-controls/api-keys/${body.key.id}/rotate`, {
      method: 'POST',
      cookie: cookies.admin,
      body: { commandId: cmd(), expectedVersion: 1, graceSeconds: 600 }
    })
    expect(stale!.status).toBe(409)
    const revoke = await call(`/api/admin/security-controls/api-keys/${rotated.newKey.id}/revoke`, {
      method: 'POST',
      cookie: cookies.admin,
      body: { commandId: cmd(), reason: 'baja' }
    })
    expect(revoke!.status).toBe(200)
    const audit = await json(
      await call(`/api/admin/security-controls/api-keys/${rotated.newKey.id}/audit`, { cookie: cookies.admin })
    )
    expect(audit.audit.map((a: { action: string }) => a.action)).toEqual(['created', 'revoked'])
    const patch = await call(`/api/admin/security-controls/api-keys/${rotated.newKey.id}`, {
      method: 'PATCH',
      cookie: cookies.admin,
      body: { commandId: cmd(), expectedVersion: 99, quotaPerMinute: 5 }
    })
    expect(patch!.status).toBe(409)
    expect(
      (await call('/api/admin/security-controls/api-keys/not-a-uuid/revoke', {
        method: 'POST',
        cookie: cookies.admin,
        body: { commandId: cmd(), reason: 'x' }
      }))!.status
    ).toBe(400)
  })

  it('API B2B: exige clave, aplica scope, IP, cuota y revocación inmediata', async () => {
    const { body } = await createKey({ scopes: ['catalog:read'], quotaPerMinute: 2, allowedIps: ['203.0.113.0/24'] })
    const ping = (secret: string | null, ip = '203.0.113.5') =>
      call('/api/b2b/v1/ping', {
        headers: { ...(secret ? { 'x-neteco-api-key': secret } : {}), 'cf-connecting-ip': ip }
      })
    expect((await ping(null))!.status).toBe(401)
    expect((await ping('ntk_bad'))!.status).toBe(401)
    const ok = await ping(body.secret)
    expect(ok!.status).toBe(200)
    expect(await json(ok)).toMatchObject({ ok: true, companyId: IDS.company, scopes: ['catalog:read'] })
    expect((await ping(body.secret, '198.51.100.1'))!.status).toBe(403)
    expect((await ping(body.secret))!.status).toBe(200)
    const limited = await ping(body.secret)
    expect(limited!.status).toBe(429)
    expect(limited!.headers.get('retry-after')).toBe('60')
    await call(`/api/admin/security-controls/api-keys/${body.key.id}/revoke`, {
      method: 'POST',
      cookie: cookies.admin,
      body: { commandId: cmd(), reason: 'x' }
    })
    vi.setSystemTime(new Date('2026-10-29T10:05:00Z'))
    expect((await ping(body.secret))!.status).toBe(401)
    expect(
      (await call('/api/b2b/v1/ping', { method: 'POST', headers: { 'x-neteco-api-key': body.secret } }))!.status
    ).toBe(405)
  })

  it('dispositivos: admin enrola y bloquea; el titular informa postura, hace checkin y confirma wipe', async () => {
    const enroll = await call('/api/admin/security-controls/devices', {
      method: 'POST',
      cookie: cookies.admin,
      body: {
        commandId: cmd(),
        label: 'Scanner 1',
        kind: 'warehouse_scanner',
        platform: 'android',
        assignedIdentityId: IDS.worker1
      }
    })
    expect(enroll!.status).toBe(201)
    const { device } = await json(enroll)
    const posture = await call(`/api/devices/v1/${device.id}/posture`, {
      method: 'POST',
      cookie: cookies.worker1,
      body: GOOD
    })
    expect(posture!.status).toBe(200)
    expect((await json(posture)).device.status).toBe('active')
    expect(
      (await call(`/api/devices/v1/${device.id}/posture`, { method: 'POST', cookie: cookies.worker2, body: GOOD }))!
        .status
    ).toBe(403)
    expect((await call(`/api/devices/v1/${device.id}/checkin`, { method: 'POST' }))!.status).toBe(401)
    const checkin = await json(
      await call(`/api/devices/v1/${device.id}/checkin`, { method: 'POST', cookie: cookies.worker1 })
    )
    expect(checkin).toMatchObject({ status: 'active', wipe: false, lock: false })
    const lock = await call(`/api/admin/security-controls/devices/${device.id}/lock`, {
      method: 'POST',
      cookie: cookies.admin,
      body: { commandId: cmd(), expectedVersion: 2, reason: 'inspección' }
    })
    expect(lock!.status).toBe(200)
    expect(
      (await call(`/api/admin/security-controls/devices/${device.id}/lock`, {
        method: 'POST',
        cookie: cookies.plain,
        body: { commandId: cmd(), expectedVersion: 3, reason: 'x' }
      }))!.status
    ).toBe(403)
    const wipe = await call(`/api/admin/security-controls/devices/${device.id}/wipe`, {
      method: 'POST',
      cookie: cookies.admin,
      body: { commandId: cmd(), expectedVersion: 3, reason: 'robo' }
    })
    expect(wipe!.status).toBe(200)
    expect(
      await json(await call(`/api/devices/v1/${device.id}/checkin`, { method: 'POST', cookie: cookies.worker1 }))
    ).toMatchObject({ wipe: true, lock: true })
    const ack = await call(`/api/devices/v1/${device.id}/wipe-ack`, {
      method: 'POST',
      cookie: cookies.worker1,
      body: { commandId: cmd() }
    })
    expect((await json(ack)).device.status).toBe('wiped')
    const list = await json(await call('/api/admin/security-controls/devices?status=wiped', { cookie: cookies.admin }))
    expect(list.devices).toHaveLength(1)
    const audit = await json(
      await call(`/api/admin/security-controls/devices/${device.id}/audit`, { cookie: cookies.admin })
    )
    expect(audit.audit.length).toBeGreaterThanOrEqual(5)
  })

  it('dispositivos: bundle offline cifrado solo para dispositivo activo del titular; sin PII', async () => {
    const { device } = await json(
      await call('/api/admin/security-controls/devices', {
        method: 'POST',
        cookie: cookies.admin,
        body: {
          commandId: cmd(),
          label: 'Móvil',
          kind: 'delivery_phone',
          platform: 'ios',
          assignedIdentityId: IDS.worker1
        }
      })
    )
    const manifest = {
      shiftId: 'turno-1',
      stops: [{ stopId: 'p1', orderNumber: 'NET-1', lines: [{ sku: 'DET-5L', quantity: 2 }] }],
      expiresAt: '2026-10-29T18:00:00Z'
    }
    const early = await call(`/api/devices/v1/${device.id}/offline-bundle`, {
      method: 'POST',
      cookie: cookies.worker1,
      body: manifest
    })
    expect(early!.status).toBe(409)
    await call(`/api/devices/v1/${device.id}/posture`, { method: 'POST', cookie: cookies.worker1, body: GOOD })
    const sealed = await call(`/api/devices/v1/${device.id}/offline-bundle`, {
      method: 'POST',
      cookie: cookies.worker1,
      body: manifest
    })
    expect(sealed!.status).toBe(200)
    const body = await json(sealed)
    expect(JSON.stringify(body)).not.toContain('DET-5L')
    const pii = await call(`/api/devices/v1/${device.id}/offline-bundle`, {
      method: 'POST',
      cookie: cookies.worker1,
      body: { ...manifest, stops: [{ ...manifest.stops[0], address: 'Calle 1' }] }
    })
    expect(pii!.status).toBe(400)
  })

  it('abuso: evaluar, cola, revisar, métricas y modelos vía HTTP', async () => {
    const features = Object.fromEntries(ABUSE_RULES.map((r) => [r.feature, r.cap]))
    const assess = await call('/api/admin/security-controls/abuse/assessments', {
      method: 'POST',
      cookie: cookies.admin,
      body: { commandId: cmd(), subjectKind: 'ip', subjectId: '203.0.113.9', context: 'login', features }
    })
    expect(assess!.status).toBe(201)
    const { assessment } = await json(assess)
    expect(assessment.decision).toBe('hold')
    expect(JSON.stringify(assessment)).not.toContain('203.0.113.9')
    const queue = await json(await call('/api/admin/security-controls/abuse/queue?limit=5', { cookie: cookies.admin }))
    expect(queue.queue).toHaveLength(1)
    const review = await call(`/api/admin/security-controls/abuse/assessments/${assessment.id}/review`, {
      method: 'POST',
      cookie: cookies.admin,
      body: { outcome: 'false_positive', note: 'cliente conocido' }
    })
    expect(review!.status).toBe(200)
    expect(
      (await call(`/api/admin/security-controls/abuse/assessments/${assessment.id}/review`, {
        method: 'POST',
        cookie: cookies.admin,
        body: { outcome: 'confirmed_abuse', note: 'x' }
      }))!.status
    ).toBe(409)
    const metrics = await json(
      await call('/api/admin/security-controls/abuse/metrics?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z', {
        cookie: cookies.admin
      })
    )
    expect(metrics.metrics).toMatchObject({ reviewed: 1, falsePositive: 1, falsePositiveRate: 1 })
    expect((await call('/api/admin/security-controls/abuse/metrics?from=bad', { cookie: cookies.admin }))!.status).toBe(
      400
    )
    const model = await call('/api/admin/security-controls/abuse/models', {
      method: 'POST',
      cookie: cookies.admin,
      body: { weights: { failed_logins_1h: 1 }, reviewThreshold: 30, holdThreshold: 60 }
    })
    expect(model!.status).toBe(201)
    const created = await json(model)
    expect(
      (await call(`/api/admin/security-controls/abuse/models/${created.model.id}/activate`, {
        method: 'POST',
        cookie: cookies.admin,
        body: {}
      }))!.status
    ).toBe(200)
    expect(
      (await call('/api/admin/security-controls/abuse/drift', {
        method: 'POST',
        cookie: cookies.admin,
        body: { modelVersionId: created.model.id, from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' }
      }))!.status
    ).toBe(409)
    expect(
      (await call('/api/admin/security-controls/abuse/assessments', {
        method: 'POST',
        cookie: cookies.plain,
        body: {}
      }))!.status
    ).toBe(403)
  })

  it('rechaza cuerpos enormes y dispositivos con identificador inválido', async () => {
    const huge = await call('/api/admin/security-controls/api-keys', {
      method: 'POST',
      cookie: cookies.admin,
      raw: JSON.stringify({ name: 'x'.repeat(70_000) })
    })
    expect(huge!.status).toBe(413)
    expect((await call('/api/admin/security-controls/devices?status=bogus', { cookie: cookies.admin }))!.status).toBe(
      400
    )
    expect(
      (await call('/api/devices/v1/not-a-uuid/checkin', { method: 'POST', cookie: cookies.worker1 }))!.status
    ).toBe(400)
    expect((await call('/api/devices/v1/x/unknown', { method: 'POST', cookie: cookies.worker1 }))!.status).toBe(404)
    expect((await call(`/api/devices/v1/${uuid(1)}/checkin`, { method: 'GET', cookie: cookies.worker1 }))!.status).toBe(
      405
    )
    expect(
      (await call(`/api/devices/v1/${uuid(1)}/checkin`, { method: 'POST', cookie: cookies.worker1 }))!.status
    ).toBe(404)
  })
})
