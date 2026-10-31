import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBaTestWorld,
  MKT_MGR_IDENTITY,
  UNPRIVILEGED_IDENTITY,
  FIXTURE_NOW,
  type BaTestWorld
} from './d1-ba-preview-diff-fixtures'
import { handleSeasonalCampaignsHttp } from '../../workers/marketing/seasonal-campaigns-http'

describe('Seasonal Campaigns HTTP API (MKT-032)', () => {
  let world: BaTestWorld

  beforeEach(async () => {
    world = await createBaTestWorld()
    const migrationSql = await readFile('db/d1/migrations/0143_seasonal_sector_campaigns.sql', 'utf8')
    world.sqlite.exec(migrationSql)
  })

  afterEach(() => world.close())

  function makeRequest(
    path: string,
    method = 'GET',
    body?: unknown,
    actorId = MKT_MGR_IDENTITY,
    idempotencyKey = 'cmd-http-01'
  ): Request {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-actor-id': actorId
    }
    return new Request(`https://shop.neteco.invalid${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    })
  }

  const samplePayload = {
    code: 'camp-http-horeca-2027',
    name: 'Campaña HORECA Primavera HTTP',
    sector: 'horeca',
    season: 'spring',
    year: 2027,
    need: {
      needJustification: 'Puesta a punto terrazas y cocinas de hostelería ante temporada estival.',
      targetCustomerProfile: 'horeca_operators'
    },
    window: {
      procurementStartAt: '2027-02-01T00:00:00Z',
      windowStartAt: '2027-03-01T00:00:00Z',
      windowEndAt: '2027-04-30T23:59:59Z'
    },
    inventory: {
      items: [
        {
          sku: 'DES-01',
          variantId: 'v-01',
          plannedUnits: 100,
          safetyStockUnits: 20,
          maxAllocationUnits: 200
        }
      ],
      bufferPercentage: 15
    },
    logistics: {
      allowedProfiles: ['parcel'],
      maxLeadTimeDays: 3,
      localDeliveryPriority: true
    },
    content: {
      landingSlug: 'primavera-horeca',
      bannerSlots: ['home_hero'],
      marketingTags: ['horeca', 'primavera']
    },
    margin: {
      targetRevenueCents: 1000000,
      budgetLimitCents: 100000,
      minMarginBasisPoints: 2000,
      maxDiscountBasisPoints: 1000
    }
  }

  it('creates campaign via POST /api/admin/seasonal-campaigns', async () => {
    const req = makeRequest('/api/admin/seasonal-campaigns', 'POST', samplePayload)
    const res = await handleSeasonalCampaignsHttp(req, { database: world.db, now: () => FIXTURE_NOW })

    expect(res).toBeDefined()
    expect(res!.status).toBe(201)
    const data = (await res!.json()) as Record<string, unknown>
    expect(data.id).toBeDefined()
    expect(data.code).toBe('camp-http-horeca-2027')
    expect(data.status).toBe('draft')
  })

  it('returns calendar view via GET /api/admin/seasonal-campaigns/calendar', async () => {
    // Seed campaign
    const postReq = makeRequest('/api/admin/seasonal-campaigns', 'POST', samplePayload)
    await handleSeasonalCampaignsHttp(postReq, { database: world.db, now: () => FIXTURE_NOW })

    const getReq = makeRequest('/api/admin/seasonal-campaigns/calendar?year=2027&sector=horeca', 'GET')
    const res = await handleSeasonalCampaignsHttp(getReq, { database: world.db, now: () => FIXTURE_NOW })

    expect(res).toBeDefined()
    expect(res!.status).toBe(200)
    const data = (await res!.json()) as { year: number; campaigns: unknown[] }
    expect(data.year).toBe(2027)
    expect(data.campaigns).toHaveLength(1)
  })

  it('rejects unprivileged access with 403 forbidden', async () => {
    const req = makeRequest('/api/admin/seasonal-campaigns', 'POST', samplePayload, UNPRIVILEGED_IDENTITY)
    const res = await handleSeasonalCampaignsHttp(req, { database: world.db, now: () => FIXTURE_NOW })

    expect(res).toBeDefined()
    expect(res!.status).toBe(403)
    const err = (await res!.json()) as { error: { code: string } }
    expect(err.error.code).toBe('forbidden')
  })

  it('rejects unprivileged GET access to calendar with 403 forbidden', async () => {
    const req = makeRequest('/api/admin/seasonal-campaigns/calendar', 'GET', undefined, UNPRIVILEGED_IDENTITY)
    const res = await handleSeasonalCampaignsHttp(req, { database: world.db, now: () => FIXTURE_NOW })

    expect(res).toBeDefined()
    expect(res!.status).toBe(403)
    const err = (await res!.json()) as { error: { code: string } }
    expect(err.error.code).toBe('forbidden')
  })

  it('rejects unauthenticated requests without actor identity with 401 unauthenticated', async () => {
    const req = new Request('https://shop.neteco.invalid/api/admin/seasonal-campaigns', {
      method: 'GET'
    })
    const res = await handleSeasonalCampaignsHttp(req, {
      database: world.db,
      now: () => FIXTURE_NOW,
      actorIdFromRequest: async () => null
    })

    expect(res).toBeDefined()
    expect(res!.status).toBe(401)
    const err = (await res!.json()) as { error: { code: string } }
    expect(err.error.code).toBe('unauthenticated')
  })

  it('rejects cross-site CSRF mutating requests with 403 cross_site_forbidden', async () => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': 'csrf-01',
      'x-actor-id': MKT_MGR_IDENTITY,
      'sec-fetch-site': 'cross-site'
    }
    const req = new Request('https://shop.neteco.invalid/api/admin/seasonal-campaigns', {
      method: 'POST',
      headers,
      body: JSON.stringify(samplePayload)
    })
    const res = await handleSeasonalCampaignsHttp(req, { database: world.db, now: () => FIXTURE_NOW })

    expect(res).toBeDefined()
    expect(res!.status).toBe(403)
    const err = (await res!.json()) as { error: { code: string } }
    expect(err.error.code).toBe('cross_site_forbidden')
  })

  it('rejects invalid payload violating Zod schemas with 400 invalid_input', async () => {
    const invalidPayload = {
      ...samplePayload,
      need: {
        needJustification: 'short', // min length 10
        targetCustomerProfile: 'invalid_profile'
      }
    }
    const req = makeRequest('/api/admin/seasonal-campaigns', 'POST', invalidPayload)
    const res = await handleSeasonalCampaignsHttp(req, { database: world.db, now: () => FIXTURE_NOW })

    expect(res).toBeDefined()
    expect(res!.status).toBe(400)
    const err = (await res!.json()) as { error: { code: string } }
    expect(err.error.code).toBe('invalid_input')
  })
})
