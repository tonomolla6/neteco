import { z } from 'zod'
import type { FiscalCustomer, InvoiceProvider, IssueInvoiceRequest, ProviderInvoice } from './invoice-provider'

type Fetcher = typeof globalThis.fetch

export interface BeplyConfiguration {
  baseUrl: string
  token: string
  invoiceSeries: string
  correctiveSeries: string
  taxCode21: string
  paymentCodeRedsys: string
  companyId: string
  timeoutMs?: number
}

export class BeplyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly retryable: boolean,
    readonly category: 'transport' | 'credentials' | 'validation' | 'not_found' | 'duplicate' | 'provider'
  ) {
    super(message)
    this.name = 'BeplyError'
  }
}

const invoiceDocumentSchema = z
  .object({
    idfactura: z.union([z.string(), z.number()]),
    codigo: z.string().optional(),
    codserie: z.string().optional(),
    total: z.union([z.number(), z.string()]).optional(),
    totaliva: z.union([z.number(), z.string()]).optional(),
    pagada: z.union([z.boolean(), z.number(), z.string()]).optional()
  })
  .passthrough()

function trimSlashes(value: string) {
  return value.replace(/\/+$/, '')
}

function formBody(values: Record<string, unknown>) {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue
    form.set(key, typeof value === 'string' ? value : String(value))
  }
  return form
}

function statusCategory(status: number): Pick<BeplyError, 'retryable' | 'category'> {
  if (status === 401 || status === 403) return { retryable: false, category: 'credentials' }
  if (status === 400 || status === 422) return { retryable: false, category: 'validation' }
  if (status === 404) return { retryable: false, category: 'not_found' }
  if (status === 409) return { retryable: false, category: 'duplicate' }
  return { retryable: status >= 500 || status === 408 || status === 429, category: 'provider' }
}

function customerCode(customer: FiscalCustomer) {
  const safe = customer.externalKey.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return `NE${safe.slice(-18)}`
}

function countryCode(country: string) {
  return country.toUpperCase() === 'ES' ? 'ESP' : country.toUpperCase()
}

function dateParts(issuedOn: string) {
  const value = new Date(issuedOn)
  if (Number.isNaN(value.getTime())) throw new Error('Invoice issue date is invalid')
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(value)
  const time = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(value)
  return { date, time }
}

export class BeplyInvoiceProvider implements InvoiceProvider {
  readonly name = 'beply'
  readonly configuration: Required<BeplyConfiguration>

  constructor(
    configuration: BeplyConfiguration,
    private readonly fetcher: Fetcher = globalThis.fetch
  ) {
    this.configuration = {
      baseUrl: z.string().url().parse(trimSlashes(configuration.baseUrl)),
      token: z.string().min(1).parse(configuration.token),
      invoiceSeries: z.string().min(1).max(10).parse(configuration.invoiceSeries),
      correctiveSeries: z.string().min(1).max(10).parse(configuration.correctiveSeries),
      taxCode21: z.string().min(1).max(20).parse(configuration.taxCode21),
      paymentCodeRedsys: z.string().min(1).max(20).parse(configuration.paymentCodeRedsys),
      companyId: z.string().min(1).max(20).parse(configuration.companyId),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(60_000)
        .parse(configuration.timeoutMs ?? 10_000)
    }
  }

  private async request(
    path: string,
    options: { method?: 'GET' | 'POST' | 'PUT'; form?: Record<string, unknown>; accept?: string } = {}
  ) {
    const method = options.method ?? 'GET'
    let response: Response
    try {
      response = await this.fetcher(`${this.configuration.baseUrl}/${path.replace(/^\/+/, '')}`, {
        method,
        headers: {
          Token: this.configuration.token,
          Accept: options.accept ?? 'application/json',
          ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
        },
        body: options.form ? formBody(options.form) : undefined,
        signal: AbortSignal.timeout(this.configuration.timeoutMs)
      })
    } catch (error) {
      throw new BeplyError(
        `Beply ${method} transport failed`,
        0,
        error instanceof Error ? error.message : 'unknown',
        true,
        'transport'
      )
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 2_000)
      const classification = statusCategory(response.status)
      throw new BeplyError(
        `Beply ${method} ${path} failed (${response.status})`,
        response.status,
        body,
        classification.retryable,
        classification.category
      )
    }
    return response
  }

  async upsertCustomer(customer: FiscalCustomer) {
    const code = customerCode(customer)
    try {
      await this.request('clientes', {
        method: 'POST',
        form: {
          codcliente: code,
          nombre: customer.legalName,
          razonsocial: customer.legalName,
          cifnif: customer.taxId,
          email: customer.email,
          telefono1: customer.phone,
          codpago: this.configuration.paymentCodeRedsys,
          codserie: this.configuration.invoiceSeries,
          observaciones: `NETECO ${customer.externalKey}`
        }
      })
    } catch (error) {
      if (!(error instanceof BeplyError) || error.category !== 'duplicate') throw error
    }
    const contacts = await this.request(`contactos?filter[codcliente]=${encodeURIComponent(code)}&limit=1`)
    const current = (await contacts.json()) as Array<{ idcontacto?: string | number }>
    await this.request(current[0]?.idcontacto ? `contactos/${current[0].idcontacto}` : 'contactos', {
      method: current[0]?.idcontacto ? 'PUT' : 'POST',
      form: {
        codcliente: code,
        nombre: customer.legalName,
        empresa: customer.legalName,
        cifnif: customer.taxId,
        direccion: customer.address.line1,
        ciudad: customer.address.city,
        provincia: customer.address.region,
        codpostal: customer.address.postalCode,
        codpais: countryCode(customer.address.countryCode),
        telefono1: customer.phone,
        email: customer.email,
        descripcion: 'Dirección fiscal NETECO'
      }
    })
    return code
  }

  private invoiceLines(request: IssueInvoiceRequest) {
    const lines = request.lines.map((line) => ({
      referencia: line.sku,
      descripcion: line.description,
      cantidad: line.quantity,
      pvpunitario: Number((line.lineNetCents / line.quantity / 100).toFixed(6)),
      dtopor: 0,
      codimpuesto: this.configuration.taxCode21,
      iva: line.taxRateBasisPoints / 100
    }))
    if (request.shippingNetCents > 0) {
      lines.push({
        referencia: 'ENVIO',
        descripcion: 'Gastos de envío',
        cantidad: 1,
        pvpunitario: request.shippingNetCents / 100,
        dtopor: 0,
        codimpuesto: this.configuration.taxCode21,
        iva: 21
      })
    }
    return lines
  }

  private async createDocument(
    path: string,
    request: IssueInvoiceRequest,
    options: { series: string; sourceProviderInvoiceId?: string; reason?: string }
  ) {
    const code = await this.upsertCustomer(request.customer)
    const { date, time } = dateParts(request.issuedOn)
    const response = await this.request(path, {
      method: 'POST',
      form: {
        codcliente: code,
        lineas: JSON.stringify(this.invoiceLines(request)),
        codserie: options.series,
        codpago: this.configuration.paymentCodeRedsys,
        idempresa: this.configuration.companyId,
        fecha: date,
        hora: time,
        pagada: 1,
        nombrecliente: request.customer.legalName,
        cifnif: request.customer.taxId,
        direccion: request.customer.address.line1,
        ciudad: request.customer.address.city,
        provincia: request.customer.address.region,
        codpostal: request.customer.address.postalCode,
        codpais: countryCode(request.customer.address.countryCode),
        numero2: request.orderNumber,
        idfacturaoriginal: options.sourceProviderInvoiceId,
        motivo: options.reason,
        observaciones: `NETECO ${request.orderNumber}; idempotencia ${request.idempotencyKey}`
      }
    })
    const raw = (await response.json()) as unknown
    const document = invoiceDocumentSchema.parse(
      raw && typeof raw === 'object' && 'data' in raw ? (raw as { data: unknown }).data : raw
    )
    return {
      providerId: String(document.idfactura),
      code: document.codigo ?? `${options.series}-${document.idfactura}`,
      status: 'issued' as const,
      amountCents: Math.round(Number(document.total ?? 0) * 100)
    }
  }

  issueInvoice(request: IssueInvoiceRequest): Promise<ProviderInvoice> {
    return this.createDocument('crearFacturaCliente', request, { series: request.series })
  }

  issueCreditNote(
    request: IssueInvoiceRequest & { sourceProviderInvoiceId: string; reason: string }
  ): Promise<ProviderInvoice> {
    return this.createDocument('crearFacturaRectificativaCliente', request, {
      series: this.configuration.correctiveSeries,
      sourceProviderInvoiceId: request.sourceProviderInvoiceId,
      reason: request.reason
    })
  }

  async markPaid(providerInvoiceId: string, paidOn: string) {
    const { date } = dateParts(paidOn)
    await this.request(`pagarFacturaCliente/${encodeURIComponent(providerInvoiceId)}`, {
      method: 'POST',
      form: { fechapago: date, codpago: this.configuration.paymentCodeRedsys, pagada: 1 }
    })
  }

  async downloadPdf(providerInvoiceId: string) {
    const response = await this.request(
      `exportarFacturaCliente/${encodeURIComponent(providerInvoiceId)}?type=PDF&lang=es_ES`,
      { accept: 'application/pdf' }
    )
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength < 4 || Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== '%PDF') {
      throw new BeplyError('Beply returned an invalid PDF', 502, '', false, 'provider')
    }
    return bytes
  }
}
