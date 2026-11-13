/**
 * Conversiones de formato para los formularios del panel: el comerciante teclea euros y elige
 * fechas en su hora local; la API sigue recibiendo céntimos enteros e instantes ISO en UTC.
 */

/**
 * «12,50», «12.50», «1.234,56 €» o `12.5` → `1250`. Acepta coma o punto como separador decimal.
 * Devuelve `null` si el texto está vacío, es negativo, tiene más de dos decimales o no es un importe.
 */
export function adminEurosToCents(text: string | number | null | undefined): number | null {
  if (text === null || text === undefined) return null
  if (typeof text === 'number') {
    if (!Number.isFinite(text) || text < 0) return null
    const cents = Math.round(text * 100)
    return Number.isSafeInteger(cents) && Math.abs(text * 100 - cents) < 1e-6 ? cents : null
  }
  let value = text.replace(/[\s€]/g, '')
  if (!/^\d[\d.,]*$/.test(value)) return null
  const lastComma = value.lastIndexOf(','),
    lastDot = value.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    // Con los dos signos, el último es el decimal y el otro separa miles.
    const decimal = lastComma > lastDot ? ',' : '.'
    value = value.split(decimal === ',' ? '.' : ',').join('')
    if (value.indexOf(decimal) !== value.lastIndexOf(decimal)) return null
    value = value.replace(decimal, '.')
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? ',' : '.'
    const parts = value.split(separator)
    // «1.234» o «1.234.567» son miles; «12,5» o «12.50» son decimales.
    const thousands = parts.length > 2 || (separator === '.' && parts[1]?.length === 3 && parts[0] !== '0')
    if (thousands) {
      if (parts.slice(1).some((part) => part.length !== 3)) return null
      value = parts.join('')
    } else value = parts.join('.')
  }
  if (!/^\d+(\.\d{0,2})?$/.test(value)) return null
  const [whole = '0', fraction = ''] = value.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

/** `1250` → «12,50» (sin símbolo ni separador de miles: es el valor inicial de un campo de texto). */
export function adminCentsToEuros(cents: number | string | null | undefined): string {
  if (cents === null || cents === undefined || cents === '') return ''
  const value = Number(cents)
  if (!Number.isFinite(value)) return ''
  return (Math.round(value) / 100).toFixed(2).replace('.', ',')
}

/**
 * Valor de `<input type="datetime-local">` o `type="date"` (hora del navegador) → instante ISO en UTC
 * sin milisegundos («2026-11-13T08:35:00Z»). Una fecha sola se toma a las 00:00 locales.
 * Devuelve `null` si está vacío o no es una fecha válida.
 */
export function adminLocalToIso(value: string | null | undefined): string | null {
  const text = value?.trim()
  if (!text) return null
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00` : text)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Instante ISO → valor para `<input type="datetime-local">` («2026-11-13T09:35», hora del navegador)
 * o, sin hora, para `<input type="date">` («2026-11-13»). Cadena vacía si no hay fecha válida.
 * Con `withSeconds` conserva los segundos (solo para campos con `step="1"`).
 */
export function adminIsoToLocal(
  value: string | number | Date | null | undefined,
  withTime = true,
  withSeconds = false
): string {
  if (value === null || value === undefined || value === '') return ''
  if (!withTime && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (!withTime) return day
  const time = `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  return withSeconds && date.getSeconds() ? `${time}:${pad(date.getSeconds())}` : time
}

/** Identificador largo → «#1A2B3C4D». Los códigos cortos se muestran tal cual. */
export function adminShortId(id: string | null | undefined): string {
  if (!id) return '—'
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? `#${id.slice(0, 8).toUpperCase()}` : id
}

/** «12,5» o «12.5» (tanto por ciento) → `1250` centésimas de punto. `null` si no es un porcentaje válido. */
export function adminPercentToBps(text: string | number | null | undefined): number | null {
  if (text === null || text === undefined) return null
  const value = String(text).replace(/[\s%]/g, '').replace(',', '.')
  if (!/^\d+(\.\d{0,2})?$/.test(value)) return null
  const [whole = '0', fraction = ''] = value.split('.')
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(bps) ? bps : null
}

/** `1250` centésimas de punto → «12,5» (valor inicial de un campo de porcentaje). */
export function adminBpsToPercent(bps: number | string | null | undefined): string {
  if (bps === null || bps === undefined || bps === '') return ''
  const value = Number(bps)
  return Number.isFinite(value) ? String(Math.round(value) / 100).replace('.', ',') : ''
}

/**
 * Para campos de euros enlazados con `:value="adminCentsToEuros(x)"` y `@change`: lee el texto tecleado,
 * devuelve los céntimos (o `current` si no es un importe válido) y deja el campo con el formato «12,50».
 */
export function adminEurosFromInput(event: Event, current: number): number {
  const field = event.target as HTMLInputElement
  const next = adminEurosToCents(field.value) ?? current
  field.value = adminCentsToEuros(next)
  return next
}

/** Igual que `adminEurosFromInput`, para porcentajes enlazados con `:value="adminBpsToPercent(x)"`. */
export function adminPercentFromInput(event: Event, current: number, maxBps = 10_000): number {
  const field = event.target as HTMLInputElement
  const bps = adminPercentToBps(field.value)
  const next = bps === null || bps > maxBps ? current : bps
  field.value = adminBpsToPercent(next)
  return next
}
