import { describe, expect, it } from 'vitest'
import { deterministicUuid, FIXED_TEST_INSTANT } from '../fixtures/deterministic'
import {
  assetCommandSchema,
  buildTrustJsonLd,
  computeDilution,
  contentGovernanceCommandSchema,
  evaluateTrust,
  reviewBucket,
  safeRedirectPath
} from '../../shared/content-governance'

const day = (offset: number, base = Date.parse(FIXED_TEST_INSTANT)) =>
  new Date(base + offset * 86_400_000).toISOString().slice(0, 10)
const source = {
  label: 'Ficha de datos de seguridad del fabricante',
  url: 'https://example.invalid/fds.pdf',
  kind: 'safety_data_sheet'
}
const base = {
  action: 'save_governance',
  slug: 'guia-desinfeccion',
  expectedVersion: 0,
  ownerName: 'Equipo técnico',
  sensitivity: 'regulation',
  nextReviewAt: day(90),
  authorId: deterministicUuid('governance-author'),
  reviewerId: deterministicUuid('governance-reviewer'),
  sources: [source],
  claims: [{ text: 'Eficaz frente a bacterias según el ensayo citado', category: 'health', sourceIndex: 0 }],
  retirement: null
}

describe('SEO-029/031 command schema', () => {
  it('uses repeatable governance dates and distinct synthetic identities', () => {
    expect(base.nextReviewAt).toBe('2026-11-11')
    expect(base.authorId).toBe(deterministicUuid('governance-author'))
    expect(base.reviewerId).toBe(deterministicUuid('governance-reviewer'))
    expect(base.authorId).not.toBe(base.reviewerId)
  })
  it('accepts a complete governance command', () => {
    expect(contentGovernanceCommandSchema.safeParse(base).success).toBe(true)
  })
  it.each([
    ['unknown key', { ...base, extra: 1 }],
    ['client-supplied time', { ...base, signedOffAt: '2026-01-01T00:00:00Z' }],
    ['client-supplied identity', { ...base, actorId: deterministicUuid('governance-actor') }],
    ['bad slug', { ...base, slug: 'Not A Slug' }],
    ['non-https source', { ...base, sources: [{ ...source, url: 'http://example.invalid/x' }] }],
    ['javascript source', { ...base, sources: [{ ...source, url: 'javascript:alert(1)' }] }],
    ['source with credentials', { ...base, sources: [{ ...source, url: 'https://u:p@example.invalid/x' }] }],
    ['impossible review date', { ...base, nextReviewAt: '2026-02-31' }],
    ['author equals reviewer', { ...base, reviewerId: base.authorId }],
    ['duplicate source url', { ...base, sources: [source, { ...source, label: 'Otra copia' }] }],
    [
      'claim index out of range',
      { ...base, claims: [{ text: 'Afirmación sanitaria sin fuente válida', category: 'health', sourceIndex: 4 }] }
    ],
    [
      'too many claims',
      {
        ...base,
        claims: Array.from({ length: 41 }, (_, n) => ({
          text: `Afirmación comercial número ${n}`,
          category: 'commercial',
          sourceIndex: 0
        }))
      }
    ],
    ['redirect without date', { ...base, retirement: { retireAt: null, redirectTo: '/recursos' } }],
    ['negative version', { ...base, expectedVersion: -1 }]
  ])('rejects %s', (_name, input) => {
    expect(contentGovernanceCommandSchema.safeParse(input).success).toBe(false)
  })
  it('accepts a retirement with an internal redirect', () => {
    const ok = { ...base, retirement: { retireAt: day(120), redirectTo: '/recursos/otra-guia' } }
    expect(contentGovernanceCommandSchema.safeParse(ok).success).toBe(true)
  })
  it.each(['//evil.invalid', 'https://evil.invalid', '/\\evil', '/a/../b', 'recursos', '/a b', '/a?x=1#', '/%2e%2e/x'])(
    'refuses unsafe redirect %s',
    (value) => expect(safeRedirectPath(value)).toBe(false)
  )
  it('accepts a normal redirect', () => expect(safeRedirectPath('/recursos/guia-nueva')).toBe(true))
  it('requires author entered credentials to be admin text, never defaulted', () => {
    const author = {
      action: 'save_author',
      expectedVersion: 0,
      displayName: 'Persona Sintética',
      bio: 'Biografía de prueba suficientemente larga.',
      experience: 'Experiencia de prueba suficientemente larga.'
    }
    const parsed = contentGovernanceCommandSchema.safeParse(author)
    expect(parsed.success).toBe(true)
    expect(parsed.success && (parsed.data as { credentials?: unknown }).credentials).toBeUndefined()
    expect(contentGovernanceCommandSchema.safeParse({ ...author, bio: 'corta' }).success).toBe(false)
  })
})

describe('SEO-030 assets', () => {
  const common = {
    action: 'save_asset',
    expectedVersion: 0,
    title: 'Título del activo',
    summary: 'Resumen suficientemente descriptivo.',
    methodology: 'Metodología documentada: cómo se obtuvieron los datos y bajo qué supuestos.',
    dataAsOf: day(-3)
  }
  it('accepts each kind with its own payload', () => {
    for (const [kind, payload] of [
      ['checklist', { items: ['Paso 1', 'Paso 2'] }],
      ['guide', { sections: [{ heading: 'Inicio', body: 'Texto' }] }],
      ['comparison', { columns: ['A', 'B'], rows: [{ label: 'x', values: ['1', '2'] }] }],
      ['study', { sampleSize: 12, dataset: [{ label: 'a', value: 1.5, unit: '%' }] }],
      ['calculator', { type: 'dilution', presets: [{ use: 'Suelos', concentrateParts: 1, waterParts: 50 }] }]
    ] as const)
      expect(assetCommandSchema.safeParse({ ...common, slug: `activo-${kind}`, kind, payload }).success, kind).toBe(
        true
      )
  })
  it.each([
    ['payload of another kind', { kind: 'checklist', payload: { sections: [] } }],
    [
      'comparison row width mismatch',
      { kind: 'comparison', payload: { columns: ['A', 'B'], rows: [{ label: 'x', values: ['1'] }] } }
    ],
    ['study without sample size', { kind: 'study', payload: { dataset: [{ label: 'a', value: 1, unit: '%' }] } }],
    [
      'study with NaN',
      { kind: 'study', payload: { sampleSize: 3, dataset: [{ label: 'a', value: Number.NaN, unit: '%' }] } }
    ],
    [
      'zero water parts',
      { kind: 'calculator', payload: { type: 'dilution', presets: [{ use: 'x', concentrateParts: 1, waterParts: 0 }] } }
    ],
    ['short methodology', { kind: 'checklist', payload: { items: ['x'] }, methodology: 'corta' }],
    ['invalid date', { kind: 'checklist', payload: { items: ['x'] }, dataAsOf: '2026-13-01' }]
  ])('rejects %s', (_n, extra) => {
    expect(assetCommandSchema.safeParse({ ...common, slug: 'activo-x', ...extra }).success).toBe(false)
  })
  it('computes dilution deterministically and rejects bad input', () => {
    expect(computeDilution({ totalMl: 1000, concentrateParts: 1, waterParts: 49 })).toEqual({
      concentrateMl: 20,
      waterMl: 980
    })
    expect(computeDilution({ totalMl: 500, concentrateParts: 1, waterParts: 2 })).toEqual({
      concentrateMl: 166.7,
      waterMl: 333.3
    })
    expect(computeDilution({ totalMl: 0, concentrateParts: 1, waterParts: 2 })).toBeNull()
    expect(computeDilution({ totalMl: 100, concentrateParts: 0, waterParts: 2 })).toBeNull()
    expect(computeDilution({ totalMl: Number.NaN, concentrateParts: 1, waterParts: 2 })).toBeNull()
    expect(computeDilution({ totalMl: 1e9, concentrateParts: 1, waterParts: 2 })).toBeNull()
  })
})

describe('trust evaluation and calendar', () => {
  const now = '2026-10-30T10:00:00Z'
  const full = {
    ownerName: 'Equipo',
    sensitivity: 'regulation' as const,
    nextReviewAt: '2027-01-10',
    authorStatus: 'active' as const,
    reviewerStatus: 'active' as const,
    hasAuthor: true,
    hasReviewer: true,
    signedOffAt: '2026-10-01T00:00:00Z',
    sourceCount: 1,
    claims: [{ text: 'x'.repeat(12), category: 'chemical' as const, sourceIndex: 0 }]
  }
  it('is verified when everything is in place', () =>
    expect(evaluateTrust(full, now)).toEqual({ state: 'verified', issues: [] }))
  it.each([
    ['no_author', { hasAuthor: false }],
    ['no_reviewer', { hasReviewer: false }],
    ['not_signed_off', { signedOffAt: null }],
    ['review_overdue', { nextReviewAt: '2026-10-30' }],
    ['author_archived', { authorStatus: 'archived' as const }],
    ['reviewer_archived', { reviewerStatus: 'archived' as const }],
    ['no_sources', { sourceCount: 0, claims: [] }],
    ['claim_without_evidence', { claims: [{ text: 'x'.repeat(12), category: 'health' as const, sourceIndex: null }] }],
    ['claim_without_evidence', { claims: [{ text: 'x'.repeat(12), category: 'health' as const, sourceIndex: 3 }] }]
  ])('flags %s', (issue, patch) => {
    const result = evaluateTrust({ ...full, ...patch }, now)
    expect(result.issues).toContain(issue)
    expect(result.state).not.toBe('verified')
  })
  it('general content without claims needs no sources', () =>
    expect(evaluateTrust({ ...full, sensitivity: 'general', sourceCount: 0, claims: [] }, now).state).toBe('verified'))
  it('buckets the review calendar from the supplied server time', () => {
    expect(reviewBucket('2026-10-29', now)).toBe('overdue')
    expect(reviewBucket('2026-10-30', now)).toBe('overdue')
    expect(reviewBucket('2026-11-15', now)).toBe('due_30')
    expect(reviewBucket('2026-11-29', now)).toBe('due_30')
    expect(reviewBucket('2026-12-01', now)).toBe('scheduled')
  })
  it('builds Article JSON-LD only from stored facts and escapes script breaking', () => {
    const ld = buildTrustJsonLd({
      url: 'https://neteco.invalid/recursos/guia',
      headline: 'Guía </script><b>',
      dateModified: '2026-10-01T00:00:00Z',
      author: { name: 'Ana', experience: 'Experiencia', credentials: null },
      reviewer: { name: 'Luis', experience: 'Revisión', credentials: 'Máster en Química' },
      sources: [{ label: 'FDS', url: 'https://example.invalid/fds.pdf' }]
    })
    expect(ld['@type']).toBe('Article')
    expect(ld.author).toEqual({ '@type': 'Person', name: 'Ana', description: 'Experiencia' })
    expect(ld.reviewedBy).toMatchObject({ '@type': 'Person', name: 'Luis', hasCredential: 'Máster en Química' })
    expect(ld.citation).toEqual([{ '@type': 'CreativeWork', name: 'FDS', url: 'https://example.invalid/fds.pdf' }])
    expect(ld.dateModified).toBe('2026-10-01T00:00:00Z')
  })
})
