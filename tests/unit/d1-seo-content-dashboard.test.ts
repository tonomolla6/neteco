import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  readSeoContentDashboard,
  syncSeoContentMetrics,
  recordSeoContentCost,
  getSeoContentSyncState
} from '../../workers/seo/content-dashboard'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000001',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0123_seo_b2b_metrics_cost_to_serve.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  // Seed admin identity and auth session
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('catalog.write', 'catalog', 'write', 'Edición catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'catalog.write');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin-seo@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_CLAIMS.identityId}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin', '${NOW}');
  `)

  return sqlite
}

describe('DAT-019: SEO & Content Dashboard Core Logic', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('calculates aggregate impressions, clicks, CTR, position and assisted revenue (no solo sesiones)', async () => {
    // Sync SEO performance metrics
    await syncSeoContentMetrics(
      db,
      ADMIN_CLAIMS,
      {
        syncDate: '2026-10-28',
        dataThroughDate: '2026-10-28',
        source: 'google_search_console_sync',
        metrics: [
          {
            landingPath: '/producto/desengrasante-industrial-5l',
            query: 'desengrasante industrial',
            device: 'desktop',
            impressions: 1200,
            clicks: 120,
            avgPosition: 2.5,
            assistedOrdersCount: 8,
            assistedRevenueGrossCents: 96000,
            assistedRevenueNetCents: 79339
          },
          {
            landingPath: '/producto/desengrasante-industrial-5l',
            query: 'comprar desengrasante taller',
            device: 'mobile',
            impressions: 800,
            clicks: 60,
            avgPosition: 3.8,
            assistedOrdersCount: 4,
            assistedRevenueGrossCents: 48000,
            assistedRevenueNetCents: 39669
          },
          {
            landingPath: '/categoria/desengrasantes',
            query: 'productos limpieza quimica',
            device: 'desktop',
            impressions: 3000,
            clicks: 90,
            avgPosition: 7.2,
            assistedOrdersCount: 3,
            assistedRevenueGrossCents: 36000,
            assistedRevenueNetCents: 29752
          }
        ]
      },
      { commandId: 'cmd-seo-sync-1', now: () => NOW }
    )

    // Record editorial/production costs
    await recordSeoContentCost(
      db,
      ADMIN_CLAIMS,
      {
        landingPath: '/producto/desengrasante-industrial-5l',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        costCents: 25000, // 250.00 EUR
        costType: 'copywriting',
        description: 'Redacción ficha técnica y optimización SEO semántico'
      },
      { commandId: 'cmd-seo-cost-1', now: () => NOW }
    )

    const dashboard = await readSeoContentDashboard(
      db,
      ADMIN_CLAIMS,
      { from: '2026-10-01', to: '2026-10-31' },
      { now: () => NOW }
    )

    // Check acceptance criteria:
    // 1. Impresiones
    expect(dashboard.summary.totalImpressions).toBe(5000)
    // 2. Clicks
    expect(dashboard.summary.totalClicks).toBe(270)
    // CTR calculation: 270 / 5000 = 5.4%
    expect(dashboard.summary.overallCtr).toBeCloseTo(0.054, 3)
    // Weighted avg position
    // (1200*2.5 + 800*3.8 + 3000*7.2) / 5000 = (3000 + 3040 + 21600) / 5000 = 27640 / 5000 = 5.528
    expect(dashboard.summary.avgPosition).toBeCloseTo(5.53, 1)

    // 3. Revenue asistido
    expect(dashboard.summary.assistedOrdersCount).toBe(15)
    expect(dashboard.summary.assistedRevenueGrossCents).toBe(180000) // 1800.00 EUR
    expect(dashboard.summary.assistedRevenueNetCents).toBe(148760)

    // 4. Coste y ROI
    expect(dashboard.summary.totalContentCostCents).toBe(25000) // 250.00 EUR
    expect(dashboard.summary.seoRoi).toBeCloseTo(148760 / 25000, 2) // ~5.95x net revenue / cost

    // 5. Consultas
    expect(dashboard.queries.length).toBe(3)
    const topQuery = dashboard.queries.find((q) => q.query === 'desengrasante industrial')
    expect(topQuery).toBeDefined()
    expect(topQuery?.impressions).toBe(1200)
    expect(topQuery?.clicks).toBe(120)
    expect(topQuery?.ctr).toBeCloseTo(0.1, 2)
    expect(topQuery?.avgPosition).toBe(2.5)
    expect(topQuery?.assistedRevenueGrossCents).toBe(96000)

    // 6. Landing pages
    expect(dashboard.landingPages.length).toBe(2)
    const productLanding = dashboard.landingPages.find((l) => l.landingPath === '/producto/desengrasante-industrial-5l')
    expect(productLanding).toBeDefined()
    expect(productLanding?.impressions).toBe(2000)
    expect(productLanding?.clicks).toBe(180)
    expect(productLanding?.contentCostCents).toBe(25000)
    expect(productLanding?.assistedRevenueGrossCents).toBe(144000)

    // 7. Actualización
    expect(dashboard.syncStatus.status).toBe('synced')
    expect(dashboard.syncStatus.dataThroughDate).toBe('2026-10-28')
    expect(dashboard.syncStatus.lastSyncAt).toBe(NOW)
  })

  it('filters by device and landingPath', async () => {
    await syncSeoContentMetrics(
      db,
      ADMIN_CLAIMS,
      {
        syncDate: '2026-10-28',
        dataThroughDate: '2026-10-28',
        source: 'gsc',
        metrics: [
          {
            landingPath: '/producto/desengrasante',
            query: 'desengrasante',
            device: 'desktop',
            impressions: 500,
            clicks: 50,
            avgPosition: 3.0,
            assistedOrdersCount: 2,
            assistedRevenueGrossCents: 20000,
            assistedRevenueNetCents: 16528
          },
          {
            landingPath: '/producto/desengrasante',
            query: 'desengrasante',
            device: 'mobile',
            impressions: 400,
            clicks: 20,
            avgPosition: 4.0,
            assistedOrdersCount: 1,
            assistedRevenueGrossCents: 10000,
            assistedRevenueNetCents: 8264
          }
        ]
      },
      { commandId: 'cmd-filter-test', now: () => NOW }
    )

    const mobileOnly = await readSeoContentDashboard(db, ADMIN_CLAIMS, { device: 'mobile' }, { now: () => NOW })
    expect(mobileOnly.summary.totalImpressions).toBe(400)
    expect(mobileOnly.summary.totalClicks).toBe(20)

    const desktopOnly = await readSeoContentDashboard(db, ADMIN_CLAIMS, { device: 'desktop' }, { now: () => NOW })
    expect(desktopOnly.summary.totalImpressions).toBe(500)
    expect(desktopOnly.summary.totalClicks).toBe(50)
  })

  it('handles empty data gracefully without division by zero', async () => {
    const dashboard = await readSeoContentDashboard(
      db,
      ADMIN_CLAIMS,
      { from: '2026-01-01', to: '2026-01-02' },
      { now: () => NOW }
    )

    expect(dashboard.summary.totalImpressions).toBe(0)
    expect(dashboard.summary.totalClicks).toBe(0)
    expect(dashboard.summary.overallCtr).toBe(0)
    expect(dashboard.summary.avgPosition).toBe(0)
    expect(dashboard.summary.assistedRevenueGrossCents).toBe(0)
    expect(dashboard.summary.totalContentCostCents).toBe(0)
    expect(dashboard.summary.seoRoi).toBe(0)
    expect(dashboard.queries).toEqual([])
    expect(dashboard.landingPages).toEqual([])
  })

  it('enforces idempotency on sync commands', async () => {
    const payload = {
      syncDate: '2026-10-27',
      dataThroughDate: '2026-10-27',
      source: 'gsc',
      metrics: [
        {
          landingPath: '/contacto',
          query: 'telefono neteco',
          device: 'all' as const,
          impressions: 100,
          clicks: 10,
          avgPosition: 1.1,
          assistedOrdersCount: 0,
          assistedRevenueGrossCents: 0,
          assistedRevenueNetCents: 0
        }
      ]
    }

    const first = await syncSeoContentMetrics(db, ADMIN_CLAIMS, payload, {
      commandId: 'cmd-idempotent-1',
      now: () => NOW
    })
    expect(first.recordsProcessed).toBe(1)

    // Replay with identical commandId
    const second = await syncSeoContentMetrics(db, ADMIN_CLAIMS, payload, {
      commandId: 'cmd-idempotent-1',
      now: () => NOW
    })
    expect(second.idempotentReplay).toBe(true)

    const syncState = await getSeoContentSyncState(db, ADMIN_CLAIMS, { now: () => NOW })
    expect(syncState.lastSyncAt).toBe(NOW)
    expect(syncState.dataThroughDate).toBe('2026-10-27')
  })
})
