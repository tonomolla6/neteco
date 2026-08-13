import { createHash, randomUUID } from 'node:crypto'
import { BeplyInvoiceProvider } from '../server/integrations/beply'
import type { IssueInvoiceRequest } from '../server/integrations/invoice-provider'

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the opt-in Beply sandbox contract`)
  return value
}

if (process.env.BEPLY_CONTRACT_SANDBOX !== '1') {
  throw new Error('Set BEPLY_CONTRACT_SANDBOX=1 to acknowledge fiscal writes in the Beply test tenant')
}
if (process.env.APP_ENV === 'production') throw new Error('The Beply sandbox contract cannot run in production')
const baseUrl = new URL(required('BEPLY_BASE_URL'))
if (baseUrl.protocol !== 'https:') throw new Error('The Beply sandbox contract requires HTTPS')

const provider = new BeplyInvoiceProvider({
  baseUrl: baseUrl.toString(),
  token: required('BEPLY_API_TOKEN'),
  invoiceSeries: required('BEPLY_INVOICE_SERIES'),
  correctiveSeries: required('BEPLY_CORRECTIVE_SERIES'),
  taxCode0: required('BEPLY_TAX_CODE_0'),
  taxCode10: required('BEPLY_TAX_CODE_10'),
  taxCode21: required('BEPLY_TAX_CODE_21'),
  paymentCodeRedsys: required('BEPLY_PAYMENT_CODE_REDSYS'),
  paymentCodeBankTransfer: required('BEPLY_PAYMENT_CODE_BANK_TRANSFER'),
  companyId: required('BEPLY_COMPANY_ID')
})
const runId = randomUUID()
const orderNumber = `NETECO${runId.replaceAll('-', '').slice(0, 10).toUpperCase()}`
const request: IssueInvoiceRequest = {
  orderId: runId,
  orderNumber,
  series: required('BEPLY_INVOICE_SERIES'),
  issuedOn: new Date().toISOString(),
  customer: {
    externalKey: `contract-${runId}`,
    legalName: 'NETECO Contrato Sandbox',
    taxId: undefined,
    email: `contract+${runId}@example.invalid`,
    phone: undefined,
    address: {
      line1: 'Dirección sintética de pruebas 1',
      postalCode: '46800',
      city: 'Xàtiva',
      region: 'Valencia',
      countryCode: 'ES'
    }
  },
  lines: [
    {
      sku: 'CONTRACT-IVA21',
      description: 'Línea sintética de contrato',
      quantity: 1,
      unitNetCents: 100,
      lineNetCents: 100,
      discountNetCents: 0,
      taxRateBasisPoints: 2100
    }
  ],
  shippingNetCents: 0,
  currency: 'EUR',
  paymentMethod: 'redsys',
  idempotencyKey: `beply-contract:${runId}`
}
const invoice = await provider.issueInvoice(request)
await provider.markPaid(invoice.providerId, request.issuedOn, 'redsys')
const invoicePdf = await provider.downloadPdf(invoice.providerId)
const credit = await provider.issueCreditNote({
  ...request,
  orderNumber: `${orderNumber}-R`,
  idempotencyKey: `beply-contract-credit:${runId}`,
  sourceProviderInvoiceId: invoice.providerId,
  reason: 'Rectificación sintética del contrato sandbox'
})
const creditPdf = await provider.downloadPdf(credit.providerId)

process.stdout.write(
  `${JSON.stringify({
    event: 'beply.sandbox.contract.completed',
    invoice: {
      providerId: invoice.providerId,
      code: invoice.code,
      pdfChecksum: createHash('sha256').update(invoicePdf).digest('hex')
    },
    credit: {
      providerId: credit.providerId,
      code: credit.code,
      pdfChecksum: createHash('sha256').update(creditPdf).digest('hex')
    }
  })}\n`
)
