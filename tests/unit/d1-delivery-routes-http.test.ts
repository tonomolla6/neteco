import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase } from '../support/d1-sqlite'
import { handleDeliveryRoutesHttp, ownsDeliveryRoutesNamespace } from '../../workers/fulfillment/delivery-routes-http'
import type { DatabaseAdapter } from '../../workers/fulfillment/convenience-points'
import type { DeliveryRoute, ReoptimizeDeliveryRouteResult } from '../../shared/delivery-route-planning'

const now = '2026-10-29T10:00:00Z'

async function fixture() {
  const db = await openMigratedDatabase()
  try {
    const migration = await readFile('db/d1/migrations/0109_shipping_convenience_conditions_routes.sql', 'utf8')
    db.exec(migration)

    db.exec(`
      INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('admin-1', 'admin@example.invalid', 'syn', '${now}', 'active', '${now}', '${now}');

      INSERT INTO roles(code, name, description) VALUES('admin-role', 'Admin', 'Synthetic');
      INSERT INTO permissions(code, resource, action, description) VALUES('administration.manage', 'administration', 'manage', 'Synthetic');
      INSERT INTO role_permissions(role_code, permission_code) VALUES('admin-role', 'administration.manage');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('admin-1', 'admin-role', '${now}');

      INSERT INTO delivery_vehicles(id, name, registration_plate, max_weight_grams, max_parcels, status, created_at, updated_at) VALUES
      ('v-1', 'Furgoneta 1', '1111-AAA', 1000000, 50, 'active', '${now}', '${now}');

      INSERT INTO delivery_drivers(id, name, phone, license_number, status, created_at, updated_at) VALUES
      ('d-1', 'Conductor 1', '+34600111222', 'LIC-1', 'active', '${now}', '${now}');

      INSERT INTO delivery_routes(id, route_date, vehicle_id, driver_id, status, window_start, window_end, total_stops, total_parcels, total_weight_grams, version, created_at, updated_at) VALUES
      ('r-1', '2026-10-30', 'v-1', 'd-1', 'planned', '09:00', '14:00', 0, 0, 0, 1, '${now}', '${now}');
    `)

    return db
  } catch (error) {
    db.close()
    throw error
  }
}

describe('SHP-026: Delivery routes planning HTTP contract', () => {
  it('recognizes namespace ownership for delivery routes and vehicle/driver management', () => {
    expect(ownsDeliveryRoutesNamespace('/api/admin/delivery-routes')).toBe(true)
    expect(ownsDeliveryRoutesNamespace('/api/admin/delivery-routes/r-1')).toBe(true)
    expect(ownsDeliveryRoutesNamespace('/api/admin/delivery-routes/r-1/reoptimize')).toBe(true)
    expect(ownsDeliveryRoutesNamespace('/api/admin/delivery-vehicles')).toBe(true)
    expect(ownsDeliveryRoutesNamespace('/api/admin/delivery-drivers')).toBe(true)
    expect(ownsDeliveryRoutesNamespace('/api/orders')).toBe(false)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const db = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/admin/delivery-routes')
      const response = await handleDeliveryRoutesHttp(request, {
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

  it('lists delivery routes for authenticated admin', async () => {
    const db = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/admin/delivery-routes')
      const response = await handleDeliveryRoutesHttp(request, {
        database: db as unknown as DatabaseAdapter,
        sessionProvider: async () => ({
          identityId: 'admin-1',
          roles: ['admin-role'],
          permissions: ['administration.manage']
        })
      })

      expect(response?.status).toBe(200)
      const data = (await response?.json()) as { routes: DeliveryRoute[] }
      expect(Array.isArray(data.routes)).toBe(true)
      expect(data.routes.length).toBe(1)
      expect(data.routes[0]?.id).toBe('r-1')
    } finally {
      db.close()
    }
  })

  it('POST /api/admin/delivery-routes/:id/reoptimize triggers controlled reoptimization', async () => {
    const db = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/admin/delivery-routes/r-1/reoptimize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: 1,
          commandId: 'cmd-http-reopt-1',
          optimizationStrategy: 'window_priority'
        })
      })

      const response = await handleDeliveryRoutesHttp(request, {
        database: db as unknown as DatabaseAdapter,
        sessionProvider: async () => ({
          identityId: 'admin-1',
          roles: ['admin-role'],
          permissions: ['administration.manage']
        })
      })

      expect(response?.status).toBe(200)
      const data = (await response?.json()) as ReoptimizeDeliveryRouteResult
      expect(data.newVersion).toBe(2)
      expect(data.capacityOk).toBe(true)
    } finally {
      db.close()
    }
  })

  it('returns 409 on reoptimization version conflict', async () => {
    const db = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/admin/delivery-routes/r-1/reoptimize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: 99,
          commandId: 'cmd-conflict',
          optimizationStrategy: 'window_priority'
        })
      })

      const response = await handleDeliveryRoutesHttp(request, {
        database: db as unknown as DatabaseAdapter,
        sessionProvider: async () => ({
          identityId: 'admin-1',
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

  it('rejects access when admin authorization is revoked mid-flight (after reading route)', async () => {
    const db = await fixture()
    try {
      let callCount = 0
      const request = new Request('https://tienda.example.com/api/admin/delivery-routes/r-1')
      const response = await handleDeliveryRoutesHttp(request, {
        database: db as unknown as DatabaseAdapter,
        sessionProvider: async () => {
          callCount++
          if (callCount === 1) {
            return {
              identityId: 'admin-1',
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
