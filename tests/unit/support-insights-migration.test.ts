import { afterEach, describe, expect, it } from 'vitest'
import { insightsFixture, seedTicket, seedOrder, seedKnowledgePage, CUSTOMER_A, NOW } from './support-insights-fixture'

let f: Awaited<ReturnType<typeof insightsFixture>>
afterEach(() => f.sqlite.close())

describe('migration 0153 (applied over the base schema)', () => {
  it('creates the tables and the fixtures seed through real constraints', async () => {
    f = await insightsFixture()
    const names = f.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'support_%'")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const t of [
      'support_insight_commands',
      'support_faq_turns',
      'support_faq_handoffs',
      'support_education_candidates',
      'support_b2b_requests',
      'support_b2b_request_events',
      'support_b2b_request_documents',
      'support_contact_backlog_items'
    ])
      expect(names).toContain(t)
    seedOrder(f.sqlite, {
      id: '50000000-0000-4000-8000-000000000001',
      customerId: CUSTOMER_A.customer,
      createdAt: NOW,
      carrier: 'SEUR',
      productSlugs: ['lejia-5l']
    })
    seedTicket(f.sqlite, {
      createdAt: NOW,
      adminTouches: 1,
      orderId: '50000000-0000-4000-8000-000000000001',
      customerId: CUSTOMER_A.customer
    })
    seedKnowledgePage(f.sqlite, { slug: 'a-b', title: 'T', description: 'd', category: 'envios', text: ['x'] })
    expect(f.sqlite.prepare('SELECT count(*) n FROM support_commands').get()).toEqual({ n: 2 })
  })
  it('keeps ledgers append-only', async () => {
    f = await insightsFixture()
    f.sqlite
      .prepare(
        "INSERT INTO support_insight_commands(id,scope,actor_id,idempotency_key,payload_hash,subject_id,receipt,created_at) VALUES (?, 'education',?, 'k', ?, ?, '{}', ?)"
      )
      .run('a'.repeat(36), '10000000-0000-4000-8000-0000000000a1', 'a'.repeat(64), 'b'.repeat(36), NOW)
    expect(() => f.sqlite.prepare("UPDATE support_insight_commands SET scope='b2b_admin'").run()).toThrow(/immutable/)
    expect(() => f.sqlite.prepare('DELETE FROM support_insight_commands').run()).toThrow(/immutable/)
  })
})
