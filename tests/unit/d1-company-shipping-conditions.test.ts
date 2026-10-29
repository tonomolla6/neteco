import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase } from '../support/d1-sqlite'
import {
  getCompanyShippingConditions,
  setCompanyShippingConditions,
  CompanyShippingConditionsError
} from '../../workers/fulfillment/company-shipping-conditions'

const now = '2026-10-29T10:00:00Z'

async function fixture() {
  const db = await openMigratedDatabase()
  try {
    const migration = await readFile('db/d1/migrations/0109_shipping_convenience_conditions_routes.sql', 'utf8')
    db.exec(migration)

    // Create test customer, company, identities
    db.exec(`
      INSERT INTO customers(id, created_at, updated_at) VALUES
      ('cust-alpha', '${now}', '${now}'),
      ('cust-beta', '${now}', '${now}');

      INSERT INTO companies(id, customer_id, legal_name, status, created_at, updated_at) VALUES
      ('comp-alpha', 'cust-alpha', 'Empresa Alfa SL', 'approved', '${now}', '${now}'),
      ('comp-beta', 'cust-beta', 'Empresa Beta SA', 'approved', '${now}', '${now}');

      INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('admin-1', 'admin@example.invalid', 'syn', '${now}', 'active', '${now}', '${now}'),
      ('user-alpha', 'alpha@example.invalid', 'syn', '${now}', 'active', '${now}', '${now}'),
      ('user-beta', 'beta@example.invalid', 'syn', '${now}', 'active', '${now}', '${now}');
    `)

    return db
  } catch (error) {
    db.close()
    throw error
  }
}

describe('SHP-025: Company shipping conditions database & domain contract', () => {
  it('creates and updates company shipping conditions with version CAS and command audit', async () => {
    const db = await fixture()
    try {
      // 1. Initial creation (expectedVersion: 0)
      const initial = await setCompanyShippingConditions(db, {
        actorId: 'admin-1',
        companyId: 'comp-alpha',
        allowedMethods: ['pickup', 'own_delivery', 'parcel'],
        customMethodsEnabled: true,
        carrierAccountCarrier: null,
        carrierAccountNumber: null,
        warehousePickupAllowed: true,
        freeShippingThresholdCents: 6000,
        customDeliveryInstructions: 'Entregar en puerta trasera de 8 a 14h',
        expectedVersion: 0,
        commandId: 'cmd-alpha-1',
        now
      })

      expect(initial.version).toBe(1)
      expect(initial.freeShippingThresholdCents).toBe(6000)
      expect(initial.allowedMethods).toEqual(['pickup', 'own_delivery', 'parcel'])
      expect(initial.customDeliveryInstructions).toBe('Entregar en puerta trasera de 8 a 14h')

      // Verify command audit in append-only table
      const cmdRow = db
        .prepare(
          'SELECT command_id, applied_version, actor_id FROM company_shipping_condition_commands WHERE company_id = ?'
        )
        .get('comp-alpha') as { command_id: string; applied_version: number; actor_id: string }
      expect(cmdRow).toMatchObject({
        command_id: 'cmd-alpha-1',
        applied_version: 1,
        actor_id: 'admin-1'
      })

      // 2. Update with carrier customer account (cuenta de portes) (expectedVersion: 1)
      const updated = await setCompanyShippingConditions(db, {
        actorId: 'admin-1',
        companyId: 'comp-alpha',
        allowedMethods: ['pickup', 'carrier_customer_account'],
        customMethodsEnabled: true,
        carrierAccountCarrier: 'seur',
        carrierAccountNumber: 'SEUR-ACC-98765',
        warehousePickupAllowed: true,
        freeShippingThresholdCents: null,
        customDeliveryInstructions: 'Cargar en cuenta de cliente SEUR',
        expectedVersion: 1,
        commandId: 'cmd-alpha-2',
        now
      })

      expect(updated.version).toBe(2)
      expect(updated.carrierAccountCarrier).toBe('seur')
      expect(updated.carrierAccountNumber).toBe('SEUR-ACC-98765')
      expect(updated.allowedMethods).toContain('carrier_customer_account')
    } finally {
      db.close()
    }
  })

  it('detects CAS version conflict when expectedVersion does not match', async () => {
    const db = await fixture()
    try {
      await setCompanyShippingConditions(db, {
        actorId: 'admin-1',
        companyId: 'comp-alpha',
        allowedMethods: ['parcel'],
        expectedVersion: 0,
        commandId: 'cmd-cas-1',
        now
      })

      // Attempt update with stale expectedVersion 0
      await expect(
        setCompanyShippingConditions(db, {
          actorId: 'admin-1',
          companyId: 'comp-alpha',
          allowedMethods: ['parcel', 'pickup'],
          expectedVersion: 0,
          commandId: 'cmd-cas-2',
          now
        })
      ).rejects.toThrow(CompanyShippingConditionsError)
    } finally {
      db.close()
    }
  })

  it('handles idempotent replay of the exact same command_id', async () => {
    const db = await fixture()
    try {
      const first = await setCompanyShippingConditions(db, {
        actorId: 'admin-1',
        companyId: 'comp-alpha',
        allowedMethods: ['parcel'],
        expectedVersion: 0,
        commandId: 'cmd-idem-1',
        now
      })

      const second = await setCompanyShippingConditions(db, {
        actorId: 'admin-1',
        companyId: 'comp-alpha',
        allowedMethods: ['parcel'],
        expectedVersion: 0,
        commandId: 'cmd-idem-1',
        now
      })

      expect(second.version).toBe(first.version)
    } finally {
      db.close()
    }
  })

  it('isolates conditions per company and prevents data leakage across accounts', async () => {
    const db = await fixture()
    try {
      await setCompanyShippingConditions(db, {
        actorId: 'admin-1',
        companyId: 'comp-alpha',
        allowedMethods: ['carrier_customer_account'],
        carrierAccountCarrier: 'dhl',
        carrierAccountNumber: 'DHL-CONFIDENTIAL-ALFA',
        expectedVersion: 0,
        commandId: 'cmd-iso-1',
        now
      })

      // Comp-alpha has its own conditions
      const alphaConditions = await getCompanyShippingConditions(db, 'comp-alpha')
      expect(alphaConditions?.carrierAccountNumber).toBe('DHL-CONFIDENTIAL-ALFA')

      // Comp-beta has no conditions configured yet -> returns null / defaults, NEVER comp-alpha data
      const betaConditions = await getCompanyShippingConditions(db, 'comp-beta')
      expect(betaConditions).toBeNull()
    } finally {
      db.close()
    }
  })

  it('validates carrier_customer_account requires both carrier and account number', async () => {
    const db = await fixture()
    try {
      await expect(
        setCompanyShippingConditions(db, {
          actorId: 'admin-1',
          companyId: 'comp-alpha',
          allowedMethods: ['carrier_customer_account'],
          carrierAccountCarrier: 'seur',
          carrierAccountNumber: null, // missing account number!
          expectedVersion: 0,
          commandId: 'cmd-val-1',
          now
        })
      ).rejects.toThrow(CompanyShippingConditionsError)
    } finally {
      db.close()
    }
  })
})
