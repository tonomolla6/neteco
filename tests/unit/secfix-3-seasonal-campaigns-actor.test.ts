import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBaTestWorld, MKT_MGR_IDENTITY, FIXTURE_NOW, type BaTestWorld } from './d1-ba-preview-diff-fixtures'
import { handleSeasonalCampaignsHttp } from '../../workers/marketing/seasonal-campaigns-http'

// SECFIX-3 finding 2: the untrusted x-actor-id header must never identify the caller.
describe('SECFIX-3 seasonal campaigns ignore x-actor-id', () => {
  let world: BaTestWorld

  beforeEach(async () => {
    world = await createBaTestWorld()
    world.sqlite.exec(await readFile('db/d1/migrations/0143_seasonal_sector_campaigns.sql', 'utf8'))
  })

  afterEach(() => world.close())

  const spoofed = () =>
    new Request('https://shop.neteco.invalid/api/admin/seasonal-campaigns', {
      headers: { 'x-actor-id': MKT_MGR_IDENTITY }
    })

  it('rejects a spoofed admin x-actor-id when no session resolver is wired (401)', async () => {
    const res = await handleSeasonalCampaignsHttp(spoofed(), { database: world.db, now: () => FIXTURE_NOW })
    expect(res?.status).toBe(401)
  })

  it('rejects a spoofed admin x-actor-id when the session resolver finds no session (401)', async () => {
    const res = await handleSeasonalCampaignsHttp(spoofed(), {
      database: world.db,
      now: () => FIXTURE_NOW,
      actorIdFromRequest: async () => null
    })
    expect(res?.status).toBe(401)
  })
})
