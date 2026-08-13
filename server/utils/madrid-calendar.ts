export const BUSINESS_TIME_ZONE = 'Europe/Madrid'

export interface MadridDateTimeParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
})

export function madridDateTimeParts(instant: Date): MadridDateTimeParts {
  if (Number.isNaN(instant.getTime())) throw new RangeError('Invalid calendar instant')
  const values = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  )
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!
  }
}

export function madridDateKey(instant: Date) {
  const value = madridDateTimeParts(instant)
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`
}

export function madridTimeKey(instant: Date) {
  const value = madridDateTimeParts(instant)
  return `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}:${String(value.second).padStart(2, '0')}`
}

export type MadridTimeDisambiguation = 'earlier' | 'later' | 'reject'

function localDateTimeToInstant(
  parts: MadridDateTimeParts,
  milliseconds: number,
  disambiguation: MadridTimeDisambiguation
) {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    milliseconds
  )
  const candidates: Date[] = []
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = new Date(localAsUtc - offsetMinutes * 60_000)
    const observed = madridDateTimeParts(candidate)
    if (
      candidate.getUTCMilliseconds() === milliseconds &&
      Object.keys(parts).every(
        (key) => parts[key as keyof MadridDateTimeParts] === observed[key as keyof MadridDateTimeParts]
      )
    ) {
      candidates.push(candidate)
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.getTime(), candidate])).values()].sort(
    (left, right) => left.getTime() - right.getTime()
  )
  if (unique.length === 0) throw new RangeError('Local time does not exist in Europe/Madrid')
  if (unique.length > 1 && disambiguation === 'reject') {
    throw new RangeError('Local time is repeated in Europe/Madrid; choose earlier or later')
  }
  return disambiguation === 'later' ? unique.at(-1)! : unique[0]!
}

export function madridLocalDateTimeToInstant(value: string, disambiguation: MadridTimeDisambiguation = 'reject') {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value)
  if (!match) throw new RangeError('Madrid local date-time must use YYYY-MM-DDTHH:mm[:ss[.SSS]]')
  const parts: MadridDateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0)
  }
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'))
  return localDateTimeToInstant(parts, milliseconds, disambiguation)
}

export function addMadridCalendarDays(instant: Date, days: number) {
  if (!Number.isSafeInteger(days)) throw new RangeError('Calendar-day count must be an integer')
  const current = madridDateTimeParts(instant)
  const targetDate = new Date(Date.UTC(current.year, current.month - 1, current.day + days))
  return localDateTimeToInstant(
    {
      ...current,
      year: targetDate.getUTCFullYear(),
      month: targetDate.getUTCMonth() + 1,
      day: targetDate.getUTCDate()
    },
    instant.getUTCMilliseconds(),
    'earlier'
  )
}

export function madridWeekday(instant: Date) {
  const value = madridDateTimeParts(instant)
  return new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay()
}
