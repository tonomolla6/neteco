import { ARCHIVO_600_METRICS, INTER_400_METRICS, type OgFontMetrics } from './og-metrics'

export interface FitTextOptions {
  metrics: OgFontMetrics
  /** Tamaños en píxeles de mayor a menor; se baja de forma escalonada hasta que el texto cabe. */
  sizes: readonly number[]
  maxWidth: number
  maxLines: number
  /** Interletraje en em (negativo = más apretado). */
  letterSpacingEm?: number
}

export interface FitTextResult {
  lines: string[]
  size: number
  truncated: boolean
}

const ELLIPSIS = '…'
// Solo se dibujan caracteres presentes en ambas fuentes empaquetadas (subset latino).
const DRAWABLE = new Set(
  Object.keys(ARCHIVO_600_METRICS.advances)
    .map(Number)
    .filter((codePoint) => codePoint in INTER_400_METRICS.advances)
)

/** Normaliza texto de catálogo para dibujarlo: sin controles, sin glifos ausentes y con espacios colapsados. */
export function sanitizeOgText(value: string | null | undefined): string {
  if (!value) return ''
  let output = ''
  for (const character of value.normalize('NFC')) {
    const codePoint = character.codePointAt(0)!
    if (/\s/u.test(character) || codePoint < 0x20 || codePoint === 0x7f) {
      output += ' '
    } else if (character === "'") output += '’'
    else if (codePoint === 0xad) continue
    else if (DRAWABLE.has(codePoint)) output += character
  }
  return output.replace(/ {2,}/g, ' ').trim()
}

export function measureText(metrics: OgFontMetrics, text: string, size: number, letterSpacingEm = 0): number {
  let width = 0
  let count = 0
  for (const character of text) {
    width += ((metrics.advances[character.codePointAt(0)!] ?? metrics.advances[0x20] ?? 0) / metrics.unitsPerEm) * size
    count++
  }
  return width + count * letterSpacingEm * size
}

function splitLongWord(word: string, fits: (text: string) => boolean): string[] {
  const parts: string[] = []
  let current = ''
  for (const character of word) {
    if (current && !fits(current + character)) {
      parts.push(current)
      current = ''
    }
    current += character
  }
  if (current) parts.push(current)
  return parts
}

function wrap(words: readonly string[], fits: (text: string) => boolean, allowBreak: boolean) {
  const lines: string[] = []
  let current = ''
  let broken = false
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (fits(candidate)) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    if (fits(word)) {
      current = word
      continue
    }
    if (!allowBreak) return null
    broken = true
    const parts = splitLongWord(word, fits)
    lines.push(...parts.slice(0, -1))
    current = parts.at(-1)!
  }
  if (current) lines.push(current)
  return { lines, broken }
}

/** Última línea visible con «…» pegada a la última palabra completa que cabe (o a un fragmento si no hay otra). */
function ellipsize(line: string, fits: (text: string) => boolean): string {
  const words = line.split(' ')
  while (words.length > 1 && !fits(`${words.join(' ')}${ELLIPSIS}`)) words.pop()
  let text = words.join(' ')
  const characters = Array.from(text)
  while (characters.length > 1 && !fits(`${characters.join('')}${ELLIPSIS}`)) characters.pop()
  text = characters.join('')
  return `${text.replace(/[\s.,;:·-]+$/u, '')}${ELLIPSIS}`
}

/**
 * Ajusta un texto a un ancho y a un número máximo de líneas: baja el tamaño de forma escalonada,
 * parte solo las palabras que no caben solas y, como último recurso, recorta con «…» en límite de palabra.
 * El resultado nunca supera `maxWidth` según los avances reales de la fuente.
 */
export function fitText(raw: string, options: FitTextOptions): FitTextResult {
  const { metrics, sizes, maxWidth, maxLines } = options
  const spacing = options.letterSpacingEm ?? 0
  const text = sanitizeOgText(raw)
  const largest = sizes[0]!
  if (!text) return { lines: [], size: largest, truncated: false }
  const words = text.split(' ')
  const fitsAt = (size: number) => (candidate: string) => measureText(metrics, candidate, size, spacing) <= maxWidth

  for (const allowBreak of [false, true]) {
    for (const size of sizes) {
      const wrapped = wrap(words, fitsAt(size), allowBreak)
      if (wrapped && wrapped.lines.length <= maxLines) return { lines: wrapped.lines, size, truncated: false }
    }
  }
  const size = sizes.at(-1)!
  const fits = fitsAt(size)
  const wrapped = wrap(words, fits, true)!
  const lines = wrapped.lines.slice(0, maxLines)
  lines[maxLines - 1] = ellipsize(lines[maxLines - 1]!, fits)
  return { lines, size, truncated: true }
}
