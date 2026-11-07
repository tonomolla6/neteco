import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Decorative emoji are a widely cited "AI-generated UI" tell; the shop uses SVG icons and plain copy.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2705}\u{2728}\u{26A1}\u{2B50}\u{2B55}\u{FE0F}]/u

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
