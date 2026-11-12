import type { CommercialTerms } from './commercial-terms'

/**
 * «Te llega el martes 17 si lo pides hoy antes de las 13:00».
 *
 * La fecha concreta convence más que un plazo («24-72 h») porque el cliente no tiene que
 * hacer la cuenta. Se calcula solo con lo que el negocio ha configurado en
 * `shared/commercial-terms.ts`: días de ruta del reparto propio, hora de corte y plazo de la
 * agencia. Sin esos datos no se promete ninguna fecha (devuelve `null`).
 *
 * Es una previsión para la ficha y el carrito. El servidor sigue siendo la autoridad de la
 * fecha de cada pedido (calendario operativo y transportista); el pago la confirma.
 *
 * Todas las fechas son días civiles de Europe/Madrid en formato `YYYY-MM-DD`.
 */

export type DeliveryPromiseMethod = 'own_delivery' | 'parcel'

export interface DeliveryPromiseInput {
  now: Date
  terms: Pick<CommercialTerms, 'ownDeliveryDays' | 'orderCutoffTime' | 'parcelLeadTime'>
  /** Código postal recordado; sin él se promete el envío por agencia. */
  postalCode?: string | null
  /** Prefijos con reparto propio. Por defecto, la Vall d'Albaida (468xx). */
  ownDeliveryPrefixes?: readonly string[]
  /** Días laborables extra antes de salir (p. ej. plazo de un producto bajo pedido). */
  preparationDays?: number
  /** Días sin actividad (festivos) conocidos, `YYYY-MM-DD`. */
  closedDates?: readonly string[]
}

export interface DeliveryPromise {
  method: DeliveryPromiseMethod
  /** Primer día estimado de entrega. */
  from: string
  /** Último día estimado; igual a `from` si es un solo día. */
  to: string
  /** Día en que se considera hecho el pedido si se hace ahora. */
  orderDay: string
  /** Hora de corte que rige la promesa; solo si el pedido entra hoy. */
  cutoff: { time: string; minutesLeft: number } | null
  /** Se ha usado el código postal del cliente para elegir el método. */
  destinationKnown: boolean
}

export const DEFAULT_OWN_DELIVERY_PREFIXES = ['468'] as const

const WEEKDAYS: Record<string, number> = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  domingo: 7
}

function fold(value: string) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** «martes y jueves», «de lunes a viernes», «L-X-V» no: solo nombres completos. ISO: lunes = 1. */
export function parseRouteWeekdays(text: string): number[] {
  const folded = fold(text)
  const days = new Set<number>()
  const names = Object.keys(WEEKDAYS).join('|')
  for (const range of folded.matchAll(new RegExp(`(${names})\\s+a\\s+(${names})`, 'g'))) {
    const start = WEEKDAYS[range[1]!]!
    const end = WEEKDAYS[range[2]!]!
    for (let day = start; day !== end; day = (day % 7) + 1) days.add(day)
    days.add(end)
  }
  for (const match of folded.matchAll(new RegExp(`\\b(${names})\\b`, 'g'))) days.add(WEEKDAYS[match[1]!]!)
  return [...days].sort((left, right) => left - right)
}

/** «24-72 h» → [1, 3]; «48 h» → [2, 2]; «2-3 días» → [2, 3]. Laborables. `null` si no se entiende. */
export function parseParcelLeadDays(text: string): [number, number] | null {
  const folded = fold(text).replace(/\s+/g, ' ')
  const range = folded.match(/(\d{1,3})\s*(?:-|–|a)\s*(\d{1,3})\s*(h|horas|dias?|d)\b/)
  const single = folded.match(/(\d{1,3})\s*(h|horas|dias?|d)\b/)
  const toDays = (amount: number, unit: string) => (unit.startsWith('h') ? Math.max(1, Math.ceil(amount / 24)) : amount)
  if (range) {
    const minimum = toDays(Number(range[1]), range[3]!)
    const maximum = toDays(Number(range[2]), range[3]!)
    return minimum <= maximum && maximum <= 30 ? [minimum, maximum] : null
  }
  if (single) {
    const days = toDays(Number(single[1]), single[2]!)
    return days <= 30 ? [days, days] : null
  }
  return null
}

const madridFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})

function madridNow(instant: Date) {
  const parts = Object.fromEntries(
    madridFormatter
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  )
  return {
    date: Date.UTC(parts.year!, parts.month! - 1, parts.day!),
    minutes: parts.hour! * 60 + parts.minute!
  }
}

const DAY = 86_400_000
const key = (civil: number) => new Date(civil).toISOString().slice(0, 10)
/** ISO: lunes = 1 … domingo = 7. */
const isoWeekday = (civil: number) => ((new Date(civil).getUTCDay() + 6) % 7) + 1

export function deliveryPromise(input: DeliveryPromiseInput): DeliveryPromise | null {
  const { terms } = input
  const closed = new Set(input.closedDates ?? [])
  const businessDay = (civil: number) => isoWeekday(civil) <= 5 && !closed.has(key(civil))
  const addBusinessDays = (civil: number, days: number) => {
    let result = civil
    for (let remaining = days; remaining > 0;) {
      result += DAY
      if (businessDay(result)) remaining -= 1
    }
    return result
  }
  const preparation = Math.max(0, Math.min(60, Math.trunc(input.preparationDays ?? 0)))

  const now = madridNow(input.now)
  const cutoffMatch = terms.orderCutoffTime.match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  const cutoffMinutes = cutoffMatch ? Number(cutoffMatch[1]) * 60 + Number(cutoffMatch[2]) : null
  // Sin hora de corte no se sabe si el pedido de hoy entra hoy: se cuenta desde el siguiente laborable.
  const entersToday = cutoffMinutes !== null && businessDay(now.date) && now.minutes < cutoffMinutes
  const orderDay = entersToday ? now.date : addBusinessDays(now.date, 1)
  const readyDay = addBusinessDays(orderDay, preparation)
  const cutoff =
    entersToday && cutoffMinutes !== null
      ? { time: terms.orderCutoffTime, minutesLeft: cutoffMinutes - now.minutes }
      : null

  const postalCode = input.postalCode?.trim() ?? ''
  const knownPostalCode = /^\d{5}$/.test(postalCode)
  const prefixes = input.ownDeliveryPrefixes?.length ? input.ownDeliveryPrefixes : DEFAULT_OWN_DELIVERY_PREFIXES
  const routeDays = parseRouteWeekdays(terms.ownDeliveryDays)
  const ownZone = knownPostalCode && prefixes.some((prefix) => postalCode.startsWith(prefix))

  if (ownZone && routeDays.length) {
    let day = readyDay + DAY
    for (let guard = 0; guard < 21 && (!routeDays.includes(isoWeekday(day)) || closed.has(key(day))); guard++)
      day += DAY
    if (!routeDays.includes(isoWeekday(day)) || closed.has(key(day))) return null
    return {
      method: 'own_delivery',
      from: key(day),
      to: key(day),
      orderDay: key(orderDay),
      cutoff,
      destinationKnown: true
    }
  }

  const lead = parseParcelLeadDays(terms.parcelLeadTime)
  if (!lead) return null
  return {
    method: 'parcel',
    from: key(addBusinessDays(readyDay, lead[0])),
    to: key(addBusinessDays(readyDay, lead[1])),
    orderDay: key(orderDay),
    cutoff,
    destinationKnown: knownPostalCode
  }
}

const weekdayFormatter = new Intl.DateTimeFormat('es-ES', { weekday: 'long', timeZone: 'UTC' })
const monthFormatter = new Intl.DateTimeFormat('es-ES', { month: 'long', timeZone: 'UTC' })

/** «martes 17»; con el mes si cae a más de una semana: «martes 24 de noviembre». */
export function formatPromiseDay(day: string, today?: string): string {
  const civil = Date.parse(`${day}T00:00:00Z`)
  const date = new Date(civil)
  const label = `${weekdayFormatter.format(date)} ${date.getUTCDate()}`
  if (!today) return label
  const distance = Math.round((civil - Date.parse(`${today}T00:00:00Z`)) / DAY)
  if (distance === 1) return `mañana, ${label}`
  return distance > 6 ? `${label} de ${monthFormatter.format(date)}` : label
}

/** «Te llega el martes 17» o «Te llega entre el martes 17 y el jueves 19». */
export function formatPromiseHeadline(promise: DeliveryPromise, today?: string): string {
  if (promise.from === promise.to) {
    const day = formatPromiseDay(promise.from, today)
    return day.startsWith('mañana') ? `Te llega ${day}` : `Te llega el ${day}`
  }
  return `Te llega entre el ${formatPromiseDay(promise.from)} y el ${formatPromiseDay(promise.to, today)}`
}

/**
 * «miércoles, 18 de noviembre»: la fecha entera, como la escribe Amazon. Sin «mañana» ni
 * rangos: una fecha que se lee de un vistazo.
 */
export function formatDeliveryDate(day: string): string {
  const date = new Date(Date.parse(`${day}T00:00:00Z`))
  return `${weekdayFormatter.format(date)}, ${date.getUTCDate()} de ${monthFormatter.format(date)}`
}

/** Tiempo que queda hasta la hora de corte, «3 h 12 min»; `null` si el pedido ya no entra hoy. */
export function formatCutoffCountdown(promise: Pick<DeliveryPromise, 'cutoff'>): string | null {
  if (!promise.cutoff) return null
  const { minutesLeft } = promise.cutoff
  const hours = Math.floor(minutesLeft / 60)
  const minutes = minutesLeft % 60
  return hours ? `${hours} h ${String(minutes).padStart(2, '0')} min` : `${minutes} min`
}

/** «si lo pides hoy antes de las 13:00»; con poco margen, el tiempo que queda. */
export function formatPromiseCondition(promise: DeliveryPromise): string {
  if (!promise.cutoff) return 'si lo pides ahora'
  const { time, minutesLeft } = promise.cutoff
  if (minutesLeft <= 180) {
    const hours = Math.floor(minutesLeft / 60)
    const minutes = minutesLeft % 60
    const left = hours ? `${hours} h ${String(minutes).padStart(2, '0')} min` : `${minutes} min`
    return `si lo pides en las próximas ${left} (antes de las ${time})`
  }
  return `si lo pides hoy antes de las ${time}`
}

/** Fecha civil de hoy en Madrid, para comparar con las de la promesa. */
export function madridToday(instant: Date): string {
  return key(madridNow(instant).date)
}
