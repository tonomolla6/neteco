import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { CreatePromotionInput, SubmitSignoffInput } from '../../shared/alpha-beta-promotion'
import {
  createAlphaBetaPromotion,
  getAlphaBetaPromotion,
  promoteAlphaBetaRelease,
  rejectAlphaBetaPromotion,
  submitAlphaBetaSignoff
} from '../../workers/release/alpha-beta-promotion'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const BIZ_ID = '10000000-0000-4000-8000-000000000002'
const LEGAL_ID = '10000000-0000-4000-8000-000000000003'
const RM_ID = '10000000-0000-4000-8000-000000000004'

async function setupDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Fixture admin'),
      ('business', 'Negocio', 'Fixture business'),
      ('legal', 'Legal', 'Fixture legal'),
      ('release_manager', 'Release Manager', 'Fixture RM');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@example.invalid', 'hash', 'active', '${NOW}', '${NOW}'),
      ('${BIZ_ID}', 'business@example.invalid', 'hash', 'active', '${NOW}', '${NOW}'),
      ('${LEGAL_ID}', 'legal@example.invalid', 'hash', 'active', '${NOW}', '${NOW}'),
      ('${RM_ID}', 'rm@example.invalid', 'hash', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${BIZ_ID}', 'business', '${NOW}'),
      ('${LEGAL_ID}', 'legal', '${NOW}'),
      ('${RM_ID}', 'release_manager', '${NOW}');
  `)
  return sqlite
}

const SAMPLE_CHECKLIST = {
  sloVerified: true,
  alertsConfigured: true,
  runbooksPublished: true,
  restoreRehearsed: true,
  pentestCleared: true,
  uatPassed: true,
  notes: 'All preflight gates green.'
}

const SAMPLE_EVIDENCE = {
  releaseVersion: 'v2.4.0-beta.1',
  targetCommit: 'abcdef1234567890abcdef1234567890abcdef12',
  sloDashboardRef: 'https://mon.internal/dashboards/slo-beta-20261029',
  alertsAuditRef: 'audit://alerts/release-v2.4.0',
  runbookIndexRef: 'docs://runbooks/dr-v2',
  restoreDrillLogRef: 'logs://restore/drill-20261028-ok',
  pentestReportHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  uatReportRef: 'reports://uat/cycle-42-pass',
  metadata: { pipeline: 'build-9041' }
}

describe('CIC-028: Promoción Alpha→Beta por checklist firmado y evidencia', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('crea un borrador de promoción con evidencia adjunta y hash determinista', async () => {
    const input: CreatePromotionInput = {
      commandId: 'cmd-promo-001',
      releaseVersion: 'v2.4.0-beta.1',
      p0DefectsCount: 0,
      p1DefectsCount: 0,
      checklist: SAMPLE_CHECKLIST,
      evidenceBundle: SAMPLE_EVIDENCE
    }

    const created = await createAlphaBetaPromotion(db, input, ADMIN_ID, NOW)
    expect(created.status).toBe('draft')
    expect(created.releaseVersion).toBe('v2.4.0-beta.1')
    expect(created.evidenceHash).toHaveLength(64)
    expect(created.p0DefectsCount).toBe(0)
    expect(created.p1DefectsCount).toBe(0)
    expect(created.version).toBe(1)

    const fetched = await getAlphaBetaPromotion(db, created.id)
    expect(fetched.id).toBe(created.id)
    expect(fetched.checklistSummary.sloVerified).toBe(true)
  })

  it('bloquea firmas de aprobación si existen defectos P0 o P1 pendientes', async () => {
    const input: CreatePromotionInput = {
      commandId: 'cmd-promo-002',
      releaseVersion: 'v2.4.0-beta.2',
      p0DefectsCount: 1, // P0 presente
      p1DefectsCount: 0,
      checklist: SAMPLE_CHECKLIST,
      evidenceBundle: SAMPLE_EVIDENCE
    }

    const promo = await createAlphaBetaPromotion(db, input, ADMIN_ID, NOW)

    const signoffInput: SubmitSignoffInput = {
      commandId: 'cmd-sign-001',
      promotionId: promo.id,
      expectedVersion: promo.version,
      role: 'business',
      statement: 'Apruebo pase a beta comercial'
    }

    await expect(submitAlphaBetaSignoff(db, signoffInput, BIZ_ID, NOW)).rejects.toThrow(
      expect.objectContaining({ code: 'p0_p1_defects_present' })
    )
  })

  it('bloquea firmas si el checklist tiene items incompletos (e.g. restore o pentest)', async () => {
    const incompleteChecklist = { ...SAMPLE_CHECKLIST, restoreRehearsed: false }
    const input: CreatePromotionInput = {
      commandId: 'cmd-promo-003',
      releaseVersion: 'v2.4.0-beta.3',
      p0DefectsCount: 0,
      p1DefectsCount: 0,
      checklist: incompleteChecklist,
      evidenceBundle: SAMPLE_EVIDENCE
    }

    const promo = await createAlphaBetaPromotion(db, input, ADMIN_ID, NOW)

    const signoffInput: SubmitSignoffInput = {
      commandId: 'cmd-sign-002',
      promotionId: promo.id,
      expectedVersion: promo.version,
      role: 'legal',
      statement: 'Validado legalmente'
    }

    await expect(submitAlphaBetaSignoff(db, signoffInput, LEGAL_ID, NOW)).rejects.toThrow(
      expect.objectContaining({ code: 'checklist_incomplete' })
    )
  })

  it('requiere firmas de negocio, legal y release manager antes de permitir promoción', async () => {
    const input: CreatePromotionInput = {
      commandId: 'cmd-promo-004',
      releaseVersion: 'v2.4.0-beta.4',
      p0DefectsCount: 0,
      p1DefectsCount: 0,
      checklist: SAMPLE_CHECKLIST,
      evidenceBundle: SAMPLE_EVIDENCE
    }

    const promo = await createAlphaBetaPromotion(db, input, ADMIN_ID, NOW)

    // Intento de promocionar directamente sin firmas
    await expect(
      promoteAlphaBetaRelease(
        db,
        { commandId: 'cmd-premature', promotionId: promo.id, expectedVersion: promo.version },
        RM_ID,
        NOW
      )
    ).rejects.toThrow(expect.objectContaining({ code: 'promotion_not_approved' }))

    // 1. Firma de negocio
    const afterBiz = await submitAlphaBetaSignoff(
      db,
      {
        commandId: 'cmd-sign-biz',
        promotionId: promo.id,
        expectedVersion: 1,
        role: 'business',
        statement: 'Negocio aprueba lanzamiento Beta'
      },
      BIZ_ID,
      NOW
    )
    expect(afterBiz.status).toBe('in_review')

    // 2. Firma legal
    const afterLegal = await submitAlphaBetaSignoff(
      db,
      {
        commandId: 'cmd-sign-legal',
        promotionId: promo.id,
        expectedVersion: 2,
        role: 'legal',
        statement: 'Cumplimiento legal y RGPD verificado'
      },
      LEGAL_ID,
      NOW
    )
    expect(afterLegal.status).toBe('in_review')

    // 3. Firma release manager -> pasa a approved
    const afterRm = await submitAlphaBetaSignoff(
      db,
      {
        commandId: 'cmd-sign-rm',
        promotionId: promo.id,
        expectedVersion: 3,
        role: 'release_manager',
        statement: 'Checklist técnico y SLO conformes'
      },
      RM_ID,
      NOW
    )
    expect(afterRm.status).toBe('approved')

    // 4. Promoción efectiva
    const promoted = await promoteAlphaBetaRelease(
      db,
      { commandId: 'cmd-promote-ok', promotionId: promo.id, expectedVersion: 4 },
      RM_ID,
      NOW
    )
    expect(promoted.status).toBe('promoted')
    expect(promoted.promotedAt).toBe(NOW)
  })

  it('permite rechazar una promoción con motivo explicito', async () => {
    const input: CreatePromotionInput = {
      commandId: 'cmd-promo-005',
      releaseVersion: 'v2.4.0-beta.5',
      p0DefectsCount: 0,
      p1DefectsCount: 0,
      checklist: SAMPLE_CHECKLIST,
      evidenceBundle: SAMPLE_EVIDENCE
    }

    const promo = await createAlphaBetaPromotion(db, input, ADMIN_ID, NOW)
    const rejected = await rejectAlphaBetaPromotion(
      db,
      {
        commandId: 'cmd-reject-01',
        promotionId: promo.id,
        expectedVersion: 1,
        reason: 'Riesgo regulatorio en nueva pasarela'
      },
      LEGAL_ID,
      NOW
    )
    expect(rejected.status).toBe('rejected')
    expect(rejected.rejectionReason).toBe('Riesgo regulatorio en nueva pasarela')
  })

  it('gestiona concurrencia CAS y colisiones de versiones obsoletas', async () => {
    const input: CreatePromotionInput = {
      commandId: 'cmd-promo-006',
      releaseVersion: 'v2.4.0-beta.6',
      p0DefectsCount: 0,
      p1DefectsCount: 0,
      checklist: SAMPLE_CHECKLIST,
      evidenceBundle: SAMPLE_EVIDENCE
    }

    const promo = await createAlphaBetaPromotion(db, input, ADMIN_ID, NOW)

    // Signoff incrementa versión a 2
    await submitAlphaBetaSignoff(
      db,
      {
        commandId: 'cmd-sign-c1',
        promotionId: promo.id,
        expectedVersion: 1,
        role: 'business',
        statement: 'Aprobación 1'
      },
      BIZ_ID,
      NOW
    )

    // Intento concurrente con versión obsoleta 1
    await expect(
      submitAlphaBetaSignoff(
        db,
        {
          commandId: 'cmd-sign-c2',
          promotionId: promo.id,
          expectedVersion: 1,
          role: 'legal',
          statement: 'Aprobación 2'
        },
        LEGAL_ID,
        NOW
      )
    ).rejects.toThrow(expect.objectContaining({ code: 'concurrency_conflict' }))
  })

  it('garantiza idempotencia estricta por commandId', async () => {
    const input: CreatePromotionInput = {
      commandId: 'cmd-promo-idemp',
      releaseVersion: 'v2.4.0-beta.7',
      p0DefectsCount: 0,
      p1DefectsCount: 0,
      checklist: SAMPLE_CHECKLIST,
      evidenceBundle: SAMPLE_EVIDENCE
    }

    const first = await createAlphaBetaPromotion(db, input, ADMIN_ID, NOW)
    const second = await createAlphaBetaPromotion(db, input, ADMIN_ID, NOW)

    expect(second.id).toBe(first.id)

    // Conflicto de payload con mismo commandId
    await expect(
      createAlphaBetaPromotion(db, { ...input, releaseVersion: 'v2.4.0-beta.altered' }, ADMIN_ID, NOW)
    ).rejects.toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  })
})
