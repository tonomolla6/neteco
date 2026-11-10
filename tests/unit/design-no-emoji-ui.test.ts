import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Decorative emoji are a widely cited "AI-generated UI" tell; the shop uses SVG icons and plain copy.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2705}\u{2728}\u{26A1}\u{2B50}\u{2B55}]|\u{FE0F}/u

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return vueFiles(path)
    return path.endsWith('.vue') ? [path] : []
  })
}

describe('UI copy without decorative emoji', () => {
  it('keeps app/ Vue templates free of emoji', () => {
    const offenders = vueFiles('app').flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(({ text }) => EMOJI.test(text))
        .map(({ file, line, text }) => `${file}:${line} ${text.trim()}`)
    )
    expect(offenders).toEqual([])
  })
})

describe('UI chrome without generic AI-template styling', () => {
  const TELLS: Array<[string, RegExp]> = [
    ['accent stripe', /\bborder-l-4\b/],
    ['oversized radius', /\brounded-3xl\b/],
    ['oversized shadow', /\bshadow-2xl\b/],
    ['off-brand gradient banner', /bg-gradient-to-r from-(?:sky|emerald|purple|violet|indigo|fuchsia|pink)-/]
  ]
  it.each(TELLS)('avoids %s in app/ templates', (_label, pattern) => {
    const offenders = vueFiles('app').filter((file) => pattern.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('section headings', () => {
  it('use plain headings without dot + all-caps eyebrow labels', () => {
    const eyebrow = /uppercase tracking-\[0\.18em\][^\n]*\n\s*<span class="size-2 rounded-full/
    expect(vueFiles('app').filter((file) => eyebrow.test(readFileSync(file, 'utf8')))).toEqual([])
  })
})

describe('heading typography and casing', () => {
  const FORBIDDEN_AI_TITLE_CASE = [
    'Casos de Éxito de Clientes Neteco',
    'Kits y Bundles Profesionales',
    'Webinars, Demos Técnicas y Eventos',
    'Biblioteca de Plantillas Descargables',
    'Centro de Marca y Certificaciones Oficiales',
    'Verificador Instantáneo de Certificados',
    'Política de Tolerancia Cero con Sellos Vagos y Greenwashing'
  ]

  it.each(FORBIDDEN_AI_TITLE_CASE)('avoids AI Title Case heading "%s"', (phrase) => {
    const offenders = vueFiles('app').filter((file) => readFileSync(file, 'utf8').includes(phrase))
    expect(offenders).toEqual([])
  })

  it('avoids English Title Case with ≥3 consecutive capitalized words in h1/h2 headings', () => {
    const headingPattern = /<(?:h1|h2)[^>]*>([\s\S]*?)<\/(?:h1|h2)>/gu
    const threeCaps =
      /\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s*,\s*|\s+)[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s*,\s*|\s+)[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\b/u

    const offenders: string[] = []
    for (const file of vueFiles('app')) {
      const content = readFileSync(file, 'utf8')
      for (const match of content.matchAll(headingPattern)) {
        const text = match[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (threeCaps.test(text)) {
          offenders.push(`${file}: ${text}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('avoids marketing buzzwords (Bundles, Webinars) in public page headings', () => {
    const kitsContent = readFileSync('app/pages/kits.vue', 'utf8')
    const eventosContent = readFileSync('app/pages/eventos.vue', 'utf8')
    expect(kitsContent).not.toMatch(/<h1[^>]*>[\s\S]*?\bBundles\b[\s\S]*?<\/h1>/i)
    expect(eventosContent).not.toMatch(/<h1[^>]*>[\s\S]*?\bWebinars\b[\s\S]*?<\/h1>/i)
  })
})
