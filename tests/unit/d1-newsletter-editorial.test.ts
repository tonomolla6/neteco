import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  newsletterEditorialFixture,
  newsletterCampaignDocument,
  newsletterPolicyDocument
} from './d1-newsletter-editorial-fixture'
import {
  executeNewsletterEditorialAdmin,
  readNewsletterEditorialAdmin
} from '../../workers/marketing/newsletter-campaigns'
import { readNewsletterPreferences, saveNewsletterPreferences } from '../../workers/marketing/newsletter-preferences'
import {
  dispatchNewsletterCampaigns,
  expandNewsletterCampaign,
  nextNewsletterAllowedAt
} from '../../workers/marketing/newsletter-campaign-delivery'
import { previewNewsletterCampaign, editorialSourcesCte } from '../../workers/marketing/newsletter-campaign-render'
import { suppressNewsletterEmail } from '../../workers/marketing/newsletter'

describe('D1 newsletter editorial real SQLite', () => {
  let w: Awaited<ReturnType<typeof newsletterEditorialFixture>>
  beforeEach(async () => {
    w = await newsletterEditorialFixture()
  })
  afterEach(() => w.sqlite.close())
  it('starts without manufactured policy, topics, preference or consent', async () => {
    expect((await readNewsletterEditorialAdmin(w.deps, w.claims)).policy).toBeNull()
    expect(await readNewsletterPreferences(w.deps, { type: 'account', claims: w.claims })).toMatchObject({
      status: 'not_subscribed',
      preference: null,
      canSave: false
    })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_subscriptions').get()).toEqual({ n: 0 })
  })
  it('saves explicit preferences with CAS, exact replay and irreversible unsubscribe', async () => {
    const sub = await w.subscriber(),
      key = crypto.randomUUID(),
      input = {
        action: 'save',
        expectedRevision: 1,
        preference: { frequency: 'weekly', topics: [], locale: 'es', quietHours: null }
      }
    const receipt = await saveNewsletterPreferences(w.deps, sub.authority, input, key)
    expect(await saveNewsletterPreferences(w.deps, sub.authority, input, key)).toEqual(receipt)
    await expect(
      saveNewsletterPreferences(
        w.deps,
        sub.authority,
        { ...input, preference: { ...input.preference, frequency: 'monthly' } },
        key
      )
    ).rejects.toThrow('idempotency_conflict')
    await expect(saveNewsletterPreferences(w.deps, sub.authority, input, crypto.randomUUID())).rejects.toThrow(
      'version_conflict'
    )
    await saveNewsletterPreferences(
      w.deps,
      sub.authority,
      { action: 'unsubscribe', expectedRevision: 2 },
      crypto.randomUUID()
    )
    expect(await readNewsletterPreferences(w.deps, sub.authority)).toMatchObject({
      status: 'unsubscribed',
      canSave: false
    })
    await expect(
      saveNewsletterPreferences(w.deps, sub.authority, { ...input, expectedRevision: 3 }, crypto.randomUUID())
    ).rejects.toThrow('consent_unavailable')
    expect(await saveNewsletterPreferences(w.deps, sub.authority, input, key)).toEqual(receipt)
  })
  it('stores versioned campaign commands and blocks edits after approval', async () => {
    await w.policy()
    const id = await w.campaign(),
      snapshot = await readNewsletterEditorialAdmin(w.deps, w.claims),
      c = snapshot.campaigns[0]!
    expect(c).toMatchObject({ id, status: 'approved', revision: 2, totals: { accepted: 0 } })
    await expect(
      executeNewsletterEditorialAdmin(
        w.deps,
        w.claims,
        id,
        {
          action: 'update_campaign',
          expectedRevision: 2,
          document: newsletterCampaignDocument(),
          reason: 'Cambio posterior'
        },
        crypto.randomUUID()
      )
    ).rejects.toThrow('not_editable')
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_audit').get()).toEqual({ n: 3 })
  })
  it('delivers fake only after real DOI, records receipt, and never resends', async () => {
    await w.subscriber()
    await w.policy()
    const id = await w.campaign()
    expect(() => w.sqlite.prepare(`${editorialSourcesCte('?1', false)} SELECT 1`)).not.toThrow()
    expect(() =>
      w.sqlite.prepare(`${editorialSourcesCte('?1', false)} SELECT * FROM newsletter_live_products`)
    ).not.toThrow()
    const original = w.deps.database.batch.bind(w.deps.database)
    let batchFailure: unknown
    w.deps.database = {
      ...w.database,
      batch: async (statements) => {
        try {
          for (const [index, statement] of statements.entries())
            try {
              w.sqlite.prepare(z.object({ sql: z.string() }).passthrough().parse(statement).sql)
            } catch (failure) {
              throw new Error(`statement ${index}: ${failure instanceof Error ? failure.message : 'unavailable'}`, {
                cause: failure
              })
            }
          return await original(statements)
        } catch (failure) {
          batchFailure = failure
          throw failure
        }
      }
    }
    const report = await dispatchNewsletterCampaigns(w.deps, { campaignId: id })
    expect(batchFailure).toBeUndefined()
    expect(report).toMatchObject({
      disabled: false,
      expanded: 1,
      acceptedLocal: 1,
      acceptedProvider: 0,
      externalDelivery: false
    })
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.html).toContain('/newsletter/preferencias?token=np1.')
    expect(JSON.stringify(w.sqlite.prepare('SELECT * FROM newsletter_editorial_deliveries').all())).not.toContain(
      'token='
    )
    expect(JSON.stringify(w.sqlite.prepare('SELECT * FROM newsletter_editorial_audit').all())).not.toContain(
      'cms@example.invalid'
    )
    await dispatchNewsletterCampaigns(w.deps)
    expect(w.sent).toHaveLength(1)
  })
  it('rechecks suppression for already queued recipients', async () => {
    await w.subscriber()
    await w.policy()
    const id = await w.campaign()
    await expandNewsletterCampaign(w.deps, id)
    await suppressNewsletterEmail(
      w.database,
      'cms@example.invalid',
      'complaint',
      'synthetic_test',
      w.secrets,
      Math.floor(Date.parse(w.getNow()) / 1000)
    )
    expect(await dispatchNewsletterCampaigns(w.deps, { campaignId: id })).toMatchObject({
      acceptedLocal: 0,
      skipped: 1
    })
    expect(w.sent).toHaveLength(0)
  })
  it('shared recipient cap prevents two campaign sends in one interval', async () => {
    await w.subscriber()
    await w.policy()
    const a = await w.campaign(),
      b = await w.campaign()
    await dispatchNewsletterCampaigns(w.deps, { campaignId: a })
    expect(await dispatchNewsletterCampaigns(w.deps, { campaignId: b })).toMatchObject({
      acceptedLocal: 0,
      deferred: 1
    })
    expect(w.sent).toHaveLength(1)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_caps').get()).toEqual({ n: 1 })
  })
  it('provider ambiguity is manual review, not retryable', async () => {
    await w.subscriber()
    await w.policy()
    await w.campaign()
    let calls = 0
    w.deps.transport!.senderFactory = () => ({
      kind: 'local-fake',
      send: async () => {
        calls++
        throw new Error('unknown outcome')
      }
    })
    expect(await dispatchNewsletterCampaigns(w.deps)).toMatchObject({ acceptedLocal: 0, manualReview: 1 })
    await dispatchNewsletterCampaigns(w.deps)
    expect(calls).toBe(1)
    expect(w.sqlite.prepare('SELECT status,last_error_code FROM newsletter_editorial_deliveries').get()).toEqual({
      status: 'manual_review',
      last_error_code: 'provider_outcome_unknown'
    })
  })
  it('OFF does not invoke any sender or create delivery jobs', async () => {
    await w.subscriber()
    await w.policy()
    await w.campaign()
    let calls = 0
    w.deps.transport!.mode = 'disabled'
    w.deps.transport!.senderFactory = () => {
      calls++
      throw new Error('should not construct')
    }
    expect(await dispatchNewsletterCampaigns(w.deps)).toMatchObject({ disabled: true, acceptedLocal: 0, expanded: 0 })
    expect(calls).toBe(0)
  })
  it('preview is escaped, synthetic and has no working action links', async () => {
    const id = await w.campaign(false),
      preview = await previewNewsletterCampaign(w.deps, w.claims, id)
    expect(preview).toMatchObject({ synthetic: true, actionsEnabled: false, externalDelivery: false })
    expect(preview.html).not.toContain('href=')
    expect(w.sent).toHaveLength(0)
  })
  it('requires existing administration.manage and live MFA', async () => {
    w.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(w.claims.sessionId)
    await expect(readNewsletterEditorialAdmin(w.deps, w.claims)).rejects.toThrow('mfa_required')
  })
  it('quiet hours use actual Madrid DST boundaries', () => {
    const policy = newsletterPolicyDocument(),
      pref = {
        frequency: 'weekly' as const,
        topics: [],
        locale: 'es' as const,
        quietHours: { startMinute: 120, endMinute: 240, timezone: 'Europe/Madrid' as const }
      }
    expect(nextNewsletterAllowedAt('2026-03-29T00:59:00Z', pref, policy)).toBe('2026-03-29T00:59:00Z')
    expect(nextNewsletterAllowedAt('2026-03-29T01:00:00Z', pref, policy)).toBe('2026-03-29T02:00:00Z')
    expect(nextNewsletterAllowedAt('2026-10-25T00:30:00Z', pref, policy)).toBe('2026-10-25T03:00:00Z')
  })
})
