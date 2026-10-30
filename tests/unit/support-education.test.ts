import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askFaqAssistant, recordFaqFeedback, requestFaqHandoff } from '../../workers/support/faq-assistant'
import {
  detectEducationCandidates,
  listEducationCandidates,
  commandEducationCandidate,
  measureEducationDeflection
} from '../../workers/support/education'
import { InsightError } from '../../workers/support/insight-commands'
import { insightsFixture, seedKnowledgePage, claimsOf, ADMIN, ADMIN2, NOPERM } from './support-insights-fixture'

let f: Awaited<ReturnType<typeof insightsFixture>>
let clock = '2026-10-01T10:00:00Z'
const deps = () => ({ database: f.database, enabled: true, now: () => clock })
const key = () => crypto.randomUUID()
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => (e instanceof InsightError ? e.code : String(e))
  )
const WINDOW = { from: '2026-09-01', to: '2026-12-01', minOccurrences: 3 }
const EPOXY = [
  '¿Qué pintura epoxi industrial recomendáis?',
  'Recomendáis pintura epoxi industrial',
  'pintura epoxi industrial ¿cuál?',
  '¿Qué pintura epoxi industrial usar?'
]
const at = async (when: string, question: string) => {
  clock = when
  return askFaqAssistant(deps(), { question }, key(), null)
}

beforeEach(async () => {
  f = await insightsFixture()
})
afterEach(() => f.sqlite.close())

describe('detectEducationCandidates (SUP-015)', () => {
  beforeEach(async () => {
    for (const [i, q] of EPOXY.entries()) await at(`2026-10-0${i + 1}T10:00:00Z`, q)
    await at('2026-10-06T10:00:00Z', '¿Venden bombonas de ácido clorhídrico?')
    await at('2026-10-07T10:00:00Z', '¿Venden bombonas de ácido clorhídrico?')
  })
  it('groups repeated unresolved questions by normalised content and ignores rare ones', async () => {
    const run = await detectEducationCandidates(f.database, claimsOf(ADMIN), WINDOW, key(), '2026-10-29T12:00:00Z')
    expect(run).toMatchObject({ created: 1, updated: 0 })
    const list = await listEducationCandidates(f.database, claimsOf(ADMIN), {}, '2026-10-29T12:00:00Z')
    expect(list.items).toEqual([
      expect.objectContaining({
        occurrences: 4,
        status: 'detected',
        version: 1,
        firstSeenAt: '2026-10-01T10:00:00Z',
        lastSeenAt: '2026-10-04T10:00:00Z'
      })
    ])
    expect(list.items[0]!.sampleQuestion).toMatch(/epoxi/)
  })
  it('does not propose topics the assistant already answers', async () => {
    seedKnowledgePage(f.sqlite, {
      slug: 'plazos',
      title: 'Plazos de envío',
      description: 'Cuánto tarda.',
      category: 'envios',
      text: ['El envío por agencia tarda de 2 a 4 días.'],
      publishedAt: '2026-09-15T00:00:00Z'
    })
    for (let i = 0; i < 4; i++) await at(`2026-10-1${i}T10:00:00Z`, '¿Cuánto tarda el envío por agencia?')
    await detectEducationCandidates(f.database, claimsOf(ADMIN), WINDOW, key(), '2026-10-29T12:00:00Z')
    const list = await listEducationCandidates(f.database, claimsOf(ADMIN), {}, '2026-10-29T12:00:00Z')
    expect(list.items.map((i) => i.sampleQuestion).join(' ')).not.toMatch(/agencia/)
  })
  it('counts an answered question that still needed a human as unresolved', async () => {
    seedKnowledgePage(f.sqlite, {
      slug: 'plazos',
      title: 'Plazos de envío',
      description: 'Cuánto tarda.',
      category: 'envios',
      text: ['El envío por agencia tarda de 2 a 4 días.'],
      publishedAt: '2026-09-15T00:00:00Z'
    })
    for (let i = 0; i < 3; i++) {
      const turn = await at(`2026-10-1${i}T10:00:00Z`, '¿Cuánto tarda el envío por agencia?')
      await requestFaqHandoff(deps(), { turnId: turn.turnId, contactEmail: 'a@b.es' }, null)
    }
    await detectEducationCandidates(f.database, claimsOf(ADMIN), WINDOW, key(), '2026-10-29T12:00:00Z')
    expect(
      (await listEducationCandidates(f.database, claimsOf(ADMIN), {}, '2026-10-29T12:00:00Z')).items.some((i) =>
        /agencia/.test(i.sampleQuestion)
      )
    ).toBe(true)
  })
  it('is idempotent and refreshes counts on a later run without duplicating candidates', async () => {
    const k = key()
    await detectEducationCandidates(f.database, claimsOf(ADMIN), WINDOW, k, '2026-10-29T12:00:00Z')
    expect(
      (await detectEducationCandidates(f.database, claimsOf(ADMIN), WINDOW, k, '2026-10-29T12:00:00Z')).created
    ).toBe(1)
    await at('2026-10-20T10:00:00Z', EPOXY[0]!)
    const later = await detectEducationCandidates(f.database, claimsOf(ADMIN), WINDOW, key(), '2026-10-29T12:00:00Z')
    expect(later).toMatchObject({ created: 0, updated: 1 })
    expect(f.sqlite.prepare('SELECT occurrences FROM support_education_candidates').all()).toEqual([{ occurrences: 5 }])
    expect(
      await code(
        detectEducationCandidates(
          f.database,
          claimsOf(ADMIN),
          { ...WINDOW, minOccurrences: 4 },
          k,
          '2026-10-29T12:00:00Z'
        )
      )
    ).toBe('idempotency_conflict')
  })
  it('requires live support authority and a valid window', async () => {
    expect(
      await code(detectEducationCandidates(f.database, claimsOf(NOPERM), WINDOW, key(), '2026-10-29T12:00:00Z'))
    ).toBe('forbidden')
    expect(
      await code(
        detectEducationCandidates(
          f.database,
          claimsOf(ADMIN),
          { ...WINDOW, from: '2026-12-01', to: '2026-09-01' },
          key(),
          '2026-10-29T12:00:00Z'
        )
      )
    ).toBe('invalid_input')
    expect(await code(listEducationCandidates(f.database, null, {}, '2026-10-29T12:00:00Z'))).toBe('unauthenticated')
  })
})

describe('review and publication workflow', () => {
  let candidateId: string
  const NOW = '2026-10-29T12:00:00Z'
  const run = (command: unknown, k = key(), who = ADMIN, id = candidateId) =>
    commandEducationCandidate({ ...deps(), now: () => NOW }, claimsOf(who), id, command, k)
  const approve = {
    action: 'approve',
    expectedVersion: 2,
    reviewNotes: 'Revisado por el responsable técnico de producto',
    targetKind: 'guide',
    safetyReviewed: true
  }
  beforeEach(async () => {
    for (const [i, q] of EPOXY.entries()) await at(`2026-10-0${i + 1}T10:00:00Z`, q)
    await detectEducationCandidates(f.database, claimsOf(ADMIN), WINDOW, key(), NOW)
    candidateId = (await listEducationCandidates(f.database, claimsOf(ADMIN), {}, NOW)).items[0]!.id
  })
  it('walks detected -> in_review -> approved -> published recording each step', async () => {
    expect(await run({ action: 'start_review', expectedVersion: 1 })).toMatchObject({ status: 'in_review', version: 2 })
    expect(await run(approve, key(), ADMIN2)).toMatchObject({ status: 'approved', version: 3 })
    const page = seedKnowledgePage(f.sqlite, {
      slug: 'pintura-epoxi',
      title: 'Pintura epoxi',
      description: 'Guía.',
      category: 'productos',
      text: ['Se recomienda epoxi bicomponente para suelos industriales.'],
      publishedAt: '2026-10-28T00:00:00Z'
    })
    expect(await run({ action: 'publish', expectedVersion: 3, targetPageId: page.pageId })).toMatchObject({
      status: 'published',
      version: 4
    })
    const row = f.sqlite
      .prepare(
        'SELECT status,target_kind,target_page_id,reviewer_id,safety_reviewed,published_at FROM support_education_candidates'
      )
      .get()
    expect(row).toEqual({
      status: 'published',
      target_kind: 'guide',
      target_page_id: page.pageId,
      reviewer_id: ADMIN2.id,
      safety_reviewed: 1,
      published_at: NOW
    })
    expect(
      f.sqlite
        .prepare('SELECT action FROM support_education_events ORDER BY result_version')
        .all()
        .map((r) => (r as { action: string }).action)
    ).toEqual(['start_review', 'approve', 'publish'])
  })
  it('refuses to publish content that is not live approved knowledge or a published product', async () => {
    await run({ action: 'start_review', expectedVersion: 1 })
    await run(approve)
    const draft = seedKnowledgePage(f.sqlite, {
      slug: 'borrador',
      title: 'Borrador',
      description: 'x',
      category: 'productos',
      text: ['x'],
      publish: false
    })
    expect(await code(run({ action: 'publish', expectedVersion: 3, targetPageId: draft.pageId }))).toBe(
      'target_unavailable'
    )
    expect(await code(run({ action: 'publish', expectedVersion: 3, targetProductSlug: 'no-existe' }))).toBe(
      'target_unavailable'
    )
    expect(
      (f.sqlite.prepare('SELECT status FROM support_education_candidates').get() as { status: string }).status
    ).toBe('approved')
  })
  it('can target a published product page', async () => {
    await run({ action: 'start_review', expectedVersion: 1 })
    await run({ ...approve, targetKind: 'pdp' })
    f.sqlite.exec(
      "PRAGMA foreign_keys = OFF; INSERT INTO products(id,category_id,name,slug,status) VALUES('p1','c1','Epoxi','epoxi-suelos','published'); PRAGMA foreign_keys = ON"
    )
    expect((await run({ action: 'publish', expectedVersion: 3, targetProductSlug: 'epoxi-suelos' })).status).toBe(
      'published'
    )
  })
  it('rejects illegal transitions, stale versions and incomplete reviews', async () => {
    expect(await code(run({ action: 'publish', expectedVersion: 1, targetProductSlug: 'x' }))).toBe(
      'invalid_transition'
    )
    expect(
      await code(
        run({
          action: 'approve',
          expectedVersion: 1,
          reviewNotes: 'Revisado por el responsable',
          targetKind: 'faq',
          safetyReviewed: true
        })
      )
    ).toBe('invalid_transition')
    await run({ action: 'start_review', expectedVersion: 1 })
    expect(await code(run({ action: 'start_review', expectedVersion: 1 }, key(), ADMIN2))).toBe('concurrency_conflict')
    expect(await code(run({ ...approve, safetyReviewed: false }))).toBe('invalid_input')
    expect(await code(run({ ...approve, reviewNotes: 'ok' }))).toBe('invalid_input')
    expect(await code(run(approve, key(), ADMIN, crypto.randomUUID()))).toBe('not_found')
  })
  it('can reject a topic and then closes it for good', async () => {
    await run({ action: 'start_review', expectedVersion: 1 })
    expect(
      (await run({ action: 'reject', expectedVersion: 2, reviewNotes: 'Fuera del alcance de la tienda' })).status
    ).toBe('rejected')
    expect(await code(run({ action: 'start_review', expectedVersion: 3 }))).toBe('invalid_transition')
    await detectEducationCandidates(f.database, claimsOf(ADMIN), WINDOW, key(), NOW)
    expect(
      (f.sqlite.prepare('SELECT status FROM support_education_candidates').get() as { status: string }).status
    ).toBe('rejected')
  })
  it('replays an idempotent command and detects key reuse with another payload', async () => {
    const k = key()
    const first = await run({ action: 'start_review', expectedVersion: 1 }, k)
    expect(await run({ action: 'start_review', expectedVersion: 1 }, k)).toEqual(first)
    expect(
      await code(run({ action: 'reject', expectedVersion: 1, reviewNotes: 'Fuera del alcance de la tienda' }, k))
    ).toBe('idempotency_conflict')
    expect((f.sqlite.prepare('SELECT count(*) n FROM support_education_events').get() as { n: number }).n).toBe(1)
  })
  it('needs live authority', async () => {
    expect(await code(run({ action: 'start_review', expectedVersion: 1 }, key(), NOPERM))).toBe('forbidden')
  })
})

describe('measureEducationDeflection', () => {
  const PUBLISHED = '2026-10-15T00:00:00Z'
  const NOW = '2026-10-29T12:00:00Z'
  async function publishedCandidate() {
    for (const [i, q] of EPOXY.entries()) await at(`2026-10-0${i + 1}T10:00:00Z`, q)
    await at('2026-10-05T10:00:00Z', EPOXY[0]!)
    await detectEducationCandidates(f.database, claimsOf(ADMIN), WINDOW, key(), NOW)
    const id = (await listEducationCandidates(f.database, claimsOf(ADMIN), {}, NOW)).items[0]!.id
    const d = { ...deps(), now: () => NOW }
    await commandEducationCandidate(d, claimsOf(ADMIN), id, { action: 'start_review', expectedVersion: 1 }, key())
    await commandEducationCandidate(
      d,
      claimsOf(ADMIN),
      id,
      {
        action: 'approve',
        expectedVersion: 2,
        reviewNotes: 'Revisado por el responsable técnico',
        targetKind: 'faq',
        safetyReviewed: true
      },
      key()
    )
    const page = seedKnowledgePage(f.sqlite, {
      slug: 'pintura-epoxi',
      title: 'Pintura epoxi industrial',
      description: 'Guía epoxi.',
      category: 'productos',
      text: ['Recomendamos pintura epoxi industrial bicomponente para suelos de almacén.'],
      publishedAt: PUBLISHED
    })
    await commandEducationCandidate(
      { ...d, now: () => PUBLISHED },
      claimsOf(ADMIN),
      id,
      { action: 'publish', expectedVersion: 3, targetPageId: page.pageId },
      key()
    )
    return id
  }
  it('refuses to measure a topic that is not published', async () => {
    for (const [i, q] of EPOXY.entries()) await at(`2026-10-0${i + 1}T10:00:00Z`, q)
    await detectEducationCandidates(f.database, claimsOf(ADMIN), WINDOW, key(), NOW)
    const id = (await listEducationCandidates(f.database, claimsOf(ADMIN), {}, NOW)).items[0]!.id
    expect(await code(measureEducationDeflection(f.database, claimsOf(ADMIN), id, NOW))).toBe('invalid_transition')
    expect(await code(measureEducationDeflection(f.database, claimsOf(ADMIN), crypto.randomUUID(), NOW))).toBe(
      'not_found'
    )
  })
  it('measures the real fall in questions that still needed a human', async () => {
    const id = await publishedCandidate()
    for (let i = 0; i < 4; i++) {
      const turn = await at(`2026-10-${16 + i}T10:00:00Z`, EPOXY[i % EPOXY.length]!)
      expect(turn.outcome).toBe('answered')
      if (i < 3) await recordFaqFeedback(deps(), { turnId: turn.turnId, helpful: true })
    }
    const r = await measureEducationDeflection(f.database, claimsOf(ADMIN), id, NOW)
    expect(r).toMatchObject({
      status: 'measured',
      before: { turns: 5, escalated: 5, rateBp: 10000 },
      after: { turns: 4, escalated: 0, rateBp: 0, helpfulRateBp: 10000 },
      deflectionBp: 10000
    })
  })
  it('does not call it measured before the observation period', async () => {
    const id = await publishedCandidate()
    const r = await measureEducationDeflection(f.database, claimsOf(ADMIN), id, '2026-10-18T00:00:00Z')
    expect(r.status).toBe('insufficient_data')
    expect(r.deflectionBp).toBeNull()
  })
  it('shows no improvement when people still escalate', async () => {
    const id = await publishedCandidate()
    for (let i = 0; i < 4; i++) {
      const turn = await at(`2026-10-${16 + i}T10:00:00Z`, EPOXY[i % EPOXY.length]!)
      await requestFaqHandoff(deps(), { turnId: turn.turnId, contactEmail: 'a@b.es' }, null)
    }
    const r = await measureEducationDeflection(f.database, claimsOf(ADMIN), id, NOW)
    expect(r.deflectionBp).toBe(0)
  })
})
