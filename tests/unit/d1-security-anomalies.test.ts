import { readFile, readdir } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { ADMIN, RECIPIENT, FOREIGN, utc } from './d1-admin-invitations-fixture'
import {
  createD1AdminInvitation,
  acceptD1AdminInvitation,
  revokeD1AdminInvitation
} from '../../workers/auth/admin-invitations'
import { exportD1AdminAudit } from '../../workers/auth/admin-audit'
import { exportD1AdminOrders } from '../../workers/catalog/order-export'
import { handleCatalogExportHttp } from '../../workers/catalog/catalog-export-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { adminInvitationTokenHash } from '../../shared/admin-invitations'
import {
  SECURITY_ANOMALY_TYPES,
  SECURITY_ANOMALY_SEVERITIES,
  SECURITY_ANOMALY_STATUSES,
  SECURITY_ANOMALY_REASONS,
  DEFAULT_SECURITY_ANOMALY_THRESHOLDS,
  computeSecurityDeviceFingerprintHash,
  hashSecurityNetworkValue,
  securityAnomalyIntentHash,
  emitSecurityAnomalySignal,
  recordAdminSessionDeviceSignal,
  recordMfaChangeSignal,
  recordMassExportSignal,
  recordRolePermissionChangeSignal,
  recordRefundAnomalySignal,
  readD1SecurityAnomalies,
  readD1SecurityAnomalyDetail,
  acknowledgeD1SecurityAnomaly,
  resolveD1SecurityAnomaly,
  readD1SecurityAnomalyCommand
} from '../../workers/auth/security-anomalies'

const SECURITY_AUDITOR = {
  identityId: '11111111-1111-4111-8111-111111111191',
  sessionId: '11111111-1111-4111-8111-111111111192',
  sessionVersion: 1
}

const CATALOG_ONLY_ADMIN = {
  identityId: '22222222-2222-4222-8222-222222222291',
  sessionId: '22222222-2222-4222-8222-222222222292',
  sessionVersion: 1
}

const IP_HASH_A = 'a'.repeat(64)
const IP_HASH_B = 'b'.repeat(64)
const UA_HASH_A = 'c'.repeat(64)
const UA_HASH_B = 'd'.repeat(64)

async function createSecurityAnomalyFixture() {
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
    [ADMIN, 'admin-sec@example.invalid', false],
    [SECURITY_AUDITOR, 'auditor-sec@example.invalid', false],
    [CATALOG_ONLY_ADMIN, 'catalog-only@example.invalid', false],
    [RECIPIENT, 'recipient@example.invalid', true],
    [FOREIGN, 'foreign@example.invalid', true]
  ] as const) {
    const customerId = isCustomer ? crypto.randomUUID() : null
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
      ('admin','Admin','Full security and admin role'),
      ('security_auditor','Security Auditor','Read-only security role'),
      ('support','Support','Support role'),
      ('catalog_manager','Catalog Manager','Catalog role');
    INSERT INTO permissions VALUES
      ('security.read','security','read','Read security anomaly inbox'),
      ('security.manage','security','manage','Manage security anomaly inbox'),
      ('administration.manage','administration','manage','Manage admin invitations and audit'),
      ('support.manage','support','manage','Manage support'),
      ('orders.read','orders','read','Read orders'),
      ('orders.write','orders','write','Write orders'),
      ('payments.write','payments','write','Write payments and refunds'),
      ('catalog.write','catalog','write','Write catalog');
    INSERT INTO role_permissions VALUES
      ('admin','security.read'),
      ('admin','security.manage'),
      ('admin','administration.manage'),
      ('admin','support.manage'),
      ('admin','orders.read'),
      ('admin','orders.write'),
      ('admin','payments.write'),
      ('admin','catalog.write'),
      ('security_auditor','security.read'),
      ('support','support.manage'),
      ('catalog_manager','catalog.write');
  `)

  sqlite.prepare("INSERT INTO identity_roles VALUES(?,'admin',NULL,?,NULL)").run(ADMIN.identityId, past)
  sqlite
    .prepare("INSERT INTO identity_roles VALUES(?,'security_auditor',NULL,?,NULL)")
    .run(SECURITY_AUDITOR.identityId, past)
  sqlite
    .prepare("INSERT INTO identity_roles VALUES(?,'catalog_manager',NULL,?,NULL)")
    .run(CATALOG_ONLY_ADMIN.identityId, past)

  return { sqlite, database, past, future }
}

describe('SEC-035 D1 security anomaly signals, thresholds, deduplication and inbox governance', () => {
  let f: Awaited<ReturnType<typeof createSecurityAnomalyFixture>>

  beforeEach(async () => {
    f = await createSecurityAnomalyFixture()
  })

  afterEach(() => {
    f?.sqlite.close()
  })

  describe('1. Taxonomy, network hashing and PII minimization', () => {
    it('exports the canonical signal types, severities, statuses, reasons and default thresholds', () => {
      expect(SECURITY_ANOMALY_TYPES).toEqual([
        'admin_new_device_login',
        'mfa_change',
        'mass_export',
        'role_permission_change',
        'refund_anomaly'
      ])
      expect(SECURITY_ANOMALY_SEVERITIES).toEqual(['low', 'medium', 'high', 'critical'])
      expect(SECURITY_ANOMALY_STATUSES).toEqual(['open', 'acknowledged', 'resolved'])
      expect(SECURITY_ANOMALY_REASONS.length).toBeGreaterThanOrEqual(14)
      expect(DEFAULT_SECURITY_ANOMALY_THRESHOLDS).toMatchObject({
        exportRowThreshold: 25,
        exportWindowCountThreshold: 3,
        exportWindowSeconds: 600,
        refundAmountThresholdCents: 10000,
        refundBurstCountThreshold: 3,
        refundBurstWindowSeconds: 600
      })
    })

    it('hashes raw IP and User-Agent deterministically and strips raw PII keys from signal context', async () => {
      const rawIp = '203.0.113.195'
      const rawUa = 'Mozilla/5.0 (X11; Linux x86_64) SecretAgent/99.1'
      const ipHash = await hashSecurityNetworkValue(rawIp, 'pepper-test-01')
      const uaHash = await hashSecurityNetworkValue(rawUa, 'pepper-test-01')
      expect(ipHash).toMatch(/^[0-9a-f]{64}$/)
      expect(uaHash).toMatch(/^[0-9a-f]{64}$/)
      expect(ipHash).not.toContain(rawIp)
      expect(uaHash).not.toContain('Mozilla')

      const fpHash = await computeSecurityDeviceFingerprintHash(ipHash, uaHash)
      expect(fpHash).toMatch(/^[0-9a-f]{64}$/)

      const { signal } = await emitSecurityAnomalySignal(f.database, {
        sourceKey: 'mfa_change:mfa_reset:pii-test-1',
        type: 'mfa_change',
        severity: 'high',
        reasonCode: 'mfa_reset',
        actorId: ADMIN.identityId,
        actorSessionId: ADMIN.sessionId,
        objectType: 'identity_mfa',
        objectId: ADMIN.identityId,
        ipHash,
        userAgentHash: uaHash,
        deviceFingerprintHash: fpHash,
        context: {
          ip: rawIp,
          ipAddress: rawIp,
          userAgent: rawUa,
          email: 'secret-user@example.invalid',
          recipientEmail: 'secret-recipient@example.invalid',
          token: 'raw-secret-token',
          tokenHash: 'f'.repeat(64),
          password: 'my-secret-password',
          safeField: 'allowed-context-value',
          count: 3
        }
      })

      const serialized = JSON.stringify(signal)
      expect(serialized).not.toContain(rawIp)
      expect(serialized).not.toContain('Mozilla')
      expect(serialized).not.toContain('secret-user@example.invalid')
      expect(serialized).not.toContain('secret-recipient@example.invalid')
      expect(serialized).not.toContain('raw-secret-token')
      expect(serialized).not.toContain('my-secret-password')
      expect(signal.context).toEqual({
        safeField: 'allowed-context-value',
        count: 3
      })
    })

    it('enforces SQLite CHECK constraints against unhashed IP or User-Agent strings at the DB boundary', () => {
      expect(() =>
        f.sqlite
          .prepare(
            `INSERT INTO security_anomaly_signals(
              id,source_key,signal_type,severity,reason_code,status,actor_id,actor_session_id,
              object_type,object_id,ip_hash,user_agent_hash,device_fingerprint_hash,context_json,
              version,occurred_at,created_at,updated_at
            ) VALUES (?,?,?,?,?,'open',?,?,?,?,'203.0.113.99',NULL,NULL,'{}',1,?,?,?)`
          )
          .run(
            crypto.randomUUID(),
            'raw_ip_violation',
            'mfa_change',
            'high',
            'mfa_reset',
            ADMIN.identityId,
            ADMIN.sessionId,
            'identity_mfa',
            ADMIN.identityId,
            utc(),
            utc(),
            utc()
          )
      ).toThrow()
    })
  })

  describe('2. Signal Type 1 — Admin login from new device fingerprint & deduplication', () => {
    it('emits a signal on the first unseen device for an admin, skips repeat logins from that device, and alerts with high severity on a second new device', async () => {
      const first = await recordAdminSessionDeviceSignal(f.database, {
        identityId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        sourceEventId: 'login-evt-1',
        ipHash: IP_HASH_A,
        userAgentHash: UA_HASH_A,
        occurredAt: utc(-3000)
      })
      expect(first.emitted).toBe(true)
      expect(first.deduplicated).toBe(false)
      expect(first.isFirstDevice).toBe(true)
      expect(first.signal).toMatchObject({
        type: 'admin_new_device_login',
        severity: 'medium',
        reasonCode: 'admin_login_new_device_fingerprint',
        actorId: ADMIN.identityId,
        objectType: 'auth_session',
        objectId: ADMIN.sessionId,
        ipHash: IP_HASH_A,
        userAgentHash: UA_HASH_A
      })
      expect(first.signal?.context).toMatchObject({
        knownDeviceCountBefore: 0,
        isFirstKnownDevice: true
      })

      // Re-emitting exact same origin event is deduplicated
      const replay = await recordAdminSessionDeviceSignal(f.database, {
        identityId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        sourceEventId: 'login-evt-1',
        ipHash: IP_HASH_A,
        userAgentHash: UA_HASH_A,
        occurredAt: utc(-2500)
      })
      expect(replay.emitted).toBe(true)
      expect(replay.deduplicated).toBe(true)
      expect(replay.signal?.id).toBe(first.signal?.id)

      // Subsequent login from the SAME device fingerprint (new session) does NOT emit an anomaly
      const secondSessionSameDevice = crypto.randomUUID()
      const sameDevice = await recordAdminSessionDeviceSignal(f.database, {
        identityId: ADMIN.identityId,
        sessionId: secondSessionSameDevice,
        sourceEventId: 'login-evt-2',
        ipHash: IP_HASH_A,
        userAgentHash: UA_HASH_A,
        occurredAt: utc(-2000)
      })
      expect(sameDevice.emitted).toBe(false)
      expect(sameDevice.signal).toBeNull()

      // Login from a NEW device fingerprint for the same admin emits a HIGH severity signal
      const thirdSessionNewDevice = crypto.randomUUID()
      const newDevice = await recordAdminSessionDeviceSignal(f.database, {
        identityId: ADMIN.identityId,
        sessionId: thirdSessionNewDevice,
        sourceEventId: 'login-evt-3',
        ipHash: IP_HASH_B,
        userAgentHash: UA_HASH_B,
        occurredAt: utc(-1000)
      })
      expect(newDevice.emitted).toBe(true)
      expect(newDevice.deduplicated).toBe(false)
      expect(newDevice.isFirstDevice).toBe(false)
      expect(newDevice.signal).toMatchObject({
        type: 'admin_new_device_login',
        severity: 'high',
        reasonCode: 'admin_login_new_device_fingerprint',
        actorId: ADMIN.identityId,
        objectId: thirdSessionNewDevice
      })
      expect(newDevice.signal?.context).toMatchObject({
        knownDeviceCountBefore: 1,
        isFirstKnownDevice: false
      })
    })

    it('does not emit admin_new_device_login for non-admin customer identities', async () => {
      const result = await recordAdminSessionDeviceSignal(f.database, {
        identityId: RECIPIENT.identityId,
        sessionId: RECIPIENT.sessionId,
        sourceEventId: 'customer-login-1',
        ipHash: IP_HASH_A,
        userAgentHash: UA_HASH_A
      })
      expect(result.emitted).toBe(false)
      expect(result.signal).toBeNull()
    })
  })

  describe('3. Signal Type 2 — MFA reset, disable, re-enrollment and recovery code use', () => {
    it.each([
      ['mfa_reset', 'critical'],
      ['mfa_disabled', 'critical'],
      ['mfa_reenrolled', 'high'],
      ['mfa_recovery_code_used', 'high']
    ] as const)('emits and deduplicates %s with severity %s for an admin identity', async (changeType, severity) => {
      const first = await recordMfaChangeSignal(f.database, {
        identityId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        changeType,
        sourceEventId: `evt-${changeType}-01`,
        ipHash: IP_HASH_A,
        userAgentHash: UA_HASH_A,
        context: { method: changeType }
      })
      expect(first.emitted).toBe(true)
      expect(first.deduplicated).toBe(false)
      expect(first.signal).toMatchObject({
        type: 'mfa_change',
        severity,
        reasonCode: changeType,
        actorId: ADMIN.identityId,
        objectType: 'identity_mfa',
        objectId: ADMIN.identityId
      })

      const duplicate = await recordMfaChangeSignal(f.database, {
        identityId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        changeType,
        sourceEventId: `evt-${changeType}-01`,
        ipHash: IP_HASH_A,
        userAgentHash: UA_HASH_A
      })
      expect(duplicate.emitted).toBe(true)
      expect(duplicate.deduplicated).toBe(true)
      expect(duplicate.signal?.id).toBe(first.signal?.id)
    })
  })

  describe('4. Signal Type 3 — Mass exports with exact boundary thresholds (below / at / above)', () => {
    it.each([
      [9, false],
      [10, true],
      [11, true]
    ])(
      'evaluates exportRowThreshold=10 boundary accurately for rowCount=%i (shouldEmit=%s)',
      async (rowCount, shouldEmit) => {
        const result = await recordMassExportSignal(f.database, {
          actorId: ADMIN.identityId,
          sessionId: ADMIN.sessionId,
          exportKind: 'orders',
          exportCommandId: `order-exp-rows-${rowCount}`,
          rowCount,
          byteLength: rowCount * 120,
          ipHash: IP_HASH_A,
          thresholds: {
            exportRowThreshold: 10,
            exportWindowCountThreshold: 5,
            exportWindowSeconds: 600
          }
        })
        expect(result.emitted).toBe(shouldEmit)
        if (shouldEmit) {
          expect(result.signal).toMatchObject({
            type: 'mass_export',
            reasonCode: 'export_row_threshold_exceeded',
            actorId: ADMIN.identityId,
            objectType: 'orders_export',
            objectId: `order-exp-rows-${rowCount}`
          })
          expect(result.signal?.context).toMatchObject({
            exportKind: 'orders',
            rowCount,
            rowThreshold: 10
          })
        } else {
          expect(result.signal).toBeNull()
        }
      }
    )

    it('evaluates exportWindowCountThreshold=3 burst boundary: 2 below (no signal), 3 at limit (signal), 4 above (signal), outside window ignored', async () => {
      const thresholds = {
        exportRowThreshold: 100,
        exportWindowCountThreshold: 3,
        exportWindowSeconds: 600
      }

      // 1 export outside the 600s window (700s ago) must NOT count toward burst
      const outside = await recordMassExportSignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        exportKind: 'catalog',
        exportCommandId: 'exp-outside-window',
        rowCount: 5,
        occurredAt: utc(-1_500_000),
        thresholds
      })
      expect(outside.emitted).toBe(false)

      // 1st in window (count=1 < 3) -> below threshold
      const first = await recordMassExportSignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        exportKind: 'catalog',
        exportCommandId: 'exp-in-window-1',
        rowCount: 5,
        occurredAt: utc(-200_000),
        thresholds
      })
      expect(first.emitted).toBe(false)
      expect(first.windowExportCount).toBe(1)

      // 2nd in window (count=2 == threshold - 1) -> just below threshold
      const second = await recordMassExportSignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        exportKind: 'catalog',
        exportCommandId: 'exp-in-window-2',
        rowCount: 5,
        occurredAt: utc(-100_000),
        thresholds
      })
      expect(second.emitted).toBe(false)
      expect(second.windowExportCount).toBe(2)

      // 3rd in window (count=3 == threshold) -> at threshold -> emits signal
      const third = await recordMassExportSignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        exportKind: 'catalog',
        exportCommandId: 'exp-in-window-3',
        rowCount: 5,
        occurredAt: utc(-50_000),
        thresholds
      })
      expect(third.emitted).toBe(true)
      expect(third.windowExportCount).toBe(3)
      expect(third.signal).toMatchObject({
        type: 'mass_export',
        severity: 'high',
        reasonCode: 'export_window_burst_exceeded'
      })

      // 4th in window (count=4 == threshold + 1) -> just above threshold -> emits signal
      const fourth = await recordMassExportSignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        exportKind: 'catalog',
        exportCommandId: 'exp-in-window-4',
        rowCount: 5,
        occurredAt: utc(-10_000),
        thresholds
      })
      expect(fourth.emitted).toBe(true)
      expect(fourth.windowExportCount).toBe(4)
      expect(fourth.signal?.id).not.toBe(third.signal?.id)

      // 5th in window exceeding BOTH row threshold and burst threshold -> critical export_row_and_burst_exceeded
      const fifth = await recordMassExportSignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        exportKind: 'catalog',
        exportCommandId: 'exp-in-window-5',
        rowCount: 100,
        occurredAt: utc(-5_000),
        thresholds
      })
      expect(fifth.emitted).toBe(true)
      expect(fifth.signal).toMatchObject({
        type: 'mass_export',
        severity: 'critical',
        reasonCode: 'export_row_and_burst_exceeded'
      })
    })
  })

  describe('5. Signal Type 4 — Role, permission and admin invitation changes', () => {
    it.each([
      ['admin_invitation_created', 'support', 'medium'],
      ['admin_invitation_created', 'admin', 'high'],
      ['admin_invitation_accepted', 'support', 'high'],
      ['admin_invitation_accepted', 'admin', 'critical'],
      ['admin_invitation_revoked', 'support', 'low'],
      ['admin_role_granted', 'admin', 'critical']
    ] as const)(
      'emits and deduplicates %s for role %s with severity %s without leaking recipient email or tokens',
      async (changeKind, roleCode, expectedSeverity) => {
        const cmdId = crypto.randomUUID()
        const invId = crypto.randomUUID()
        const first = await recordRolePermissionChangeSignal(f.database, {
          actorId: ADMIN.identityId,
          sessionId: ADMIN.sessionId,
          changeKind,
          sourceCommandId: cmdId,
          invitationId: invId,
          targetIdentityId: RECIPIENT.identityId,
          roleCode,
          permissions: roleCode === 'admin' ? ['security.manage', 'administration.manage'] : ['support.manage'],
          ipHash: IP_HASH_A
        })
        expect(first.emitted).toBe(true)
        expect(first.deduplicated).toBe(false)
        expect(first.signal).toMatchObject({
          type: 'role_permission_change',
          severity: expectedSeverity,
          reasonCode: changeKind,
          actorId: ADMIN.identityId,
          objectType: 'admin_invitation',
          objectId: invId
        })

        const replay = await recordRolePermissionChangeSignal(f.database, {
          actorId: ADMIN.identityId,
          sessionId: ADMIN.sessionId,
          changeKind,
          sourceCommandId: cmdId,
          invitationId: invId,
          targetIdentityId: RECIPIENT.identityId,
          roleCode
        })
        expect(replay.emitted).toBe(true)
        expect(replay.deduplicated).toBe(true)
        expect(replay.signal?.id).toBe(first.signal?.id)
      }
    )
  })

  describe('6. Signal Type 5 — Refund anomalies with exact boundary thresholds (below / at / above)', () => {
    it.each([
      [9999, false],
      [10000, true],
      [10001, true]
    ])(
      'evaluates refundAmountThresholdCents=10000 boundary accurately for grossCents=%i (shouldEmit=%s)',
      async (grossCents, shouldEmit) => {
        const refundId = crypto.randomUUID()
        const result = await recordRefundAnomalySignal(f.database, {
          actorId: ADMIN.identityId,
          sessionId: ADMIN.sessionId,
          refundId,
          orderId: crypto.randomUUID(),
          stage: 'confirm',
          sourceCommandId: crypto.randomUUID(),
          grossCents,
          currency: 'EUR',
          thresholds: {
            refundAmountThresholdCents: 10000,
            refundBurstCountThreshold: 5,
            refundBurstWindowSeconds: 600
          }
        })
        expect(result.emitted).toBe(shouldEmit)
        if (shouldEmit) {
          expect(result.signal).toMatchObject({
            type: 'refund_anomaly',
            reasonCode: 'refund_amount_threshold_exceeded',
            actorId: ADMIN.identityId,
            objectType: 'refund',
            objectId: refundId
          })
          expect(result.signal?.context).toMatchObject({
            grossCents,
            amountThresholdCents: 10000
          })
        } else {
          expect(result.signal).toBeNull()
        }
      }
    )

    it('evaluates refundBurstCountThreshold=3 boundary: 2 below (no signal), 3 at limit (signal), 4 above (signal), outside window ignored', async () => {
      const thresholds = {
        refundAmountThresholdCents: 50000,
        refundBurstCountThreshold: 3,
        refundBurstWindowSeconds: 600
      }

      // 1 refund outside window (800s ago)
      const outside = await recordRefundAnomalySignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        refundId: crypto.randomUUID(),
        orderId: crypto.randomUUID(),
        stage: 'confirm',
        sourceCommandId: crypto.randomUUID(),
        grossCents: 1500,
        occurredAt: utc(-1_500_000),
        thresholds
      })
      expect(outside.emitted).toBe(false)

      // 1st in window (count=1 < 3)
      const r1 = await recordRefundAnomalySignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        refundId: crypto.randomUUID(),
        orderId: crypto.randomUUID(),
        stage: 'confirm',
        sourceCommandId: crypto.randomUUID(),
        grossCents: 1500,
        occurredAt: utc(-300_000),
        thresholds
      })
      expect(r1.emitted).toBe(false)
      expect(r1.windowRefundCount).toBe(1)

      // 2nd in window (count=2 == threshold - 1) -> just below
      const r2 = await recordRefundAnomalySignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        refundId: crypto.randomUUID(),
        orderId: crypto.randomUUID(),
        stage: 'confirm',
        sourceCommandId: crypto.randomUUID(),
        grossCents: 1500,
        occurredAt: utc(-200_000),
        thresholds
      })
      expect(r2.emitted).toBe(false)
      expect(r2.windowRefundCount).toBe(2)

      // 3rd in window (count=3 == threshold) -> at threshold -> emits signal
      const r3 = await recordRefundAnomalySignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        refundId: crypto.randomUUID(),
        orderId: crypto.randomUUID(),
        stage: 'confirm',
        sourceCommandId: crypto.randomUUID(),
        grossCents: 1500,
        occurredAt: utc(-100_000),
        thresholds
      })
      expect(r3.emitted).toBe(true)
      expect(r3.windowRefundCount).toBe(3)
      expect(r3.signal).toMatchObject({
        type: 'refund_anomaly',
        severity: 'high',
        reasonCode: 'refund_actor_burst_exceeded'
      })

      // 4th in window (count=4 == threshold + 1) -> just above threshold -> emits signal
      const r4 = await recordRefundAnomalySignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        refundId: crypto.randomUUID(),
        orderId: crypto.randomUUID(),
        stage: 'confirm',
        sourceCommandId: crypto.randomUUID(),
        grossCents: 1500,
        occurredAt: utc(-50_000),
        thresholds
      })
      expect(r4.emitted).toBe(true)
      expect(r4.windowRefundCount).toBe(4)

      // 5th in window exceeding both amount and burst -> critical refund_amount_and_burst_exceeded
      const r5 = await recordRefundAnomalySignal(f.database, {
        actorId: ADMIN.identityId,
        sessionId: ADMIN.sessionId,
        refundId: crypto.randomUUID(),
        orderId: crypto.randomUUID(),
        stage: 'confirm',
        sourceCommandId: crypto.randomUUID(),
        grossCents: 50000,
        occurredAt: utc(-10_000),
        thresholds
      })
      expect(r5.emitted).toBe(true)
      expect(r5.signal).toMatchObject({
        type: 'refund_anomaly',
        severity: 'critical',
        reasonCode: 'refund_amount_and_burst_exceeded'
      })
    })
  })

  describe('7. Admin inbox pagination, filters, state transitions, CAS, idempotency and audit trail', () => {
    it('lists signals with bounded keyset pagination, filter binding and filtering by severity, type and status', async () => {
      const s1 = (
        await emitSecurityAnomalySignal(f.database, {
          sourceKey: 'sig-1',
          type: 'mfa_change',
          severity: 'high',
          reasonCode: 'mfa_reset',
          actorId: ADMIN.identityId,
          objectType: 'identity_mfa',
          objectId: ADMIN.identityId,
          occurredAt: utc(-30_000)
        })
      ).signal
      const s2 = (
        await emitSecurityAnomalySignal(f.database, {
          sourceKey: 'sig-2',
          type: 'mass_export',
          severity: 'medium',
          reasonCode: 'export_row_threshold_exceeded',
          actorId: ADMIN.identityId,
          objectType: 'orders_export',
          objectId: 'exp-2',
          occurredAt: utc(-20_000)
        })
      ).signal
      const s3 = (
        await emitSecurityAnomalySignal(f.database, {
          sourceKey: 'sig-3',
          type: 'refund_anomaly',
          severity: 'critical',
          reasonCode: 'refund_amount_threshold_exceeded',
          actorId: ADMIN.identityId,
          objectType: 'refund',
          objectId: 'ref-3',
          occurredAt: utc(-10_000)
        })
      ).signal

      // Keyset pagination (limit=2 -> page 1 has [s3, s2], page 2 has [s1])
      const page1 = await readD1SecurityAnomalies(f.database, ADMIN, { limit: 2 })
      expect(page1.items.map((item) => item.id)).toEqual([s3.id, s2.id])
      expect(page1.nextCursor).not.toBeNull()

      const page2 = await readD1SecurityAnomalies(f.database, ADMIN, { limit: 2, cursor: page1.nextCursor! })
      expect(page2.items.map((item) => item.id)).toEqual([s1.id])
      expect(page2.nextCursor).toBeNull()

      // Using cursor with modified filters is rejected
      await expect(
        readD1SecurityAnomalies(f.database, ADMIN, { limit: 2, severity: 'critical', cursor: page1.nextCursor! })
      ).rejects.toMatchObject({ code: 'invalid_input' })

      // Filtering by severity, type, status
      const criticalOnly = await readD1SecurityAnomalies(f.database, ADMIN, { severity: 'critical' })
      expect(criticalOnly.items.map((item) => item.id)).toEqual([s3.id])

      const mfaOnly = await readD1SecurityAnomalies(f.database, ADMIN, { type: 'mfa_change' })
      expect(mfaOnly.items.map((item) => item.id)).toEqual([s1.id])

      await expect(readD1SecurityAnomalies(f.database, ADMIN, { limit: 26 })).rejects.toMatchObject({
        code: 'invalid_input'
      })
    })

    it('acknowledges and resolves a signal with note, CAS version checks, exact idempotency replay and command recovery', async () => {
      const { signal } = await emitSecurityAnomalySignal(f.database, {
        sourceKey: 'sig-lifecycle-1',
        type: 'admin_new_device_login',
        severity: 'high',
        reasonCode: 'admin_login_new_device_fingerprint',
        actorId: ADMIN.identityId,
        actorSessionId: ADMIN.sessionId,
        objectType: 'auth_session',
        objectId: ADMIN.sessionId
      })
      expect(signal.version).toBe(1)
      expect(signal.status).toBe('open')

      // 1. Acknowledge (version 1 -> 2)
      const ackKey = crypto.randomUUID()
      const ackInput = { expectedVersion: 1, note: 'Revisando inicio de sesión desde nuevo dispositivo.' }
      const ackReceipt = await acknowledgeD1SecurityAnomaly(f.database, ADMIN, signal.id, ackInput, {
        idempotencyKey: ackKey,
        ipHash: IP_HASH_A,
        userAgentHash: UA_HASH_A
      })
      const expectedAckHash = await securityAnomalyIntentHash('acknowledge', signal.id, ackInput)
      expect(ackReceipt).toMatchObject({
        action: 'acknowledge',
        commandId: ackKey,
        signalId: signal.id,
        status: 'acknowledged',
        previousStatus: 'open',
        version: 2,
        actorId: ADMIN.identityId,
        payloadHash: expectedAckHash
      })

      // Exact replay with same Idempotency-Key returns identical receipt without incrementing version
      const ackReplay = await acknowledgeD1SecurityAnomaly(f.database, ADMIN, signal.id, ackInput, {
        idempotencyKey: ackKey
      })
      expect(ackReplay).toEqual(ackReceipt)

      // Same Idempotency-Key with altered payload is rejected with idempotency_conflict
      await expect(
        acknowledgeD1SecurityAnomaly(
          f.database,
          ADMIN,
          signal.id,
          { expectedVersion: 1, note: 'Nota alterada con la misma clave.' },
          { idempotencyKey: ackKey }
        )
      ).rejects.toMatchObject({ code: 'idempotency_conflict' })

      // Stale expectedVersion (1 instead of 2) is rejected with version_conflict
      await expect(
        resolveD1SecurityAnomaly(
          f.database,
          ADMIN,
          signal.id,
          { expectedVersion: 1, note: 'Intento con versión obsoleta.' },
          { idempotencyKey: crypto.randomUUID() }
        )
      ).rejects.toMatchObject({ code: 'version_conflict' })

      // Re-acknowledging an already acknowledged signal with expectedVersion=2 is rejected with invalid_transition
      await expect(
        acknowledgeD1SecurityAnomaly(
          f.database,
          ADMIN,
          signal.id,
          { expectedVersion: 2, note: 'Doble reconocimiento no permitido.' },
          { idempotencyKey: crypto.randomUUID() }
        )
      ).rejects.toMatchObject({ code: 'invalid_transition' })

      // 2. Resolve with note (version 2 -> 3)
      const resolveKey = crypto.randomUUID()
      const resolveInput = {
        expectedVersion: 2,
        note: 'Verificado con el administrador por canal secundario; dispositivo corporativo legítimo.'
      }
      const resolveReceipt = await resolveD1SecurityAnomaly(f.database, ADMIN, signal.id, resolveInput, {
        idempotencyKey: resolveKey,
        ipHash: IP_HASH_A,
        userAgentHash: UA_HASH_A
      })
      expect(resolveReceipt).toMatchObject({
        action: 'resolve',
        commandId: resolveKey,
        signalId: signal.id,
        status: 'resolved',
        previousStatus: 'acknowledged',
        version: 3,
        note: resolveInput.note
      })

      // Exact replay of resolve returns identical receipt
      expect(
        await resolveD1SecurityAnomaly(f.database, ADMIN, signal.id, resolveInput, { idempotencyKey: resolveKey })
      ).toEqual(resolveReceipt)

      // Cannot acknowledge or resolve an already resolved signal
      await expect(
        acknowledgeD1SecurityAnomaly(
          f.database,
          ADMIN,
          signal.id,
          { expectedVersion: 3, note: 'Intento de reabrir como reconocido.' },
          { idempotencyKey: crypto.randomUUID() }
        )
      ).rejects.toMatchObject({ code: 'invalid_transition' })

      await expect(
        resolveD1SecurityAnomaly(
          f.database,
          ADMIN,
          signal.id,
          { expectedVersion: 3, note: 'Intento de resolver dos veces.' },
          { idempotencyKey: crypto.randomUUID() }
        )
      ).rejects.toMatchObject({ code: 'invalid_transition' })

      // Re-emitting the origin signal after resolution must NOT reset status or version
      const reemitted = await emitSecurityAnomalySignal(f.database, {
        sourceKey: 'sig-lifecycle-1',
        type: 'admin_new_device_login',
        severity: 'high',
        reasonCode: 'admin_login_new_device_fingerprint',
        actorId: ADMIN.identityId,
        objectType: 'auth_session',
        objectId: ADMIN.sessionId
      })
      expect(reemitted.deduplicated).toBe(true)
      expect(reemitted.signal.status).toBe('resolved')
      expect(reemitted.signal.version).toBe(3)

      // Detail includes the full audited transition history
      const detail = await readD1SecurityAnomalyDetail(f.database, ADMIN, signal.id)
      expect(detail.item.status).toBe('resolved')
      expect(detail.item.version).toBe(3)
      expect(detail.item.resolutionNote).toBe(resolveInput.note)
      expect(detail.transitions).toHaveLength(2)
      expect(detail.transitions[0]).toMatchObject({
        commandId: ackKey,
        action: 'acknowledge',
        fromStatus: 'open',
        toStatus: 'acknowledged',
        version: 2
      })
      expect(detail.transitions[1]).toMatchObject({
        commandId: resolveKey,
        action: 'resolve',
        fromStatus: 'acknowledged',
        toStatus: 'resolved',
        version: 3,
        note: resolveInput.note
      })

      // Command recovery works for the issuing actor and returns unknown for absent command
      const recovered = await readD1SecurityAnomalyCommand(f.database, ADMIN, ackKey, expectedAckHash)
      expect(recovered).toEqual({
        source: 'cloudflare',
        outcome: 'applied',
        receipt: ackReceipt
      })
      const unknownCmd = await readD1SecurityAnomalyCommand(f.database, ADMIN, crypto.randomUUID(), 'a'.repeat(64))
      expect(unknownCmd).toEqual({
        source: 'cloudflare',
        outcome: 'unknown',
        receipt: null
      })
    })

    it('enforces immutability triggers on security_anomaly_commands against UPDATE and DELETE', async () => {
      const { signal } = await emitSecurityAnomalySignal(f.database, {
        sourceKey: 'sig-immutable-cmd',
        type: 'mfa_change',
        severity: 'high',
        reasonCode: 'mfa_reset',
        actorId: ADMIN.identityId,
        objectType: 'identity_mfa',
        objectId: ADMIN.identityId
      })
      const cmdId = crypto.randomUUID()
      await resolveD1SecurityAnomaly(
        f.database,
        ADMIN,
        signal.id,
        { expectedVersion: 1, note: 'Resolución directa auditada.' },
        { idempotencyKey: cmdId }
      )
      expect(() =>
        f.sqlite.prepare("UPDATE security_anomaly_commands SET note='manipulado' WHERE command_id=?").run(cmdId)
      ).toThrow()
      expect(() => f.sqlite.prepare('DELETE FROM security_anomaly_commands WHERE command_id=?').run(cmdId)).toThrow()
    })
  })

  describe('8. Specific security permissions, MFA verification and authority revocation', () => {
    it('allows security.read to list and inspect signals but denies acknowledge, resolve and command recovery', async () => {
      const { signal } = await emitSecurityAnomalySignal(f.database, {
        sourceKey: 'sig-perm-1',
        type: 'mfa_change',
        severity: 'high',
        reasonCode: 'mfa_reset',
        actorId: ADMIN.identityId,
        objectType: 'identity_mfa',
        objectId: ADMIN.identityId
      })

      // security.read can list and view detail
      const list = await readD1SecurityAnomalies(f.database, SECURITY_AUDITOR, {})
      expect(list.items).toHaveLength(1)
      const detail = await readD1SecurityAnomalyDetail(f.database, SECURITY_AUDITOR, signal.id)
      expect(detail.item.id).toBe(signal.id)

      // security.read CANNOT acknowledge, resolve, or read write command receipts
      await expect(
        acknowledgeD1SecurityAnomaly(
          f.database,
          SECURITY_AUDITOR,
          signal.id,
          { expectedVersion: 1, note: 'Auditor intentando reconocer.' },
          { idempotencyKey: crypto.randomUUID() }
        )
      ).rejects.toMatchObject({ code: 'forbidden' })

      await expect(
        resolveD1SecurityAnomaly(
          f.database,
          SECURITY_AUDITOR,
          signal.id,
          { expectedVersion: 1, note: 'Auditor intentando resolver.' },
          { idempotencyKey: crypto.randomUUID() }
        )
      ).rejects.toMatchObject({ code: 'forbidden' })

      await expect(
        readD1SecurityAnomalyCommand(f.database, SECURITY_AUDITOR, crypto.randomUUID(), 'a'.repeat(64))
      ).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('denies unauthenticated, customer, catalog-only admin, unverified email, and missing MFA enrollment', async () => {
      await expect(readD1SecurityAnomalies(f.database, null, {})).rejects.toMatchObject({ code: 'unauthenticated' })
      await expect(readD1SecurityAnomalies(f.database, RECIPIENT, {})).rejects.toMatchObject({ code: 'forbidden' })
      await expect(readD1SecurityAnomalies(f.database, CATALOG_ONLY_ADMIN, {})).rejects.toMatchObject({
        code: 'forbidden'
      })

      // Missing MFA enrollment on security auditor -> mfa_required
      f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(SECURITY_AUDITOR.identityId)
      await expect(readD1SecurityAnomalies(f.database, SECURITY_AUDITOR, {})).rejects.toMatchObject({
        code: 'mfa_required'
      })
    })

    it('rolls back signal state transition if security.manage permission is revoked mid-flight before batch commit', async () => {
      const { signal } = await emitSecurityAnomalySignal(f.database, {
        sourceKey: 'sig-race-1',
        type: 'mfa_change',
        severity: 'high',
        reasonCode: 'mfa_reset',
        actorId: ADMIN.identityId,
        objectType: 'identity_mfa',
        objectId: ADMIN.identityId
      })

      const racingDb = {
        ...f.database,
        batch: async (statements: D1PreparedStatement[]) => {
          f.sqlite.exec("DELETE FROM role_permissions WHERE role_code='admin' AND permission_code='security.manage'")
          return f.database.batch(statements)
        }
      } as D1Database

      await expect(
        acknowledgeD1SecurityAnomaly(
          racingDb,
          ADMIN,
          signal.id,
          { expectedVersion: 1, note: 'Intento con revocación en vuelo.' },
          { idempotencyKey: crypto.randomUUID() }
        )
      ).rejects.toMatchObject({ code: 'forbidden' })

      const row = f.sqlite
        .prepare('SELECT status, version FROM security_anomaly_signals WHERE id=?')
        .get(signal.id) as { status: string; version: number }
      expect(row).toEqual({ status: 'open', version: 1 })
      expect(f.sqlite.prepare('SELECT count(*) n FROM security_anomaly_commands').get()).toEqual({ n: 0 })
    })
  })

  describe('9. End-to-end emission hooks and non-blocking resilience when signal storage fails', () => {
    it('emits role_permission_change signals on create, accept and revoke in admin-invitations without breaking if signal table fails', async () => {
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
      const input = {
        recipientEmail: 'recipient@example.invalid',
        roleCode: 'support' as const,
        tokenHash: await adminInvitationTokenHash(token),
        expiresInHours: 24,
        reason: 'Concesión auditada de soporte.'
      }

      await createD1AdminInvitation(f.database, ADMIN, input, {
        idempotencyKey: crypto.randomUUID(),
        ipHash: IP_HASH_A
      })
      const accepted = await acceptD1AdminInvitation(
        f.database,
        RECIPIENT,
        { token },
        { idempotencyKey: crypto.randomUUID(), ipHash: IP_HASH_B }
      )
      expect(accepted.action).toBe('accept')

      const signals = await readD1SecurityAnomalies(f.database, ADMIN, { type: 'role_permission_change' })
      expect(signals.items.map((item) => item.reasonCode)).toEqual(
        expect.arrayContaining(['admin_invitation_created', 'admin_invitation_accepted'])
      )
      expect(JSON.stringify(signals)).not.toContain('recipient@example.invalid')
      expect(JSON.stringify(signals)).not.toContain(token)

      // Now inject a SQLite trigger that forces any INSERT into security_anomaly_signals to ABORT
      f.sqlite.exec(
        "CREATE TRIGGER fail_signal_insert BEFORE INSERT ON security_anomaly_signals BEGIN SELECT RAISE(ABORT,'synthetic_signal_failure'); END"
      )

      const token2 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
      const created2 = await createD1AdminInvitation(
        f.database,
        ADMIN,
        { ...input, tokenHash: await adminInvitationTokenHash(token2) },
        { idempotencyKey: crypto.randomUUID() }
      )
      expect(created2.action).toBe('create')

      const revoked2 = await revokeD1AdminInvitation(
        f.database,
        ADMIN,
        created2.invitationId,
        { expectedVersion: 1, reason: 'Revocación de prueba con fallo de señal.' },
        { idempotencyKey: crypto.randomUUID() }
      )
      expect(revoked2.action).toBe('revoke')
    })

    it('emits mass_export on exportD1AdminAudit burst, deduplicates a replayed export and never breaks it when the signal store fails', async () => {
      const thresholds = { exportRowThreshold: 100_000, exportWindowCountThreshold: 3, exportWindowSeconds: 600 }
      const keys: string[] = []
      for (let i = 1; i <= 3; i++) {
        keys.push(crypto.randomUUID())
        const receipt = await exportD1AdminAudit(
          f.database,
          ADMIN,
          { filters: {}, reason: `Exportación de auditoría #${i} para prueba.` },
          { idempotencyKey: keys[i - 1]!, ipHash: IP_HASH_A, anomalyThresholds: thresholds }
        )
        expect(receipt.action).toBe('export')
      }
      const list = await readD1SecurityAnomalies(f.database, ADMIN, { type: 'mass_export' })
      expect(list.items).toHaveLength(1)
      expect(list.items[0]).toMatchObject({
        reasonCode: 'export_window_burst_exceeded',
        severity: 'high',
        objectType: 'admin_audit_export',
        objectId: keys[2],
        ipHash: IP_HASH_A
      })

      // Replaying the third export (same key and payload) emits nothing new.
      await exportD1AdminAudit(
        f.database,
        ADMIN,
        { filters: {}, reason: 'Exportación de auditoría #3 para prueba.' },
        { idempotencyKey: keys[2]!, ipHash: IP_HASH_A, anomalyThresholds: thresholds }
      )
      expect(f.sqlite.prepare('SELECT count(*) n FROM security_anomaly_signals').get()).toEqual({ n: 1 })

      f.sqlite.exec(
        "CREATE TRIGGER fail_export_signal BEFORE INSERT ON security_anomaly_signals BEGIN SELECT RAISE(ABORT,'synthetic_signal_failure'); END"
      )
      const survived = await exportD1AdminAudit(
        f.database,
        ADMIN,
        { filters: {}, reason: 'Exportación con almacén de señales caído.' },
        { idempotencyKey: crypto.randomUUID(), anomalyThresholds: thresholds }
      )
      expect(survived.action).toBe('export')
    })

    const CATALOG_ORIGIN = 'https://catalog-export.neteco.test'
    const CATALOG_PASSWORD = 'catalog-export-synthetic-local-test-only-password'.repeat(2)
    async function downloadCatalog(anomalyThresholds: Record<string, number>) {
      const cookie = (await issueD1SessionCookie(f.database, ADMIN, {
        password: CATALOG_PASSWORD,
        maxAgeSeconds: 3600
      }))!
      const response = await handleCatalogExportHttp(
        new Request(`${CATALOG_ORIGIN}/api/admin/catalog/export/snapshot`, {
          headers: {
            Cookie: cookie,
            Origin: CATALOG_ORIGIN,
            'Sec-Fetch-Site': 'same-origin',
            'CF-Connecting-IP': '198.51.100.9'
          }
        }),
        {
          DB: f.database,
          AUTH_ENABLED: 'true',
          AUTH_ORIGIN: CATALOG_ORIGIN,
          NUXT_SESSION_PASSWORD: CATALOG_PASSWORD,
          AUTH_RATE_LIMIT_PEPPER: 'synthetic-security-anomalies-rate-pepper-32'
        },
        { anomalyThresholds }
      )
      return response!
    }

    it('emits mass_export on order and catalog exports above the row threshold and keeps both exports working when the signal store fails', async () => {
      const orders = await exportD1AdminOrders(f.database, ADMIN, new URLSearchParams(), {
        anomalyDetection: {
          exportCommandId: 'orders-export-1',
          ipHash: IP_HASH_B,
          thresholds: { exportRowThreshold: 0 }
        }
      })
      expect(orders.csv.startsWith('\uFEFF')).toBe(true)
      const catalogDownload = () => downloadCatalog({ exportRowThreshold: 0 })
      expect((await catalogDownload()).status).toBe(200)

      const list = await readD1SecurityAnomalies(f.database, ADMIN, { type: 'mass_export' })
      expect(list.items.map((item) => item.objectType).sort()).toEqual(['catalog_export', 'orders_export'])
      expect(list.items.every((item) => item.reasonCode === 'export_row_threshold_exceeded')).toBe(true)
      const catalogSignal = list.items.find((item) => item.objectType === 'catalog_export')!
      expect(catalogSignal.ipHash).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(list)).not.toContain('198.51.100.9')

      // Below both thresholds (default 25 rows, burst limit raised) emits nothing.
      await exportD1AdminOrders(f.database, ADMIN, new URLSearchParams(), {
        anomalyDetection: { thresholds: { exportWindowCountThreshold: 100 } }
      })
      expect(f.sqlite.prepare('SELECT count(*) n FROM security_anomaly_signals').get()).toEqual({ n: 2 })

      f.sqlite.exec(
        "CREATE TRIGGER fail_export_signal BEFORE INSERT ON security_anomaly_signals BEGIN SELECT RAISE(ABORT,'synthetic_signal_failure'); END"
      )
      const stillOk = await exportD1AdminOrders(f.database, ADMIN, new URLSearchParams(), {
        anomalyDetection: { exportCommandId: 'orders-export-2', thresholds: { exportRowThreshold: 0 } }
      })
      expect(stillOk.metadata.source).toBe('cloudflare')
      expect((await catalogDownload()).status).toBe(200)
    })

    it('does not break exports when the security tables are absent (legacy schema before 0093)', async () => {
      f.sqlite.exec('DROP TABLE security_export_activity_log')
      const orders = await exportD1AdminOrders(f.database, ADMIN, new URLSearchParams(), {
        anomalyDetection: { thresholds: { exportRowThreshold: 0 } }
      })
      expect(orders.metadata.source).toBe('cloudflare')
    })
  })
})
