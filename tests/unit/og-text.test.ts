import { describe, expect, it } from 'vitest'
import { ARCHIVO_600_METRICS, INTER_400_METRICS } from '../../workers/seo/og-metrics'
import { fitText, measureText, sanitizeOgText } from '../../workers/seo/og-text'

const options = { metrics: ARCHIVO_600_METRICS, sizes: [64, 52, 44], maxWidth: 600, maxLines: 3 } as const
const LONG_NAME =
  'Desengrasante concentrado multiusos de alta espuma para cocinas industriales, hornos, planchas y campanas extractoras de hostelería y colectividades con certificación alimentaria ' +
  'y fragancia neutra, formato profesional para dosificación automática y manual en garrafa reutilizable de gran capacidad'

function expectFits(result: ReturnType<typeof fitText>, maxWidth = options.maxWidth) {
  expect(result.lines.length).toBeGreaterThan(0)
  expect(result.lines.length).toBeLessThanOrEqual(3)
  for (const line of result.lines) {
    expect(line.length).toBeGreaterThan(0)
    expect(measureText(options.metrics, line, result.size, 0)).toBeLessThanOrEqual(maxWidth)
  }
}

describe('sanitizeOgText', () => {
  it('collapses whitespace, strips control characters and keeps Spanish typography', () => {
    expect(sanitizeOgText('  Limpiador\n\t multiusos \u0000 ñ°®€  ')).toBe('Limpiador multiusos ñ°®€')
    expect(sanitizeOgText('Don\'t "quote" «x»')).toBe('Don’t "quote" «x»')
  })

  it('drops characters the embedded font cannot draw instead of rendering missing-glyph boxes', () => {
    expect(sanitizeOgText('Gel 清洁 limpiador 🧼')).toBe('Gel limpiador')
    expect(sanitizeOgText('‮evil‬')).toBe('evil')
  })

  it('returns an empty string for null-like input', () => {
    expect(sanitizeOgText(undefined)).toBe('')
    expect(sanitizeOgText(null)).toBe('')
  })
})

describe('fitText', () => {
  it('uses the largest size on one line for a short title', () => {
    const result = fitText('Guante de nitrilo', options)
    expect(result).toMatchObject({ size: 64, lines: ['Guante de nitrilo'], truncated: false })
  })

  it('steps the size down (64 → 52 → 44) as the name grows, never exceeding 3 lines', () => {
    const sizes = new Set<number>()
    const vocabulary = ['desengrasante', 'profesional', 'cocina', 'alta', 'espuma', 'suelos', 'concentrado']
    let name = 'Limpiador'
    for (let i = 0; i < 80; i++) {
      name += ` ${vocabulary[i % vocabulary.length]}`
      const result = fitText(name, options)
      expectFits(result)
      sizes.add(result.size)
    }
    expect([...sizes].sort((a, b) => b - a)).toEqual([64, 52, 44])
  })

  it('truncates a 180+ character name with an ellipsis at a word boundary', () => {
    expect(LONG_NAME.length).toBeGreaterThan(180)
    const result = fitText(LONG_NAME, options)
    expectFits(result)
    expect(result.size).toBe(44)
    expect(result.truncated).toBe(true)
    const last = result.lines.at(-1)!
    expect(last.endsWith('…')).toBe(true)
    const words = last.slice(0, -1).trimEnd().split(' ')
    const source = new Set(LONG_NAME.split(' ').map((word) => word.replace(/[,.;:]+$/, '')))
    for (const word of words) expect(source.has(word), `"${word}" must be a whole source word`).toBe(true)
    expect(last).not.toMatch(/\s…$/)
  })

  it('force-breaks a 40 character word without spaces and keeps every line inside the width', () => {
    const word = 'Supercalifragilisticoespialidosoabcdefgh'
    expect(word).toHaveLength(40)
    const result = fitText(`Gel ${word}`, options)
    expectFits(result)
    expect(result.lines.join('').replace(/…/g, '')).toContain('Supercalifragilistico'.slice(0, 8))
    expect(result.truncated).toBe(false)
  })

  it('shortens (never overflows) a giant unbroken string', () => {
    const result = fitText('W'.repeat(300), options)
    expectFits(result)
    expect(result.truncated).toBe(true)
    expect(result.lines.at(-1)!.endsWith('…')).toBe(true)
  })

  it('measures all-caps names with the real advances', () => {
    const result = fitText('DESENGRASANTE CONCENTRADO PROFESIONAL PARA COCINAS INDUSTRIALES ALTA ESPUMA', options)
    expectFits(result)
    expect(result.size).toBeLessThan(64)
  })

  it('keeps accents, ñ, €, °, ® and quotes in the output', () => {
    const result = fitText('Años 90° “Fría” 5 € NETECO®', options)
    expectFits(result)
    expect(result.lines.join(' ')).toBe('Años 90° “Fría” 5 € NETECO®')
  })

  it('works for the secondary font and a single line (brand, reference)', () => {
    const result = fitText('Ref. ' + 'X'.repeat(120), {
      metrics: INTER_400_METRICS,
      sizes: [28],
      maxWidth: 600,
      maxLines: 1
    })
    expect(result.lines).toHaveLength(1)
    expect(measureText(INTER_400_METRICS, result.lines[0]!, 28, 0)).toBeLessThanOrEqual(600)
    expect(result.truncated).toBe(true)
    expect(result.lines[0]!.endsWith('…')).toBe(true)
  })

  it('returns no lines for empty text', () => {
    expect(fitText('   ', options)).toEqual({ lines: [], size: 64, truncated: false })
  })
})
