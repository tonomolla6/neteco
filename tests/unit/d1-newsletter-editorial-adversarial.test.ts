import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newsletterEditorialFixture, newsletterCampaignDocument } from './d1-newsletter-editorial-fixture'
import {
  dispatchNewsletterCampaigns,
  expandNewsletterCampaign
} from '../../workers/marketing/newsletter-campaign-delivery'
import {
  executeNewsletterEditorialAdmin,
  readNewsletterEditorialAdmin
} from '../../workers/marketing/newsletter-campaigns'
import {
  issueNewsletterPreferenceToken,
  readNewsletterPreferences,
  saveNewsletterPreferences
} from '../../workers/marketing/newsletter-preferences'
import {
  createNewsletterEmailServiceAdapter,
  transportReady,
  resolveEditorialSender
} from '../../workers/marketing/newsletter-campaign-transport'
import { newsletterAdminInputSchema } from '../../shared/newsletter-editorial'
describe('newsletter editorial adversarial actual D1', () => {
  let w: Awaited<ReturnType<typeof newsletterEditorialFixture>>
  beforeEach(async () => {
    w = await newsletterEditorialFixture()
  })
  afterEach(() => w.sqlite.close())
  it('rejects inherited command bodies before any write', async () => {
    const inherited = Object.create({
      action: 'create_campaign',
      expectedRevision: 0,
      document: newsletterCampaignDocument(),
      reason: 'No inherited fields'
    })
    expect(newsletterAdminInputSchema.safeParse(inherited).success).toBe(false)
    await expect(
      executeNewsletterEditorialAdmin(w.deps, w.claims, null, inherited, crypto.randomUUID())
    ).rejects.toThrow('invalid_input')
  })
  it('rolls all metadata back if live MFA is revoked at the atomic batch boundary', async () => {
    const original = w.database.batch.bind(w.database)
    w.deps.database = {
      ...w.database,
      batch: async (statements) => {
        w.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(w.claims.sessionId)
        return original(statements)
      }
    }
    await expect(w.campaign(false)).rejects.toThrow('mfa_required')
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_versions').get()).toEqual({ n: 0 })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_commands').get()).toEqual({ n: 0 })
  })
  it('signed preference links cannot be forged or used beyond their short expiry', async () => {
    const sub = await w.subscriber()
    await expect(
      readNewsletterPreferences(w.deps, {
        type: 'bearer',
        token: sub.token.slice(0, -1) + (sub.token.endsWith('a') ? 'b' : 'a')
      })
    ).rejects.toThrow('unauthenticated')
    w.setNow(new Date(Date.parse(w.getNow()) + 1800000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
    await expect(readNewsletterPreferences(w.deps, sub.authority)).rejects.toThrow('unauthenticated')
  })
  it('account preferences always follow the current verified mailbox, not a supplied subscriber', async () => {
    const sub = await w.subscriber('other@example.invalid')
    expect((await readNewsletterPreferences(w.deps, { type: 'account', claims: w.claims })).subscriptionId).toBeNull()
    expect((await readNewsletterPreferences(w.deps, sub.authority)).subscriptionId).toBe(sub.id)
  })
  it('preference changes after fanout are resegmented before any sender invocation', async () => {
    const sub = await w.subscriber()
    await w.policy()
    const id = await w.campaign(true, { ...newsletterCampaignDocument(), frequencies: ['immediate'] })
    await expandNewsletterCampaign(w.deps, id)
    const token = await issueNewsletterPreferenceToken(w.deps, sub.id)
    await saveNewsletterPreferences(
      w.deps,
      { type: 'bearer', token },
      {
        action: 'save',
        expectedRevision: 1,
        preference: { frequency: 'weekly', topics: [], locale: 'es', quietHours: null }
      },
      crypto.randomUUID()
    )
    expect(await dispatchNewsletterCampaigns(w.deps, { campaignId: id })).toMatchObject({
      acceptedLocal: 0,
      skipped: 1
    })
    expect(w.sent).toHaveLength(0)
  })
  it('suppression racing the cap reservation cannot call the sender', async () => {
    await w.subscriber()
    await w.policy()
    await w.campaign()
    w.sqlite.exec(`CREATE TRIGGER synthetic_suppress_on_cap BEFORE INSERT ON newsletter_editorial_caps BEGIN
 INSERT INTO newsletter_suppressions(email_hash,reason,source,created_at,updated_at) SELECT email_hash,'complaint','synthetic_race',unixepoch(),unixepoch() FROM newsletter_subscriptions WHERE id=NEW.subscription_id; END`)
    expect(await dispatchNewsletterCampaigns(w.deps)).toMatchObject({ acceptedLocal: 0 })
    expect(w.sent).toHaveLength(0)
  })
  it('ambiguous acknowledgement failure is quarantined, never redelivered', async () => {
    await w.subscriber()
    await w.policy()
    await w.campaign()
    w.sqlite.exec(
      "CREATE TRIGGER synthetic_ack_fail BEFORE UPDATE ON newsletter_editorial_deliveries WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'synthetic_ack_reject'); END"
    )
    expect(await dispatchNewsletterCampaigns(w.deps)).toMatchObject({ manualReview: 1, acceptedLocal: 0 })
    expect(w.sent).toHaveLength(1)
    await dispatchNewsletterCampaigns(w.deps)
    expect(w.sent).toHaveLength(1)
  })
  it('expired send markers go manual review even with transport OFF', async () => {
    await w.subscriber()
    await w.policy()
    const id = await w.campaign()
    await expandNewsletterCampaign(w.deps, id)
    const past = w.getNow(),
      future = new Date(Date.parse(past) + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    w.sqlite
      .prepare(
        "UPDATE newsletter_editorial_deliveries SET status='sending',sending_at=?,lease_token=?,lease_until=?,provider='local-fake'"
      )
      .run(past, crypto.randomUUID(), future)
    w.setNow(future)
    w.deps.transport!.mode = 'disabled'
    expect(await dispatchNewsletterCampaigns(w.deps)).toMatchObject({ disabled: true, manualReview: 1 })
    expect(w.sent).toHaveLength(0)
  })
  it('policy retirement invalidates queued approvals without requiring a browser session later', async () => {
    await w.subscriber()
    await w.policy()
    const id = await w.campaign()
    await expandNewsletterCampaign(w.deps, id)
    const snapshot = await readNewsletterEditorialAdmin(w.deps, w.claims)
    await executeNewsletterEditorialAdmin(
      w.deps,
      w.claims,
      null,
      { action: 'retire_policy', expectedRevision: snapshot.policyRevision, reason: 'Retirada explícita' },
      crypto.randomUUID()
    )
    expect(await dispatchNewsletterCampaigns(w.deps)).toMatchObject({ skipped: 1, acceptedLocal: 0 })
    expect(w.sent).toHaveLength(0)
  })
  it('real Cloudflare port is explicit opt-in, separate from fake; no external I/O in factory', async () => {
    let calls = 0
    const sender = createNewsletterEmailServiceAdapter({
      send: async (message) => {
        calls++
        expect(message.to).toBe('real-subscriber@example.org')
        return { messageId: 'accepted-synthetic-binding' }
      }
    })
    expect(calls).toBe(0)
    const transport = {
      mode: 'cloudflare-email' as const,
      environment: 'preprod' as const,
      externalEnabled: false,
      from: 'newsletter@example.org',
      allowedRecipients: ['real-subscriber@example.org'],
      senderFactory: () => sender
    }
    expect(transportReady(transport, 'https://shop.example.org')).toBe(false)
    expect(() => resolveEditorialSender(transport, 'https://shop.example.org')).toThrow('delivery_disabled')
    transport.externalEnabled = true
    expect(transportReady(transport, 'https://shop.example.org')).toBe(true)
    expect(transportReady({ ...transport, environment: 'local' }, 'https://shop.example.org')).toBe(false)
    expect(transportReady(transport, 'https://shop.example.test')).toBe(false)
    expect(calls).toBe(0)
  })
  it('real-address consent is not permanently restricted to synthetic customers', async () => {
    await w.subscriber('real-subscriber@example.org')
    await w.policy()
    await w.campaign()
    let calls = 0
    w.deps.publicOrigin = 'https://shop.example.org'
    w.deps.transport = {
      mode: 'cloudflare-email',
      environment: 'preprod',
      externalEnabled: true,
      from: 'newsletter@example.org',
      allowedRecipients: ['real-subscriber@example.org'],
      senderFactory: () =>
        createNewsletterEmailServiceAdapter({
          send: async () => {
            calls++
            return { messageId: 'synthetic-no-network-receipt' }
          }
        })
    }
    expect(await dispatchNewsletterCampaigns(w.deps)).toMatchObject({
      externalDelivery: true,
      acceptedProvider: 1,
      acceptedLocal: 0
    })
    expect(calls).toBe(1)
  })
  it('real-address fake delivery stays blocked', async () => {
    await w.subscriber('real-subscriber@example.org')
    await w.policy()
    await w.campaign()
    expect(await dispatchNewsletterCampaigns(w.deps)).toMatchObject({ acceptedLocal: 0, skipped: 1 })
    expect(w.sent).toHaveLength(0)
  })
  it('concurrent campaign workers share one recipient cap and cannot both send', async () => {
    await w.subscriber()
    await w.policy()
    const a = await w.campaign(),
      b = await w.campaign()
    await Promise.all([
      dispatchNewsletterCampaigns(w.deps, { campaignId: a }),
      dispatchNewsletterCampaigns(w.deps, { campaignId: b })
    ])
    expect(w.sent).toHaveLength(1)
    expect(
      w.sqlite.prepare("SELECT count(*) AS n FROM newsletter_editorial_deliveries WHERE status='accepted'").get()
    ).toEqual({ n: 1 })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_caps').get()).toEqual({ n: 1 })
  })
  it('does not approve links to absent or private CMS/product sources', async () => {
    await w.policy()
    for (const type of ['cms', 'product'] as const) {
      const doc = {
        ...newsletterCampaignDocument(),
        blocks: [
          {
            id: crypto.randomUUID(),
            type: 'link' as const,
            kind: 'editorial' as const,
            label: 'Fuente inexistente',
            target: { type, slug: 'private-not-published' }
          }
        ]
      }
      await expect(w.campaign(true, doc)).rejects.toThrow('source_unavailable')
    }
    expect(
      w.sqlite.prepare("SELECT count(*) AS n FROM newsletter_editorial_campaigns WHERE status='approved'").get()
    ).toEqual({ n: 0 })
  })
  it('escapes synthetic preview and sends typed first-party links only', async () => {
    await w.subscriber()
    await w.policy()
    const doc = {
      ...newsletterCampaignDocument(),
      blocks: [
        {
          id: crypto.randomUUID(),
          type: 'link' as const,
          kind: 'editorial' as const,
          label: 'Consultar catálogo',
          target: { type: 'static' as const, path: '/catalogo' as const }
        }
      ]
    }
    await w.campaign(true, doc)
    expect(await dispatchNewsletterCampaigns(w.deps)).toMatchObject({ acceptedLocal: 1 })
    expect(w.sent[0]!.html).toContain('https://newsletter.neteco.test/catalogo')
  })
})
