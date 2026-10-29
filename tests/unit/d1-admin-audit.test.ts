import { describe, expect, it } from 'vitest'
import { adminAuditFixture, ADMIN, RECIPIENT, utc } from './d1-admin-audit-fixture'
import { ADMIN_AUDIT_FAMILIES, adminAuditIntentHash, adminAuditListSchema } from '../../shared/admin-audit'
import {
  readD1AdminAudit,
  readD1AdminAuditDetail,
  reviewD1AdminAudit,
  exportD1AdminAudit,
  readD1AdminAuditCommand,
  downloadD1AdminAuditExport
} from '../../workers/auth/admin-audit'

const review = {
  expectedVersion: 0,
  disposition: 'reviewed' as const,
  reason: 'Revisión humana explícita del registro.'
}
describe('D1 central sensitive admin audit', () => {
  it('declares every administrative family and an honest empty bounded result', async () => {
    const f = await adminAuditFixture()
    try {
      const result = adminAuditListSchema.parse(await readD1AdminAudit(f.database, ADMIN, {}))
      expect(result.items).toEqual([])
      expect(result.coverage.families).toEqual([...ADMIN_AUDIT_FAMILIES])
      expect(result.coverage.historicalNetworkMetadata).toBe('only_when_recorded')
    } finally {
      f.sqlite.close()
    }
  })
  it('projects a real immutable invitation without recipient, token, or arbitrary input', async () => {
    const f = await adminAuditFixture()
    try {
      const { id, receipt } = await f.source()
      const result = await readD1AdminAudit(f.database, ADMIN, { family: 'admin_invitation' })
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        id,
        actorId: ADMIN.identityId,
        commandId: receipt.commandId,
        sessionId: ADMIN.sessionId,
        ipHash: null
      })
      const detail = await readD1AdminAuditDetail(f.database, ADMIN, id)
      expect(detail.changes).toContainEqual({ field: 'roleCode', before: null, after: 'support' })
      const serialized = JSON.stringify({ result, detail })
      for (const secret of [f.input.recipientEmail, f.token, f.input.tokenHash, f.input.reason, 'synthetic-password'])
        expect(serialized).not.toContain(secret)
    } finally {
      f.sqlite.close()
    }
  })
  it('requires a current administrative actor instead of a customer identity', async () => {
    const f = await adminAuditFixture()
    try {
      await expect(readD1AdminAudit(f.database, null, {})).rejects.toMatchObject({ code: 'unauthenticated' })
      await expect(readD1AdminAudit(f.database, RECIPIENT, {})).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects a session MFA flag when the actual enrollment is absent', async () => {
    const f = await adminAuditFixture()
    try {
      f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(ADMIN.identityId)
      await expect(readD1AdminAudit(f.database, ADMIN, {})).rejects.toMatchObject({ code: 'mfa_required' })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects malformed filters and never substitutes an empty result for source outage', async () => {
    const f = await adminAuditFixture()
    try {
      await expect(readD1AdminAudit(f.database, ADMIN, { limit: 26 })).rejects.toMatchObject({ code: 'invalid_input' })
      const unavailable = {
        prepare() {
          throw new Error('private database failure')
        }
      } as unknown as D1Database
      await expect(readD1AdminAudit(unavailable, ADMIN, {})).rejects.toMatchObject({ code: 'service_unavailable' })
    } finally {
      f.sqlite.close()
    }
  })
  it('keyset pages without repeats and binds the cursor to its filters', async () => {
    const f = await adminAuditFixture()
    try {
      await f.source()
      await f.source()
      const first = await readD1AdminAudit(f.database, ADMIN, { family: 'admin_invitation', limit: 1 })
      expect(first.items).toHaveLength(1)
      expect(first.nextCursor).not.toBeNull()
      const second = await readD1AdminAudit(f.database, ADMIN, {
        family: 'admin_invitation',
        limit: 1,
        cursor: first.nextCursor!
      })
      expect(second.items).toHaveLength(1)
      expect(second.items[0]!.id).not.toBe(first.items[0]!.id)
      await expect(
        readD1AdminAudit(f.database, ADMIN, { family: 'inventory', cursor: first.nextCursor! })
      ).rejects.toMatchObject({ code: 'invalid_input' })
    } finally {
      f.sqlite.close()
    }
  })
  it('appends a review with exact replay and preserves the original business ledger', async () => {
    const f = await adminAuditFixture()
    try {
      const { id } = await f.source(),
        key = crypto.randomUUID()
      const before = f.sqlite.prepare('SELECT * FROM admin_invitation_commands').all()
      const receipt = await reviewD1AdminAudit(f.database, ADMIN, id, review, {
        idempotencyKey: key,
        ipHash: 'a'.repeat(64)
      })
      expect(receipt).toMatchObject({ action: 'review', commandId: key, eventId: id, version: 1 })
      expect(await reviewD1AdminAudit(f.database, ADMIN, id, review, { idempotencyKey: key })).toEqual(receipt)
      const detail = await readD1AdminAuditDetail(f.database, ADMIN, id)
      expect(detail.item.reviewVersion).toBe(1)
      expect(detail.reviews[0]).toMatchObject({ commandId: key, disposition: 'reviewed', reason: 'redacted' })
      expect(f.sqlite.prepare('SELECT * FROM admin_invitation_commands').all()).toEqual(before)
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects stale review CAS and changed same-key payloads without extra reviews', async () => {
    const f = await adminAuditFixture()
    try {
      const { id } = await f.source(),
        key = crypto.randomUUID()
      await reviewD1AdminAudit(f.database, ADMIN, id, review, { idempotencyKey: key })
      await expect(
        reviewD1AdminAudit(f.database, ADMIN, id, { ...review, disposition: 'follow_up' }, { idempotencyKey: key })
      ).rejects.toMatchObject({ code: 'idempotency_conflict' })
      await expect(
        reviewD1AdminAudit(f.database, ADMIN, id, review, { idempotencyKey: crypto.randomUUID() })
      ).rejects.toMatchObject({ code: 'version_conflict' })
      expect((await readD1AdminAuditDetail(f.database, ADMIN, id)).reviews).toHaveLength(1)
    } finally {
      f.sqlite.close()
    }
  })
  it('recovers only the exact actor-bound command and rejects replay after authority revocation', async () => {
    const f = await adminAuditFixture()
    try {
      const { id } = await f.source(),
        key = crypto.randomUUID(),
        hash = await adminAuditIntentHash('review', id, review)
      const receipt = await reviewD1AdminAudit(f.database, ADMIN, id, review, { idempotencyKey: key })
      expect(await readD1AdminAuditCommand(f.database, ADMIN, key, hash)).toMatchObject({ outcome: 'applied', receipt })
      await expect(readD1AdminAuditCommand(f.database, RECIPIENT, key, hash)).rejects.toMatchObject({
        code: 'forbidden'
      })
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), ADMIN.sessionId)
      await expect(reviewD1AdminAudit(f.database, ADMIN, id, review, { idempotencyKey: key })).rejects.toMatchObject({
        code: 'unauthenticated'
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('creates one durable bounded export and downloads identical metadata without read writes', async () => {
    const f = await adminAuditFixture()
    try {
      await f.source()
      const input = { filters: { family: 'admin_invitation' }, reason: 'Exportación explícita para revisión interna.' }
      const key = crypto.randomUUID(),
        receipt = await exportD1AdminAudit(f.database, ADMIN, input, { idempotencyKey: key })
      expect(receipt).toMatchObject({ action: 'export', rows: 1 })
      expect(await exportD1AdminAudit(f.database, ADMIN, input, { idempotencyKey: key })).toEqual(receipt)
      const download = await downloadD1AdminAuditExport(f.database, ADMIN, key)
      expect(download.receipt).toEqual(receipt)
      expect(download.csv.startsWith('\uFEFFid,family,')).toBe(true)
      expect(download.csv).not.toContain(f.input.recipientEmail)
      expect(download.csv).not.toContain(f.input.reason)
      expect(new TextEncoder().encode(download.csv).byteLength).toBe(receipt.action === 'export' ? receipt.bytes : -1)
      const count = f.sqlite.prepare('SELECT count(*) n FROM admin_audit_commands').get()
      expect(await downloadD1AdminAuditExport(f.database, ADMIN, key)).toEqual(download)
      expect(f.sqlite.prepare('SELECT count(*) n FROM admin_audit_commands').get()).toEqual(count)
    } finally {
      f.sqlite.close()
    }
  })
  it('expires download after 24h while preserving its immutable command receipt', async () => {
    const f = await adminAuditFixture()
    try {
      const input = { filters: {}, reason: 'Exportación con conservación operativa acotada.' },
        key = crypto.randomUUID()
      const receipt = await exportD1AdminAudit(f.database, ADMIN, input, { idempotencyKey: key })
      if (receipt.action !== 'export') throw new Error('wrong receipt')
      await expect(
        downloadD1AdminAuditExport(f.database, ADMIN, key, { now: receipt.expiresAt })
      ).rejects.toMatchObject({ code: 'not_found' })
      expect(
        await readD1AdminAuditCommand(f.database, ADMIN, key, await adminAuditIntentHash('export', null, input))
      ).toMatchObject({ outcome: 'applied', receipt })
    } finally {
      f.sqlite.close()
    }
  })
  it('returns unknown only for an authorized absent exact command', async () => {
    const f = await adminAuditFixture()
    try {
      expect(await readD1AdminAuditCommand(f.database, ADMIN, crypto.randomUUID(), 'a'.repeat(64))).toEqual({
        source: 'cloudflare',
        outcome: 'unknown',
        receipt: null
      })
    } finally {
      f.sqlite.close()
    }
  })
})
