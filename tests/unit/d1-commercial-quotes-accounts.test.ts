import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  getCommercialPipeline,
  getCommercialAccountDetail,
  createCommercialNextAction,
  completeCommercialNextAction,
  evaluateQuoteMargin,
  approveQuoteMarginThreshold,
  CommercialQuotesAccountsError
} from '../../workers/catalog/commercial-quotes-accounts'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000030',
  sessionId: '20000000-0000-4000-8000-000000000030',
  sessionVersion: 1
}

const UNAUTHORIZED_CLAIMS: VerifiedSessionClaims = {
  identityId: '90000000-0000-4000-8000-000000000099',
  sessionId: '91000000-0000-4000-8000-000000000099',
  sessionVersion: 1
}

const CUSTOMER_ID = '40000000-0000-4000-8000-000000000001'
const QUOTE_ID = '50000000-0000-4000-8000-000000000001'
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
      ('sales', 'Comercial', 'Rol comercial'),
      ('guest', 'Invitado', 'Sin permisos');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('sales.manage', 'sales', 'manage', 'Gestión comercial');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('sales', 'sales.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'sales-manager@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${UNAUTHORIZED_CLAIMS.identityId}', 'unauth@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_CLAIMS.identityId}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('${UNAUTHORIZED_CLAIMS.sessionId}', '${UNAUTHORIZED_CLAIMS.identityId}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin', '${NOW}'),
      ('${UNAUTHORIZED_CLAIMS.identityId}', 'guest', '${NOW}');

    INSERT OR IGNORE INTO customers (id, name, status, created_at, updated_at) VALUES
      ('${CUSTOMER_ID}', 'Manuel Soto', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO companies (id, customer_id, legal_name, status, created_at, updated_at) VALUES
      ('comp-001', '${CUSTOMER_ID}', 'Industrias Químicas del Norte S.L.', 'approved', '${NOW}', '${NOW}');
  `)

  sqlite.exec(`
      CREATE TABLE IF NOT EXISTS sales_quotes (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        current_version INTEGER NOT NULL CHECK(current_version>=1),
        created_by TEXT NOT NULL REFERENCES identities(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT OR IGNORE INTO sales_quotes (id, customer_id, current_version, created_by, created_at, updated_at) VALUES
        ('${QUOTE_ID}', '${CUSTOMER_ID}', 1, '${ADMIN_CLAIMS.identityId}', '${NOW}', '${NOW}');
    `)

  return sqlite
}

describe('ADM-030: Commercial Pipeline, Next Actions & Margins Core', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('retrieves commercial pipeline with ERP/CRM disclaimer and stage metrics', async () => {
    const pipeline = await getCommercialPipeline(db, ADMIN_CLAIMS, {}, { now: NOW })

    expect(pipeline.erpDisclaimer).toContain('No sustituye un ERP/CRM')
    expect(pipeline.stages).toBeDefined()
    expect(pipeline.stages.lead).toBeDefined()
    expect(pipeline.stages.quote_drafted).toBeDefined()
    expect(pipeline.stages.negotiation).toBeDefined()
    expect(pipeline.stages.approved).toBeDefined()
    expect(pipeline.stages.converted).toBeDefined()
    expect(pipeline.accounts).toBeInstanceOf(Array)
  })

  it('creates and completes next actions for commercial accounts with CAS', async () => {
    const action = await createCommercialNextAction(
      db,
      ADMIN_CLAIMS,
      {
        customerId: CUSTOMER_ID,
        quoteId: QUOTE_ID,
        actionDescription: 'Revisión técnica de incompatibilidades de surfactantes con cliente',
        dueDate: '2026-11-05',
        priority: 'high',
        assignedIdentityId: ADMIN_CLAIMS.identityId
      },
      { commandId: '30000000-0000-4000-8000-000000000021', now: NOW }
    )

    expect(action.id).toBeDefined()
    expect(action.completed).toBe(false)
    expect(action.priority).toBe('high')
    expect(action.version).toBe(1)

    // Complete the action
    const completed = await completeCommercialNextAction(
      db,
      ADMIN_CLAIMS,
      action.id,
      {
        expectedVersion: 1,
        notes: 'Cliente confirma recepción de ficha técnica y aprueba propuesta'
      },
      { commandId: '30000000-0000-4000-8000-000000000022', now: NOW }
    )

    expect(completed.completed).toBe(true)
    expect(completed.version).toBe(2)
    expect(completed.completedBy).toBe(ADMIN_CLAIMS.identityId)

    // Stale version conflict
    await expect(
      completeCommercialNextAction(
        db,
        ADMIN_CLAIMS,
        action.id,
        {
          expectedVersion: 1,
          notes: 'Stale attempt'
        },
        { commandId: '30000000-0000-4000-8000-000000000023', now: NOW }
      )
    ).rejects.toThrow(CommercialQuotesAccountsError)
  })

  it('calculates quote margins and flags below threshold margins (< 15%)', async () => {
    // Normal healthy margin (e.g. Net 10000 cents, Cost 6500 cents -> 35% margin)
    const healthy = await evaluateQuoteMargin(
      db,
      ADMIN_CLAIMS,
      QUOTE_ID,
      {
        quoteVersion: 1,
        totalNetCents: 10000,
        totalCostCents: 6500
      },
      { commandId: '30000000-0000-4000-8000-000000000024', now: NOW }
    )

    expect(healthy.marginCents).toBe(3500)
    expect(healthy.marginPercentageBps).toBe(3500) // 35.00%
    expect(healthy.isBelowThreshold).toBe(false)

    // Low margin (e.g. Net 10000 cents, Cost 9000 cents -> 10% margin < 15%)
    const low = await evaluateQuoteMargin(
      db,
      ADMIN_CLAIMS,
      QUOTE_ID,
      {
        quoteVersion: 1,
        totalNetCents: 10000,
        totalCostCents: 9000
      },
      { commandId: '30000000-0000-4000-8000-000000000025', now: NOW }
    )

    expect(low.marginCents).toBe(1000)
    expect(low.marginPercentageBps).toBe(1000) // 10.00%
    expect(low.isBelowThreshold).toBe(true)
  })

  it('allows manager approval of below-threshold margin exception', async () => {
    await evaluateQuoteMargin(
      db,
      ADMIN_CLAIMS,
      QUOTE_ID,
      {
        quoteVersion: 1,
        totalNetCents: 10000,
        totalCostCents: 9000
      },
      { commandId: '30000000-0000-4000-8000-000000000026', now: NOW }
    )

    const approved = await approveQuoteMarginThreshold(
      db,
      ADMIN_CLAIMS,
      QUOTE_ID,
      {
        reason: 'Aprobación estratégica de cuenta B2B por volumen anual superior a 50k EUR'
      },
      { commandId: '30000000-0000-4000-8000-000000000027', now: NOW }
    )

    expect(approved.approvedBy).toBe(ADMIN_CLAIMS.identityId)
    expect(approved.approvedAt).toBeDefined()
  })

  it('retrieves detailed commercial account information for customer', async () => {
    const detail = await getCommercialAccountDetail(db, ADMIN_CLAIMS, CUSTOMER_ID)
    expect(detail.customerId).toBe(CUSTOMER_ID)
    expect(detail.companyName).toBe('Industrias Químicas del Norte S.L.')
    expect(detail.contactName).toBe('Manuel Soto')
    expect(detail.nextActions).toBeInstanceOf(Array)
  })

  it('rejects unauthorized access for commercial pipeline operations', async () => {
    await expect(getCommercialPipeline(db, UNAUTHORIZED_CLAIMS, {}, { now: NOW })).rejects.toThrow(
      /forbidden|unauthenticated/
    )
  })
})
