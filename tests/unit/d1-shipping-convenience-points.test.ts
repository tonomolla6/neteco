import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase } from '../support/d1-sqlite'
import {
  listConveniencePoints,
  getConveniencePointById,
  ConveniencePointsError
} from '../../workers/fulfillment/convenience-points'
import { conveniencePointSchema } from '../../shared/shipping-convenience-points'

const now = '2026-10-29T10:00:00Z'

async function fixture() {
  const db = await openMigratedDatabase()
  try {
    const migration = await readFile('db/d1/migrations/0109_shipping_convenience_conditions_routes.sql', 'utf8')
    db.exec(migration)

    // Seed convenience points in Ontinyent (46870) and Valencia (46001)
    db.prepare(
      `
      INSERT INTO shipping_convenience_points (
        id, network, code, name, street_address, postal_code, city, province, country_code,
        latitude, longitude, opening_hours_json, operating_status, max_weight_grams, accepts_returns, has_locker,
        created_at, updated_at
      ) VALUES
      ('pt-inpost-1', 'inpost', 'INP-46870-1', 'Locker InPost Gasolinera BP', 'Av. del Textil 12', '46870', 'Ontinyent', 'Valencia', 'ES',
       38.821, -0.605, '{"monday":{"open":"00:00","close":"23:59"}}', 'active', 20000, 1, 1, '${now}', '${now}'),
      ('pt-correos-1', 'correos', 'COR-46870-1', 'CityPaq Supermercado Consum', 'Carrer Major 45', '46870', 'Ontinyent', 'Valencia', 'ES',
       38.825, -0.601, '{"monday":{"open":"09:00","close":"21:00"}}', 'active', 15000, 1, 1, '${now}', '${now}'),
      ('pt-seur-1', 'seur', 'SEU-46870-1', 'Punto SEUR Papelería San José', 'Plaça de la Coronació 3', '46870', 'Ontinyent', 'Valencia', 'ES',
       38.823, -0.603, '{"monday":{"open":"08:30","close":"19:30"}}', 'active', 25000, 0, 0, '${now}', '${now}'),
      ('pt-gls-closed', 'gls', 'GLS-46870-1', 'GLS ParcelShop Kiosco Centro', 'Carrer de Sant Antoni 8', '46870', 'Ontinyent', 'Valencia', 'ES',
       38.822, -0.602, '{}', 'temporarily_closed', 10000, 0, 0, '${now}', '${now}'),
      ('pt-inpost-vlc', 'inpost', 'INP-46001-1', 'Locker InPost Estación', 'Carrer de Xàtiva 24', '46001', 'Valencia', 'Valencia', 'ES',
       39.467, -0.377, '{}', 'active', 20000, 1, 1, '${now}', '${now}');
    `
    ).run()

    return db
  } catch (error) {
    db.close()
    throw error
  }
}

describe('SHP-023: Shipping convenience points database & domain', () => {
  it('lists active convenience points for a valid Spanish postal code', async () => {
    const db = await fixture()
    try {
      const results = await listConveniencePoints(db, { postalCode: '46870' })
      expect(results.length).toBe(3) // 3 active, 1 temporarily_closed excluded
      expect(results.map((p) => p.network).sort()).toEqual(['correos', 'inpost', 'seur'])

      // Every returned point conforms to the schema
      for (const point of results) {
        expect(() => conveniencePointSchema.parse(point)).not.toThrow()
        expect(point.postalCode).toBe('46870')
        expect(point.operatingStatus).toBe('active')
      }
    } finally {
      db.close()
    }
  })

  it('filters convenience points by network when requested', async () => {
    const db = await fixture()
    try {
      const inpostPoints = await listConveniencePoints(db, { postalCode: '46870', network: 'inpost' })
      expect(inpostPoints.length).toBe(1)
      expect(inpostPoints[0]?.network).toBe('inpost')
      expect(inpostPoints[0]?.code).toBe('INP-46870-1')
      expect(inpostPoints[0]?.hasLocker).toBe(true)
    } finally {
      db.close()
    }
  })

  it('includes temporarily closed points only when includeClosed is true', async () => {
    const db = await fixture()
    try {
      const withClosed = await listConveniencePoints(db, { postalCode: '46870', includeClosed: true })
      expect(withClosed.length).toBe(4)
      const closed = withClosed.find((p) => p.code === 'GLS-46870-1')
      expect(closed).toBeDefined()
      expect(closed?.operatingStatus).toBe('temporarily_closed')
    } finally {
      db.close()
    }
  })

  it('returns an empty array when no convenience points exist for a postal code', async () => {
    const db = await fixture()
    try {
      const results = await listConveniencePoints(db, { postalCode: '28001' })
      expect(results).toEqual([])
    } finally {
      db.close()
    }
  })

  it('validates postal code format and rejects invalid formats', async () => {
    const db = await fixture()
    try {
      await expect(listConveniencePoints(db, { postalCode: 'invalid' })).rejects.toThrow(ConveniencePointsError)
      await expect(listConveniencePoints(db, { postalCode: '4687' })).rejects.toThrow(ConveniencePointsError)
    } finally {
      db.close()
    }
  })

  it('fetches a convenience point by ID', async () => {
    const db = await fixture()
    try {
      const point = await getConveniencePointById(db, 'pt-correos-1')
      expect(point).not.toBeNull()
      expect(point?.name).toBe('CityPaq Supermercado Consum')
      expect(point?.acceptsReturns).toBe(true)

      const missing = await getConveniencePointById(db, 'non-existent')
      expect(missing).toBeNull()
    } finally {
      db.close()
    }
  })

  it('enforces database strict checks and uniqueness on (network, code)', async () => {
    const db = await fixture()
    try {
      expect(() => {
        db.prepare(
          `
          INSERT INTO shipping_convenience_points (
            id, network, code, name, street_address, postal_code, city, province, country_code,
            created_at, updated_at
          ) VALUES ('pt-dup', 'inpost', 'INP-46870-1', 'Duplicate', 'Street', '46870', 'City', 'Prov', 'ES', '${now}', '${now}')
        `
        ).run()
      }).toThrow(/UNIQUE constraint failed/)
    } finally {
      db.close()
    }
  })
})
