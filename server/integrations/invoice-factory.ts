import type { InvoiceProvider } from './invoice-provider'
import { BeplyInvoiceProvider } from './beply'
import { MockInvoiceProvider } from './mock-invoice'

export function invoiceProviderFromEnvironment(environment: NodeJS.ProcessEnv = process.env): InvoiceProvider {
  const provider = environment.INVOICE_PROVIDER ?? 'mock'
  if (provider === 'mock' && environment.APP_ENV !== 'production') return new MockInvoiceProvider()
  if (provider !== 'beply') throw new Error('Production invoice provider must be beply')
  return new BeplyInvoiceProvider({
    baseUrl: environment.BEPLY_BASE_URL ?? '',
    token: environment.BEPLY_API_TOKEN ?? '',
    invoiceSeries: environment.BEPLY_INVOICE_SERIES ?? '',
    correctiveSeries: environment.BEPLY_CORRECTIVE_SERIES ?? '',
    taxCode21: environment.BEPLY_TAX_CODE_21 ?? '',
    paymentCodeRedsys: environment.BEPLY_PAYMENT_CODE_REDSYS ?? '',
    companyId: environment.BEPLY_COMPANY_ID ?? ''
  })
}
