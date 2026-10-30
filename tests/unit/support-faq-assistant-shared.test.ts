import { describe, expect, it } from 'vitest'
import {
  assistantAskInputSchema,
  assistantHandoffInputSchema,
  assistantFeedbackInputSchema,
  assessRisk,
  redactQuestion,
  tokenizeQuestion,
  selectGroundedAnswer,
  type ApprovedArticle
} from '../../shared/support-faq-assistant'

const article = (over: Partial<ApprovedArticle> = {}): ApprovedArticle => ({
  pageId: '10000000-0000-4000-8000-000000000001',
  versionId: '20000000-0000-4000-8000-000000000001',
  slug: 'plazos-de-envio',
  title: 'Plazos de envío',
  description: 'Cuánto tarda un pedido en llegar.',
  category: 'envios',
  reviewedAt: '2026-10-01T00:00:00Z',
  passages: ['El reparto propio llega en 24 a 48 horas laborables. El envío por agencia tarda de 2 a 4 días.'],
  ...over
})

describe('tokenizeQuestion', () => {
  it('folds accents and case, drops stopwords and short tokens, and stems plurals', () => {
    expect(tokenizeQuestion('¿Cuánto TARDAN los envíos a Málaga?')).toEqual(['tardan', 'envio', 'malaga'].sort())
  })
  it('is stable and de-duplicated', () => {
    expect(tokenizeQuestion('envío envío ENVÍO')).toEqual(['envio'])
  })
  it('returns empty for stopword-only input', () => {
    expect(tokenizeQuestion('que de la el')).toEqual([])
  })
})

describe('redactQuestion', () => {
  it('removes e-mails, long digit runs and urls before persistence', () => {
    const out = redactQuestion('Soy ana@example.com, pedido 123456789 https://x.test/a?b=1 ¿cuándo llega?')
    expect(out).not.toMatch(/ana@|123456789|https:/)
    expect(out).toContain('[correo]')
    expect(out).toContain('[numero]')
    expect(out).toContain('[enlace]')
  })
  it('collapses whitespace', () => {
    expect(redactQuestion('  hola \n\n  mundo  ')).toBe('hola mundo')
  })
})

describe('input schemas', () => {
  it('trims and bounds the question and rejects control characters and unknown keys', () => {
    expect(assistantAskInputSchema.safeParse({ question: '  ¿Plazo?  ' }).data?.question).toBe('¿Plazo?')
    expect(assistantAskInputSchema.safeParse({ question: 'ab' }).success).toBe(false)
    expect(assistantAskInputSchema.safeParse({ question: 'x'.repeat(301) }).success).toBe(false)
    expect(assistantAskInputSchema.safeParse({ question: 'hola\u0000mundo' }).success).toBe(false)
    expect(assistantAskInputSchema.safeParse({ question: 'hola mundo', extra: 1 }).success).toBe(false)
    expect(assistantAskInputSchema.safeParse({ question: 'hola mundo', category: 'otra' }).success).toBe(false)
  })
  it('requires a contact only through a valid e-mail and bounds the note', () => {
    const turnId = '10000000-0000-4000-8000-000000000001'
    expect(assistantHandoffInputSchema.safeParse({ turnId, contactEmail: 'a@b.es' }).success).toBe(true)
    expect(assistantHandoffInputSchema.safeParse({ turnId, contactEmail: 'nope' }).success).toBe(false)
    expect(assistantHandoffInputSchema.safeParse({ turnId, note: 'x'.repeat(1001) }).success).toBe(false)
    expect(assistantHandoffInputSchema.safeParse({ turnId: 'no' }).success).toBe(false)
    expect(assistantFeedbackInputSchema.safeParse({ turnId, helpful: true }).success).toBe(true)
    expect(assistantFeedbackInputSchema.safeParse({ turnId, helpful: 'yes' }).success).toBe(false)
  })
})

describe('assessRisk', () => {
  it('flags exposure/ingestion as emergency', () => {
    for (const q of [
      'Mi hijo ha bebido lejía',
      'Me salpicó en los ojos',
      'he inhalado ácido, qué hago',
      'intoxicación por amoníaco'
    ]) {
      expect(assessRisk(q)).toBe('emergency')
    }
  })
  it('flags mixing/dosing as chemical', () => {
    for (const q of [
      'Puedo mezclar lejía con amoníaco',
      'qué dosis de desengrasante uso',
      'proporción para diluir el ácido'
    ]) {
      expect(assessRisk(q)).toBe('chemical')
    }
  })
  it('leaves ordinary logistics questions alone', () => {
    expect(assessRisk('cuánto tarda el envío')).toBe('none')
  })
})

describe('selectGroundedAnswer', () => {
  it('answers verbatim from the approved passage and cites the source', () => {
    const r = selectGroundedAnswer('¿Cuánto tarda el envío por agencia?', [article()], 'none')
    expect(r.outcome).toBe('answered')
    expect(r.reason).toBe('grounded')
    expect(r.answer).toContain('El envío por agencia tarda de 2 a 4 días.')
    expect(r.sources).toEqual([
      expect.objectContaining({ slug: 'plazos-de-envio', versionId: '20000000-0000-4000-8000-000000000001' })
    ])
    expect(r.confidenceBp).toBeGreaterThanOrEqual(6000)
  })
  it('never emits text that is not in an approved passage', () => {
    const a = article()
    const r = selectGroundedAnswer('plazo envío agencia', [a], 'none')
    for (const sentence of (r.answer ?? '').split(/(?<=\.)\s+/)) expect(a.passages.join(' ')).toContain(sentence)
  })
  it('acknowledges uncertainty when nothing matches', () => {
    const r = selectGroundedAnswer('¿Venden pintura epoxi industrial?', [article()], 'none')
    expect(r).toMatchObject({ outcome: 'uncertain', reason: 'no_match', answer: null, sources: [] })
  })
  it('acknowledges uncertainty on weak overlap', () => {
    const r = selectGroundedAnswer('envío paquetería internacional Japón aduanas', [article()], 'none')
    expect(r.outcome).toBe('uncertain')
    expect(r.reason).toBe('low_confidence')
    expect(r.answer).toBeNull()
  })
  it('is uncertain with an empty knowledge base', () => {
    expect(selectGroundedAnswer('plazo de envío', [], 'none')).toMatchObject({
      outcome: 'uncertain',
      reason: 'no_match'
    })
  })
  it('hands off emergencies without answering, even if a passage matches', () => {
    const a = article({
      category: 'seguridad',
      passages: ['En caso de contacto con los ojos, lavar con agua abundante.']
    })
    const r = selectGroundedAnswer('me salpicó lejía en los ojos', [a], 'emergency')
    expect(r).toMatchObject({ outcome: 'handoff_required', reason: 'emergency', answer: null })
    expect(r.notice).toContain('112')
  })
  it('hands off chemical questions unless a safety/product article covers them closely', () => {
    const logistics = article({ passages: ['Puedes mezclar tu pedido con otros productos en una sola caja.'] })
    const r = selectGroundedAnswer('puedo mezclar lejía con amoníaco', [logistics], 'chemical')
    expect(r).toMatchObject({ outcome: 'handoff_required', reason: 'chemical_safety', answer: null })
  })
  it('answers chemical questions only verbatim from seguridad/productos with a safety notice', () => {
    const safety = article({
      slug: 'no-mezclar-productos',
      title: 'No mezclar productos',
      category: 'seguridad',
      passages: ['Nunca mezcles lejía con amoníaco ni con ácidos porque se liberan gases tóxicos.']
    })
    const r = selectGroundedAnswer('puedo mezclar lejía con amoníaco', [safety], 'chemical')
    expect(r.outcome).toBe('answered')
    expect(r.answer).toBe('Nunca mezcles lejía con amoníaco ni con ácidos porque se liberan gases tóxicos.')
    expect(r.notice).toMatch(/ficha de datos de seguridad|persona/i)
  })
  it('prefers the better supported article and cites only the one used', () => {
    const other = article({
      pageId: '10000000-0000-4000-8000-000000000002',
      slug: 'facturas',
      title: 'Facturas',
      category: 'facturas',
      passages: ['Descarga tu factura desde la cuenta.']
    })
    const r = selectGroundedAnswer('dónde descargo mi factura', [article(), other], 'none')
    expect(r.sources.map((s) => s.slug)).toEqual(['facturas'])
  })
})
