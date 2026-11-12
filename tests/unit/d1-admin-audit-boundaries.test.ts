import { expect, it } from 'vitest'
import { adminAuditFixture, ADMIN, utc } from './d1-admin-audit-fixture'
import { ADMIN_AUDIT_EXPORT_COLUMNS, adminAuditHash } from '../../shared/admin-audit'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'
import {
  exportD1AdminAudit,
  downloadD1AdminAuditExport,
  readD1AdminAudit,
  reviewD1AdminAudit
} from '../../workers/auth/admin-audit'
import { testUuid } from '../support/deterministic'

it('exports exactly 1000 real invitation commands and rejects the 1001st without truncation or a receipt', async () => {
  const f = await adminAuditFixture()
  try {
    for (let index = 0; index < 1000; index++) await f.source()
    const input = { filters: { family: 'admin_invitation' }, reason: 'Exportación explícita del límite autorizado.' }
    const receipt = await exportD1AdminAudit(f.database, ADMIN, input, { idempotencyKey: testUuid() })
    expect(receipt).toMatchObject({ action: 'export', rows: 1000 })
    if (receipt.action !== 'export') throw new Error('wrong receipt')
    const download = await downloadD1AdminAuditExport(f.database, ADMIN, receipt.commandId)
    const parsed = parseCatalogCsvCells(download.csv.slice(1), {
      maxRows: 1001,
      maxColumns: ADMIN_AUDIT_EXPORT_COLUMNS.length,
      maxCellCharacters: 4096
    })
    expect(parsed).toHaveLength(1001)
    expect(parsed[0]).toEqual([...ADMIN_AUDIT_EXPORT_COLUMNS])
    expect(new Set(parsed.slice(1).map((row) => row[0])).size).toBe(1000)
    expect(await adminAuditHash(download.csv)).toBe(receipt.digest)
    await f.source()
    const count = f.sqlite.prepare('SELECT count(*) n FROM admin_audit_commands').get()
    const key = testUuid()
    await expect(exportD1AdminAudit(f.database, ADMIN, input, { idempotencyKey: key })).rejects.toMatchObject({
      code: 'export_too_large'
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM admin_audit_commands').get()).toEqual(count)
    expect(f.sqlite.prepare('SELECT id FROM admin_audit_commands WHERE id=?').get(key)).toBeUndefined()
    expect(f.sqlite.prepare('SELECT count(*) n FROM admin_invitation_commands').get()).toEqual({ n: 1001 })
    const pages = Number(f.sqlite.prepare('PRAGMA page_count').get()!.page_count)
    const pageSize = Number(f.sqlite.prepare('PRAGMA page_size').get()!.page_size)
    expect(pages * pageSize).toBeLessThanOrEqual(16 * 1024 * 1024)
  } finally {
    f.sqlite.close()
  }
}, 60_000)

it('rechecks live authority at the review transaction and rolls back every audit write after revocation', async () => {
  const f = await adminAuditFixture()
  try {
    const { id } = await f.source(),
      key = testUuid()
    let revoked = false
    const database = {
      prepare: f.database.prepare.bind(f.database),
      async batch(statements: D1PreparedStatement[]) {
        if (
          !revoked &&
          statements.some((statement) =>
            String((statement as unknown as { sql?: string }).sql).includes('INSERT INTO admin_audit_commands(')
          )
        ) {
          revoked = true
          f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), ADMIN.sessionId)
        }
        return f.database.batch(statements)
      }
    } as D1Database
    await expect(
      reviewD1AdminAudit(
        database,
        ADMIN,
        id,
        {
          expectedVersion: 0,
          disposition: 'reviewed',
          reason: 'Confirmación explícita previa a revocación.'
        },
        { idempotencyKey: key }
      )
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(revoked).toBe(true)
    expect(f.sqlite.prepare('SELECT count(*) n FROM admin_audit_commands').get()).toEqual({ n: 0 })
    expect(f.sqlite.prepare('SELECT count(*) n FROM admin_audit_guards').get()).toEqual({ n: 0 })
    expect(f.sqlite.prepare('SELECT count(*) n FROM admin_invitation_commands').get()).toEqual({ n: 1 })
  } finally {
    f.sqlite.close()
  }
})

it('rejects reversed date filters instead of returning a false empty history', async () => {
  const f = await adminAuditFixture()
  try {
    await expect(readD1AdminAudit(f.database, ADMIN, { from: utc(), to: utc(-1000) })).rejects.toMatchObject({
      code: 'invalid_input'
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM admin_audit_commands').get()).toEqual({ n: 0 })
  } finally {
    f.sqlite.close()
  }
})
