import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { SQLInputValue } from 'node:sqlite'
import { newsletterEditorialFixture, newsletterPolicyDocument } from './d1-newsletter-editorial-fixture'
import { expandNewsletterCampaign } from '../../workers/marketing/newsletter-campaign-delivery'
describe('newsletter editorial D1 constraints and immutable authority', () => {
  let w: Awaited<ReturnType<typeof newsletterEditorialFixture>>
  beforeEach(async () => {
    w = await newsletterEditorialFixture()
  })
  afterEach(() => w.sqlite.close())
  const row = z.record(z.union([z.string(), z.number(), z.null()]))
  function insert(table: string, fields: Record<string, SQLInputValue>) {
    const columns = Object.keys(fields)
    w.sqlite
      .prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...Object.values(fields))
  }
  it.each([null, '', 'bad', '2026-02-30T00:00:00Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00+00:00'])(
    'refuses noncanonical policy time %s',
    (created_at) => {
      expect(() =>
        insert('newsletter_editorial_policies', {
          id: crypto.randomUUID(),
          document: JSON.stringify(newsletterPolicyDocument()),
          actor_id: w.claims.identityId,
          created_at
        })
      ).toThrow()
    }
  )
  it.each(['null', '{}', '[]', '{"minEditorialPercent":null}', '{"intervalHours":{"weekly":1}}'])(
    'refuses incomplete policy JSON %s',
    (document) => {
      expect(() =>
        insert('newsletter_editorial_policies', {
          id: crypto.randomUUID(),
          document,
          actor_id: w.claims.identityId,
          created_at: w.getNow()
        })
      ).toThrow()
    }
  )
  it.each(['x'.repeat(36), 'A0000000-0000-4000-8000-000000000000', '100000000000-0000-8000-000000000000'])(
    'rejects malformed UUID %s',
    (id) => {
      expect(() =>
        insert('newsletter_editorial_topics', {
          id,
          code: 'synthetic',
          label: 'Tema sintético',
          active: 1,
          revision: 1
        })
      ).toThrow()
    }
  )
  it.each(['2start', '-start', 'Topic', 'topic with spaces'])('rejects incompatible topic code %s', (code) => {
    expect(() =>
      insert('newsletter_editorial_topics', {
        id: crypto.randomUUID(),
        code,
        label: 'Tema sintético',
        active: 1,
        revision: 1
      })
    ).toThrow()
  })
  it.each([
    '{}',
    'null',
    '{"frequency":"weekly","topics":null,"locale":"es","quietHours":null}',
    '{"frequency":"weekly","topics":[],"locale":"es"}'
  ])('rejects incomplete preference JSON %s', async (document) => {
    const sub = await w.subscriber()
    expect(() =>
      w.sqlite
        .prepare('UPDATE newsletter_editorial_preferences SET revision=revision+1,document=? WHERE subscription_id=?')
        .run(document, sub.id)
    ).toThrow()
  })
  it('blocks a campaign pointer to another campaign version', async () => {
    const a = await w.campaign(false),
      b = await w.campaign(false),
      version = w.sqlite.prepare('SELECT draft_version_id FROM newsletter_editorial_campaigns WHERE id=?').get(b)!
    expect(() =>
      w.sqlite
        .prepare('UPDATE newsletter_editorial_campaigns SET draft_version_id=?,revision=revision+1 WHERE id=?')
        .run(row.parse(version).draft_version_id!, a)
    ).toThrow('newsletter_editorial_campaign_head')
  })
  it('does not permit restoring an approved head to draft or changing approval payload', async () => {
    await w.policy()
    const id = await w.campaign()
    expect(() =>
      w.sqlite
        .prepare("UPDATE newsletter_editorial_campaigns SET status='draft',revision=revision+1 WHERE id=?")
        .run(id)
    ).toThrow('newsletter_editorial_campaign_head')
    expect(() =>
      w.sqlite.prepare("UPDATE newsletter_editorial_campaigns SET ends_at='2027-01-01T00:00:00Z' WHERE id=?").run(id)
    ).toThrow('newsletter_editorial_campaign_head')
  })
  it('refuses partial leases and impossible terminal/receipt state', async () => {
    await w.subscriber()
    await w.policy()
    const id = await w.campaign()
    await expandNewsletterCampaign(w.deps, id)
    expect(() =>
      w.sqlite.prepare('UPDATE newsletter_editorial_deliveries SET lease_token=?').run(crypto.randomUUID())
    ).toThrow()
    expect(() =>
      w.sqlite.exec("UPDATE newsletter_editorial_deliveries SET status='accepted',finished_at=created_at")
    ).toThrow()
    expect(() =>
      w.sqlite.exec(
        "UPDATE newsletter_editorial_deliveries SET status='leased',lease_token=NULL,lease_until=created_at"
      )
    ).toThrow()
  })
  it.each([
    'newsletter_editorial_policies',
    'newsletter_editorial_versions',
    'newsletter_editorial_commands',
    'newsletter_editorial_audit'
  ])('keeps history immutable %s', async (table) => {
    await w.policy()
    await w.campaign(false)
    expect(() => w.sqlite.exec(`DELETE FROM ${table}`)).toThrow('newsletter_editorial_immutable')
  })
  it('rejects NULL-passing command metadata and does not accept bool revision', async () => {
    await w.policy()
    const original = row.parse(w.sqlite.prepare('SELECT * FROM newsletter_editorial_commands').get())
    for (const change of [
      { payload_hash: 'z'.repeat(64) },
      { created_at: '' },
      { input: 'null' },
      { response: '{}' },
      { after_state: 'null' },
      { input: JSON.stringify({ action: 'set_policy', expectedRevision: false }) }
    ])
      expect(() =>
        insert('newsletter_editorial_commands', {
          ...original,
          id: crypto.randomUUID(),
          idempotency_key: crypto.randomUUID(),
          ...change
        })
      ).toThrow()
  })
})
