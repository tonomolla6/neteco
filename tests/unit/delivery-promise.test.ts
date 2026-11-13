import { describe, expect, it } from 'vitest'
import {
  deliveryPromise,
  formatPromiseCondition,
  formatPromiseHeadline,
  madridToday,
  parseParcelLeadDays,
  parseRouteWeekdays
} from '../../shared/delivery-promise'

const terms = { ownDeliveryDays: 'martes y jueves (Ontinyent)', orderCutoffTime: '13:00', parcelLeadTime: '24-72 h' }
const promise = (now: string, extra: Partial<Parameters<typeof deliveryPromise>[0]> = {}) =>
  deliveryPromise({ now: new Date(now), terms, postalCode: '46870', ...extra })

describe('delivery promises use the configured Madrid business calendar', () => {
  it('uses the next own route before cutoff with a real countdown', () => {
    const result = promise('2026-11-16T09:00:00Z')!
    expect(result).toMatchObject({
      method: 'own_delivery',
      from: '2026-11-17',
      to: '2026-11-17',
      orderDay: '2026-11-16'
    })
    expect(result.cutoff).toEqual({ time: '13:00', minutesLeft: 180 })
    expect(formatPromiseHeadline(result, '2026-11-16')).toBe('Te llega mañana, martes 17')
    expect(formatPromiseCondition(result)).toContain('3 h 00 min')
  })

  it.each(['2026-11-16T12:00:00Z', '2026-11-16T12:01:00Z'])(
    'at or after cutoff (%s), moves intake to the next business day',
    (now) => {
      expect(promise(now)).toMatchObject({ orderDay: '2026-11-17', from: '2026-11-19', cutoff: null })
    }
  )

  it('uses agency business days outside the own-delivery area', () => {
    const result = promise('2026-11-13T09:00:00Z', { postalCode: '28001' })!
    expect(result).toMatchObject({ method: 'parcel', from: '2026-11-16', to: '2026-11-18', destinationKnown: true })
    expect(formatPromiseHeadline(result)).toBe('Te llega entre el lunes 16 y el miércoles 18')
  })

  it.each([null, '', '4687', 'abcde'])(
    'uses the agency without claiming a known invalid destination %s',
    (postalCode) => {
      expect(promise('2026-11-16T09:00:00Z', { postalCode })).toMatchObject({
        method: 'parcel',
        destinationKnown: false
      })
    }
  )

  it('respects configured own-delivery prefixes and extra preparation days', () => {
    expect(promise('2026-11-16T09:00:00Z', { ownDeliveryPrefixes: ['28'] })?.method).toBe('parcel')
    expect(promise('2026-11-16T09:00:00Z', { preparationDays: 2 })?.from).toBe('2026-11-19')
    expect(promise('2026-11-16T09:00:00Z', { preparationDays: 3 })?.from).toBe('2026-11-24')
  })

  it('skips closures in both order intake and delivery', () => {
    expect(promise('2026-11-16T09:00:00Z', { closedDates: ['2026-11-17'] })?.from).toBe('2026-11-19')
    expect(
      promise('2026-11-16T09:00:00Z', { postalCode: '28001', closedDates: ['2026-11-16', '2026-11-18'] })
    ).toMatchObject({ orderDay: '2026-11-17', from: '2026-11-19', to: '2026-11-23' })
  })

  it('never promises a closed route day when the bounded search finds no available route', () => {
    const closedDates = Array.from({ length: 35 }, (_, index) =>
      new Date(Date.UTC(2026, 10, 17 + index)).toISOString().slice(0, 10)
    )
    expect(promise('2026-11-16T09:00:00Z', { closedDates })).toBeNull()
  })

  it.each(['25:00', '13:99', 'invalid', ''])(
    'does not claim a cutoff with invalid configured time %s',
    (orderCutoffTime) => {
      const result = promise('2026-11-16T09:00:00Z', { terms: { ...terms, orderCutoffTime } })!
      expect(result.cutoff).toBeNull()
      expect(result.orderDay).toBe('2026-11-17')
    }
  )

  it('does not promise a date without configured routes or an intelligible agency lead time', () => {
    expect(promise('2026-11-16T09:00:00Z', { terms: { ...terms, ownDeliveryDays: '', parcelLeadTime: '' } })).toBeNull()
  })

  it('handles summer time and midnight in Madrid', () => {
    expect(madridToday(new Date('2026-07-06T22:30:00Z'))).toBe('2026-07-07')
    expect(promise('2026-07-06T10:00:00Z')?.cutoff?.minutesLeft).toBe(60)
  })
})

describe('delivery configuration parsers', () => {
  it.each([
    ['martes y jueves', [2, 4]],
    ['de lunes a viernes', [1, 2, 3, 4, 5]],
    ['miércoles, sábado y miércoles', [3, 6]],
    ['de viernes a lunes', [1, 5, 6, 7]],
    ['consultar reparto', []]
  ])('parses route days %s', (text, expected) => expect(parseRouteWeekdays(text as string)).toEqual(expected))

  it.each([
    ['24-72 h', [1, 3]],
    ['48 horas', [2, 2]],
    ['2–3 días', [2, 3]],
    ['3 a 5 días', [3, 5]],
    ['72-24 h', null],
    ['999 días', null],
    ['consultar', null]
  ])('parses agency lead time %s', (text, expected) => expect(parseParcelLeadDays(text as string)).toEqual(expected))
})
