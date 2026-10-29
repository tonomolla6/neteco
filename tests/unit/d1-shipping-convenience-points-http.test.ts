import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleConveniencePointsHttp,
  ownsConveniencePointsNamespace
} from '../../workers/fulfillment/convenience-points-http'
import type { DatabaseAdapter } from '../../workers/fulfillment/convenience-points'

const now = '2026-10-29T10:00:00Z'

async function fixture() {
  const db = await openMigratedDatabase()
  try {
    const migration = await readFile('db/d1/migrations/0109_shipping_convenience_conditions_routes.sql', 'utf8')
    db.exec(migration)

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
       38.825, -0.601, '{"monday":{"open":"09:00","close":"21:00"}}', 'active', 15000, 1, 1, '${now}', '${now}');
    `
    ).run()

    return db
  } catch (error) {
    db.close()
    throw error
  }
}

describe('SHP-023: Shipping convenience points HTTP contract', () => {
  it('recognizes namespace ownership for convenience points endpoints', () => {
    expect(ownsConveniencePointsNamespace('/api/shipping/convenience-points')).toBe(true)
    expect(ownsConveniencePointsNamespace('/api/shipping/convenience-points/pt-1')).toBe(true)
    expect(ownsConveniencePointsNamespace('/api/shipping/rates')).toBe(false)
    expect(ownsConveniencePointsNamespace('/api/checkout')).toBe(false)
  })

  it('GET /api/shipping/convenience-points returns 200 with matching points', async () => {
    const db = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/shipping/convenience-points?postalCode=46870')
      const response = await handleConveniencePointsHttp(request, { database: db as unknown as DatabaseAdapter })

      expect(response).not.toBeNull()
      expect(response?.status).toBe(200)
      const data = (await response?.json()) as {
        total: number
        postalCode: string
        points: { code: string }[]
      }
      expect(data.total).toBe(2)
      expect(data.postalCode).toBe('46870')
      expect(data.points.length).toBe(2)
      expect(data.points.map((p) => p.code).sort()).toEqual(['COR-46870-1', 'INP-46870-1'])
    } finally {
      db.close()
    }
  })

  it('GET /api/shipping/convenience-points?network=correos filters by network', async () => {
    const db = await fixture()
    try {
      const request = new Request(
        'https://tienda.example.com/api/shipping/convenience-points?postalCode=46870&network=correos'
      )
      const response = await handleConveniencePointsHttp(request, { database: db as unknown as DatabaseAdapter })

      expect(response?.status).toBe(200)
      const data = (await response?.json()) as {
        total: number
        points: { network: string }[]
      }
      expect(data.total).toBe(1)
      expect(data.points[0]?.network).toBe('correos')
    } finally {
      db.close()
    }
  })

  it('GET /api/shipping/convenience-points returns 400 when postalCode is missing or invalid', async () => {
    const db = await fixture()
    try {
      const missingReq = new Request('https://tienda.example.com/api/shipping/convenience-points')
      const missingRes = await handleConveniencePointsHttp(missingReq, { database: db as unknown as DatabaseAdapter })
      expect(missingRes?.status).toBe(400)
      const missingData = (await missingRes?.json()) as { error?: { code: string } }
      expect(missingData.error?.code).toBe('invalid_input')

      const invalidReq = new Request('https://tienda.example.com/api/shipping/convenience-points?postalCode=ABC')
      const invalidRes = await handleConveniencePointsHttp(invalidReq, { database: db as unknown as DatabaseAdapter })
      expect(invalidRes?.status).toBe(400)
    } finally {
      db.close()
    }
  })

  it('GET /api/shipping/convenience-points/:id returns individual point or 404', async () => {
    const db = await fixture()
    try {
      const hitReq = new Request('https://tienda.example.com/api/shipping/convenience-points/pt-inpost-1')
      const hitRes = await handleConveniencePointsHttp(hitReq, { database: db as unknown as DatabaseAdapter })
      expect(hitRes?.status).toBe(200)
      const hitData = (await hitRes?.json()) as { id: string }
      expect(hitData.id).toBe('pt-inpost-1')

      const missReq = new Request('https://tienda.example.com/api/shipping/convenience-points/pt-unknown')
      const missRes = await handleConveniencePointsHttp(missReq, { database: db as unknown as DatabaseAdapter })
      expect(missRes?.status).toBe(404)
      const missData = (await missRes?.json()) as { error?: { code: string } }
      expect(missData.error?.code).toBe('not_found')
    } finally {
      db.close()
    }
  })
})
