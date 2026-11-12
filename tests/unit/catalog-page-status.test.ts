import { describe, expect, it } from 'vitest'
import { catalogPageFailureStatus } from '../../shared/catalog-page-status'

describe('public catalogue page availability', () => {
  it('renders a confirmed response and treats absent responses as temporary outages', () => {
    expect(catalogPageFailureStatus(null, { id: 'product' })).toBeNull()
    expect(catalogPageFailureStatus(undefined, { roots: [] })).toBeNull()
    expect(catalogPageFailureStatus(null, null)).toBe(503)
    expect(catalogPageFailureStatus(undefined, undefined)).toBe(503)
  })
  it.each([
    new TypeError('network disconnected'),
    { statusCode: 500 },
    { status: 502 },
    { response: { status: 503 } },
    { statusCode: 504, response: { status: 404 } },
    { statusCode: '404' }
  ])('preserves an outage instead of declaring missing content: %j', (error) => {
    expect(catalogPageFailureStatus(error, null)).toBe(503)
    expect(catalogPageFailureStatus(error, { id: 'cached' })).toBe(503)
  })
  it.each([{ statusCode: 404 }, { status: 404 }, { response: { status: 404 } }])(
    'returns 404 only for confirmed missing content: %j',
    (error) => {
      expect(catalogPageFailureStatus(error, null)).toBe(404)
    }
  )
})
