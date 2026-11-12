import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { fulfillmentFixture } from './d1-fulfillment-fixture'
import { createPackingOrder } from './d1-order-packing-fixture'
import type { CarrierProvider, Parcel, ShippingAddress } from '../../server/integrations/carrier-provider'
import {
  CarrierResilienceError,
  getCarrierCircuitBreaker,
  recordCarrierSuccess,
  recordCarrierFailure,
  isCarrierExecutionAllowed,
  quoteResilientCarrierRate,
  resilientCreateCarrierLabel,
  getCarrierShipmentLabel
} from '../../workers/fulfillment/carrier-resilience'
import { testNow } from '../support/deterministic'

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
})

const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')

async function createResilienceFixture() {
  const { sqlite, database } = await fulfillmentFixture()
  connections.push(sqlite)

  // Configure parcel zone and rate for order creation
  sqlite
    .prepare(
      "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('resilience-parcel-zone','resilience-parcel','Synthetic parcel','parcel_peninsular','[\"peninsular\"]',1,?)"
    )
    .run(utc(-60000))
  sqlite
    .prepare(
      "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('resilience-parcel-rate','resilience-parcel-zone','parcel','parcel',500,2100,1,2,1,1,?)"
    )
    .run(utc(-60000))

  const migrationSql = await readFile(
    new URL('../../db/d1/migrations/0097_carrier_resilience.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migrationSql)

  const orderId = await createPackingOrder(database, { method: 'parcel', paid: true })
  return { sqlite, database, orderId }
}

const mockDestination: ShippingAddress = {
  name: 'Empresa Test SL',
  line1: 'Calle Industria 42',
  postalCode: '46870',
  city: 'Ontinyent',
  region: 'Valencia',
  countryCode: 'ES',
  phone: '+34600111222'
}

const mockParcels: Parcel[] = [
  {
    weightGrams: 5000,
    widthMm: 200,
    heightMm: 200,
    depthMm: 200,
    contents: [{ sku: 'PROD-001', quantity: 2 }],
    handling: 'parcel'
  }
]

describe('SHP-022 Carrier Resilience & Circuit Breaker', () => {
  describe('Circuit breaker state transitions and thresholds', () => {
    it('initializes in closed state with default thresholds', async () => {
      const { database } = await createResilienceFixture()
      const breaker = await getCarrierCircuitBreaker(database, 'correos_express', '2026-10-29T10:00:00Z')

      expect(breaker.carrier).toBe('correos_express')
      expect(breaker.state).toBe('closed')
      expect(breaker.consecutiveFailures).toBe(0)
      expect(breaker.consecutiveSuccesses).toBe(0)
      expect(breaker.failureThreshold).toBe(5)
      expect(breaker.cooldownSeconds).toBe(300)

      const check = isCarrierExecutionAllowed(breaker)
      expect(check.allowed).toBe(true)
      expect(check.isProbe).toBe(false)
    })

    it('remains closed when failures are below threshold', async () => {
      const { database } = await createResilienceFixture()
      const now = '2026-10-29T10:00:00Z'

      for (let i = 1; i <= 4; i++) {
        const breaker = await recordCarrierFailure(database, 'correos_express', 'Connection timeout', now)
        expect(breaker.state).toBe('closed')
        expect(breaker.consecutiveFailures).toBe(i)
        expect(breaker.failureCount).toBe(i)
      }
    })

    it('transitions from closed to open when failure threshold is reached', async () => {
      const { database } = await createResilienceFixture()
      const now = '2026-10-29T10:00:00Z'

      for (let i = 1; i < 5; i++) {
        await recordCarrierFailure(database, 'correos_express', 'Connection timeout', now)
      }

      const opened = await recordCarrierFailure(database, 'correos_express', 'Connection timeout 5', now)
      expect(opened.state).toBe('open')
      expect(opened.consecutiveFailures).toBe(5)
      expect(opened.openedAt).toBe(now)

      const check = isCarrierExecutionAllowed(opened)
      expect(check.allowed).toBe(false)
    })

    it('stays open during cooldown period', async () => {
      const { database } = await createResilienceFixture()
      const openTime = '2026-10-29T10:00:00Z'

      for (let i = 0; i < 5; i++) {
        await recordCarrierFailure(database, 'gls', 'Outage', openTime)
      }

      // Check after 200 seconds (cooldown is 300s)
      const duringCooldown = '2026-10-29T10:03:20Z'
      const breaker = await getCarrierCircuitBreaker(database, 'gls', duringCooldown)
      expect(breaker.state).toBe('open')
      expect(isCarrierExecutionAllowed(breaker).allowed).toBe(false)
    })

    it('transitions from open to half_open after cooldown expires', async () => {
      const { database } = await createResilienceFixture()
      const openTime = '2026-10-29T10:00:00Z'

      for (let i = 0; i < 5; i++) {
        await recordCarrierFailure(database, 'gls', 'Outage', openTime)
      }

      // Check after 301 seconds
      const afterCooldown = '2026-10-29T10:05:01Z'
      const breaker = await getCarrierCircuitBreaker(database, 'gls', afterCooldown)
      expect(breaker.state).toBe('half_open')
      expect(breaker.halfOpenedAt).toBe(afterCooldown)

      const check = isCarrierExecutionAllowed(breaker)
      expect(check.allowed).toBe(true)
      expect(check.isProbe).toBe(true)
    })

    it('transitions from half_open back to open if a probe fails', async () => {
      const { database } = await createResilienceFixture()
      const openTime = '2026-10-29T10:00:00Z'

      for (let i = 0; i < 5; i++) {
        await recordCarrierFailure(database, 'gls', 'Outage', openTime)
      }

      // Cool-down passes -> half_open
      const halfOpenTime = '2026-10-29T10:05:01Z'
      await getCarrierCircuitBreaker(database, 'gls', halfOpenTime)

      // Probe failure
      const failTime = '2026-10-29T10:05:10Z'
      const reOpened = await recordCarrierFailure(database, 'gls', 'Probe failure 503', failTime)
      expect(reOpened.state).toBe('open')
      expect(reOpened.openedAt).toBe(failTime)
    })

    it('transitions from half_open to closed when consecutive successes reach success_threshold', async () => {
      const { database } = await createResilienceFixture()
      const openTime = '2026-10-29T10:00:00Z'

      for (let i = 0; i < 5; i++) {
        await recordCarrierFailure(database, 'gls', 'Outage', openTime)
      }

      // Cool-down passes -> half_open
      const halfOpenTime = '2026-10-29T10:05:01Z'
      await getCarrierCircuitBreaker(database, 'gls', halfOpenTime)

      // First successful probe (threshold is 2)
      const success1 = await recordCarrierSuccess(database, 'gls', '2026-10-29T10:05:05Z')
      expect(success1.state).toBe('half_open')
      expect(success1.consecutiveSuccesses).toBe(1)

      // Second successful probe -> closed
      const success2 = await recordCarrierSuccess(database, 'gls', '2026-10-29T10:05:10Z')
      expect(success2.state).toBe('closed')
      expect(success2.consecutiveFailures).toBe(0)
      expect(success2.consecutiveSuccesses).toBe(0)
    })
  })

  describe('Rate caching and safe fallback hierarchy', () => {
    it('caches live rates and uses them when carrier later fails', async () => {
      const { database } = await createResilienceFixture()
      const now = '2026-10-29T10:00:00Z'

      const mockProvider: CarrierProvider = {
        name: 'correos_express',
        rates: async () => [
          {
            provider: 'correos_express',
            serviceCode: 'EXP-24',
            label: 'Paq 24',
            netCents: 650,
            taxRateBasisPoints: 2100,
            estimatedDeliveryFrom: '2026-10-30T10:00:00Z',
            estimatedDeliveryTo: '2026-10-31T18:00:00Z',
            profile: 'parcel'
          }
        ],
        createShipment: async () => {
          throw new Error('not implemented')
        },
        cancelShipment: async () => {},
        tracking: async () => [],
        createReturn: async () => {
          throw new Error('not implemented')
        },
        schedulePickup: async () => {
          throw new Error('not implemented')
        }
      }

      // 1. Live quote succeeds and is cached
      const liveResult = await quoteResilientCarrierRate(database, mockProvider, {
        carrier: 'correos_express',
        originPostalCode: '46870',
        destination: mockDestination,
        parcels: mockParcels,
        now
      })

      expect(liveResult.source).toBe('live')
      expect(liveResult.rate.netCents).toBe(650)
      expect(liveResult.rate.grossCents).toBe(787) // 650 + round(650 * 0.21) = 650 + 137 = 787

      // 2. Carrier goes down (throws)
      const failingProvider: CarrierProvider = {
        ...mockProvider,
        rates: async () => {
          throw new Error('Carrier gateway 500 internal server error')
        }
      }

      // Resilient quote should fall back to valid cache
      const cachedResult = await quoteResilientCarrierRate(database, failingProvider, {
        carrier: 'correos_express',
        originPostalCode: '46870',
        destination: mockDestination,
        parcels: mockParcels,
        now: '2026-10-29T10:15:00Z'
      })

      expect(cachedResult.source).toBe('cache')
      expect(cachedResult.rate.netCents).toBe(650)
      expect(cachedResult.rate.serviceCode).toBe('EXP-24')
    })

    it('skips expired cache and uses configured safe manual rate', async () => {
      const { database, sqlite } = await createResilienceFixture()
      const now = '2026-10-29T10:00:00Z'

      // Seed safe manual fallback rate
      sqlite.exec(`
        INSERT INTO carrier_fallback_rates(carrier, service_profile, zone_code, service_code,
          net_cents, tax_rate_basis_points, gross_cents, eta_min_days, eta_max_days, active, created_at, updated_at)
        VALUES('correos_express', 'parcel', '46', 'MANUAL-PARCEL', 750, 2100, 908, 1, 3, 1, '${now}', '${now}');
      `)

      // Seed an expired cache entry (older than maxCacheAge)
      sqlite.exec(`
        INSERT INTO carrier_rate_cache(cache_key, carrier, zone_code, service_code, service_profile,
          weight_tier_grams, net_cents, tax_rate_basis_points, gross_cents, eta_min_days, eta_max_days, cached_at, expires_at)
        VALUES('e000000000000000000000000000000000000000000000000000000000000001', 'correos_express', '46',
          'OLD-CODE', 'parcel', 5000, 500, 2100, 605, 1, 2, '2026-10-20T10:00:00Z', '2026-10-21T10:00:00Z');
      `)

      const failingProvider: CarrierProvider = {
        name: 'correos_express',
        rates: async () => {
          throw new Error('Carrier down')
        },
        createShipment: async () => {
          throw new Error('not implemented')
        },
        cancelShipment: async () => {},
        tracking: async () => [],
        createReturn: async () => {
          throw new Error('not implemented')
        },
        schedulePickup: async () => {
          throw new Error('not implemented')
        }
      }

      const fallbackResult = await quoteResilientCarrierRate(database, failingProvider, {
        carrier: 'correos_express',
        originPostalCode: '46870',
        destination: mockDestination,
        parcels: mockParcels,
        now
      })

      expect(fallbackResult.source).toBe('manual_safe_rate')
      expect(fallbackResult.rate.netCents).toBe(750)
      expect(fallbackResult.rate.serviceCode).toBe('MANUAL-PARCEL')
    })

    it('falls back to alternative carrier if no valid cache or manual rate exists', async () => {
      const { database } = await createResilienceFixture()
      const now = '2026-10-29T10:00:00Z'

      const failingPrimary: CarrierProvider = {
        name: 'correos_express',
        rates: async () => {
          throw new Error('Primary carrier connection timeout')
        },
        createShipment: async () => {
          throw new Error('not implemented')
        },
        cancelShipment: async () => {},
        tracking: async () => [],
        createReturn: async () => {
          throw new Error('not implemented')
        },
        schedulePickup: async () => {
          throw new Error('not implemented')
        }
      }

      const workingAlternative: CarrierProvider = {
        name: 'gls',
        rates: async () => [
          {
            provider: 'gls',
            serviceCode: 'GLS-PARCEL',
            label: 'GLS BusinessParcel',
            netCents: 720,
            taxRateBasisPoints: 2100,
            estimatedDeliveryFrom: '2026-10-30T10:00:00Z',
            estimatedDeliveryTo: '2026-10-31T18:00:00Z',
            profile: 'parcel'
          }
        ],
        createShipment: async () => {
          throw new Error('not implemented')
        },
        cancelShipment: async () => {},
        tracking: async () => [],
        createReturn: async () => {
          throw new Error('not implemented')
        },
        schedulePickup: async () => {
          throw new Error('not implemented')
        }
      }

      const altResult = await quoteResilientCarrierRate(database, failingPrimary, {
        carrier: 'correos_express',
        originPostalCode: '46870',
        destination: mockDestination,
        parcels: mockParcels,
        now,
        alternativeCarrier: {
          name: 'gls',
          provider: workingAlternative
        }
      })

      expect(altResult.source).toBe('alternative_carrier')
      expect(altResult.carrier).toBe('gls')
      expect(altResult.rate.netCents).toBe(720)
    })
  })

  describe('NUNCA doble etiqueta: Idempotency per parcel and uncertain reconciliation', () => {
    it('creates label on first call and returns existing label on retry without calling carrier again', async () => {
      const { database, orderId } = await createResilienceFixture()
      const now = '2026-10-29T10:00:00Z'

      let carrierCallCount = 0
      const mockProvider: CarrierProvider = {
        name: 'correos_express',
        rates: async () => [],
        createShipment: async (_input) => {
          carrierCallCount++
          return {
            providerShipmentId: 'EXP-12345',
            trackingNumber: '0281234567890123',
            label: new TextEncoder().encode('%PDF-1.4 mock label'),
            status: 'created'
          }
        },
        cancelShipment: async () => {},
        tracking: async () => [],
        createReturn: async () => {
          throw new Error('not implemented')
        },
        schedulePickup: async () => {
          throw new Error('not implemented')
        }
      }

      const idempotencyKey = 'label-cmd-001'

      // First call
      const firstResult = await resilientCreateCarrierLabel(database, mockProvider, {
        orderId,
        parcelIndex: 0,
        idempotencyKey,
        orderNumber: 'NET-0001',
        destination: mockDestination,
        parcels: mockParcels,
        serviceCode: 'EXP-24',
        quotedGrossCents: 690,
        now
      })

      expect(firstResult.outcome).toBe('created')
      expect(firstResult.doubleLabelPrevented).toBe(false)
      expect(firstResult.label.trackingNumber).toBe('0281234567890123')
      expect(carrierCallCount).toBe(1)

      // Second call (replay with same idempotency key or orderId/parcelIndex)
      const secondResult = await resilientCreateCarrierLabel(database, mockProvider, {
        orderId,
        parcelIndex: 0,
        idempotencyKey,
        orderNumber: 'NET-0001',
        destination: mockDestination,
        parcels: mockParcels,
        serviceCode: 'EXP-24',
        quotedGrossCents: 690,
        now: '2026-10-29T10:01:00Z'
      })

      expect(secondResult.outcome).toBe('already_created')
      expect(secondResult.doubleLabelPrevented).toBe(true)
      expect(secondResult.label.trackingNumber).toBe('0281234567890123')
      // Essential requirement: carrier API must NOT be called a second time!
      expect(carrierCallCount).toBe(1)
    })

    it('handles uncertain result when carrier call times out and reconciles before retrying', async () => {
      const { database, orderId } = await createResilienceFixture()
      const now = '2026-10-29T10:00:00Z'
      const idempotencyKey = 'label-uncertain-001'

      // 1. First call fails with timeout (outcome uncertain)
      const timeoutProvider: CarrierProvider = {
        name: 'correos_express',
        rates: async () => [],
        createShipment: async () => {
          throw new Error('ETIMEDOUT: Connection reset by peer while creating shipment')
        },
        cancelShipment: async () => {},
        tracking: async () => [],
        createReturn: async () => {
          throw new Error('not implemented')
        },
        schedulePickup: async () => {
          throw new Error('not implemented')
        }
      }

      await expect(
        resilientCreateCarrierLabel(database, timeoutProvider, {
          orderId,
          parcelIndex: 0,
          idempotencyKey,
          orderNumber: 'NET-0001',
          destination: mockDestination,
          parcels: mockParcels,
          serviceCode: 'EXP-24',
          quotedGrossCents: 690,
          now
        })
      ).rejects.toThrow(CarrierResilienceError)

      // Check that a record was stored in 'uncertain' state with reconciliation_status 'required'
      const uncertainLabel = await getCarrierShipmentLabel(database, orderId, 0)
      expect(uncertainLabel).not.toBeNull()
      expect(uncertainLabel!.status).toBe('uncertain')
      expect(uncertainLabel!.reconciliationStatus).toBe('required')

      // 2. On subsequent retry, reconciliation detects that the carrier DID receive the shipment
      let reconcileCallCount = 0
      const reconcilingProvider: CarrierProvider = {
        name: 'correos_express',
        rates: async () => [],
        createShipment: async () => {
          // If called, test fails because double shipment must not occur!
          throw new Error('Should not call createShipment during reconciliation!')
        },
        cancelShipment: async () => {},
        tracking: async () => [],
        createReturn: async () => {
          throw new Error('not implemented')
        },
        schedulePickup: async () => {
          throw new Error('not implemented')
        }
      }

      const reconciledResult = await resilientCreateCarrierLabel(database, reconcilingProvider, {
        orderId,
        parcelIndex: 0,
        idempotencyKey,
        orderNumber: 'NET-0001',
        destination: mockDestination,
        parcels: mockParcels,
        serviceCode: 'EXP-24',
        quotedGrossCents: 690,
        now: '2026-10-29T10:02:00Z',
        reconcileLookup: async () => {
          reconcileCallCount++
          return {
            found: true,
            providerShipmentId: 'EXP-RECONCILED-99',
            trackingNumber: '0289999999999999',
            labelData: Buffer.from('%PDF-1.4 reconciled label').toString('base64')
          }
        }
      })

      expect(reconcileCallCount).toBe(1)
      expect(reconciledResult.outcome).toBe('reconciled')
      expect(reconciledResult.doubleLabelPrevented).toBe(true)
      expect(reconciledResult.label.trackingNumber).toBe('0289999999999999')
      expect(reconciledResult.label.status).toBe('confirmed')
      expect(reconciledResult.label.reconciliationStatus).toBe('reconciled_confirmed')
    })

    it('rejects duplicate parcel label under concurrent race conditions with unique constraint', async () => {
      const { database, sqlite, orderId } = await createResilienceFixture()
      const now = '2026-10-29T10:00:00Z'

      // Pre-insert a confirmed label
      sqlite.exec(`
        INSERT INTO carrier_shipment_labels(id, order_id, parcel_index, idempotency_key, carrier,
          service_code, tracking_number, provider_shipment_id, label_format, label_data, status,
          quoted_gross_cents, actual_cost_cents, created_at, updated_at)
        VALUES('00000000-0000-4000-8000-000000000099', '${orderId}', 0, 'existing-key', 'correos_express',
          'EXP-24', 'TRACK-1111', 'SHIP-1111', 'pdf', 'JVBERi0xLjQK...', 'confirmed',
          690, 650, '${now}', '${now}');
      `)

      let carrierCalled = false
      const mockProvider: CarrierProvider = {
        name: 'correos_express',
        rates: async () => [],
        createShipment: async () => {
          carrierCalled = true
          return {
            providerShipmentId: 'SHIP-DUPLICATE',
            trackingNumber: 'TRACK-DUPLICATE',
            label: new Uint8Array(),
            status: 'created'
          }
        },
        cancelShipment: async () => {},
        tracking: async () => [],
        createReturn: async () => {
          throw new Error('not implemented')
        },
        schedulePickup: async () => {
          throw new Error('not implemented')
        }
      }

      // Attempt with a different idempotency key for the SAME parcel index
      const result = await resilientCreateCarrierLabel(database, mockProvider, {
        orderId,
        parcelIndex: 0,
        idempotencyKey: 'different-key-attempt',
        orderNumber: 'NET-0001',
        destination: mockDestination,
        parcels: mockParcels,
        serviceCode: 'EXP-24',
        quotedGrossCents: 690,
        now
      })

      expect(carrierCalled).toBe(false)
      expect(result.outcome).toBe('already_created')
      expect(result.doubleLabelPrevented).toBe(true)
      expect(result.label.trackingNumber).toBe('TRACK-1111')
    })
  })
})
