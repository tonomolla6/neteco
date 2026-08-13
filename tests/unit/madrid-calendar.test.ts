import { describe, expect, it } from 'vitest'
import {
  addMadridCalendarDays,
  BUSINESS_TIME_ZONE,
  madridDateKey,
  madridDateTimeParts,
  madridLocalDateTimeToInstant,
  madridTimeKey,
  madridWeekday
} from '../../server/utils/madrid-calendar'

describe('Europe/Madrid business calendar', () => {
  it('makes the business timezone explicit and crosses local midnight correctly', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Europe/Madrid')
    expect(madridDateKey(new Date('2026-03-28T22:59:59Z'))).toBe('2026-03-28')
    expect(madridDateKey(new Date('2026-03-28T23:00:00Z'))).toBe('2026-03-29')
    expect(madridTimeKey(new Date('2026-03-28T23:00:00Z'))).toBe('00:00:00')
  })

  it('handles the missing and repeated DST hours as instants', () => {
    expect(madridDateTimeParts(new Date('2026-03-29T00:59:59Z'))).toMatchObject({ hour: 1, minute: 59 })
    expect(madridDateTimeParts(new Date('2026-03-29T01:00:00Z'))).toMatchObject({ hour: 3, minute: 0 })
    expect(madridDateTimeParts(new Date('2026-10-25T00:30:00Z'))).toMatchObject({ hour: 2, minute: 30 })
    expect(madridDateTimeParts(new Date('2026-10-25T01:30:00Z'))).toMatchObject({ hour: 2, minute: 30 })
    expect(madridLocalDateTimeToInstant('2026-10-25T02:30', 'earlier').toISOString()).toBe('2026-10-25T00:30:00.000Z')
    expect(madridLocalDateTimeToInstant('2026-10-25T02:30', 'later').toISOString()).toBe('2026-10-25T01:30:00.000Z')
    expect(() => madridLocalDateTimeToInstant('2026-10-25T02:30')).toThrow('repeated')
    expect(() => madridLocalDateTimeToInstant('2026-03-29T02:30', 'later')).toThrow('does not exist')
  })

  it('preserves local wall time when adding dates across DST', () => {
    expect(addMadridCalendarDays(new Date('2026-03-28T11:00:00Z'), 2).toISOString()).toBe('2026-03-30T10:00:00.000Z')
    expect(addMadridCalendarDays(new Date('2026-10-24T10:00:00Z'), 2).toISOString()).toBe('2026-10-26T11:00:00.000Z')
    expect(madridWeekday(new Date('2026-03-30T10:00:00Z'))).toBe(1)
  })

  it('rejects invalid instants and fractional calendar days', () => {
    expect(() => madridDateKey(new Date('invalid'))).toThrow('Invalid calendar instant')
    expect(() => addMadridCalendarDays(new Date('2026-08-13T12:00:00Z'), 1.5)).toThrow('integer')
    expect(() => madridLocalDateTimeToInstant('2026-02-30T12:00')).toThrow('does not exist')
  })
})
