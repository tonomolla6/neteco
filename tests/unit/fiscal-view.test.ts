import { describe, expect, it, vi } from 'vitest'
import { parseFiscalOrderView } from '../../shared/fiscal-view'
import type { FiscalOrderView } from '../../shared/fiscal-issuance'

const ORDER = '30000000-0000-4000-8000-000000000043'
const view = (status: FiscalOrderView['status'] = 'completed'): FiscalOrderView => ({
  orderId: ORDER,
  status,
  intentId: '40000000-0000-4000-8000-000000000043',
  generation: 1,
  provider: 'beply',
  validationOnly: false,
  code: status === 'completed' ? 'WEB-123' : null,
  fiscalStatus: status === 'completed' ? 'issued' : null,
  amountCents: 12100,
  currency: 'EUR',
  pdfAvailable: status === 'completed',
  lastErrorCode: null,
  capabilities: { reconcile: status === 'uncertain', edit: false, issueRetry: false, creditNote: false }
})
describe('confirmed fiscal view boundary', () => {
  it.each(['queued', 'leased', 'issuing', 'uncertain', 'reconciling', 'completed', 'manual_review'] as const)(
    'accepts the %s protocol state without interpreting it as fiscal issuance',
    (state) => expect(parseFiscalOrderView(view(state), ORDER)).toEqual(view(state))
  )
  it('accepts the exact blocked-policy view and pending fiscal status independently of workflow completion', () => {
    expect(
      parseFiscalOrderView(
        {
          ...view(),
          status: 'blocked_policy',
          intentId: null,
          generation: null,
          provider: null,
          amountCents: null,
          code: null,
          fiscalStatus: null,
          pdfAvailable: false
        },
        ORDER
      ).status
    ).toBe('blocked_policy')
    expect(parseFiscalOrderView({ ...view(), fiscalStatus: 'fiscal_pending' }, ORDER).fiscalStatus).toBe(
      'fiscal_pending'
    )
    expect(
      parseFiscalOrderView({ ...view(), provider: 'local_fake', validationOnly: true, pdfAvailable: false }, ORDER)
        .validationOnly
    ).toBe(true)
  })
  it.each(['uncertain', 'reconciling'] as const)(
    'preserves a durable provider receipt after a PDF/completion failure in %s',
    (status) => {
      const existing = { ...view(status), code: 'WEB-123', fiscalStatus: 'issued' as const }
      expect(parseFiscalOrderView(existing, ORDER)).toEqual(existing)
      expect(() => parseFiscalOrderView({ ...existing, code: null }, ORDER)).toThrow()
    }
  )
  it.each([
    { orderId: '30000000-0000-4000-8000-000000000044' },
    { orderId: '../invoice' },
    { currency: 'USD' },
    { pdfAvailable: 'true' },
    { amountCents: 0 },
    { generation: 1.5 },
    { intentId: null },
    { provider: 'local_fake' },
    { validationOnly: true },
    { fiscalStatus: null },
    { code: null },
    { status: 'queued' },
    { token: 'secret' },
    { capabilities: { reconcile: false, edit: false, issueRetry: true, creditNote: false } },
    { capabilities: { reconcile: true, edit: false, issueRetry: false, creditNote: false } }
  ])('rejects contradictory or overprivileged response %#', (patch) => {
    expect(() => parseFiscalOrderView({ ...view(), ...patch }, ORDER)).toThrow()
  })
  it('does not execute response getters, inherited fields or coercion hooks', () => {
    const getter = vi.fn(() => 'completed'),
      payload = view()
    Object.defineProperty(payload, 'status', { enumerable: true, get: getter })
    expect(() => parseFiscalOrderView(payload, ORDER)).toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(() => parseFiscalOrderView(Object.create(view()), ORDER)).toThrow()
  })
})
