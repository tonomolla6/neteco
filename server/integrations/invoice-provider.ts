export interface FiscalCustomer {
  externalKey: string
  legalName: string
  taxId?: string
  email: string
  phone?: string
  address: { line1: string; postalCode: string; city: string; region: string; countryCode: string }
}

export interface InvoiceLine {
  sku: string
  description: string
  quantity: number
  unitNetCents: number
  lineNetCents: number
  discountNetCents: number
  taxRateBasisPoints: number
}

export interface IssueInvoiceRequest {
  orderId: string
  orderNumber: string
  series: string
  issuedOn: string
  customer: FiscalCustomer
  lines: InvoiceLine[]
  shippingNetCents: number
  currency: 'EUR'
  paymentMethod?: 'redsys' | 'bank_transfer'
  idempotencyKey: string
}

export interface ProviderInvoice {
  providerId: string
  code: string
  status: 'issued' | 'fiscal_pending'
  amountCents: number
}

export interface InvoiceProvider {
  readonly name: string
  upsertCustomer(customer: FiscalCustomer): Promise<string>
  issueInvoice(request: IssueInvoiceRequest): Promise<ProviderInvoice>
  downloadPdf(providerInvoiceId: string): Promise<Uint8Array>
  issueCreditNote(
    request: IssueInvoiceRequest & { sourceProviderInvoiceId: string; reason: string }
  ): Promise<ProviderInvoice>
  markPaid(
    providerInvoiceId: string,
    paidOn: string,
    paymentMethod: NonNullable<IssueInvoiceRequest['paymentMethod']>
  ): Promise<void>
}
