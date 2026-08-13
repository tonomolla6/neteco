import { createHash } from 'node:crypto'
import type { FiscalCustomer, InvoiceProvider, IssueInvoiceRequest, ProviderInvoice } from './invoice-provider'

function reference(value: string, prefix: string) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12).toUpperCase()}`
}

function amount(request: IssueInvoiceRequest) {
  const net = request.lines.reduce((total, line) => total + line.lineNetCents - line.discountNetCents, 0)
  const tax = request.lines.reduce(
    (total, line) =>
      total + Math.round(((line.lineNetCents - line.discountNetCents) * line.taxRateBasisPoints) / 10_000),
    0
  )
  const shippingTax = Math.round((request.shippingNetCents * 2100) / 10_000)
  return net + tax + request.shippingNetCents + shippingTax
}

export class MockInvoiceProvider implements InvoiceProvider {
  readonly name = 'mock'

  async upsertCustomer(customer: FiscalCustomer) {
    return reference(customer.externalKey, 'CUS')
  }

  async issueInvoice(request: IssueInvoiceRequest): Promise<ProviderInvoice> {
    return {
      providerId: reference(request.idempotencyKey, 'INV'),
      code: reference(request.orderNumber, request.series),
      status: 'issued',
      amountCents: amount(request)
    }
  }

  async issueCreditNote(
    request: IssueInvoiceRequest & { sourceProviderInvoiceId: string; reason: string }
  ): Promise<ProviderInvoice> {
    return {
      providerId: reference(request.idempotencyKey, 'CRN'),
      code: reference(`${request.sourceProviderInvoiceId}:${request.reason}`, 'RECT'),
      status: 'issued',
      amountCents: amount(request)
    }
  }

  async downloadPdf(providerInvoiceId: string) {
    return new TextEncoder().encode(`%PDF-1.4\n% NETECO synthetic invoice ${providerInvoiceId}\n%%EOF`)
  }

  async markPaid(
    _providerInvoiceId: string,
    _paidOn: string,
    _paymentMethod: NonNullable<IssueInvoiceRequest['paymentMethod']>
  ) {}
}
