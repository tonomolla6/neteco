import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  createEditorialBriefing,
  updateEditorialBriefing,
  reviewEditorialBriefing,
  publishOrScheduleEditorialBriefing,
  readEditorialBriefing,
  listEditorialBriefings,
  readUnifiedEditorialCalendar,
  EditorialBriefingError
} from '../../workers/cms/editorial-seo-briefing'
import type { CreateEditorialBriefingInput } from '../../shared/editorial-seo-briefing'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000029',
  sessionId: '20000000-0000-4000-8000-000000000029',
  sessionVersion: 1
}

const UNAUTHORIZED_CLAIMS: VerifiedSessionClaims = {
  identityId: '90000000-0000-4000-8000-000000000099',
  sessionId: '91000000-0000-4000-8000-000000000099',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0132_editorial_seo_commercial_warehouse_scan.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador'),
      ('guest', 'Invitado', 'Sin permisos');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('catalog.write', 'catalog', 'write', 'Edición catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'catalog.write');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'editor-seo@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${UNAUTHORIZED_CLAIMS.identityId}', 'unauth@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_CLAIMS.identityId}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('${UNAUTHORIZED_CLAIMS.sessionId}', '${UNAUTHORIZED_CLAIMS.identityId}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin', '${NOW}'),
      ('${UNAUTHORIZED_CLAIMS.identityId}', 'guest', '${NOW}');
  `)

  return sqlite
}

const sampleBriefingInput: CreateEditorialBriefingInput = {
  topic: 'Guía de Desinfección Hospitalaria con Amonios Cuaternarios',
  searchIntent: 'informational',
  targetKeyword: 'desinfeccion hospitalaria amonios cuaternarios',
  secondaryKeywords: ['limpieza clinica profesional', 'normativa une en 14476'],
  expertAuthor: {
    name: 'Dra. Carmen Rivas',
    credentials: 'Dra. en Química Industrial, Especialista en Biocidas',
    identityId: '10000000-0000-4000-8000-000000000029'
  },
  sources: [
    {
      title: 'Reglamento (UE) nº 528/2012 relativo a los biocidas',
      url: 'https://eur-lex.europa.eu/legal-content/ES/TXT/?uri=CELEX%3A32012R0528',
      citation: 'Diario Oficial de la Unión Europea L 167',
      verified: true
    }
  ],
  assets: [
    {
      assetType: 'infographic',
      name: 'Tabla de compatibilidad de materiales con amonios',
      status: 'ready'
    }
  ],
  targetPublishDate: '2026-11-15',
  updateCadenceMonths: 6,
  kpiTargets: {
    targetMonthlyVisits: 2500,
    targetSerpRank: 3,
    conversionGoal: 'Descarga de ficha técnica o solicitud presupuesto B2B'
  }
}

describe('ADM-029: Editorial SEO Briefing & Calendar Core', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('creates an editorial SEO briefing with complete acceptance fields', async () => {
    const res = await createEditorialBriefing(db, ADMIN_CLAIMS, sampleBriefingInput, {
      commandId: '30000000-0000-4000-8000-000000000001',
      now: NOW
    })

    expect(res.id).toBeDefined()
    expect(res.version).toBe(1)
    expect(res.status).toBe('planned')
    expect(res.topic).toBe(sampleBriefingInput.topic)
    expect(res.searchIntent).toBe('informational')
    expect(res.expertAuthor.name).toBe('Dra. Carmen Rivas')
    expect(res.sources).toHaveLength(1)
    expect(res.assets).toHaveLength(1)
    expect(res.kpiTargets.targetMonthlyVisits).toBe(2500)
  })

  it('rejects creation if required fields or sources are missing', async () => {
    await expect(
      createEditorialBriefing(
        db,
        ADMIN_CLAIMS,
        { ...sampleBriefingInput, topic: '' },
        { commandId: '30000000-0000-4000-8000-000000000002', now: NOW }
      )
    ).rejects.toThrow(EditorialBriefingError)

    await expect(
      createEditorialBriefing(
        db,
        ADMIN_CLAIMS,
        { ...sampleBriefingInput, sources: [] },
        { commandId: '30000000-0000-4000-8000-000000000003', now: NOW }
      )
    ).rejects.toThrow(EditorialBriefingError)
  })

  it('enforces authorization and rejects unauthorized users', async () => {
    await expect(
      createEditorialBriefing(db, UNAUTHORIZED_CLAIMS, sampleBriefingInput, {
        commandId: '30000000-0000-4000-8000-000000000004',
        now: NOW
      })
    ).rejects.toThrow(/forbidden|unauthenticated/)
  })

  it('guarantees idempotency for identical commandId replay', async () => {
    const cmdId = '30000000-0000-4000-8000-000000000005'
    const first = await createEditorialBriefing(db, ADMIN_CLAIMS, sampleBriefingInput, { commandId: cmdId, now: NOW })
    const replay = await createEditorialBriefing(db, ADMIN_CLAIMS, sampleBriefingInput, { commandId: cmdId, now: NOW })

    expect(replay.id).toBe(first.id)
    expect(replay.version).toBe(first.version)
  })

  it('supports CAS updates and rejects out-of-order version updates', async () => {
    const created = await createEditorialBriefing(db, ADMIN_CLAIMS, sampleBriefingInput, {
      commandId: '30000000-0000-4000-8000-000000000006',
      now: NOW
    })

    const updated = await updateEditorialBriefing(
      db,
      ADMIN_CLAIMS,
      created.id,
      {
        expectedVersion: 1,
        topic: 'Guía Avanzada de Desinfección Hospitalaria 2026',
        targetKeyword: sampleBriefingInput.targetKeyword,
        secondaryKeywords: sampleBriefingInput.secondaryKeywords,
        searchIntent: sampleBriefingInput.searchIntent,
        expertAuthor: sampleBriefingInput.expertAuthor,
        sources: sampleBriefingInput.sources,
        assets: sampleBriefingInput.assets,
        targetPublishDate: '2026-11-20',
        updateCadenceMonths: 6,
        kpiTargets: sampleBriefingInput.kpiTargets
      },
      { commandId: '30000000-0000-4000-8000-000000000007', now: NOW }
    )

    expect(updated.version).toBe(2)
    expect(updated.topic).toBe('Guía Avanzada de Desinfección Hospitalaria 2026')

    // Expect conflict when passing stale expectedVersion 1
    await expect(
      updateEditorialBriefing(
        db,
        ADMIN_CLAIMS,
        created.id,
        {
          expectedVersion: 1,
          topic: 'Stale attempt',
          targetKeyword: sampleBriefingInput.targetKeyword,
          secondaryKeywords: [],
          searchIntent: 'informational',
          expertAuthor: sampleBriefingInput.expertAuthor,
          sources: sampleBriefingInput.sources,
          assets: [],
          targetPublishDate: '2026-11-25',
          updateCadenceMonths: 12,
          kpiTargets: sampleBriefingInput.kpiTargets
        },
        { commandId: '30000000-0000-4000-8000-000000000008', now: NOW }
      )
    ).rejects.toThrow(EditorialBriefingError)
  })

  it('manages editorial review lifecycle and transitions', async () => {
    const created = await createEditorialBriefing(db, ADMIN_CLAIMS, sampleBriefingInput, {
      commandId: '30000000-0000-4000-8000-000000000009',
      now: NOW
    })

    const reviewed = await reviewEditorialBriefing(
      db,
      ADMIN_CLAIMS,
      created.id,
      {
        expectedVersion: 1,
        reviewStatus: 'approved',
        reviewNotes: 'Revisión técnica conforme con normativa CLP y REACH.'
      },
      { commandId: '30000000-0000-4000-8000-000000000010', now: NOW }
    )

    expect(reviewed.reviewStatus).toBe('approved')
    expect(reviewed.version).toBe(2)
    expect(reviewed.reviewerIdentityId).toBe(ADMIN_CLAIMS.identityId)
  })

  it('schedules and publishes briefing with KPI verification', async () => {
    const created = await createEditorialBriefing(db, ADMIN_CLAIMS, sampleBriefingInput, {
      commandId: '30000000-0000-4000-8000-000000000011',
      now: NOW
    })

    const published = await publishOrScheduleEditorialBriefing(
      db,
      ADMIN_CLAIMS,
      created.id,
      {
        expectedVersion: 1,
        action: 'publish',
        actualPublishedAt: '2026-11-01T09:00:00Z'
      },
      { commandId: '30000000-0000-4000-8000-000000000012', now: NOW }
    )

    expect(published.status).toBe('published')
    expect(published.actualPublishedAt).toBe('2026-11-01T09:00:00Z')
  })

  it('reads unified editorial calendar with Madrid date buckets and KPI summaries', async () => {
    await createEditorialBriefing(db, ADMIN_CLAIMS, sampleBriefingInput, {
      commandId: '30000000-0000-4000-8000-000000000013',
      now: NOW
    })

    const calendar = await readUnifiedEditorialCalendar(db, ADMIN_CLAIMS, { month: '2026-11' }, { now: NOW })

    expect(calendar.month).toBe('2026-11')
    expect(calendar.timeZone).toBe('Europe/Madrid')
    expect(calendar.briefings.length).toBeGreaterThanOrEqual(1)
    expect(calendar.briefings[0].targetPublishDate).toBe('2026-11-15')
    expect(calendar.metrics.totalPlanned).toBeGreaterThanOrEqual(1)
  })

  it('reads briefing directly and lists briefings with filters', async () => {
    const created = await createEditorialBriefing(db, ADMIN_CLAIMS, sampleBriefingInput, {
      commandId: '30000000-0000-4000-8000-000000000014',
      now: NOW
    })

    const direct = await readEditorialBriefing(db, ADMIN_CLAIMS, created.id, NOW)
    expect(direct.id).toBe(created.id)
    expect(direct.topic).toBe(sampleBriefingInput.topic)

    const list = await listEditorialBriefings(db, ADMIN_CLAIMS, { searchIntent: 'informational' }, NOW)
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list.some((b) => b.id === created.id)).toBe(true)
  })
})
