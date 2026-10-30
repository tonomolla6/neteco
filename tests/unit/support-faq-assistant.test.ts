import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  askFaqAssistant,
  requestFaqHandoff,
  recordFaqFeedback,
  listFaqHandoffs,
  commandFaqHandoff,
  readFaqAssistantStats
} from '../../workers/support/faq-assistant'
import { InsightError } from '../../workers/support/insight-commands'
import {
  insightsFixture,
  seedKnowledgePage,
  claimsOf,
  ADMIN,
  ADMIN2,
  NOPERM,
  NOMFA,
  CUSTOMER_A,
  NOW
} from './support-insights-fixture'

let f: Awaited<ReturnType<typeof insightsFixture>>
let deps: { database: D1Database; enabled: boolean; now: () => string }
const key = () => crypto.randomUUID()
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => (e instanceof InsightError ? e.code : String(e))
  )

beforeEach(async () => {
  f = await insightsFixture()
  deps = { database: f.database, enabled: true, now: () => NOW }
  seedKnowledgePage(f.sqlite, {
    slug: 'plazos-de-envio',
    title: 'Plazos de envío',
    description: 'Cuánto tarda un pedido en llegar.',
    category: 'envios',
    text: ['El reparto propio llega en 24 a 48 horas laborables. El envío por agencia tarda de 2 a 4 días.']
  })
  seedKnowledgePage(f.sqlite, {
    slug: 'no-mezclar-productos',
    title: 'No mezclar productos',
    description: 'Seguridad al usar productos de limpieza.',
    category: 'seguridad',
    text: ['Nunca mezcles lejía con amoníaco ni con ácidos porque se liberan gases tóxicos.']
  })
})
afterEach(() => f.sqlite.close())

describe('askFaqAssistant (SUP-012)', () => {
  it('answers from the approved article, cites it and persists the turn', async () => {
    const reply = await askFaqAssistant(deps, { question: '¿Cuánto tarda el envío por agencia?' }, key(), null)
    expect(reply).toMatchObject({
      outcome: 'answered',
      reason: 'grounded',
      handoff: { available: true, handoffId: null }
    })
    expect(reply.answer).toBe('El envío por agencia tarda de 2 a 4 días.')
    expect(reply.sources).toEqual([expect.objectContaining({ slug: 'plazos-de-envio', category: 'envios' })])
    expect(f.sqlite.prepare('SELECT outcome,reason FROM support_faq_turns').all()).toEqual([
      { outcome: 'answered', reason: 'grounded' }
    ])
  })
  it('does not use unpublished or review-expired articles', async () => {
    seedKnowledgePage(f.sqlite, {
      slug: 'borrador',
      title: 'Garantía de producto',
      description: 'Garantía legal del producto.',
      category: 'productos',
      text: ['La garantía legal cubre dos años completos.'],
      publish: false
    })
    seedKnowledgePage(f.sqlite, {
      slug: 'caducado',
      title: 'Cobertura devoluciones',
      description: 'Cobertura.',
      category: 'devoluciones',
      text: ['Aceptamos devoluciones durante catorce días.'],
      reviewDueAt: '2026-10-10T00:00:00Z'
    })
    for (const question of [
      '¿Cuánto cubre la garantía legal del producto?',
      '¿Aceptáis devoluciones durante catorce días?'
    ]) {
      const reply = await askFaqAssistant(deps, { question }, key(), null)
      expect(reply.outcome).toBe('uncertain')
      expect(reply.answer).toBeNull()
      expect(reply.sources).toEqual([])
    }
  })
  it('acknowledges uncertainty instead of inventing an answer', async () => {
    const reply = await askFaqAssistant(
      deps,
      { question: '¿Qué pintura epoxi industrial recomendáis para suelos?' },
      key(),
      null
    )
    expect(reply).toMatchObject({
      outcome: 'uncertain',
      reason: 'no_match',
      answer: null,
      handoff: { available: true }
    })
  })
  it('routes emergencies to a human without any answer', async () => {
    const reply = await askFaqAssistant(deps, { question: 'Mi hijo ha bebido lejía qué hago' }, key(), null)
    expect(reply).toMatchObject({ outcome: 'handoff_required', reason: 'emergency', answer: null })
    expect(reply.notice).toContain('112')
  })
  it('never improvises chemical guidance: mixing questions need a safety article or a human', async () => {
    const answered = await askFaqAssistant(deps, { question: '¿Puedo mezclar lejía con amoníaco?' }, key(), null)
    expect(answered.outcome).toBe('answered')
    expect(answered.answer).toBe('Nunca mezcles lejía con amoníaco ni con ácidos porque se liberan gases tóxicos.')
    expect(answered.notice).toMatch(/ficha de datos de seguridad/)
    const refused = await askFaqAssistant(
      deps,
      { question: '¿Qué proporción de agua para diluir el desengrasante?' },
      key(),
      null
    )
    expect(refused).toMatchObject({ outcome: 'handoff_required', reason: 'chemical_safety', answer: null })
  })
  it('honours the category filter', async () => {
    const reply = await askFaqAssistant(
      deps,
      { question: '¿Cuánto tarda el envío por agencia?', category: 'seguridad' },
      key(),
      null
    )
    expect(reply.outcome).toBe('uncertain')
  })
  it('redacts direct identifiers before persisting the question', async () => {
    await askFaqAssistant(
      deps,
      { question: 'Soy ana@example.com pedido 123456789 ¿cuánto tarda el envío?' },
      key(),
      null
    )
    const row = f.sqlite.prepare('SELECT question FROM support_faq_turns').get() as { question: string }
    expect(row.question).not.toMatch(/ana@|123456789/)
  })
  it('replays an idempotent retry and rejects key reuse with another question', async () => {
    const k = key()
    const first = await askFaqAssistant(deps, { question: '¿Cuánto tarda el envío por agencia?' }, k, null)
    const again = await askFaqAssistant(deps, { question: '¿Cuánto tarda el envío por agencia?' }, k, null)
    expect(again.turnId).toBe(first.turnId)
    expect((f.sqlite.prepare('SELECT count(*) n FROM support_faq_turns').get() as { n: number }).n).toBe(1)
    expect(await code(askFaqAssistant(deps, { question: '¿Dónde descargo mi factura?' }, k, null))).toBe(
      'idempotency_conflict'
    )
  })
  it('validates input and the idempotency key, and fails closed when knowledge is disabled', async () => {
    expect(await code(askFaqAssistant(deps, { question: 'x' } as never, key(), null))).toBe('invalid_input')
    expect(await code(askFaqAssistant(deps, { question: 'hola mundo', extra: 1 } as never, key(), null))).toBe(
      'invalid_input'
    )
    expect(await code(askFaqAssistant(deps, { question: 'hola mundo' }, 'not-a-uuid', null))).toBe('invalid_input')
    expect(await code(askFaqAssistant({ ...deps, enabled: false }, { question: 'hola mundo' }, key(), null))).toBe(
      'knowledge_unavailable'
    )
  })
  it('degrades to an honest uncertain answer when the knowledge query fails', async () => {
    const broken = {
      ...deps,
      database: {
        ...f.database,
        prepare: () => {
          throw new Error('boom')
        },
        batch: f.database.batch.bind(f.database)
      } as unknown as D1Database
    }
    f.sqlite.exec('SELECT 1')
    const reply = await askFaqAssistant(
      {
        ...broken,
        database: new Proxy(f.database, {
          get: (t, p) =>
            p === 'prepare'
              ? (sql: string) => {
                  if (/content_publications/.test(sql)) throw new Error('boom')
                  return t.prepare(sql)
                }
              : (t as never)[p]
        })
      },
      { question: '¿Cuánto tarda el envío?' },
      key(),
      null
    )
    expect(reply).toMatchObject({ outcome: 'uncertain', reason: 'knowledge_unavailable', answer: null })
  })
})

describe('human handoff', () => {
  async function turn(question = '¿Qué pintura epoxi industrial recomendáis?') {
    return (await askFaqAssistant(deps, { question }, key(), null)).turnId
  }
  it('needs a way to reach the person: session customer or e-mail', async () => {
    expect(await code(requestFaqHandoff(deps, { turnId: await turn() }, null))).toBe('invalid_input')
  })
  it('opens one handoff per turn with an SLA and is idempotent', async () => {
    const turnId = await turn()
    const first = await requestFaqHandoff(
      deps,
      { turnId, contactEmail: 'Ana@Example.com', note: 'Necesito un presupuesto' },
      null
    )
    expect(first).toMatchObject({ status: 'open', slaDueAt: '2026-10-30T12:00:00Z' })
    const again = await requestFaqHandoff(deps, { turnId, contactEmail: 'ana@example.com' }, null)
    expect(again.handoffId).toBe(first.handoffId)
    expect(
      f.sqlite.prepare('SELECT count(*) n, min(contact_email) e FROM support_faq_handoffs').get() as {
        n: number
        e: string
      }
    ).toEqual({ n: 1, e: 'ana@example.com' })
  })
  it('accepts a signed-in customer without e-mail and rejects unknown turns', async () => {
    const turnId = await turn()
    expect((await requestFaqHandoff(deps, { turnId }, CUSTOMER_A.customer)).status).toBe('open')
    expect(await code(requestFaqHandoff(deps, { turnId: crypto.randomUUID(), contactEmail: 'a@b.es' }, null))).toBe(
      'not_found'
    )
  })
  it('is reflected when the same turn is replayed', async () => {
    const k = key()
    const reply = await askFaqAssistant(deps, { question: '¿Qué pintura epoxi industrial recomendáis?' }, k, null)
    const handoff = await requestFaqHandoff(deps, { turnId: reply.turnId, contactEmail: 'a@b.es' }, null)
    const replay = await askFaqAssistant(deps, { question: '¿Qué pintura epoxi industrial recomendáis?' }, k, null)
    expect(replay.handoff).toEqual({ available: true, handoffId: handoff.handoffId })
  })
  it('records helpfulness once and rejects a contradicting vote', async () => {
    const turnId = await turn('¿Cuánto tarda el envío por agencia?')
    expect(await recordFaqFeedback(deps, { turnId, helpful: true })).toEqual({ turnId, helpful: true, recorded: true })
    expect((await recordFaqFeedback(deps, { turnId, helpful: true })).helpful).toBe(true)
    expect(await code(recordFaqFeedback(deps, { turnId, helpful: false }))).toBe('idempotency_conflict')
    expect(await code(recordFaqFeedback(deps, { turnId: crypto.randomUUID(), helpful: true }))).toBe('not_found')
  })
})

describe('administrative handoff queue', () => {
  let handoffId: string
  beforeEach(async () => {
    const reply = await askFaqAssistant(deps, { question: '¿Qué pintura epoxi industrial recomendáis?' }, key(), null)
    handoffId = (await requestFaqHandoff(deps, { turnId: reply.turnId, contactEmail: 'ana@example.com' }, null))
      .handoffId
  })
  it('requires live support.manage with MFA', async () => {
    expect(await code(listFaqHandoffs(f.database, claimsOf(NOPERM), {}, NOW))).toBe('forbidden')
    expect(await code(listFaqHandoffs(f.database, claimsOf(NOMFA), {}, NOW))).toBe('mfa_required')
    expect(await code(listFaqHandoffs(f.database, null, {}, NOW))).toBe('unauthenticated')
  })
  it('lists open handoffs with the redacted question, contact and SLA state', async () => {
    const list = await listFaqHandoffs(f.database, claimsOf(ADMIN), { status: 'open' }, NOW)
    expect(list.items).toEqual([
      expect.objectContaining({
        id: handoffId,
        status: 'open',
        contactEmail: 'ana@example.com',
        slaState: 'on_track',
        reason: 'no_match'
      })
    ])
    const late = await listFaqHandoffs(f.database, claimsOf(ADMIN), {}, '2026-10-31T00:00:00Z')
    expect(late.items[0]!.slaState).toBe('breached')
  })
  it('claims then resolves with CAS and idempotency', async () => {
    const k = key()
    const claimed = await commandFaqHandoff(
      f.database,
      claimsOf(ADMIN),
      handoffId,
      { action: 'claim', expectedVersion: 1 },
      k,
      NOW
    )
    expect(claimed).toMatchObject({ status: 'claimed', version: 2 })
    expect(
      (await commandFaqHandoff(f.database, claimsOf(ADMIN), handoffId, { action: 'claim', expectedVersion: 1 }, k, NOW))
        .version
    ).toBe(2)
    expect(
      await code(
        commandFaqHandoff(f.database, claimsOf(ADMIN2), handoffId, { action: 'claim', expectedVersion: 1 }, key(), NOW)
      )
    ).toBe('concurrency_conflict')
    expect(
      await code(
        commandFaqHandoff(f.database, claimsOf(ADMIN), handoffId, { action: 'claim', expectedVersion: 1 }, k, NOW).then(
          () =>
            commandFaqHandoff(f.database, claimsOf(ADMIN), handoffId, { action: 'resolve', expectedVersion: 2 }, k, NOW)
        )
      )
    ).toBe('idempotency_conflict')
    const resolved = await commandFaqHandoff(
      f.database,
      claimsOf(ADMIN2),
      handoffId,
      { action: 'resolve', expectedVersion: 2 },
      key(),
      '2026-10-29T13:00:00Z'
    )
    expect(resolved).toMatchObject({ status: 'resolved', version: 3 })
    expect(f.sqlite.prepare('SELECT owner_id FROM support_faq_handoffs').get()).toEqual({ owner_id: ADMIN.id })
  })
  it('refuses resolving an unclaimed handoff, unknown ids and bad commands', async () => {
    expect(
      await code(
        commandFaqHandoff(f.database, claimsOf(ADMIN), handoffId, { action: 'resolve', expectedVersion: 1 }, key(), NOW)
      )
    ).toBe('invalid_transition')
    expect(
      await code(
        commandFaqHandoff(
          f.database,
          claimsOf(ADMIN),
          crypto.randomUUID(),
          { action: 'claim', expectedVersion: 1 },
          key(),
          NOW
        )
      )
    ).toBe('not_found')
    expect(
      await code(
        commandFaqHandoff(
          f.database,
          claimsOf(ADMIN),
          handoffId,
          { action: 'delete', expectedVersion: 1 } as never,
          key(),
          NOW
        )
      )
    ).toBe('invalid_input')
  })
  it('summarises answered, uncertain, handoff and helpful rates for a window', async () => {
    const t = await askFaqAssistant(deps, { question: '¿Cuánto tarda el envío por agencia?' }, key(), null)
    await recordFaqFeedback(deps, { turnId: t.turnId, helpful: true })
    const stats = await readFaqAssistantStats(
      f.database,
      claimsOf(ADMIN),
      { from: '2026-10-01', to: '2026-11-01' },
      NOW
    )
    expect(stats).toMatchObject({
      turns: 2,
      answered: 1,
      uncertain: 1,
      handoffRequested: 1,
      helpful: 1,
      notHelpful: 0,
      answeredRateBp: 5000,
      handoffRateBp: 5000
    })
    expect(
      await code(readFaqAssistantStats(f.database, claimsOf(NOPERM), { from: '2026-10-01', to: '2026-11-01' }, NOW))
    ).toBe('forbidden')
  })
})
