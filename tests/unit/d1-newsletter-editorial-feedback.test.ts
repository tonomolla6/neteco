import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newsletterEditorialFixture } from './d1-newsletter-editorial-fixture'
import { dispatchNewsletterCampaigns } from '../../workers/marketing/newsletter-campaign-delivery'
import { receiveNewsletterEditorialFeedback } from '../../workers/marketing/newsletter-campaign-feedback'
import { testUuid } from '../support/deterministic'
describe('known-receipt authenticated newsletter feedback D1', () => {
  let w: Awaited<ReturnType<typeof newsletterEditorialFixture>>
  beforeEach(async () => {
    w = await newsletterEditorialFixture()
    await w.subscriber()
    await w.policy()
    await w.campaign()
    await dispatchNewsletterCampaigns(w.deps)
  })
  afterEach(() => w.sqlite.close())
  async function feedback(
    type: 'delivered' | 'hard_bounce' | 'complaint',
    eventId = testUuid(),
    messageId = `synthetic-${w.sent[0]!.deliveryId}`
  ) {
    const body = JSON.stringify({ eventId, messageId, type, occurredAt: w.getNow() }),
      key = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(w.deps.feedback!.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      ),
      sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))), (b) =>
        b.toString(16).padStart(2, '0')
      ).join('')
    return { body, signature: `sha256=${sig}` }
  }
  it('authenticates before mutation and requires a known acceptance', async () => {
    const f = await feedback('complaint')
    await expect(receiveNewsletterEditorialFeedback(w.deps, f.body, null)).rejects.toThrow('feedback_unauthenticated')
    await expect(receiveNewsletterEditorialFeedback(w.deps, f.body + ' ', f.signature)).rejects.toThrow(
      'feedback_unauthenticated'
    )
    const unknown = await feedback('complaint', testUuid(), 'not-known')
    await expect(receiveNewsletterEditorialFeedback(w.deps, unknown.body, unknown.signature)).rejects.toThrow(
      'receipt_unknown'
    )
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_suppressions').get()).toEqual({ n: 0 })
  })
  it('deduplicates signed events and refuses changed payload under the same key', async () => {
    const key = testUuid(),
      f = await feedback('delivered', key)
    expect(await receiveNewsletterEditorialFeedback(w.deps, f.body, f.signature)).toMatchObject({ replay: false })
    expect(await receiveNewsletterEditorialFeedback(w.deps, f.body, f.signature)).toMatchObject({ replay: true })
    const changed = await feedback('complaint', key)
    await expect(receiveNewsletterEditorialFeedback(w.deps, changed.body, changed.signature)).rejects.toThrow(
      'idempotency_conflict'
    )
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_feedback').get()).toEqual({ n: 1 })
  })
  it('hard bounce and complaint suppress irreversibly; later delivered never downgrades', async () => {
    for (const type of ['hard_bounce', 'complaint', 'delivered'] as const) {
      const f = await feedback(type)
      await receiveNewsletterEditorialFeedback(w.deps, f.body, f.signature)
    }
    expect(w.sqlite.prepare('SELECT status FROM newsletter_subscriptions').get()).toEqual({ status: 'suppressed' })
    expect(w.sqlite.prepare('SELECT reason FROM newsletter_suppressions').get()).toEqual({ reason: 'complaint' })
    expect(w.sqlite.prepare('SELECT feedback_status FROM newsletter_editorial_deliveries').get()).toEqual({
      feedback_status: 'complained'
    })
    const audit = JSON.stringify(w.sqlite.prepare('SELECT * FROM newsletter_editorial_feedback').all())
    expect(audit).not.toContain('cms@example.invalid')
    expect(audit).not.toContain('np1.')
  })
  it('rolls event and result back if suppression cannot be persisted', async () => {
    w.sqlite.exec(
      "CREATE TRIGGER reject_newsletter_feedback BEFORE INSERT ON newsletter_suppressions BEGIN SELECT RAISE(ABORT,'synthetic_reject'); END"
    )
    const f = await feedback('complaint')
    await expect(receiveNewsletterEditorialFeedback(w.deps, f.body, f.signature)).rejects.toThrow('synthetic_reject')
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_feedback').get()).toEqual({ n: 0 })
    expect(w.sqlite.prepare('SELECT feedback_status FROM newsletter_editorial_deliveries').get()).toEqual({
      feedback_status: null
    })
  })
})
