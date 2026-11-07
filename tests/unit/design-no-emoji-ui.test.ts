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
