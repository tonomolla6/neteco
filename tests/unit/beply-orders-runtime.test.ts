import { describe, expect, it, vi } from 'vitest'
import {
  beplyOrdersRuntimeProvider,
  consumeBeplyOrdersMessage,
  dispatchConfiguredBeplyOrders
} from '../../workers/integrations/beply-orders-runtime'
import type { BeplyOrderAdapter } from '../../shared/beply-orders'

describe('Beply orders sandbox runtime activation', () => {
  it('has a configured scheduled executor that leaves disabled installations untouched', async () => {
    const touched = vi.fn(() => {
      throw new Error('disabled runtime touched D1')
    })
    const database = { prepare: touched, batch: touched } as unknown as D1Database
    expect(
      await dispatchConfiguredBeplyOrders({ database, fetcher: vi.fn() }, {}, { now: '2026-11-12T10:00:00Z' })
    ).toMatchObject({ disabled: true, completed: 0, published: 0 })
    expect(touched).not.toHaveBeenCalled()
  })
  it('defaults to disabled and does not read credentials or construct a provider', () => {
    const fetcher = vi.fn<typeof fetch>()
    expect(beplyOrdersRuntimeProvider({}, fetcher)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects incomplete or unsafe opt in with a stable sanitized error', () => {
    expect(() =>
      beplyOrdersRuntimeProvider({ BEPLY_ORDERS_ENABLED: 'true', BEPLY_API_TOKEN: 'secret-token' }, vi.fn())
    ).toThrow('beply_orders_configuration_invalid')
    expect(() => beplyOrdersRuntimeProvider({ BEPLY_ORDERS_ENABLED: 'yes' }, vi.fn())).toThrow(
      'beply_orders_configuration_invalid'
    )
  })
  it('creates only an explicitly configured sandbox provider with injected transport', () => {
    const variables = {
      APP_ENV: 'preview',
      BEPLY_ORDERS_ENABLED: 'true',
      BEPLY_BASE_URL: 'https://sandbox.beply.es/api/3',
      BEPLY_API_TOKEN: 'synthetic',
      BEPLY_ORDER_SERIES: 'NE',
      BEPLY_COMPANY_ID: '1',
      BEPLY_PAYMENT_CODE_REDSYS: 'CARD',
      BEPLY_PAYMENT_CODE_BANK_TRANSFER: 'TRANSFER',
      BEPLY_PAYMENT_CODE_CREDIT: 'CREDIT',
      BEPLY_TAX_CODE_0: 'IVA0',
      BEPLY_TAX_CODE_10: 'IVA10',
      BEPLY_TAX_CODE_21: 'IVA21',
      BEPLY_SUPPORT_FILE_ID: '501'
    }
    expect(beplyOrdersRuntimeProvider(variables, vi.fn())).not.toBeNull()
    expect(() => beplyOrdersRuntimeProvider({ ...variables, BEPLY_SUPPORT_FILE_ID: undefined }, vi.fn())).toThrow(
      'beply_orders_configuration_invalid'
    )
    const fetcher = vi.fn<typeof fetch>()
    expect(
      beplyOrdersRuntimeProvider(
        {
          ...variables,
          APP_ENV: 'production',
          BEPLY_ENVIRONMENT: 'production',
          BEPLY_BASE_URL: 'https://neteco.beply.es/api/3'
        },
        fetcher
      )
    ).not.toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    expect(() =>
      beplyOrdersRuntimeProvider({ ...variables, BEPLY_BASE_URL: 'https://neteco.beply.es/api/3' }, vi.fn())
    ).toThrow('beply_orders_configuration_invalid')
  })
  it('prevents sending production order data to a sandbox via runtime flags', () => {
    expect(() =>
      beplyOrdersRuntimeProvider(
        {
          APP_ENV: 'production',
          BEPLY_ORDERS_ENABLED: 'true',
          BEPLY_BASE_URL: 'https://sandbox.beply.es/api/3',
          BEPLY_API_TOKEN: 'synthetic',
          BEPLY_ORDER_SERIES: 'NE',
          BEPLY_COMPANY_ID: '1',
          BEPLY_PAYMENT_CODE_REDSYS: 'CARD',
          BEPLY_PAYMENT_CODE_BANK_TRANSFER: 'TRANSFER',
          BEPLY_PAYMENT_CODE_CREDIT: 'CREDIT',
          BEPLY_TAX_CODE_0: 'IVA0',
          BEPLY_TAX_CODE_10: 'IVA10',
          BEPLY_TAX_CODE_21: 'IVA21'
        },
        vi.fn()
      )
    ).toThrow('beply_orders_configuration_invalid')
  })
  it('does not let malformed/disabled queue input touch D1 or the provider', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database
    const adapter = {} as BeplyOrderAdapter
    expect(
      await consumeBeplyOrdersMessage(db, adapter, { type: 'other' }, { enabled: true, now: '2026-11-12T10:00:00Z' })
    ).toBe('invalid')
    expect(
      await consumeBeplyOrdersMessage(
        db,
        adapter,
        {
          type: 'beply.order.sync',
          schemaVersion: 1,
          orderId: '10000000-0000-4000-8000-000000000010'
        },
        { enabled: false, now: '2026-11-12T10:00:00Z' }
      )
    ).toBe('disabled')
    expect(db.prepare).not.toHaveBeenCalled()
  })
})
