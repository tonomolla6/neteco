import { describe, expect, it, vi } from 'vitest'
import { BeplyError, BeplyInvoiceProvider } from '../../server/integrations/beply'
import { invoiceProviderFromEnvironment } from '../../server/integrations/invoice-factory'
import type { IssueInvoiceRequest } from '../../server/integrations/invoice-provider'
import { MockInvoiceProvider } from '../../server/integrations/mock-invoice'

const configuration = {
  baseUrl: 'https://tenant.beply.es/api/3/',
  token: 'test-token',
  invoiceSeries: 'NE',
  correctiveSeries: 'NR',
  taxCode21: 'IVA21',
  paymentCodeRedsys: 'REDSYS',
  companyId: '1',
  timeoutMs: 2_000
}

const request: IssueInvoiceRequest = {
  orderId: 'order-uuid',
  orderNumber: 'NE1234567890',
  series: 'NE',
  issuedOn: '2026-08-12T10:11:12.000Z',
  customer: {
    externalKey: 'customer-uuid-123456789',
    legalName: 'Cliente de Prueba SL',
    taxId: 'B12345674',
    email: 'billing@example.test',
    phone: '600000000',
    address: {
      line1: 'Calle Fiscal 1',
      postalCode: '46870',
      city: 'Ontinyent',
      region: 'Valencia',
      countryCode: 'ES'
    }
  },
  lines: [
    {
      sku: 'SKU-1',
      description: 'Producto de prueba',
      quantity: 2,
      unitNetCents: 1000,
      lineNetCents: 2000,
      discountNetCents: 0,
      taxRateBasisPoints: 2100
    }
  ],
  shippingNetCents: 500,
  currency: 'EUR',
  idempotencyKey: 'invoice:order-uuid:v1'
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function issueFetcher(document: unknown = { idfactura: 15, codigo: 'FAC2026NE15', total: 30.25 }) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ ok: true }, 201))
    .mockResolvedValueOnce(json([]))
    .mockResolvedValueOnce(json({ idcontacto: 1 }, 201))
    .mockResolvedValueOnce(json(document, 201))
}

describe('Beply invoice provider', () => {
  it('upserts customer and issues a form-encoded high-level invoice from snapshots', async () => {
    const fetcher = issueFetcher()
    const provider = new BeplyInvoiceProvider(configuration, fetcher)
    await expect(provider.issueInvoice(request)).resolves.toEqual({
      providerId: '15',
      code: 'FAC2026NE15',
      status: 'issued',
      amountCents: 3025
    })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls[0]![0]).toBe('https://tenant.beply.es/api/3/clientes')
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ Token: 'test-token' })
    const invoiceBody = fetcher.mock.calls[3]![1]?.body as URLSearchParams
    expect(invoiceBody.get('codcliente')).toMatch(/^NE/)
    expect(invoiceBody.get('codserie')).toBe('NE')
    expect(invoiceBody.get('codpago')).toBe('REDSYS')
    expect(invoiceBody.get('idempresa')).toBe('1')
    expect(JSON.parse(invoiceBody.get('lineas')!)).toEqual([
      expect.objectContaining({
        referencia: 'SKU-1',
        cantidad: 2,
        pvpunitario: 10,
        codimpuesto: 'IVA21',
        iva: 21
      }),
      expect.objectContaining({ referencia: 'ENVIO', pvpunitario: 5 })
    ])
    expect(invoiceBody.get('numero2')).toBe('NE1234567890')
  })

  it('updates an existing fiscal contact and tolerates a duplicate customer response', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('duplicate', { status: 409 }))
      .mockResolvedValueOnce(json([{ idcontacto: 27 }]))
      .mockResolvedValueOnce(json({ ok: true }))
    const provider = new BeplyInvoiceProvider(configuration, fetcher)
    await expect(provider.upsertCustomer(request.customer)).resolves.toMatch(/^NE/)
    expect(fetcher.mock.calls[2]![0]).toContain('/contactos/27')
    expect(fetcher.mock.calls[2]![1]?.method).toBe('PUT')
  })

  it('issues a linked rectifying invoice with its own series', async () => {
    const fetcher = issueFetcher({ data: { idfactura: '16', codserie: 'NR' } })
    const provider = new BeplyInvoiceProvider(configuration, fetcher)
    await expect(
      provider.issueCreditNote({
        ...request,
        customer: {
          ...request.customer,
          phone: undefined,
          address: { ...request.customer.address, countryCode: 'fr' }
        },
        shippingNetCents: 0,
        sourceProviderInvoiceId: '15',
        reason: 'Devolución parcial'
      })
    ).resolves.toMatchObject({ providerId: '16', code: 'NR-16', amountCents: 0 })
    expect(fetcher.mock.calls[3]![0]).toContain('crearFacturaRectificativaCliente')
    const body = fetcher.mock.calls[3]![1]?.body as URLSearchParams
    expect(body.get('idfacturaoriginal')).toBe('15')
    expect(body.get('motivo')).toBe('Devolución parcial')
    expect(JSON.parse(body.get('lineas')!)).toHaveLength(1)
  })

  it('marks an invoice paid and retrieves a validated PDF', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nvalid')
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }))
    const provider = new BeplyInvoiceProvider(configuration, fetcher)
    await expect(provider.markPaid('15', '2026-10-25T00:30:00.000Z')).resolves.toBeUndefined()
    await expect(provider.downloadPdf('15')).resolves.toEqual(bytes)
    expect(fetcher.mock.calls[0]![0]).toContain('pagarFacturaCliente/15')
    expect(fetcher.mock.calls[1]![0]).toContain('exportarFacturaCliente/15?type=PDF')
  })

  it.each([
    [400, 'validation', false],
    [401, 'credentials', false],
    [403, 'credentials', false],
    [404, 'not_found', false],
    [409, 'duplicate', false],
    [422, 'validation', false],
    [429, 'provider', true],
    [500, 'provider', true],
    [418, 'provider', false]
  ] as const)('normalizes HTTP %s errors as %s', async (status, category, retryable) => {
    const provider = new BeplyInvoiceProvider(
      configuration,
      vi.fn<typeof fetch>().mockResolvedValue(new Response('provider body', { status }))
    )
    const result = provider.markPaid('15', request.issuedOn)
    await expect(result).rejects.toMatchObject({
      name: 'BeplyError',
      status,
      category,
      retryable,
      body: 'provider body'
    })
  })

  it('normalizes transport failures and rejects invalid PDFs', async () => {
    const transport = new BeplyInvoiceProvider(
      configuration,
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    )
    await expect(transport.markPaid('15', request.issuedOn)).rejects.toMatchObject({
      category: 'transport',
      retryable: true,
      status: 0
    })
    const unknownTransport = new BeplyInvoiceProvider(configuration, vi.fn<typeof fetch>().mockRejectedValue('offline'))
    await expect(unknownTransport.markPaid('15', request.issuedOn)).rejects.toMatchObject({ body: 'unknown' })
    const invalidPdf = new BeplyInvoiceProvider(
      configuration,
      vi.fn<typeof fetch>().mockResolvedValue(new Response('html', { status: 200 }))
    )
    await expect(invalidPdf.downloadPdf('15')).rejects.toBeInstanceOf(BeplyError)
  })

  it('validates configuration and document responses', async () => {
    expect(() => new BeplyInvoiceProvider({ ...configuration, token: '' })).toThrow()
    await expect(
      new BeplyInvoiceProvider(configuration, issueFetcher({ invalid: true })).issueInvoice(request)
    ).rejects.toThrow()
    await expect(
      new BeplyInvoiceProvider(configuration, issueFetcher()).issueInvoice({
        ...request,
        issuedOn: 'invalid-date'
      })
    ).rejects.toThrow('date')
  })

  it('does not suppress non-duplicate errors while creating a customer', async () => {
    const broken = new Response('error', { status: 500 })
    vi.spyOn(broken, 'text').mockRejectedValue(new Error('body unavailable'))
    const provider = new BeplyInvoiceProvider(configuration, vi.fn<typeof fetch>().mockResolvedValue(broken))
    await expect(provider.upsertCustomer(request.customer)).rejects.toThrow('body unavailable')
  })
})

describe('invoice providers and factory', () => {
  it('provides a deterministic local fake for invoices, credits and PDFs', async () => {
    const provider = new MockInvoiceProvider()
    expect(await provider.upsertCustomer(request.customer)).toMatch(/^CUS-/)
    await expect(provider.issueInvoice(request)).resolves.toMatchObject({
      providerId: expect.stringMatching(/^INV-/),
      code: expect.stringMatching(/^NE-/),
      amountCents: 3025
    })
    await expect(
      provider.issueCreditNote({
        ...request,
        sourceProviderInvoiceId: '15',
        reason: 'return'
      })
    ).resolves.toMatchObject({ providerId: expect.stringMatching(/^CRN-/), amountCents: 3025 })
    expect(new TextDecoder().decode(await provider.downloadPdf('15'))).toContain('%PDF-1.4')
    await expect(provider.markPaid('15', request.issuedOn)).resolves.toBeUndefined()
  })

  it('selects only permitted providers per environment', () => {
    expect(invoiceProviderFromEnvironment({})).toBeInstanceOf(MockInvoiceProvider)
    expect(invoiceProviderFromEnvironment({ APP_ENV: 'local', INVOICE_PROVIDER: 'mock' })).toBeInstanceOf(
      MockInvoiceProvider
    )
    expect(
      invoiceProviderFromEnvironment({
        APP_ENV: 'production',
        INVOICE_PROVIDER: 'beply',
        BEPLY_BASE_URL: configuration.baseUrl,
        BEPLY_API_TOKEN: configuration.token,
        BEPLY_INVOICE_SERIES: configuration.invoiceSeries,
        BEPLY_CORRECTIVE_SERIES: configuration.correctiveSeries,
        BEPLY_TAX_CODE_21: configuration.taxCode21,
        BEPLY_PAYMENT_CODE_REDSYS: configuration.paymentCodeRedsys,
        BEPLY_COMPANY_ID: configuration.companyId
      })
    ).toBeInstanceOf(BeplyInvoiceProvider)
    expect(() => invoiceProviderFromEnvironment({ APP_ENV: 'production', INVOICE_PROVIDER: 'mock' })).toThrow(
      'must be beply'
    )
    expect(() => invoiceProviderFromEnvironment({ APP_ENV: 'production', INVOICE_PROVIDER: 'beply' })).toThrow()
  })
})
