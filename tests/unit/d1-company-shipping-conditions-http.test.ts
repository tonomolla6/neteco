import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleCompanyShippingConditionsHttp,
  ownsCompanyShippingConditionsNamespace
} from '../../workers/fulfillment/company-shipping-conditions-http'
import type { DatabaseAdapter } from '../../workers/fulfillment/convenience-points'
import type { CompanyShippingConditions } from '../../shared/company-shipping-conditions'

const now = '2026-10-29T10:00:00Z'

async function fixture() {
  const db = await openMigratedDatabase()
  try {
    const migration = await readFile('db/d1/migrations/0109_shipping_convenience_conditions_routes.sql', 'utf8')
    db.exec(migration)

    db.exec(`
      INSERT INTO customers(id, created_at, updated_at) VALUES
      ('cust-alpha', '${now}', '${now}'),
      ('cust-beta', '${now}', '${now}');

      INSERT INTO companies(id, customer_id, legal_name, status, created_at, updated_at) VALUES
      ('comp-alpha', 'cust-alpha', 'Alfa SL', 'approved', '${now}', '${now}'),
      ('comp-beta', 'cust-beta', 'Beta SA', 'approved', '${now}', '${now}');

      INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('id-admin', 'admin@example.invalid', 'syn', '${now}', 'active', '${now}', '${now}'),
      ('id-alpha', 'user@alfa.invalid', 'syn', '${now}', 'active', '${now}', '${now}'),
      ('id-beta', 'user@beta.invalid', 'syn', '${now}', 'active', '${now}', '${now}');

      INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('sess-admin', 'id-admin', 1, 1, '${now}', '2026-10-30T10:00:00Z'),
      ('sess-alpha', 'id-alpha', 1, 1, '${now}', '2026-10-30T10:00:00Z'),
      ('sess-beta', 'id-beta', 1, 1, '${now}', '2026-10-30T10:00:00Z');

      INSERT INTO roles(code, name, description) VALUES('admin-role', 'Admin', 'Synthetic');
      INSERT INTO permissions(code, resource, action, description) VALUES('administration.manage', 'administration', 'manage', 'Synthetic');
      INSERT INTO role_permissions(role_code, permission_code) VALUES('admin-role', 'administration.manage');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('id-admin', 'admin-role', '${now}');

      -- Prepopulate comp-alpha conditions
      INSERT INTO company_shipping_conditions (
        company_id, custom_methods_enabled, allowed_methods_json, carrier_account_carrier,
        carrier_account_number, warehouse_pickup_allowed, free_shipping_threshold_cents,
        custom_delivery_instructions, version, created_at, updated_at
      ) VALUES (
        'comp-alpha', 1, '["pickup","carrier_customer_account"]', 'seur', 'SEUR-7788',
        1, 5000, 'Dock 3', 1, '${now}', '${now}'
      );
    `)

    return db
  } catch (error) {
    db.close()
    throw error
  }
}

describe('SHP-025: Company shipping conditions HTTP contract', () => {
  it('recognizes namespace ownership for company shipping conditions', () => {
    expect(ownsCompanyShippingConditionsNamespace('/api/admin/companies/comp-1/shipping-conditions')).toBe(true)
    expect(ownsCompanyShippingConditionsNamespace('/api/account/company/shipping-conditions')).toBe(true)
    expect(ownsCompanyShippingConditionsNamespace('/api/catalog/products')).toBe(false)
  })

  it('rejects unauthenticated requests to company shipping conditions', async () => {
    const db = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/admin/companies/comp-alpha/shipping-conditions')
      const response = await handleCompanyShippingConditionsHttp(request, {
        database: db as unknown as DatabaseAdapter,
        sessionProvider: async () => null
      })

      expect(response?.status).toBe(401)
      const data = (await response?.json()) as { error?: { code: string } }
      expect(data.error?.code).toBe('unauthorized')
    } finally {
      db.close()
    }
  })

  it('allows admin to GET company shipping conditions', async () => {
    const db = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/admin/companies/comp-alpha/shipping-conditions')
      const response = await handleCompanyShippingConditionsHttp(request, {
        database: db as unknown as DatabaseAdapter,
        sessionProvider: async () => ({
          identityId: 'id-admin',
          roles: ['admin-role'],
          permissions: ['administration.manage']
        })
      })

      expect(response?.status).toBe(200)
      const data = (await response?.json()) as { conditions: CompanyShippingConditions }
      expect(data.conditions.companyId).toBe('comp-alpha')
      expect(data.conditions.carrierAccountCarrier).toBe('seur')
      expect(data.conditions.carrierAccountNumber).toBe('SEUR-7788')
    } finally {
      db.close()
    }
  })

  it('allows admin to PUT company shipping conditions with CAS versioning', async () => {
    const db = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/admin/companies/comp-alpha/shipping-conditions', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId: 'comp-alpha',
          allowedMethods: ['pickup', 'own_delivery', 'parcel'],
          warehousePickupAllowed: true,
          freeShippingThresholdCents: 8000,
          expectedVersion: 1,
          commandId: 'cmd-http-put-1'
        })
      })

      const response = await handleCompanyShippingConditionsHttp(request, {
        database: db as unknown as DatabaseAdapter,
        sessionProvider: async () => ({
          identityId: 'id-admin',
          roles: ['admin-role'],
          permissions: ['administration.manage']
        })
      })

      expect(response?.status).toBe(200)
      const data = (await response?.json()) as { conditions: CompanyShippingConditions }
      expect(data.conditions.version).toBe(2)
      expect(data.conditions.freeShippingThresholdCents).toBe(8000)
    } finally {
      db.close()
    }
  })

  it('returns 409 conflict when expectedVersion is stale on PUT', async () => {
    const db = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/admin/companies/comp-alpha/shipping-conditions', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId: 'comp-alpha',
          allowedMethods: ['pickup'],
          expectedVersion: 99,
          commandId: 'cmd-http-conflict'
        })
      })

      const response = await handleCompanyShippingConditionsHttp(request, {
        database: db as unknown as DatabaseAdapter,
        sessionProvider: async () => ({
          identityId: 'id-admin',
          roles: ['admin-role'],
          permissions: ['administration.manage']
        })
      })

      expect(response?.status).toBe(409)
      const data = (await response?.json()) as { error?: { code: string } }
      expect(data.error?.code).toBe('version_conflict')
    } finally {
      db.close()
    }
  })

  it('rejects access when admin authorization is revoked mid-flight (after read/write)', async () => {
    const db = await fixture()
    try {
      let callCount = 0
      const request = new Request('https://tienda.example.com/api/admin/companies/comp-alpha/shipping-conditions')
      const response = await handleCompanyShippingConditionsHttp(request, {
        database: db as unknown as DatabaseAdapter,
        sessionProvider: async () => {
          callCount++
          // First check passes, second check (fresh verification after read) is revoked
          if (callCount === 1) {
            return {
              identityId: 'id-admin',
              roles: ['admin-role'],
              permissions: ['administration.manage']
            }
          }
          return null
        }
      })

      expect(response?.status).toBe(403)
      const data = (await response?.json()) as { error?: { code: string } }
      expect(data.error?.code).toBe('forbidden')
    } finally {
      db.close()
    }
  })
})
