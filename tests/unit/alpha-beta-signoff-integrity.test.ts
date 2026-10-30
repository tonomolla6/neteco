import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { createAlphaBetaPromotion, submitAlphaBetaSignoff } from '../../workers/release/alpha-beta-promotion'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-0000000000d1'
const BIZ_ID = '10000000-0000-4000-8000-0000000000d2'
const EXPIRED_LEGAL_ID = '10000000-0000-4000-8000-0000000000d3'

const CHECKLIST = {
  sloVerified: true,
  alertsConfigured: true,
  runbooksPublished: true,
  restoreRehearsed: true,
  pentestCleared: true,
  uatPassed: true,
  notes: 'Gates verdes'
}
const EVIDENCE = {
  releaseVersion: 'v3.0.0-beta.1',
  targetCommit: 'abcdef1234567890abcdef1234567890abcdef12',
  sloDashboardRef: 'https://mon.internal/slo',
  alertsAuditRef: 'audit://alerts/1',
  runbookIndexRef: 'docs://runbooks/1',
  restoreDrillLogRef: 'logs://restore/1',
  pentestReportHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  uatReportRef: 'reports://uat/1',
  metadata: {}
}

describe('CIC-028: la firma solo la emite quien posee el rol y es atómica', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.exec(
      await readFile(
        new URL('../../db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql', import.meta.url),
        'utf8'
      )
    )
    sqlite.exec(`
      INSERT OR IGNORE INTO roles (code, name, description) VALUES
        ('admin','Admin','x'), ('business','Negocio','x'), ('legal','Legal','x'), ('release_manager','RM','x');
      INSERT INTO identities (id,email,password_hash,status,created_at,updated_at) VALUES
        ('${ADMIN_ID}','a@example.invalid','h','active','${NOW}','${NOW}'),
        ('${BIZ_ID}','b@example.invalid','h','active','${NOW}','${NOW}'),
        ('${EXPIRED_LEGAL_ID}','l@example.invalid','h','active','${NOW}','${NOW}');
      INSERT INTO identity_roles (identity_id, role_code, granted_at, expires_at) VALUES
        ('${ADMIN_ID}','admin','${NOW}',NULL),
        ('${BIZ_ID}','business','${NOW}',NULL),
        ('${BIZ_ID}','legal','${NOW}',NULL),
        ('${EXPIRED_LEGAL_ID}','legal','2026-10-01T00:00:00Z','2026-10-02T00:00:00Z');
    `)
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => sqlite.close())

  const draft = () =>
    createAlphaBetaPromotion(
      db,
      {
        commandId: 'cmd-promo-1',
        releaseVersion: 'v3.0.0-beta.1',
        p0DefectsCount: 0,
        p1DefectsCount: 0,
        checklist: CHECKLIST,
        evidenceBundle: EVIDENCE
      },
      ADMIN_ID,
      NOW
    )
  const signoff = (
    promoId: string,
    version: number,
    role: 'business' | 'legal' | 'release_manager',
    commandId: string
  ) => ({
    commandId,
    promotionId: promoId,
    expectedVersion: version,
    role,
    statement: 'Declaro conformidad con el pase a beta'
  })

  it('un admin sin el rol de negocio no puede firmar como negocio', async () => {
    const promo = await draft()
    await expect(
      submitAlphaBetaSignoff(db, signoff(promo.id, promo.version, 'business', 'cmd-sign-1'), ADMIN_ID, NOW)
    ).rejects.toMatchObject({ code: 'signoff_role_not_held', statusCode: 403 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM alpha_beta_promotion_signoffs').get()).toEqual({ n: 0 })
  })

  it('un rol caducado no sirve para firmar', async () => {
    const promo = await draft()
    await expect(
      submitAlphaBetaSignoff(db, signoff(promo.id, promo.version, 'legal', 'cmd-sign-2'), EXPIRED_LEGAL_ID, NOW)
    ).rejects.toMatchObject({ code: 'signoff_role_not_held' })
  })

  it('la misma persona no firma dos roles de la misma promoción (separación de funciones)', async () => {
    const promo = await draft()
    const first = await submitAlphaBetaSignoff(
      db,
      signoff(promo.id, promo.version, 'business', 'cmd-sign-3'),
      BIZ_ID,
      NOW
    )
    await expect(
      submitAlphaBetaSignoff(db, signoff(promo.id, first.version, 'legal', 'cmd-sign-4'), BIZ_ID, NOW)
    ).rejects.toMatchObject({ code: 'signoff_actor_already_signed' })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM alpha_beta_promotion_signoffs').get()).toEqual({ n: 1 })
  })

  it('una firma que pierde la carrera de versión no deja firma huérfana ni comando', async () => {
    const promo = await draft()
    let fired = false
    const racing = {
      prepare: (sql: string) => {
        const wrap = (statement: ReturnType<D1Database['prepare']>): ReturnType<D1Database['prepare']> =>
          ({
            sql,
            bind: (...values: unknown[]) => wrap(statement.bind(...values)),
            first: async (...values: unknown[]) => {
              const row = await (statement as unknown as { first(...a: unknown[]): Promise<unknown> }).first(...values)
              if (!fired && /^\s*SELECT/i.test(sql) && /FROM alpha_beta_promotions/i.test(sql)) {
                fired = true
                sqlite.exec(`UPDATE alpha_beta_promotions SET version = version + 1 WHERE id = '${promo.id}'`)
              }
              return row
            },
            all: (...values: unknown[]) =>
              (statement as unknown as { all(...a: unknown[]): Promise<unknown> }).all(...values),
            run: (...values: unknown[]) =>
              (statement as unknown as { run(...a: unknown[]): Promise<unknown> }).run(...values)
          }) as never
        return wrap(db.prepare(sql))
      },
      batch: (statements: never[]) => db.batch(statements)
    } as unknown as D1Database
    await expect(
      submitAlphaBetaSignoff(racing, signoff(promo.id, promo.version, 'business', 'cmd-sign-5'), BIZ_ID, NOW)
    ).rejects.toMatchObject({ code: 'concurrency_conflict' })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM alpha_beta_promotion_signoffs').get()).toEqual({ n: 0 })
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM alpha_beta_promotion_commands WHERE command_id = 'cmd-sign-5'").get()
    ).toEqual({ n: 0 })
  })
})
