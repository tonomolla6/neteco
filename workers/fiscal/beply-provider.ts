import { z } from 'zod'
import { assertBeplyTaxCompatibility } from '../../shared/beply-orders'
import type { BeplyConfiguration } from '../../server/integrations/beply'
import type { FiscalContract, FiscalReceipt, OrdinaryFiscalProvider } from '../../shared/fiscal-issuance'
import { fiscalContractSchema, fiscalReceiptSchema, FISCAL_MAX_PDF_BYTES } from '../../shared/fiscal-issuance'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { madridDateKey, madridTimeKey } from '../../server/utils/madrid-calendar'
import { fiscalMappingFingerprint, checksumFiscalPdf } from './issuance'
import { creditContractSchema, type CreditContract } from '../../shared/fiscal-credit'

export class WorkerBeplyError extends Error {
  constructor(
    readonly code:
      | 'transport'
      | 'credentials'
      | 'validation'
      | 'duplicate'
      | 'provider'
      | 'invalid_response'
      | 'tax_rounding_review_required',
    readonly status = 0
  ) {
    super(`beply_${code}`)
    this.name = 'WorkerBeplyError'
  }
}
const code = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
const configurationSchema = z
  .object({
    baseUrl: z.string().url(),
    token: z.string().min(1).max(1000),
    invoiceSeries: z.string().regex(/^[A-Za-z0-9_-]{1,10}$/),
    correctiveSeries: z.string().min(1).max(10),
    taxCode0: code,
    taxCode10: code,
    taxCode21: code,
    paymentCodeRedsys: code,
    paymentCodeBankTransfer: code,
    companyId: code,
    timeoutMs: z.number().int().min(1000).max(60000).optional(),
    environment: z.enum(['sandbox', 'production'])
  })
  .strict()
export type WorkerBeplyConfiguration = BeplyConfiguration & { environment: 'sandbox' | 'production' }
function decimalCents(raw: unknown): number {
  const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw
  if (typeof text !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(text)) throw new WorkerBeplyError('invalid_response')
  const [whole, fraction = ''] = text.split('.'),
    amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (amount < 1n || amount > 1000000000n) throw new WorkerBeplyError('invalid_response')
  return Number(amount)
}
function unitNetDecimal(netCents: number, quantity: number): string {
  const numerator = BigInt(netCents) * 10000n,
    denominator = BigInt(quantity)
  const scaled = (numerator * 2n + denominator) / (denominator * 2n)
  return `${scaled / 1000000n}.${String(scaled % 1000000n).padStart(6, '0')}`
}
async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new WorkerBeplyError('invalid_response', response.status)
  if (!response.body) throw new WorkerBeplyError('invalid_response', response.status)
  const reader = response.body.getReader(),
    buffer = new Uint8Array(limit)
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.length > limit - size) {
        void reader.cancel().catch(() => {})
        throw new WorkerBeplyError('invalid_response', response.status)
      }
      buffer.set(part.value, size)
      size += part.value.length
    }
  } finally {
    reader.releaseLock()
  }
  return buffer.slice(0, size)
}
/** Worker port of the existing InvoiceProvider/Beply request contract. Fetch
 * is REQUIRED injection: no constructor default can accidentally enable live
 * traffic. NO external-key lookup or remotely guaranteed idempotency is claimed.
 * The actual series, BEP-002 policy and API acceptance remain external gates. */
export class WorkerBeplyInvoiceProvider implements OrdinaryFiscalProvider {
  readonly name = 'beply' as const
  readonly environment: 'sandbox' | 'production'
  private constructor(
    private readonly configuration: z.infer<typeof configurationSchema>,
    private readonly fetcher: typeof fetch,
    readonly mappingFingerprint: string
  ) {
    this.environment = configuration.environment
  }
  static async create(raw: WorkerBeplyConfiguration, fetcher: typeof fetch): Promise<WorkerBeplyInvoiceProvider> {
    const configuration = configurationSchema.parse(catalogPolicyOwnJson(raw)),
      base = new URL(configuration.baseUrl)
    if (
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.port ||
      base.search ||
      base.hash ||
      // This tenant is confirmed production. A sandbox label cannot make it
      // safe for preview; construction itself must reject the mismatched host.
      (base.hostname === 'neteco.beply.es' && configuration.environment !== 'production') ||
      !/^[a-z0-9-]+\.beply\.es$/.test(base.hostname) ||
      !['/api/3', '/api/3/'].includes(base.pathname) ||
      typeof fetcher !== 'function'
    )
      throw new WorkerBeplyError('validation')
    // Preserve the versioned API authority exactly. Never silently switch an
    // approved /api/3 endpoint to an unversioned tenant-origin endpoint.
    configuration.baseUrl = `${base.origin}/api/3`
    const fingerprint = await fiscalMappingFingerprint({
      companyId: configuration.companyId,
      taxes: { '0': configuration.taxCode0, '1000': configuration.taxCode10, '2100': configuration.taxCode21 },
      paymentCode: configuration.paymentCodeRedsys
    })
    return new WorkerBeplyInvoiceProvider(configuration, fetcher, fingerprint)
  }
  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    values?: Record<string, string>,
    accept = 'application/json'
  ): Promise<Response> {
    const form = values ? new URLSearchParams(values) : undefined
    let response: Response
    try {
      response = await this.fetcher(`${this.configuration.baseUrl}/${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(this.configuration.timeoutMs ?? 10000),
        headers: {
          Token: this.configuration.token,
          Accept: accept,
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        body: form
      })
    } catch {
      throw new WorkerBeplyError('transport')
    }
    if (!response.ok) {
      // Do not read/log/persist provider error bodies, URLs, PII or credentials.
      void response.body?.cancel().catch(() => {})
      throw new WorkerBeplyError(
        response.status === 401 || response.status === 403
          ? 'credentials'
          : response.status === 409
            ? 'duplicate'
            : response.status === 400 || response.status === 422
              ? 'validation'
              : 'provider',
        response.status
      )
    }
    return response
  }
  private async json(response: Response): Promise<unknown> {
    if (!/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? ''))
      throw new WorkerBeplyError('invalid_response')
    try {
      return catalogPolicyOwnJson(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(response, 262144)))
      )
    } catch {
      throw new WorkerBeplyError('invalid_response')
    }
  }
  private async upsertCustomer(request: FiscalContract): Promise<string> {
    const customer = request.customer,
      safe = customer.externalKey.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
      customerId = `NE${safe.slice(-18)}`
    try {
      await this.request('clientes', 'POST', {
        codcliente: customerId,
        nombre: customer.legalName,
        razonsocial: customer.legalName,
        email: customer.email,
        ...(customer.taxId ? { cifnif: customer.taxId } : {}),
        ...(customer.phone ? { telefono1: customer.phone } : {}),
        codpago: this.configuration.paymentCodeRedsys,
        codserie: request.series,
        observaciones: `NETECO ${customer.externalKey}`
      })
    } catch (error) {
      if (!(error instanceof WorkerBeplyError) || error.code !== 'duplicate') throw error
      const existing = await this.json(await this.request(`clientes/${encodeURIComponent(customerId)}`))
      if (
        !existing ||
        typeof existing !== 'object' ||
        !('codcliente' in existing) ||
        existing.codcliente !== customerId
      )
        throw new WorkerBeplyError('invalid_response')
    }
    const raw = await this.json(
      await this.request(`contactos?filter[codcliente]=${encodeURIComponent(customerId)}&limit=2`)
    )
    const contacts = z
      .array(
        z
          .object({
            idcontacto: z.union([code, z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]),
            codcliente: z.literal(customerId)
          })
          .passthrough()
      )
      .max(1)
      .parse(raw)
    const contact = contacts[0]
    await this.request(
      contact ? `contactos/${encodeURIComponent(String(contact.idcontacto))}` : 'contactos',
      contact ? 'PUT' : 'POST',
      {
        codcliente: customerId,
        nombre: customer.legalName,
        empresa: customer.legalName,
        email: customer.email,
        ...(customer.taxId ? { cifnif: customer.taxId } : {}),
        ...(customer.phone ? { telefono1: customer.phone } : {}),
        direccion: [customer.address.line1, customer.address.line2].filter(Boolean).join(' · '),
        ciudad: customer.address.city,
        provincia: customer.address.region,
        codpostal: customer.address.postalCode,
        codpais: customer.address.countryCode === 'ES' ? 'ESP' : customer.address.countryCode,
        descripcion: 'Dirección fiscal NETECO'
      }
    )
    return customerId
  }
  async issueInvoice(raw: FiscalContract): Promise<FiscalReceipt> {
    const request = fiscalContractSchema.parse(catalogPolicyOwnJson(raw))
    if (
      request.provider !== 'beply' ||
      request.validationOnly ||
      request.environment !== this.environment ||
      request.series !== this.configuration.invoiceSeries
    )
      throw new WorkerBeplyError('validation')
    // Core Calculator.php:278-342 (37e1341d): standalone invoices retain the
    // classic calculation contract. Linked orders attest their configured mode.
    try {
      assertBeplyTaxCompatibility(request)
    } catch {
      throw new WorkerBeplyError('tax_rounding_review_required')
    }
    const taxCode = (rate: number) =>
      rate === 0
        ? this.configuration.taxCode0
        : rate === 1000
          ? this.configuration.taxCode10
          : rate === 2100
            ? this.configuration.taxCode21
            : null
    const lines = request.lines.map((line) => {
      const tax = taxCode(line.taxRateBasisPoints)
      if (!tax) throw new WorkerBeplyError('validation')
      return {
        referencia: line.sku,
        descripcion: line.description,
        cantidad: line.quantity,
        pvpunitario: unitNetDecimal(line.lineNetCents - line.discountNetCents, line.quantity),
        dtopor: 0,
        codimpuesto: tax,
        iva: line.taxRateBasisPoints / 100
      }
    })
    if (request.shippingGrossCents > 0) {
      const tax = taxCode(request.shippingTaxRateBasisPoints)
      if (!tax) throw new WorkerBeplyError('validation')
      lines.push({
        referencia: 'ENVIO',
        descripcion: 'Gastos de envío',
        cantidad: 1,
        pvpunitario: unitNetDecimal(request.shippingNetCents, 1),
        dtopor: 0,
        codimpuesto: tax,
        iva: request.shippingTaxRateBasisPoints / 100
      })
    }
    const customerId = await this.upsertCustomer(request),
      date = new Date(request.issuedOn)
    const rawDocument = await this.json(
      await this.request('crearFacturaCliente', 'POST', {
        codcliente: customerId,
        lineas: JSON.stringify(lines),
        codserie: request.series,
        codpago: this.configuration.paymentCodeRedsys,
        idempresa: this.configuration.companyId,
        fecha: madridDateKey(date),
        hora: madridTimeKey(date),
        pagada: '1',
        nombrecliente: request.customer.legalName,
        ...(request.customer.taxId ? { cifnif: request.customer.taxId } : {}),
        direccion: [request.customer.address.line1, request.customer.address.line2].filter(Boolean).join(' · '),
        ciudad: request.customer.address.city,
        provincia: request.customer.address.region,
        codpostal: request.customer.address.postalCode,
        codpais: 'ESP',
        numero2: request.orderNumber,
        // An observation is correlation ONLY, never proof of remote idempotency.
        observaciones: `NETECO ${request.orderNumber}; correlación ${request.idempotencyKey}`
      })
    )
    const document =
      rawDocument && typeof rawDocument === 'object' && 'doc' in rawDocument
        ? rawDocument.doc
        : rawDocument && typeof rawDocument === 'object' && 'data' in rawDocument
          ? rawDocument.data
          : rawDocument
    const checked = z
      .object({
        idfactura: z.union([code, z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]),
        codigo: z.string().min(1).max(100),
        total: z.union([z.string(), z.number()]),
        coddivisa: z.literal('EUR')
      })
      .passthrough()
      .parse(document)
    return fiscalReceiptSchema.parse({
      providerId: String(checked.idfactura),
      code: checked.codigo,
      status: 'issued',
      amountCents: decimalCents(checked.total),
      currency: checked.coddivisa
    })
  }
  async downloadPdf(providerInvoiceId: string): Promise<Uint8Array> {
    const id = code.parse(providerInvoiceId),
      response = await this.request(
        `exportarFacturaCliente/${encodeURIComponent(id)}?type=PDF&lang=es_ES`,
        'GET',
        undefined,
        'application/pdf'
      )
    if (!/^application\/pdf(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? ''))
      throw new WorkerBeplyError('invalid_response')
    const bytes = await boundedBody(response, FISCAL_MAX_PDF_BYTES)
    await checksumFiscalPdf(bytes)
    return bytes
  }
  /** The maintained legacy port calls crearFacturaRectificativaCliente, but
   * its response proves neither corrective kind/source nor signed total. Until
   * that primary contract is verified, reject BEFORE any customer/provider I/O.
   * No invented lookup, absolute-value total or legal acceptance is inferred. */
  async issueCreditNote(raw: CreditContract): Promise<never> {
    const contract = creditContractSchema.parse(catalogPolicyOwnJson(raw))
    if (
      contract.provider !== 'beply' ||
      contract.validationOnly ||
      contract.environment !== this.environment ||
      contract.series !== this.configuration.correctiveSeries
    )
      throw new WorkerBeplyError('validation')
    throw new WorkerBeplyError('validation')
  }
}
