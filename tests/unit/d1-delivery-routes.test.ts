import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase } from '../support/d1-sqlite'
import {
  createDeliveryRoute,
  addDeliveryRouteStop,
  reoptimizeDeliveryRoute,
  getDeliveryRouteById,
  createDeliveryVehicle,
  createDeliveryDriver,
  DeliveryRouteError
} from '../../workers/fulfillment/delivery-routes'

const now = '2026-10-29T10:00:00Z'

async function fixture() {
  const db = await openMigratedDatabase()
  try {
    const migration = await readFile('db/d1/migrations/0109_shipping_convenience_conditions_routes.sql', 'utf8')
    db.exec(migration)

    db.exec(`
      INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('admin-1', 'admin@example.invalid', 'syn', '${now}', 'active', '${now}', '${now}');
    `)

    return db
  } catch (error) {
    db.close()
    throw error
  }
}

describe('SHP-026: Delivery routes planning & reoptimization database contract', () => {
  it('creates vehicle, driver, and plans a delivery route with capacity tracking', async () => {
    const db = await fixture()
    try {
      const vehicle = await createDeliveryVehicle(db, {
        id: 'veh-furgoneta-1',
        name: 'Furgoneta Neteco Eco 1',
        registrationPlate: '1234-LMN',
        maxWeightGrams: 1_200_000, // 1200 kg
        maxParcels: 60,
        status: 'active',
        now
      })
      expect(vehicle.id).toBe('veh-furgoneta-1')
      expect(vehicle.maxParcels).toBe(60)

      const driver = await createDeliveryDriver(db, {
        id: 'drv-carlos',
        name: 'Carlos Reparto',
        phone: '+34600123456',
        licenseNumber: 'B-12345678',
        status: 'active',
        now
      })
      expect(driver.id).toBe('drv-carlos')

      const route = await createDeliveryRoute(db, {
        actorId: 'admin-1',
        id: 'route-2026-10-30-1',
        routeDate: '2026-10-30',
        vehicleId: 'veh-furgoneta-1',
        driverId: 'drv-carlos',
        windowStart: '08:30',
        windowEnd: '15:00',
        commandId: 'cmd-route-create-1',
        now
      })

      expect(route.id).toBe('route-2026-10-30-1')
      expect(route.status).toBe('draft')
      expect(route.totalStops).toBe(0)
      expect(route.version).toBe(1)
    } finally {
      db.close()
    }
  })

  it('adds stops to a route, validates capacity, and tracks total weight and parcels', async () => {
    const db = await fixture()
    try {
      await createDeliveryVehicle(db, {
        id: 'veh-1',
        name: 'Furgón 1',
        registrationPlate: '9999-XYZ',
        maxWeightGrams: 50_000, // small vehicle 50kg for testing capacity boundary
        maxParcels: 5,
        status: 'active',
        now
      })
      await createDeliveryDriver(db, {
        id: 'drv-1',
        name: 'Driver 1',
        phone: '+34600000000',
        licenseNumber: 'B-000000',
        status: 'active',
        now
      })
      await createDeliveryRoute(db, {
        actorId: 'admin-1',
        id: 'route-test-stops',
        routeDate: '2026-10-30',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        windowStart: '09:00',
        windowEnd: '14:00',
        commandId: 'cmd-route-0',
        now
      })

      // Add stop 1 (20kg, 2 parcels)
      const r1 = await addDeliveryRouteStop(db, {
        actorId: 'admin-1',
        routeId: 'route-test-stops',
        recipientName: 'Taller San Rafael',
        streetAddress: 'Polígono El Plá 14',
        postalCode: '46870',
        city: 'Ontinyent',
        parcelCount: 2,
        weightGrams: 20_000,
        timeWindowStart: '10:00',
        timeWindowEnd: '11:00',
        expectedVersion: 1,
        commandId: 'cmd-stop-1',
        now
      })
      expect(r1.totalStops).toBe(1)
      expect(r1.totalParcels).toBe(2)
      expect(r1.totalWeightGrams).toBe(20_000)
      expect(r1.version).toBe(2)

      // Add stop 2 (25kg, 2 parcels) -> total 45kg, 4 parcels (still <= 50kg and <= 5)
      const r2 = await addDeliveryRouteStop(db, {
        actorId: 'admin-1',
        routeId: 'route-test-stops',
        recipientName: 'Lavandería Albaida',
        streetAddress: 'Av. Fora Fora 2',
        postalCode: '46830',
        city: 'Albaida',
        parcelCount: 2,
        weightGrams: 25_000,
        timeWindowStart: '09:30',
        timeWindowEnd: '10:30',
        expectedVersion: 2,
        commandId: 'cmd-stop-2',
        now
      })
      expect(r2.totalStops).toBe(2)
      expect(r2.totalParcels).toBe(4)
      expect(r2.totalWeightGrams).toBe(45_000)

      // Add stop 3 exceeding vehicle weight capacity (20kg more -> 65kg > 50kg)
      await expect(
        addDeliveryRouteStop(db, {
          actorId: 'admin-1',
          routeId: 'route-test-stops',
          recipientName: 'Exceeding stop',
          streetAddress: 'Calle Mayor 1',
          postalCode: '46870',
          city: 'Ontinyent',
          parcelCount: 2,
          weightGrams: 20_000,
          expectedVersion: 3,
          commandId: 'cmd-stop-exceed',
          now
        })
      ).rejects.toThrow(DeliveryRouteError)
    } finally {
      db.close()
    }
  })

  it('performs controlled reoptimization of pending stops, preserving delivered stops order', async () => {
    const db = await fixture()
    try {
      await createDeliveryVehicle(db, {
        id: 'veh-main',
        name: 'Furgón Principal',
        registrationPlate: '5555-ABC',
        maxWeightGrams: 500_000,
        maxParcels: 50,
        status: 'active',
        now
      })
      await createDeliveryDriver(db, {
        id: 'drv-main',
        name: 'Conductor Principal',
        phone: '+34600111222',
        licenseNumber: 'B-998877',
        status: 'active',
        now
      })
      await createDeliveryRoute(db, {
        actorId: 'admin-1',
        id: 'route-reopt',
        routeDate: '2026-10-30',
        vehicleId: 'veh-main',
        driverId: 'drv-main',
        windowStart: '08:00',
        windowEnd: '16:00',
        commandId: 'cmd-reopt-init',
        now
      })

      // Add 3 stops in unoptimized window order:
      // Stop 1: Late window (13:00 - 14:00)
      await addDeliveryRouteStop(db, {
        actorId: 'admin-1',
        routeId: 'route-reopt',
        recipientName: 'Cliente Tarde',
        streetAddress: 'Calle C 3',
        postalCode: '46870',
        city: 'Ontinyent',
        parcelCount: 1,
        weightGrams: 5_000,
        timeWindowStart: '13:00',
        timeWindowEnd: '14:00',
        expectedVersion: 1,
        commandId: 'cmd-s1',
        now
      })

      // Stop 2: Early morning window (09:00 - 10:00)
      await addDeliveryRouteStop(db, {
        actorId: 'admin-1',
        routeId: 'route-reopt',
        recipientName: 'Cliente Temprano',
        streetAddress: 'Calle A 1',
        postalCode: '46870',
        city: 'Ontinyent',
        parcelCount: 1,
        weightGrams: 5_000,
        timeWindowStart: '09:00',
        timeWindowEnd: '10:00',
        expectedVersion: 2,
        commandId: 'cmd-s2',
        now
      })

      // Stop 3: Midday window (11:00 - 12:00)
      await addDeliveryRouteStop(db, {
        actorId: 'admin-1',
        routeId: 'route-reopt',
        recipientName: 'Cliente Mediodía',
        streetAddress: 'Calle B 2',
        postalCode: '46870',
        city: 'Ontinyent',
        parcelCount: 1,
        weightGrams: 5_000,
        timeWindowStart: '11:00',
        timeWindowEnd: '12:00',
        expectedVersion: 3,
        commandId: 'cmd-s3',
        now
      })

      // Mark stop 1 as already 'delivered' (simulating partial route execution)
      db.prepare(
        `
        UPDATE delivery_route_stops
        SET status = 'delivered', completed_at = '${now}'
        WHERE route_id = 'route-reopt' AND recipient_name = 'Cliente Tarde'
      `
      ).run()

      // Controlled re-optimization
      const reoptResult = await reoptimizeDeliveryRoute(db, {
        actorId: 'admin-1',
        routeId: 'route-reopt',
        expectedVersion: 4,
        commandId: 'cmd-reopt-exec-1',
        optimizationStrategy: 'window_priority',
        now
      })

      expect(reoptResult.capacityOk).toBe(true)
      expect(reoptResult.newVersion).toBe(5)

      // Fetch stops: delivered stop remains at sequence 0, while pending stops are re-ordered by timeWindowStart
      const updatedRoute = await getDeliveryRouteById(db, 'route-reopt')
      expect(updatedRoute?.stops[0]?.recipientName).toBe('Cliente Tarde')
      expect(updatedRoute?.stops[0]?.status).toBe('delivered')

      // Pending stops should be sequenced: Cliente Temprano (09:00) before Cliente Mediodía (11:00)
      expect(updatedRoute?.stops[1]?.recipientName).toBe('Cliente Temprano')
      expect(updatedRoute?.stops[2]?.recipientName).toBe('Cliente Mediodía')

      // Verify audit command
      const cmd = db
        .prepare(
          'SELECT action, command_id, applied_version FROM delivery_route_commands WHERE route_id = ? AND action = ?'
        )
        .get('route-reopt', 'reoptimize') as { action: string; command_id: string; applied_version: number }
      expect(cmd).toMatchObject({
        action: 'reoptimize',
        command_id: 'cmd-reopt-exec-1',
        applied_version: 5
      })
    } finally {
      db.close()
    }
  })

  it('rejects reoptimization on cancelled or completed routes', async () => {
    const db = await fixture()
    try {
      await createDeliveryRoute(db, {
        actorId: 'admin-1',
        id: 'route-cancelled',
        routeDate: '2026-10-30',
        windowStart: '08:00',
        windowEnd: '16:00',
        commandId: 'cmd-init-cancel',
        now
      })
      db.prepare("UPDATE delivery_routes SET status = 'cancelled' WHERE id = 'route-cancelled'").run()

      await expect(
        reoptimizeDeliveryRoute(db, {
          actorId: 'admin-1',
          routeId: 'route-cancelled',
          expectedVersion: 1,
          commandId: 'cmd-reopt-fail',
          now
        })
      ).rejects.toThrow(DeliveryRouteError)
    } finally {
      db.close()
    }
  })
})
