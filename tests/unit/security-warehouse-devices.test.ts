import { beforeEach, describe, expect, it } from 'vitest'
import { evaluatePosture, offlineManifestSchema } from '../../shared/security-warehouse-devices'
import {
  authorizeDeviceAccess,
  confirmDeviceWipe,
  deviceCheckin,
  enrollDevice,
  listDeviceAudit,
  listDevices,
  lockDevice,
  reportDeviceLost,
  reportDevicePosture,
  requestDeviceWipe,
  retireDevice,
  unlockDevice
} from '../../workers/security/warehouse-devices'
import { openOfflineBundle, sealOfflineBundle } from '../../workers/security/offline-bundle'
import {
  IDS,
  MASTER_KEY,
  NOW,
  addMinutes,
  dumpDatabaseText,
  openSecurityControlsDatabase,
  uuid,
  type SecurityWorld
} from '../support/security-controls-fixture'

const GOOD = { diskEncrypted: true, screenLockEnabled: true, passcodeLength: 6, jailbroken: false }
const admin = { actorIdentityId: IDS.admin, now: NOW }
const asWorker1 = { actorIdentityId: IDS.worker1, now: NOW }
let n = 500
const cmd = () => uuid(++n)

const MANIFEST = {
  shiftId: 'turno-2026-10-29-m',
  stops: [
    { stopId: 'stop-001', orderNumber: 'NET-2026-000123', lines: [{ sku: 'DET-5L', quantity: 4 }] },
    {
      stopId: 'stop-002',
      orderNumber: 'NET-2026-000124',
      lines: [
        { sku: 'LAV-1L', quantity: 12 },
        { sku: 'DES-750', quantity: 1 }
      ]
    }
  ],
  expiresAt: '2026-10-29T20:00:00Z'
}

describe('SEC-039 shared: postura y manifiesto offline mínimo', () => {
  it('evaluatePosture lista cada incumplimiento', () => {
    expect(evaluatePosture(GOOD)).toEqual({ compliant: true, violations: [] })
    expect(evaluatePosture({ ...GOOD, diskEncrypted: false }).violations).toEqual(['disk_not_encrypted'])
    expect(evaluatePosture({ ...GOOD, screenLockEnabled: false }).violations).toEqual(['screen_lock_disabled'])
    expect(evaluatePosture({ ...GOOD, passcodeLength: 5 }).violations).toEqual(['passcode_too_short'])
    expect(evaluatePosture({ ...GOOD, jailbroken: true }).violations).toEqual(['device_compromised'])
    expect(
      evaluatePosture({ diskEncrypted: false, screenLockEnabled: false, passcodeLength: 0, jailbroken: true })
        .violations
    ).toHaveLength(4)
  })

  it('el manifiesto acepta solo identificadores operativos', () => {
    expect(offlineManifestSchema.safeParse(MANIFEST).success).toBe(true)
  })

  it.each([
    ['dirección', { ...MANIFEST, stops: [{ ...MANIFEST.stops[0]!, address: 'Calle Mayor 1' }] }],
    ['teléfono en orderNumber', { ...MANIFEST, stops: [{ ...MANIFEST.stops[0]!, orderNumber: '+34 600 111 222' }] }],
    ['email en stopId', { ...MANIFEST, stops: [{ ...MANIFEST.stops[0]!, stopId: 'ana@example.com' }] }],
    ['sin paradas', { ...MANIFEST, stops: [] }],
    ['cantidad 0', { ...MANIFEST, stops: [{ ...MANIFEST.stops[0]!, lines: [{ sku: 'X', quantity: 0 }] }] }],
    ['campo extra raíz', { ...MANIFEST, customerName: 'Ana' }],
    [
      'demasiadas paradas',
      {
        ...MANIFEST,
        stops: Array.from({ length: 201 }, (_, i) => ({
          stopId: `s${i}`,
          orderNumber: `NET-${i}`,
          lines: [{ sku: 'A', quantity: 1 }]
        }))
      }
    ]
  ])('el manifiesto rechaza %s', (_name, value) => {
    expect(offlineManifestSchema.safeParse(value).success).toBe(false)
  })
})

describe('SEC-039 worker: dispositivos, MDM, wipe y offline cifrado', () => {
  let world: SecurityWorld

  const enroll = (over: Record<string, unknown> = {}) =>
    enrollDevice(
      world.db,
      {
        commandId: cmd(),
        label: 'Scanner almacén 01',
        kind: 'warehouse_scanner',
        platform: 'android',
        assignedIdentityId: IDS.worker1,
        ...over
      },
      admin
    )

  async function activeDevice(identity = IDS.worker1) {
    const { device } = await enroll({ assignedIdentityId: identity, label: `Dev ${identity.slice(-2)}` })
    const ctx = { actorIdentityId: identity, now: NOW }
    return (await reportDevicePosture(world.db, { deviceId: device.id, posture: GOOD }, ctx)).device
  }

  beforeEach(async () => {
    world = await openSecurityControlsDatabase()
  })

  it('enrola un dispositivo pendiente ligado a una cuenta individual y lo audita', async () => {
    const { device, replayed } = await enroll()
    expect(replayed).toBe(false)
    expect(device).toMatchObject({
      status: 'pending_enrollment',
      assignedIdentityId: IDS.worker1,
      offlineKeyVersion: 1,
      version: 1
    })
    expect((await listDeviceAudit(world.db, device.id)).map((a) => a.action)).toEqual(['enrolled'])
  })

  it('exige administrador vivo para enrolar', async () => {
    await expect(
      enrollDevice(
        world.db,
        { commandId: cmd(), label: 'x', kind: 'delivery_phone', platform: 'ios', assignedIdentityId: IDS.worker1 },
        { actorIdentityId: IDS.plain, now: NOW }
      )
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })
  })

  it('rechaza cuentas compartidas, deshabilitadas o inexistentes', async () => {
    await expect(enroll({ assignedIdentityId: IDS.shared })).rejects.toMatchObject({
      code: 'shared_account_rejected',
      status: 422
    })
    await expect(enroll({ assignedIdentityId: IDS.disabled })).rejects.toMatchObject({
      code: 'identity_not_active',
      status: 409
    })
    await expect(enroll({ assignedIdentityId: uuid(3) })).rejects.toMatchObject({
      code: 'identity_not_found',
      status: 404
    })
  })

  it('una identidad solo tiene un dispositivo vivo por tipo; otro tipo sí; tras wipe+retiro se libera', async () => {
    const first = await enroll()
    await expect(enroll({ label: 'Otro scanner' })).rejects.toMatchObject({
      code: 'identity_already_has_device',
      status: 409
    })
    await expect(enroll({ kind: 'delivery_phone', platform: 'ios', label: 'Móvil reparto' })).resolves.toBeDefined()
    await retireDevice(world.db, { commandId: cmd(), deviceId: first.device.id, expectedVersion: 1 }, admin)
    await expect(enroll({ label: 'Scanner nuevo' })).resolves.toBeDefined()
  })

  it('enrolar es idempotente por commandId y detecta payload distinto', async () => {
    const commandId = cmd()
    const a = await enroll({ commandId })
    const b = await enroll({ commandId })
    expect(b.replayed).toBe(true)
    expect(b.device.id).toBe(a.device.id)
    await expect(enroll({ commandId, label: 'Distinto' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(world.sqlite.prepare('SELECT COUNT(*) c FROM warehouse_devices').get()).toEqual({ c: 1 })
  })

  it('postura conforme activa el dispositivo, solo desde la cuenta asignada', async () => {
    const { device } = await enroll()
    await expect(
      reportDevicePosture(world.db, { deviceId: device.id, posture: GOOD }, { actorIdentityId: IDS.worker2, now: NOW })
    ).rejects.toMatchObject({ code: 'device_not_assigned', status: 403 })
    const result = await reportDevicePosture(world.db, { deviceId: device.id, posture: GOOD }, asWorker1)
    expect(result).toMatchObject({ compliant: true, violations: [], device: { status: 'active', lastPostureAt: NOW } })
  })

  it('postura no conforme deja pendiente; en dispositivo activo lo bloquea automáticamente', async () => {
    const { device } = await enroll()
    const pending = await reportDevicePosture(
      world.db,
      { deviceId: device.id, posture: { ...GOOD, diskEncrypted: false } },
      asWorker1
    )
    expect(pending.device.status).toBe('pending_enrollment')
    expect(pending.violations).toEqual(['disk_not_encrypted'])
    await reportDevicePosture(world.db, { deviceId: device.id, posture: GOOD }, asWorker1)
    const locked = await reportDevicePosture(
      world.db,
      { deviceId: device.id, posture: { ...GOOD, jailbroken: true } },
      asWorker1
    )
    expect(locked.device.status).toBe('locked')
    const actions = (await listDeviceAudit(world.db, device.id)).map((a) => a.action)
    expect(actions).toContain('auto_locked_noncompliant')
  })

  it('autoriza acceso solo con dispositivo activo, titular vivo y postura reciente', async () => {
    const device = await activeDevice()
    const ok = await authorizeDeviceAccess(world.db, { deviceId: device.id, identityId: IDS.worker1 }, { now: NOW })
    expect(ok.ok).toBe(true)
    expect(
      await authorizeDeviceAccess(world.db, { deviceId: device.id, identityId: IDS.worker2 }, { now: NOW })
    ).toEqual({ ok: false, code: 'device_not_assigned' })
    expect(await authorizeDeviceAccess(world.db, { deviceId: uuid(8), identityId: IDS.worker1 }, { now: NOW })).toEqual(
      { ok: false, code: 'device_not_found' }
    )
    expect(
      await authorizeDeviceAccess(
        world.db,
        { deviceId: device.id, identityId: IDS.worker1 },
        { now: addMinutes(NOW, 72 * 60 + 1) }
      )
    ).toEqual({ ok: false, code: 'posture_stale' })
    world.sqlite.prepare(`UPDATE identities SET status='disabled', updated_at=? WHERE id=?`).run(NOW, IDS.worker1)
    expect(
      await authorizeDeviceAccess(world.db, { deviceId: device.id, identityId: IDS.worker1 }, { now: NOW })
    ).toEqual({ ok: false, code: 'identity_not_active' })
  })

  it('bloquear deniega acceso; desbloquear exige postura conforme reciente y CAS', async () => {
    const device = await activeDevice()
    const locked = await lockDevice(
      world.db,
      { commandId: cmd(), deviceId: device.id, expectedVersion: device.version, reason: 'pérdida temporal' },
      admin
    )
    expect(locked.device.status).toBe('locked')
    expect(
      await authorizeDeviceAccess(world.db, { deviceId: device.id, identityId: IDS.worker1 }, { now: NOW })
    ).toEqual({ ok: false, code: 'device_locked' })
    await expect(
      lockDevice(
        world.db,
        { commandId: cmd(), deviceId: device.id, expectedVersion: device.version, reason: 'x' },
        admin
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await reportDevicePosture(
      world.db,
      { deviceId: device.id, posture: { ...GOOD, screenLockEnabled: false } },
      asWorker1
    )
    const current = (await listDevices(world.db, {}))[0]!
    await expect(
      unlockDevice(world.db, { commandId: cmd(), deviceId: device.id, expectedVersion: current.version }, admin)
    ).rejects.toMatchObject({ code: 'posture_non_compliant', status: 409 })
    await reportDevicePosture(world.db, { deviceId: device.id, posture: GOOD }, asWorker1)
    const fresh = (await listDevices(world.db, {}))[0]!
    const unlocked = await unlockDevice(
      world.db,
      { commandId: cmd(), deviceId: device.id, expectedVersion: fresh.version },
      admin
    )
    expect(unlocked.device.status).toBe('active')
  })

  it('solo administradores bloquean/desbloquean', async () => {
    const device = await activeDevice()
    await expect(
      lockDevice(
        world.db,
        { commandId: cmd(), deviceId: device.id, expectedVersion: device.version, reason: 'x' },
        asWorker1
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('dos bloqueos concurrentes con la misma versión: solo uno se aplica', async () => {
    const device = await activeDevice()
    const mk = () =>
      lockDevice(
        world.db,
        { commandId: cmd(), deviceId: device.id, expectedVersion: device.version, reason: 'x' },
        admin
      )
    const results = await Promise.allSettled([mk(), mk()])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await listDeviceAudit(world.db, device.id)).filter((a) => a.action === 'locked')).toHaveLength(1)
  })

  it('el bloqueo es idempotente por commandId', async () => {
    const device = await activeDevice()
    const input = { commandId: cmd(), deviceId: device.id, expectedVersion: device.version, reason: 'x' }
    await lockDevice(world.db, input, admin)
    const replay = await lockDevice(world.db, input, admin)
    expect(replay.replayed).toBe(true)
    expect((await listDeviceAudit(world.db, device.id)).filter((a) => a.action === 'locked')).toHaveLength(1)
  })

  it('pérdida: el titular o un admin la declaran, se revoca acceso y se rota la clave offline', async () => {
    const device = await activeDevice()
    await expect(
      reportDeviceLost(
        world.db,
        { commandId: cmd(), deviceId: device.id, expectedVersion: device.version },
        { actorIdentityId: IDS.worker2, now: NOW }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    const lost = await reportDeviceLost(
      world.db,
      { commandId: cmd(), deviceId: device.id, expectedVersion: device.version },
      asWorker1
    )
    expect(lost.device).toMatchObject({ status: 'lost', offlineKeyVersion: 2 })
    expect(
      await authorizeDeviceAccess(world.db, { deviceId: device.id, identityId: IDS.worker1 }, { now: NOW })
    ).toEqual({ ok: false, code: 'device_lost' })
  })

  it('wipe remoto: se solicita, el checkin ordena borrar, se confirma y es terminal', async () => {
    const device = await activeDevice()
    const lost = await reportDeviceLost(
      world.db,
      { commandId: cmd(), deviceId: device.id, expectedVersion: device.version },
      admin
    )
    await expect(
      requestDeviceWipe(
        world.db,
        { commandId: cmd(), deviceId: device.id, expectedVersion: lost.device.version, reason: '' },
        admin
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const wiping = await requestDeviceWipe(
      world.db,
      { commandId: cmd(), deviceId: device.id, expectedVersion: lost.device.version, reason: 'robo' },
      admin
    )
    expect(wiping.device).toMatchObject({ status: 'wipe_pending', wipeRequestedAt: NOW, offlineKeyVersion: 3 })
    const directive = await deviceCheckin(world.db, { deviceId: device.id }, asWorker1)
    expect(directive).toMatchObject({ wipe: true, lock: true, status: 'wipe_pending' })
    const wiped = await confirmDeviceWipe(world.db, { commandId: cmd(), deviceId: device.id }, asWorker1)
    expect(wiped.device).toMatchObject({ status: 'wiped', wipeConfirmedAt: NOW })
    const after = await deviceCheckin(world.db, { deviceId: device.id }, asWorker1)
    expect(after).toMatchObject({ wipe: false, lock: true, status: 'wiped' })
    await expect(
      unlockDevice(world.db, { commandId: cmd(), deviceId: device.id, expectedVersion: wiped.device.version }, admin)
    ).rejects.toMatchObject({ code: 'invalid_transition', status: 409 })
    expect((await listDeviceAudit(world.db, device.id)).map((a) => a.action)).toEqual(
      expect.arrayContaining(['enrolled', 'posture_reported', 'lost', 'wipe_requested', 'wipe_confirmed'])
    )
  })

  it('confirmar wipe sin solicitud o desde otra cuenta falla', async () => {
    const device = await activeDevice()
    await expect(
      confirmDeviceWipe(world.db, { commandId: cmd(), deviceId: device.id }, asWorker1)
    ).rejects.toMatchObject({ code: 'wipe_not_requested', status: 409 })
    await requestDeviceWipe(
      world.db,
      { commandId: cmd(), deviceId: device.id, expectedVersion: device.version, reason: 'baja' },
      admin
    )
    await expect(
      confirmDeviceWipe(world.db, { commandId: cmd(), deviceId: device.id }, { actorIdentityId: IDS.worker2, now: NOW })
    ).rejects.toMatchObject({ code: 'device_not_assigned' })
  })

  it('checkin de un dispositivo ajeno o inexistente se rechaza; checkin activo actualiza last_seen', async () => {
    const device = await activeDevice()
    await expect(
      deviceCheckin(world.db, { deviceId: device.id }, { actorIdentityId: IDS.worker2, now: NOW })
    ).rejects.toMatchObject({ code: 'device_not_assigned' })
    await expect(deviceCheckin(world.db, { deviceId: uuid(4) }, asWorker1)).rejects.toMatchObject({
      code: 'device_not_found',
      status: 404
    })
    const result = await deviceCheckin(
      world.db,
      { deviceId: device.id },
      { actorIdentityId: IDS.worker1, now: '2026-10-29T10:05:00Z' }
    )
    expect(result).toMatchObject({ wipe: false, lock: false, status: 'active', compliant: true, postureStale: false })
    expect((await listDevices(world.db, { identityId: IDS.worker1 }))[0]!.lastSeenAt).toBe('2026-10-29T10:05:00Z')
  })

  it('retirar no es posible durante un wipe pendiente', async () => {
    const device = await activeDevice()
    const wiping = await requestDeviceWipe(
      world.db,
      { commandId: cmd(), deviceId: device.id, expectedVersion: device.version, reason: 'x' },
      admin
    )
    await expect(
      retireDevice(world.db, { commandId: cmd(), deviceId: device.id, expectedVersion: wiping.device.version }, admin)
    ).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('el audit log de dispositivos es append-only', async () => {
    const { device } = await enroll()
    expect(() =>
      world.sqlite.prepare(`UPDATE warehouse_device_audit SET action='locked' WHERE device_id=?`).run(device.id)
    ).toThrow(/append_only/)
    expect(() => world.sqlite.prepare('DELETE FROM warehouse_device_audit WHERE device_id=?').run(device.id)).toThrow(
      /append_only/
    )
  })

  it('el registro del dispositivo no guarda datos personales más allá de la cuenta asignada', async () => {
    await activeDevice()
    const text = dumpDatabaseText(world.sqlite, ['warehouse_devices', 'warehouse_device_audit'])
    expect(text).not.toContain('ana.lopez@neteco.invalid')
  })

  it('lista dispositivos filtrando por estado', async () => {
    await activeDevice(IDS.worker1)
    await enroll({ assignedIdentityId: IDS.worker2, label: 'Pendiente' })
    expect(await listDevices(world.db, { status: 'active' })).toHaveLength(1)
    expect(await listDevices(world.db, { status: 'pending_enrollment' })).toHaveLength(1)
    expect(await listDevices(world.db, {})).toHaveLength(2)
  })

  describe('bundle offline cifrado', () => {
    const ctx = { actorIdentityId: IDS.worker1, now: NOW, masterKey: MASTER_KEY }

    it('sella y abre un manifiesto; el sobre no contiene texto claro', async () => {
      const device = await activeDevice()
      const envelope = await sealOfflineBundle(world.db, { deviceId: device.id, manifest: MANIFEST }, ctx)
      expect(envelope).toMatchObject({ v: 1, deviceId: device.id, keyVersion: 1, expiresAt: MANIFEST.expiresAt })
      const wire = JSON.stringify(envelope)
      expect(wire).not.toContain('DET-5L')
      expect(wire).not.toContain('NET-2026-000123')
      const opened = await openOfflineBundle(envelope, { keyVersion: 1, masterKey: MASTER_KEY, now: NOW })
      expect(opened).toEqual(MANIFEST)
    })

    it('cada sellado usa IV distinto', async () => {
      const device = await activeDevice()
      const a = await sealOfflineBundle(world.db, { deviceId: device.id, manifest: MANIFEST }, ctx)
      const b = await sealOfflineBundle(world.db, { deviceId: device.id, manifest: MANIFEST }, ctx)
      expect(a.iv).not.toBe(b.iv)
      expect(a.ct).not.toBe(b.ct)
    })

    it('rechaza manipulación, otra clave maestra, otro dispositivo y caducidad', async () => {
      const device = await activeDevice()
      const other = await activeDevice(IDS.worker2)
      const envelope = await sealOfflineBundle(world.db, { deviceId: device.id, manifest: MANIFEST }, ctx)
      const tampered = { ...envelope, ct: envelope.ct.slice(0, -4) + 'AAAA' }
      await expect(
        openOfflineBundle(tampered, { keyVersion: 1, masterKey: MASTER_KEY, now: NOW })
      ).rejects.toMatchObject({ code: 'bundle_invalid' })
      await expect(
        openOfflineBundle(envelope, { keyVersion: 1, masterKey: 'otra-clave-maestra-0123456789-abcdefghi', now: NOW })
      ).rejects.toMatchObject({ code: 'bundle_invalid' })
      await expect(
        openOfflineBundle({ ...envelope, deviceId: other.id }, { keyVersion: 1, masterKey: MASTER_KEY, now: NOW })
      ).rejects.toMatchObject({ code: 'bundle_invalid' })
      await expect(
        openOfflineBundle(envelope, { keyVersion: 1, masterKey: MASTER_KEY, now: MANIFEST.expiresAt })
      ).rejects.toMatchObject({ code: 'bundle_expired' })
    })

    it('rotar la clave (pérdida/wipe) invalida los bundles anteriores', async () => {
      const device = await activeDevice()
      const envelope = await sealOfflineBundle(world.db, { deviceId: device.id, manifest: MANIFEST }, ctx)
      await reportDeviceLost(
        world.db,
        { commandId: cmd(), deviceId: device.id, expectedVersion: device.version },
        admin
      )
      const current = (await listDevices(world.db, {}))[0]!
      await expect(
        openOfflineBundle(envelope, { keyVersion: current.offlineKeyVersion, masterKey: MASTER_KEY, now: NOW })
      ).rejects.toMatchObject({ code: 'bundle_invalid' })
    })

    it('no sella para dispositivos no activos, ajenos o con TTL excesivo', async () => {
      const device = await activeDevice()
      await expect(
        sealOfflineBundle(
          world.db,
          { deviceId: device.id, manifest: MANIFEST },
          { ...ctx, actorIdentityId: IDS.worker2 }
        )
      ).rejects.toMatchObject({ code: 'device_not_assigned' })
      await expect(
        sealOfflineBundle(
          world.db,
          { deviceId: device.id, manifest: { ...MANIFEST, expiresAt: '2026-10-30T10:00:01Z' } },
          ctx
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(
        sealOfflineBundle(
          world.db,
          { deviceId: device.id, manifest: { ...MANIFEST, expiresAt: '2026-10-29T09:00:00Z' } },
          ctx
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(
        sealOfflineBundle(
          world.db,
          { deviceId: device.id, manifest: { ...MANIFEST, stops: [{ ...MANIFEST.stops[0]!, address: 'Calle 1' }] } },
          ctx
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
      await lockDevice(
        world.db,
        { commandId: cmd(), deviceId: device.id, expectedVersion: device.version, reason: 'x' },
        admin
      )
      await expect(sealOfflineBundle(world.db, { deviceId: device.id, manifest: MANIFEST }, ctx)).rejects.toMatchObject(
        { code: 'device_locked' }
      )
      await expect(
        sealOfflineBundle(world.db, { deviceId: device.id, manifest: MANIFEST }, { ...ctx, masterKey: 'corta' })
      ).rejects.toMatchObject({ code: 'security_configuration_missing' })
    })
  })
})
