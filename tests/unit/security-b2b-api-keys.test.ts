import { beforeEach, describe, expect, it } from 'vitest'
import {
  API_KEY_SCOPES,
  createApiKeyInputSchema,
  ipMatchesAllowlist,
  isValidAllowlistEntry,
  parseApiKey
} from '../../shared/security-b2b-api-keys'
import {
  authenticateApiKey,
  createApiKey,
  listApiKeyAudit,
  listApiKeys,
  pruneApiKeyUsage,
  revokeApiKey,
  rotateApiKey,
  updateApiKeyPolicy
} from '../../workers/security/b2b-api-keys'
import {
  IDS,
  NOW,
  PEPPER,
  addMinutes,
  dumpDatabaseText,
  openSecurityControlsDatabase,
  uuid,
  type SecurityWorld
} from '../support/security-controls-fixture'

const EXPIRES = '2027-01-15T00:00:00Z'
const admin = { actorIdentityId: IDS.admin, now: NOW, pepper: PEPPER }
let n = 100
const cmd = () => uuid(++n)

describe('SEC-038 shared: formato, scopes e IP', () => {
  it('parseApiKey acepta ntk_<8hex>_<secreto> y devuelve prefijo completo', () => {
    const parsed = parseApiKey(`ntk_ab12cd34_${'A'.repeat(43)}`)
    expect(parsed).toEqual({ prefix: 'ntk_ab12cd34', secret: 'A'.repeat(43) })
  })

  it.each([
    '',
    'ntk_',
    'ntk_ab12cd34',
    'ntk_ab12cd3_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'abc_ab12cd34_x',
    'ntk_ZZ12cd34_' + 'A'.repeat(43),
    `ntk_ab12cd34_${'A'.repeat(300)}`
  ])('parseApiKey rechaza %j', (value) => {
    expect(parseApiKey(value)).toBeNull()
  })

  it('ipMatchesAllowlist: exacta, CIDR IPv4, IPv6 exacta y entradas inválidas', () => {
    expect(ipMatchesAllowlist('203.0.113.7', ['203.0.113.7'])).toBe(true)
    expect(ipMatchesAllowlist('203.0.113.8', ['203.0.113.7'])).toBe(false)
    expect(ipMatchesAllowlist('198.51.100.200', ['198.51.100.0/24'])).toBe(true)
    expect(ipMatchesAllowlist('198.51.101.1', ['198.51.100.0/24'])).toBe(false)
    expect(ipMatchesAllowlist('2001:db8::1', ['2001:DB8::1'])).toBe(true)
    expect(ipMatchesAllowlist('2001:db8::2', ['2001:db8::1'])).toBe(false)
    expect(ipMatchesAllowlist('not-an-ip', ['203.0.113.7'])).toBe(false)
    expect(ipMatchesAllowlist('', ['203.0.113.7'])).toBe(false)
  })

  it('isValidAllowlistEntry rechaza rangos demasiado amplios o mal formados', () => {
    expect(isValidAllowlistEntry('10.0.0.0/8')).toBe(true)
    expect(isValidAllowlistEntry('10.0.0.0/7')).toBe(false)
    expect(isValidAllowlistEntry('0.0.0.0/0')).toBe(false)
    expect(isValidAllowlistEntry('300.1.1.1')).toBe(false)
    expect(isValidAllowlistEntry('10.0.0.1/33')).toBe(false)
    expect(isValidAllowlistEntry('::/0')).toBe(false)
    expect(isValidAllowlistEntry('2001:db8::1')).toBe(true)
  })

  it('el esquema de creación es estricto y acota scopes y cuotas', () => {
    const base = {
      commandId: uuid(1),
      companyId: IDS.company,
      name: 'ERP',
      scopes: ['catalog:read'],
      expiresAt: EXPIRES
    }
    expect(createApiKeyInputSchema.safeParse(base).success).toBe(true)
    expect(createApiKeyInputSchema.safeParse({ ...base, scopes: [] }).success).toBe(false)
    expect(createApiKeyInputSchema.safeParse({ ...base, scopes: ['admin:all'] }).success).toBe(false)
    expect(createApiKeyInputSchema.safeParse({ ...base, scopes: ['catalog:read', 'catalog:read'] }).success).toBe(false)
    expect(createApiKeyInputSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
    expect(createApiKeyInputSchema.safeParse({ ...base, quotaPerMinute: 0 }).success).toBe(false)
    expect(createApiKeyInputSchema.safeParse({ ...base, quotaPerDay: 2_000_000 }).success).toBe(false)
    expect(createApiKeyInputSchema.safeParse({ ...base, name: '  ' }).success).toBe(false)
    expect(createApiKeyInputSchema.safeParse({ ...base, allowedIps: ['0.0.0.0/0'] }).success).toBe(false)
    expect(API_KEY_SCOPES.length).toBeGreaterThanOrEqual(5)
  })
})

describe('SEC-038 worker: ciclo de vida de claves B2B', () => {
  let world: SecurityWorld
  const create = (over: Record<string, unknown> = {}) =>
    createApiKey(
      world.db,
      {
        commandId: cmd(),
        companyId: IDS.company,
        name: 'Conector ERP',
        scopes: ['catalog:read', 'orders:read'],
        expiresAt: EXPIRES,
        ...over
      },
      admin
    )

  beforeEach(async () => {
    world = await openSecurityControlsDatabase()
  })

  it('crea la clave, devuelve el secreto una sola vez y guarda solo hash y prefijo', async () => {
    const { key, secret, replayed } = await create()
    expect(replayed).toBe(false)
    expect(secret).toMatch(/^ntk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/)
    expect(secret!.startsWith(key.prefix)).toBe(true)
    expect(key.status).toBe('active')
    expect(key.scopes).toEqual(['catalog:read', 'orders:read'])
    expect(key.quotaPerMinute).toBe(60)
    const row = world.sqlite.prepare('SELECT * FROM b2b_api_keys').get() as Record<string, string>
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/)
    const secretPart = secret!.slice(13)
    expect(dumpDatabaseText(world.sqlite, ['b2b_api_keys', 'b2b_api_key_audit', 'b2b_api_key_commands'])).not.toContain(
      secretPart
    )
    expect(JSON.stringify(key)).not.toContain(row.key_hash)
    const audit = await listApiKeyAudit(world.db, key.id)
    expect(audit.map((a) => a.action)).toEqual(['created'])
    expect(audit[0]!.actorIdentityId).toBe(IDS.admin)
  })

  it('exige administrador vivo: usuario sin permiso, identidad deshabilitada o inexistente', async () => {
    const input = { commandId: cmd(), companyId: IDS.company, name: 'x', scopes: ['catalog:read'], expiresAt: EXPIRES }
    await expect(createApiKey(world.db, input, { ...admin, actorIdentityId: IDS.plain })).rejects.toMatchObject({
      code: 'forbidden',
      status: 403
    })
    await expect(createApiKey(world.db, input, { ...admin, actorIdentityId: IDS.disabled })).rejects.toMatchObject({
      code: 'forbidden'
    })
    await expect(createApiKey(world.db, input, { ...admin, actorIdentityId: uuid(5) })).rejects.toMatchObject({
      code: 'forbidden'
    })
    world.sqlite.prepare(`UPDATE identities SET status='locked', updated_at=? WHERE id=?`).run(NOW, IDS.admin)
    await expect(createApiKey(world.db, input, admin)).rejects.toMatchObject({ code: 'forbidden' })
    expect(world.sqlite.prepare('SELECT COUNT(*) c FROM b2b_api_keys').get()).toEqual({ c: 0 })
  })

  it('rechaza empresa inexistente o no aprobada', async () => {
    await expect(create({ companyId: IDS.company2 })).rejects.toMatchObject({
      code: 'company_not_approved',
      status: 409
    })
    await expect(create({ companyId: uuid(9) })).rejects.toMatchObject({ code: 'company_not_found', status: 404 })
  })

  it('la expiración es obligatoria, futura y de máximo 365 días', async () => {
    await expect(create({ expiresAt: undefined })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(create({ expiresAt: '2026-10-29T10:00:00Z' })).rejects.toMatchObject({ code: 'invalid_expiry' })
    await expect(create({ expiresAt: '2026-10-01T00:00:00Z' })).rejects.toMatchObject({ code: 'invalid_expiry' })
    await expect(create({ expiresAt: '2027-11-01T00:00:00Z' })).rejects.toMatchObject({ code: 'invalid_expiry' })
    await expect(create({ expiresAt: '2027-10-29T10:00:00Z' })).resolves.toBeDefined()
  })

  it('limita las claves activas por empresa', async () => {
    for (let i = 0; i < 20; i += 1) await create({ name: `k${i}` })
    await expect(create({ name: 'k21' })).rejects.toMatchObject({ code: 'key_limit_reached', status: 409 })
  })

  it('es idempotente por commandId: replay sin secreto y conflicto con payload distinto', async () => {
    const commandId = cmd()
    const first = await create({ commandId })
    const again = await create({ commandId })
    expect(again.replayed).toBe(true)
    expect(again.secret).toBeNull()
    expect(again.key.id).toBe(first.key.id)
    await expect(create({ commandId, name: 'otro nombre' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
      status: 409
    })
    expect(world.sqlite.prepare('SELECT COUNT(*) c FROM b2b_api_keys').get()).toEqual({ c: 1 })
  })

  it('autentica con el secreto, comprueba scope y registra último uso', async () => {
    const { key, secret } = await create()
    const ok = await authenticateApiKey(
      world.db,
      { presented: secret!, requiredScope: 'catalog:read', ip: '203.0.113.5' },
      { now: NOW, pepper: PEPPER }
    )
    expect(ok).toMatchObject({
      ok: true,
      key: { id: key.id, companyId: IDS.company, scopes: ['catalog:read', 'orders:read'] }
    })
    const [view] = await listApiKeys(world.db, { companyId: IDS.company })
    expect(view!.lastUsedAt).toBe(NOW)
  })

  it('rechaza secretos incorrectos, prefijos desconocidos y formatos inválidos sin filtrar información', async () => {
    const { key, secret } = await create()
    const wrong = `${key.prefix}_${'A'.repeat(43)}`
    for (const presented of [wrong, `ntk_00000000_${'A'.repeat(43)}`, 'garbage', '']) {
      const result = await authenticateApiKey(
        world.db,
        { presented, requiredScope: 'catalog:read', ip: '203.0.113.5' },
        { now: NOW, pepper: PEPPER }
      )
      expect(result).toEqual({ ok: false, code: 'invalid_api_key', status: 401 })
    }
    const badPepper = await authenticateApiKey(
      world.db,
      { presented: secret!, requiredScope: 'catalog:read', ip: '203.0.113.5' },
      { now: NOW, pepper: 'x'.repeat(40) }
    )
    expect(badPepper).toMatchObject({ ok: false, code: 'invalid_api_key' })
  })

  it('exige pepper robusto', async () => {
    await expect(
      createApiKey(
        world.db,
        { commandId: cmd(), companyId: IDS.company, name: 'x', scopes: ['catalog:read'], expiresAt: EXPIRES },
        { ...admin, pepper: 'corto' }
      )
    ).rejects.toMatchObject({ code: 'security_configuration_missing', status: 503 })
  })

  it('caduca exactamente en expires_at', async () => {
    const { secret } = await create({ expiresAt: '2026-11-01T00:00:00Z' })
    const before = await authenticateApiKey(
      world.db,
      { presented: secret!, requiredScope: 'catalog:read', ip: '1.1.1.1' },
      { now: '2026-10-31T23:59:59Z', pepper: PEPPER }
    )
    expect(before.ok).toBe(true)
    const at = await authenticateApiKey(
      world.db,
      { presented: secret!, requiredScope: 'catalog:read', ip: '1.1.1.1' },
      { now: '2026-11-01T00:00:00Z', pepper: PEPPER }
    )
    expect(at).toEqual({ ok: false, code: 'api_key_expired', status: 401 })
  })

  it('la revocación es inmediata y deja auditoría con motivo', async () => {
    const { key, secret } = await create()
    const req = { presented: secret!, requiredScope: 'catalog:read' as const, ip: '203.0.113.5' }
    expect((await authenticateApiKey(world.db, req, { now: NOW, pepper: PEPPER })).ok).toBe(true)
    const revoked = await revokeApiKey(world.db, { commandId: cmd(), keyId: key.id, reason: 'fuga sospechada' }, admin)
    expect(revoked.key.status).toBe('revoked')
    expect(revoked.key.revokedAt).toBe(NOW)
    expect(await authenticateApiKey(world.db, req, { now: NOW, pepper: PEPPER })).toEqual({
      ok: false,
      code: 'api_key_revoked',
      status: 401
    })
    const audit = await listApiKeyAudit(world.db, key.id)
    expect(audit.map((a) => a.action)).toEqual(['created', 'revoked'])
    expect(JSON.stringify(audit[1]!.detail)).toContain('fuga sospechada')
  })

  it('revocar es idempotente por commandId y falla con otro comando si ya está revocada', async () => {
    const { key } = await create()
    const commandId = cmd()
    await revokeApiKey(world.db, { commandId, keyId: key.id, reason: 'baja' }, admin)
    const replay = await revokeApiKey(world.db, { commandId, keyId: key.id, reason: 'baja' }, admin)
    expect(replay.replayed).toBe(true)
    await expect(
      revokeApiKey(world.db, { commandId: cmd(), keyId: key.id, reason: 'otra' }, admin)
    ).rejects.toMatchObject({ code: 'already_revoked', status: 409 })
    await expect(
      revokeApiKey(world.db, { commandId: cmd(), keyId: uuid(7), reason: 'x' }, admin)
    ).rejects.toMatchObject({ code: 'api_key_not_found', status: 404 })
    await expect(
      revokeApiKey(world.db, { commandId: cmd(), keyId: key.id, reason: 'x' }, { ...admin, actorIdentityId: IDS.plain })
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('deniega por scope insuficiente', async () => {
    const { secret } = await create({ scopes: ['catalog:read'] })
    const result = await authenticateApiKey(
      world.db,
      { presented: secret!, requiredScope: 'orders:write', ip: '1.1.1.1' },
      { now: NOW, pepper: PEPPER }
    )
    expect(result).toEqual({ ok: false, code: 'insufficient_scope', status: 403 })
  })

  it('aplica la lista de IP opcional', async () => {
    const restricted = await create({ allowedIps: ['198.51.100.0/24', '203.0.113.9'] })
    const open = await create({ name: 'abierta' })
    const call = (secret: string, ip: string | null) =>
      authenticateApiKey(
        world.db,
        { presented: secret, requiredScope: 'catalog:read', ip },
        { now: NOW, pepper: PEPPER }
      )
    expect((await call(restricted.secret!, '198.51.100.77')).ok).toBe(true)
    expect((await call(restricted.secret!, '203.0.113.9')).ok).toBe(true)
    expect(await call(restricted.secret!, '203.0.113.10')).toEqual({ ok: false, code: 'ip_not_allowed', status: 403 })
    expect(await call(restricted.secret!, null)).toEqual({ ok: false, code: 'ip_not_allowed', status: 403 })
    expect((await call(open.secret!, null)).ok).toBe(true)
  })

  it('aplica cuota por minuto y la renueva en el minuto siguiente', async () => {
    const { secret } = await create({ quotaPerMinute: 2 })
    const call = (now: string) =>
      authenticateApiKey(
        world.db,
        { presented: secret!, requiredScope: 'catalog:read', ip: '1.1.1.1' },
        { now, pepper: PEPPER }
      )
    expect((await call('2026-10-29T10:00:05Z')).ok).toBe(true)
    expect((await call('2026-10-29T10:00:30Z')).ok).toBe(true)
    expect(await call('2026-10-29T10:00:45Z')).toEqual({
      ok: false,
      code: 'quota_exceeded',
      status: 429,
      retryAfterSeconds: 15
    })
    expect((await call('2026-10-29T10:01:00Z')).ok).toBe(true)
  })

  it('aplica cuota diaria y no consume cuota con peticiones denegadas por scope', async () => {
    const { secret } = await create({ quotaPerMinute: 100, quotaPerDay: 3 })
    const call = (now: string, scope: 'catalog:read' | 'orders:write' = 'catalog:read') =>
      authenticateApiKey(world.db, { presented: secret!, requiredScope: scope, ip: '1.1.1.1' }, { now, pepper: PEPPER })
    await call('2026-10-29T10:00:00Z', 'orders:write')
    for (let i = 0; i < 3; i += 1) expect((await call(`2026-10-29T1${i}:00:00Z`)).ok).toBe(true)
    const denied = await call('2026-10-29T14:00:00Z')
    expect(denied).toMatchObject({ ok: false, code: 'quota_exceeded', status: 429 })
    expect((await call('2026-10-30T00:00:00Z')).ok).toBe(true)
  })

  it('la autorización de empresa es viva: empresa suspendida bloquea la clave', async () => {
    const { secret } = await create()
    world.sqlite.prepare(`UPDATE companies SET status='suspended', updated_at=? WHERE id=?`).run(NOW, IDS.company)
    const result = await authenticateApiKey(
      world.db,
      { presented: secret!, requiredScope: 'catalog:read', ip: '1.1.1.1' },
      { now: NOW, pepper: PEPPER }
    )
    expect(result).toEqual({ ok: false, code: 'company_not_approved', status: 403 })
  })

  it('rota con gracia: la clave antigua sigue válida hasta el fin de la gracia y la nueva hereda política', async () => {
    const first = await create({ allowedIps: ['203.0.113.9'], quotaPerMinute: 30 })
    const rotated = await rotateApiKey(
      world.db,
      { commandId: cmd(), keyId: first.key.id, expectedVersion: first.key.version, graceSeconds: 3600 },
      admin
    )
    expect(rotated.oldKey.status).toBe('rotated')
    expect(rotated.oldKey.expiresAt).toBe('2026-10-29T11:00:00Z')
    expect(rotated.oldKey.rotatedToId).toBe(rotated.newKey.id)
    expect(rotated.newKey.scopes).toEqual(first.key.scopes)
    expect(rotated.newKey.allowedIps).toEqual(['203.0.113.9'])
    expect(rotated.newKey.quotaPerMinute).toBe(30)
    expect(rotated.newKey.expiresAt).toBe(EXPIRES)
    expect(rotated.secret).not.toBe(first.secret)
    const call = (secret: string, now: string) =>
      authenticateApiKey(
        world.db,
        { presented: secret, requiredScope: 'catalog:read', ip: '203.0.113.9' },
        { now, pepper: PEPPER }
      )
    expect((await call(first.secret!, '2026-10-29T10:30:00Z')).ok).toBe(true)
    expect((await call(rotated.secret!, '2026-10-29T10:30:00Z')).ok).toBe(true)
    expect(await call(first.secret!, '2026-10-29T11:00:00Z')).toEqual({
      ok: false,
      code: 'api_key_expired',
      status: 401
    })
    expect((await listApiKeyAudit(world.db, first.key.id)).map((a) => a.action)).toEqual(['created', 'rotated'])
  })

  it('rotación con gracia 0 revoca la antigua al instante; nueva expiración opcional', async () => {
    const first = await create()
    const rotated = await rotateApiKey(
      world.db,
      {
        commandId: cmd(),
        keyId: first.key.id,
        expectedVersion: first.key.version,
        graceSeconds: 0,
        newExpiresAt: '2027-02-01T00:00:00Z'
      },
      admin
    )
    expect(rotated.oldKey.status).toBe('revoked')
    expect(rotated.newKey.expiresAt).toBe('2027-02-01T00:00:00Z')
    const result = await authenticateApiKey(
      world.db,
      { presented: first.secret!, requiredScope: 'catalog:read', ip: '1.1.1.1' },
      { now: NOW, pepper: PEPPER }
    )
    expect(result).toMatchObject({ ok: false, code: 'api_key_revoked' })
  })

  it('rotación: versión obsoleta, gracia fuera de rango y clave no activa', async () => {
    const first = await create()
    await expect(
      rotateApiKey(world.db, { commandId: cmd(), keyId: first.key.id, expectedVersion: 99, graceSeconds: 60 }, admin)
    ).rejects.toMatchObject({ code: 'version_conflict', status: 409 })
    await expect(
      rotateApiKey(
        world.db,
        { commandId: cmd(), keyId: first.key.id, expectedVersion: first.key.version, graceSeconds: 8 * 86400 },
        admin
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const done = await rotateApiKey(
      world.db,
      { commandId: cmd(), keyId: first.key.id, expectedVersion: first.key.version, graceSeconds: 60 },
      admin
    )
    await expect(
      rotateApiKey(
        world.db,
        { commandId: cmd(), keyId: first.key.id, expectedVersion: done.oldKey.version, graceSeconds: 60 },
        admin
      )
    ).rejects.toMatchObject({ code: 'key_not_active', status: 409 })
  })

  it('la rotación es idempotente y no crea una segunda clave en replay', async () => {
    const first = await create()
    const input = { commandId: cmd(), keyId: first.key.id, expectedVersion: first.key.version, graceSeconds: 300 }
    const a = await rotateApiKey(world.db, input, admin)
    const b = await rotateApiKey(world.db, input, admin)
    expect(b.replayed).toBe(true)
    expect(b.secret).toBeNull()
    expect(b.newKey.id).toBe(a.newKey.id)
    expect(world.sqlite.prepare('SELECT COUNT(*) c FROM b2b_api_keys').get()).toEqual({ c: 2 })
  })

  it('dos rotaciones concurrentes con la misma versión: solo una gana (CAS)', async () => {
    const first = await create()
    const mk = () =>
      rotateApiKey(
        world.db,
        { commandId: cmd(), keyId: first.key.id, expectedVersion: first.key.version, graceSeconds: 60 },
        admin
      )
    const results = await Promise.allSettled([mk(), mk()])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(world.sqlite.prepare('SELECT COUNT(*) c FROM b2b_api_keys').get()).toEqual({ c: 2 })
  })

  it('revocar una clave en gracia la mata inmediatamente', async () => {
    const first = await create()
    const rotated = await rotateApiKey(
      world.db,
      { commandId: cmd(), keyId: first.key.id, expectedVersion: first.key.version, graceSeconds: 3600 },
      admin
    )
    await revokeApiKey(world.db, { commandId: cmd(), keyId: first.key.id, reason: 'compromiso' }, admin)
    const result = await authenticateApiKey(
      world.db,
      { presented: first.secret!, requiredScope: 'catalog:read', ip: '1.1.1.1' },
      { now: NOW, pepper: PEPPER }
    )
    expect(result).toMatchObject({ ok: false, code: 'api_key_revoked' })
    expect(
      (
        await authenticateApiKey(
          world.db,
          { presented: rotated.secret!, requiredScope: 'catalog:read', ip: '1.1.1.1' },
          { now: NOW, pepper: PEPPER }
        )
      ).ok
    ).toBe(true)
  })

  it('actualizar política: CAS, efecto inmediato y no sobre claves revocadas', async () => {
    const { key, secret } = await create({ scopes: ['catalog:read'] })
    const updated = await updateApiKeyPolicy(
      world.db,
      {
        commandId: cmd(),
        keyId: key.id,
        expectedVersion: key.version,
        scopes: ['orders:write'],
        allowedIps: null,
        quotaPerMinute: 5
      },
      admin
    )
    expect(updated.key.scopes).toEqual(['orders:write'])
    expect(updated.key.quotaPerMinute).toBe(5)
    expect(updated.key.version).toBe(key.version + 1)
    const denied = await authenticateApiKey(
      world.db,
      { presented: secret!, requiredScope: 'catalog:read', ip: '1.1.1.1' },
      { now: NOW, pepper: PEPPER }
    )
    expect(denied).toMatchObject({ ok: false, code: 'insufficient_scope' })
    await expect(
      updateApiKeyPolicy(
        world.db,
        { commandId: cmd(), keyId: key.id, expectedVersion: key.version, scopes: ['orders:read'] },
        admin
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      updateApiKeyPolicy(world.db, { commandId: cmd(), keyId: key.id, expectedVersion: updated.key.version }, admin)
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await revokeApiKey(world.db, { commandId: cmd(), keyId: key.id, reason: 'x' }, admin)
    const current = (await listApiKeys(world.db, { companyId: IDS.company }))[0]!
    await expect(
      updateApiKeyPolicy(
        world.db,
        { commandId: cmd(), keyId: key.id, expectedVersion: current.version, scopes: ['orders:read'] },
        admin
      )
    ).rejects.toMatchObject({ code: 'key_not_active' })
  })

  it('el audit log es append-only', async () => {
    const { key } = await create()
    expect(() =>
      world.sqlite.prepare(`UPDATE b2b_api_key_audit SET action='revoked' WHERE key_id=?`).run(key.id)
    ).toThrow(/append_only/)
    expect(() => world.sqlite.prepare('DELETE FROM b2b_api_key_audit WHERE key_id=?').run(key.id)).toThrow(
      /append_only/
    )
  })

  it('listados nunca exponen hash ni secreto', async () => {
    await create()
    const text = JSON.stringify(await listApiKeys(world.db, {}))
    expect(text).not.toMatch(/[0-9a-f]{64}/)
    expect(text).not.toContain('key_hash')
  })

  it('el esquema impide estados incoherentes (revocada sin fecha, hash no hex)', async () => {
    const { key } = await create()
    expect(() =>
      world.sqlite.prepare(`UPDATE b2b_api_keys SET status='revoked', version=version+1 WHERE id=?`).run(key.id)
    ).toThrow()
    expect(() =>
      world.sqlite.prepare(`UPDATE b2b_api_keys SET key_hash='zz', version=version+1 WHERE id=?`).run(key.id)
    ).toThrow()
    expect(() => world.sqlite.prepare(`UPDATE b2b_api_keys SET name='x' WHERE id=?`).run(key.id)).toThrow(/version/)
  })

  it('desfase de reloj: now anterior a la creación no reabre una clave revocada', async () => {
    const { key, secret } = await create()
    await revokeApiKey(world.db, { commandId: cmd(), keyId: key.id, reason: 'x' }, admin)
    const result = await authenticateApiKey(
      world.db,
      { presented: secret!, requiredScope: 'catalog:read', ip: '1.1.1.1' },
      { now: addMinutes(NOW, -60), pepper: PEPPER }
    )
    expect(result).toMatchObject({ ok: false, code: 'api_key_revoked' })
  })

  it('poda contadores antiguos sin tocar los del día actual', async () => {
    const { secret } = await create()
    await authenticateApiKey(
      world.db,
      { presented: secret!, requiredScope: 'catalog:read', ip: null },
      { now: '2026-10-20T10:00:00Z', pepper: PEPPER }
    )
    await authenticateApiKey(
      world.db,
      { presented: secret!, requiredScope: 'catalog:read', ip: null },
      { now: NOW, pepper: PEPPER }
    )
    expect(world.sqlite.prepare('SELECT COUNT(*) c FROM b2b_api_key_usage').get()).toEqual({ c: 4 })
    await pruneApiKeyUsage(world.db, NOW)
    const rows = world.sqlite.prepare('SELECT bucket_kind k, bucket_start s FROM b2b_api_key_usage ORDER BY 1, 2').all()
    expect(rows).toEqual([
      { k: 'day', s: '2026-10-20' },
      { k: 'day', s: '2026-10-29' },
      { k: 'minute', s: '2026-10-29T10:00:00Z' }
    ])
  })
})
