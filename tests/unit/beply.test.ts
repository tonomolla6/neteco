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
  taxCode0: 'IVA0',
  taxCode10: 'IVA10',
  taxCode21: 'IVA21',
  paymentCodeRedsys: 'REDSYS',
  paymentCodeBankTransfer: 'TRANSFER',
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
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Token: 'test-token',
        Accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded'
      }
    })
    expect(Object.fromEntries(fetcher.mock.calls[0]![1]?.body as URLSearchParams)).toEqual({
      codcliente: 'NETOMERUUID123456789',
      nombre: 'Cliente de Prueba SL',
      razonsocial: 'Cliente de Prueba SL',
      cifnif: 'B12345674',
      email: 'billing@example.test',
      telefono1: '600000000',
      codpago: 'REDSYS',
      codserie: 'NE',
      observaciones: 'NETECO customer-uuid-123456789'
    })
    expect(fetcher.mock.calls[1]![0]).toBe(
      'https://tenant.beply.es/api/3/contactos?filter[codcliente]=NETOMERUUID123456789&limit=1'
    )
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      method: 'GET',
      headers: { Token: 'test-token', Accept: 'application/json' },
      body: undefined
    })
    expect(fetcher.mock.calls[2]![0]).toBe('https://tenant.beply.es/api/3/contactos')
    expect(Object.fromEntries(fetcher.mock.calls[2]![1]?.body as URLSearchParams)).toEqual({
      codcliente: 'NETOMERUUID123456789',
      nombre: 'Cliente de Prueba SL',
      empresa: 'Cliente de Prueba SL',
      cifnif: 'B12345674',
      direccion: 'Calle Fiscal 1',
      ciudad: 'Ontinyent',
      provincia: 'Valencia',
      codpostal: '46870',
      codpais: 'ESP',
      telefono1: '600000000',
      email: 'billing@example.test',
      descripcion: 'Dirección fiscal NETECO'
    })
    expect(fetcher.mock.calls[3]![0]).toBe('https://tenant.beply.es/api/3/crearFacturaCliente')
    const invoiceBody = fetcher.mock.calls[3]![1]?.body as URLSearchParams
    expect(Object.fromEntries(invoiceBody)).toMatchObject({
      codcliente: 'NETOMERUUID123456789',
      codserie: 'NE',
      codpago: 'REDSYS',
      idempresa: '1',
      fecha: '2026-08-12',
      hora: '12:11:12',
      pagada: '1',
      nombrecliente: 'Cliente de Prueba SL',
      cifnif: 'B12345674',
      direccion: 'Calle Fiscal 1',
      ciudad: 'Ontinyent',
      provincia: 'Valencia',
      codpostal: '46870',
      codpais: 'ESP',
      numero2: 'NE1234567890',
      observaciones: 'NETECO NE1234567890; idempotencia invoice:order-uuid:v1'
    })
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
    expect(provider.name).toBe('beply')
    expect(provider.configuration).toEqual({ ...configuration, baseUrl: 'https://tenant.beply.es/api/3' })
  })

  it('updates an existing fiscal contact and tolerates a duplicate customer response', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('duplicate', { status: 409 }))
      .mockResolvedValueOnce(json([{ idcontacto: 27 }]))
      .mockResolvedValueOnce(json({ ok: true }))
    const provider = new BeplyInvoiceProvider(configuration, fetcher)
    await expect(provider.upsertCustomer(request.customer)).resolves.toBe('NETOMERUUID123456789')
    expect(fetcher.mock.calls[2]![0]).toBe('https://tenant.beply.es/api/3/contactos/27')
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
    expect(body.get('codserie')).toBe('NR')
    expect(body.get('codpais')).toBe('FR')
    expect(body.has('telefono1')).toBe(false)
  })

  it('maps supported tax rates and bank transfer to explicit Beply codes', async () => {
    const fetcher = issueFetcher()
    const provider = new BeplyInvoiceProvider(configuration, fetcher)
    await provider.issueInvoice({
      ...request,
      paymentMethod: 'bank_transfer',
      shippingNetCents: 0,
      lines: [
        { ...request.lines[0]!, sku: 'ZERO', taxRateBasisPoints: 0 },
        { ...request.lines[0]!, sku: 'TEN', taxRateBasisPoints: 1000 }
      ]
    })
    const body = fetcher.mock.calls[3]![1]?.body as URLSearchParams
    expect(body.get('codpago')).toBe('TRANSFER')
    expect(JSON.parse(body.get('lineas')!)).toEqual([
      expect.objectContaining({ referencia: 'ZERO', codimpuesto: 'IVA0', iva: 0 }),
      expect.objectContaining({ referencia: 'TEN', codimpuesto: 'IVA10', iva: 10 })
    ])

    await expect(
      new BeplyInvoiceProvider(configuration, issueFetcher()).issueInvoice({
        ...request,
        shippingNetCents: 0,
        lines: [{ ...request.lines[0]!, taxRateBasisPoints: 400 }]
      })
    ).rejects.toThrow('Unsupported Beply tax rate')
  })

  it('marks an invoice paid and retrieves a validated PDF', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nvalid')
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }))
    const provider = new BeplyInvoiceProvider(configuration, fetcher)
    await expect(provider.markPaid('15', '2026-10-25T00:30:00.000Z', 'redsys')).resolves.toBeUndefined()
    await expect(provider.downloadPdf('15')).resolves.toEqual(bytes)
    expect(fetcher.mock.calls[0]![0]).toContain('pagarFacturaCliente/15')
    expect(Object.fromEntries(fetcher.mock.calls[0]![1]?.body as URLSearchParams)).toEqual({
      fechapago: '2026-10-25',
      codpago: 'REDSYS',
      pagada: '1'
    })
    expect(fetcher.mock.calls[1]![0]).toBe(
      'https://tenant.beply.es/api/3/exportarFacturaCliente/15?type=PDF&lang=es_ES'
    )
    expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ Accept: 'application/pdf' })
  })

  it('marks a bank transfer with its configured fiscal payment code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ ok: true }))
    const provider = new BeplyInvoiceProvider(configuration, fetcher)
    await expect(provider.markPaid('16', request.issuedOn, 'bank_transfer')).resolves.toBeUndefined()
    expect(Object.fromEntries(fetcher.mock.calls[0]![1]?.body as URLSearchParams)).toMatchObject({
      codpago: 'TRANSFER'
    })
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
    const result = provider.markPaid('15', request.issuedOn, 'redsys')
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
    await expect(transport.markPaid('15', request.issuedOn, 'redsys')).rejects.toMatchObject({
      category: 'transport',
      retryable: true,
      status: 0
    })
    const unknownTransport = new BeplyInvoiceProvider(configuration, vi.fn<typeof fetch>().mockRejectedValue('offline'))
    await expect(unknownTransport.markPaid('15', request.issuedOn, 'redsys')).rejects.toMatchObject({ body: 'unknown' })
    const invalidPdf = new BeplyInvoiceProvider(
      configuration,
      vi.fn<typeof fetch>().mockResolvedValue(new Response('html', { status: 200 }))
    )
    await expect(invalidPdf.downloadPdf('15')).rejects.toBeInstanceOf(BeplyError)
  })

  it('blocks private DNS resolution and redirects in the real provider request flow', async () => {
    const privateFetcher = vi.fn<typeof fetch>()
    const privateTarget = new BeplyInvoiceProvider(configuration, privateFetcher, {
      allowedDomainSuffixes: ['beply.es'],
      resolver: async () => ['127.0.0.1']
    })
    await expect(privateTarget.markPaid('15', request.issuedOn, 'redsys')).rejects.toMatchObject({
      category: 'transport',
      retryable: true
    })
    expect(privateFetcher).not.toHaveBeenCalled()

    const redirectFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
    const redirecting = new BeplyInvoiceProvider(configuration, redirectFetcher, {
      allowedDomainSuffixes: ['beply.es'],
      resolver: async () => ['8.8.8.8']
    })
    await expect(redirecting.markPaid('15', request.issuedOn, 'redsys')).rejects.toMatchObject({ status: 302 })
    expect(redirectFetcher).toHaveBeenCalledTimes(1)
    expect(redirectFetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error' })

    const pdfFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('%PDF-1.7\nvalid', { headers: { 'content-type': 'application/pdf' } }))
    const publicTargetWithQuery = new BeplyInvoiceProvider(configuration, pdfFetcher, {
      allowedDomainSuffixes: ['beply.es'],
      resolver: async () => ['8.8.8.8']
    })
    await expect(publicTargetWithQuery.downloadPdf('15')).resolves.toEqual(expect.any(Uint8Array))
    expect(pdfFetcher.mock.calls[0]![0]).toBe(
      'https://tenant.beply.es/api/3/exportarFacturaCliente/15?type=PDF&lang=es_ES'
    )
    expect(pdfFetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error' })
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
    expect(provider.name).toBe('mock')
    expect(await provider.upsertCustomer(request.customer)).toBe('CUS-1AB0A5C09155')
    await expect(provider.issueInvoice(request)).resolves.toEqual({
      providerId: 'INV-6B671FA19A8E',
      code: 'NE-09218CC55CE3',
      status: 'issued',
      amountCents: 3025
    })
    await expect(
      provider.issueCreditNote({
        ...request,
        sourceProviderInvoiceId: '15',
        reason: 'return'
      })
    ).resolves.toEqual({
      providerId: 'CRN-6B671FA19A8E',
      code: 'RECT-6CB8189588CC',
      status: 'issued',
      amountCents: 3025
    })
    await expect(
      provider.issueInvoice({
        ...request,
        lines: [{ ...request.lines[0]!, discountNetCents: 100 }]
      })
    ).resolves.toMatchObject({ amountCents: 2904 })
    expect(new TextDecoder().decode(await provider.downloadPdf('15'))).toBe(
      '%PDF-1.4\n% NETECO synthetic invoice 15\n%%EOF'
    )
    await expect(provider.markPaid('15', request.issuedOn, 'redsys')).resolves.toBeUndefined()
  })

  it('selects only permitted providers per environment', () => {
    expect(invoiceProviderFromEnvironment({})).toBeInstanceOf(MockInvoiceProvider)
    expect(invoiceProviderFromEnvironment({ APP_ENV: 'local', INVOICE_PROVIDER: 'mock' })).toBeInstanceOf(
      MockInvoiceProvider
    )
    const production = invoiceProviderFromEnvironment({
      APP_ENV: 'production',
      INVOICE_PROVIDER: 'beply',
      BEPLY_BASE_URL: configuration.baseUrl,
      BEPLY_API_TOKEN: configuration.token,
      BEPLY_INVOICE_SERIES: configuration.invoiceSeries,
      BEPLY_CORRECTIVE_SERIES: configuration.correctiveSeries,
      BEPLY_TAX_CODE_0: configuration.taxCode0,
      BEPLY_TAX_CODE_10: configuration.taxCode10,
      BEPLY_TAX_CODE_21: configuration.taxCode21,
      BEPLY_PAYMENT_CODE_REDSYS: configuration.paymentCodeRedsys,
      BEPLY_PAYMENT_CODE_BANK_TRANSFER: configuration.paymentCodeBankTransfer,
      BEPLY_COMPANY_ID: configuration.companyId
    })
    expect(production).toBeInstanceOf(BeplyInvoiceProvider)
    expect((production as BeplyInvoiceProvider).configuration).toMatchObject({
      baseUrl: 'https://tenant.beply.es/api/3',
      token: 'test-token',
      invoiceSeries: 'NE',
      correctiveSeries: 'NR',
      taxCode21: 'IVA21',
      paymentCodeRedsys: 'REDSYS',
      companyId: '1'
    })
    expect(() => invoiceProviderFromEnvironment({ APP_ENV: 'production', INVOICE_PROVIDER: 'mock' })).toThrow(
      'must be beply'
    )
    expect(() => invoiceProviderFromEnvironment({ APP_ENV: 'production', INVOICE_PROVIDER: 'beply' })).toThrow()
    expect(() =>
      invoiceProviderFromEnvironment({
        APP_ENV: 'production',
        INVOICE_PROVIDER: 'beply',
        BEPLY_BASE_URL: 'https://169.254.169.254/latest/meta-data',
        BEPLY_API_TOKEN: configuration.token,
        BEPLY_INVOICE_SERIES: configuration.invoiceSeries,
        BEPLY_CORRECTIVE_SERIES: configuration.correctiveSeries,
        BEPLY_TAX_CODE_0: configuration.taxCode0,
        BEPLY_TAX_CODE_10: configuration.taxCode10,
        BEPLY_TAX_CODE_21: configuration.taxCode21,
        BEPLY_PAYMENT_CODE_REDSYS: configuration.paymentCodeRedsys,
        BEPLY_PAYMENT_CODE_BANK_TRANSFER: configuration.paymentCodeBankTransfer,
        BEPLY_COMPANY_ID: configuration.companyId
      })
    ).toThrow('local or private network')
    expect(() =>
      invoiceProviderFromEnvironment({
        APP_ENV: 'production',
        INVOICE_PROVIDER: 'beply',
        BEPLY_BASE_URL: 'https://attacker.invalid/beply-proxy',
        BEPLY_API_TOKEN: configuration.token,
        BEPLY_INVOICE_SERIES: configuration.invoiceSeries,
        BEPLY_CORRECTIVE_SERIES: configuration.correctiveSeries,
        BEPLY_TAX_CODE_0: configuration.taxCode0,
        BEPLY_TAX_CODE_10: configuration.taxCode10,
        BEPLY_TAX_CODE_21: configuration.taxCode21,
        BEPLY_PAYMENT_CODE_REDSYS: configuration.paymentCodeRedsys,
        BEPLY_PAYMENT_CODE_BANK_TRANSFER: configuration.paymentCodeBankTransfer,
        BEPLY_COMPANY_ID: configuration.companyId
      })
    ).toThrow('allowlist')
  })
})
