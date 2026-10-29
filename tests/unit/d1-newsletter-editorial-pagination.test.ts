import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newsletterEditorialFixture } from './d1-newsletter-editorial-fixture'
import { expandNewsletterCampaign } from '../../workers/marketing/newsletter-campaign-delivery'
import { readNewsletterEditorialAdmin } from '../../workers/marketing/newsletter-campaigns'
describe('newsletter editorial actual D1 paginated expansion', () => {
  let w: Awaited<ReturnType<typeof newsletterEditorialFixture>>
  beforeEach(async () => {
    w = await newsletterEditorialFixture()
  })
  afterEach(() => w.sqlite.close())
  it('expands 1001 genuinely confirmed explicit subscribers in bounded stable pages without truncation', async () => {
    for (let index = 0; index < 1001; index++) await w.subscriber(`fanout-${index}@example.invalid`)
    await w.policy()
    const id = await w.campaign()
    let expanded = 0
    for (let page = 0; page < 11; page++) expanded += await expandNewsletterCampaign(w.deps, id, 100)
    expect(expanded).toBe(1001)
    expect(await expandNewsletterCampaign(w.deps, id, 100)).toBe(0)
    expect(
      w.sqlite
        .prepare(
          'SELECT count(*) AS n,count(DISTINCT subscription_id) AS distinct_n FROM newsletter_editorial_deliveries WHERE campaign_id=?'
        )
        .get(id)
    ).toEqual({ n: 1001, distinct_n: 1001 })
    expect(w.sqlite.prepare('SELECT fanout_complete FROM newsletter_editorial_campaigns WHERE id=?').get(id)).toEqual({
      fanout_complete: 1
    })
    expect(w.sent).toHaveLength(0)
  }, 60000)
  it('campaign overview has a real next cursor, never a silent first-100 cutoff', async () => {
    for (let index = 0; index < 101; index++) await w.campaign(false)
    const first = await readNewsletterEditorialAdmin(w.deps, w.claims)
    expect(first.campaigns).toHaveLength(100)
    expect(first.nextCursor).not.toBeNull()
    const second = await readNewsletterEditorialAdmin(w.deps, w.claims, first.nextCursor!)
    expect(second.campaigns).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.campaigns, ...second.campaigns].map((c) => c.id)).size).toBe(101)
  }, 30000)
})
