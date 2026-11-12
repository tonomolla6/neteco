import { z } from 'zod'
import {
  assertBeplyTaxCompatibility,
  beplyCustomerCode,
  beplyNetUnit,
  beplyOrderSnapshotSchema,
  beplyRemoteId,
  beplySupportObservation,
  type BeplyOrderAdapter,
  type BeplyOrderIdentity,
  type BeplyOrderSnapshot,
  type BeplyOrderReceipt,
  type BeplyErpState
} from '../../shared/beply-orders'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { madridDateKey, madridTimeKey } from '../../server/utils/madrid-calendar'
import { fiscalContractSchema, type FiscalContract, type FiscalReceipt } from '../../shared/fiscal-issuance'
import type { BeplyInvoiceSource } from '../fiscal/beply-order-invoice'

export class BeplyOrdersProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly ambiguous = false
  ) {
    super(code)
    this.name = 'BeplyOrdersProviderError'
  }
}
const tokenCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)
const configurationSchema = z
  .object({
    baseUrl: z.string().url(),
    token: z.string().min(1).max(1000),
    environment: z.enum(['sandbox', 'production']),
    companyId: tokenCode,
    orderSeries: z.string().regex(/^[A-Za-z0-9_-]{1,10}$/),
    paymentCodes: z.object({ redsys: tokenCode, bank_transfer: tokenCode, credit: tokenCode }).strict(),
    taxCodes: z.record(z.string().regex(/^\d{1,5}$/), tokenCode),
    taxCalculationMethod: z.enum(['classic', 'price-adjusted']).optional(),
    supportFileId: z
      .string()
      .regex(/^[1-9]\d{0,9}$/)
      .optional(),
    timeoutMs: z.number().int().min(1000).max(60000)
  })
  .strict()
export type BeplyOrdersConfiguration = z.infer<typeof configurationSchema>
const documentSchema = z
  .object({
    idpedido: beplyRemoteId,
    codigo: z.string().min(1).max(100),
    numero2: z.string(),
    coddivisa: z.literal('EUR'),
    total: z.union([z.string(), z.number()]),
    observaciones: z.string().max(65535).default('')
  })
  .passthrough()
const identitySchema = z
  .object({ key: z.string().regex(/^neteco-order:[0-9a-f-]{36}$/), hash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict()
function totalCents(raw: unknown): number {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(String(raw))) throw new BeplyOrdersProviderError('invalid_response')
  const [whole, fraction = ''] = String(raw).split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === 'object') {
    if ('error' in raw || ('status' in raw && raw.status === 'error'))
      throw new BeplyOrdersProviderError('invalid_response')
    if ('doc' in raw) return raw.doc
    if ('data' in raw) return raw.data
  }
  return raw
}
async function remoteKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return String(new DataView(digest).getUint32(0) & 0x7fffffff || 1)
}
/** Environment-aligned /api/3 core contracts at FacturaScripts 37e1341d.
 * No live acceptance or server-side uniqueness is inferred from mocks.
 * Required injected fetch prevents construction from enabling network traffic. */
export class BeplyOrdersProvider implements BeplyOrderAdapter {
  private readonly configuration: BeplyOrdersConfiguration
  constructor(
    raw: BeplyOrdersConfiguration,
    private readonly fetcher: typeof fetch
  ) {
    this.configuration = configurationSchema.parse(catalogPolicyOwnJson(raw))
    const base = new URL(this.configuration.baseUrl)
    if (
      base.protocol !== 'https:' ||
      base.port ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.hostname === 'neteco.beply.es' && this.configuration.environment !== 'production') ||
      (this.configuration.environment === 'production' && base.hostname !== 'neteco.beply.es') ||
      !/^[a-z0-9-]+\.beply\.es$/.test(base.hostname) ||
      !['/api/3', '/api/3/'].includes(base.pathname) ||
      typeof fetcher !== 'function'
    )
      throw new BeplyOrdersProviderError('invalid_configuration')
    this.configuration.baseUrl = `${base.origin}/api/3`
  }
  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    values?: Record<string, string>,
    key?: string
  ): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(`${this.configuration.baseUrl}/${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(this.configuration.timeoutMs),
        headers: {
          Token: this.configuration.token,
          Accept: 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
          ...(values ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        body: values ? new URLSearchParams(values) : undefined
      })
    } catch {
      throw new BeplyOrdersProviderError('transport', true, method !== 'GET')
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new BeplyOrdersProviderError(
        response.status === 401 || response.status === 403
          ? 'credentials'
          : response.status === 409
            ? 'duplicate'
            : response.status === 404
              ? 'not_found'
              : response.status === 400 || response.status === 422
                ? 'validation'
                : 'provider',
        response.status >= 500 || response.status === 408 || response.status === 429,
        method !== 'GET' && (response.status >= 500 || response.status === 408)
      )
    }
    const limit = 262144,
      length = response.headers.get('content-length')
    if (
      !/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '') ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) ||
      !response.body
    )
      throw new BeplyOrdersProviderError('invalid_response', false, method !== 'GET')
    const reader = response.body.getReader(),
      buffer = new Uint8Array(limit)
    let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        if (next.value.length > limit - size) {
          void reader.cancel().catch(() => {})
          throw new Error('size')
        }
        buffer.set(next.value, size)
        size += next.value.length
      }
      return catalogPolicyOwnJson(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))
      )
    } catch {
      throw new BeplyOrdersProviderError('invalid_response', false, method !== 'GET')
    } finally {
      reader.releaseLock()
    }
  }
  private document(raw: unknown, snapshot: Pick<BeplyOrderSnapshot, 'orderNumber' | 'totalGrossCents'>, id?: string) {
    const parsed = documentSchema.safeParse(unwrap(raw))
    if (!parsed.success) throw new BeplyOrdersProviderError('invalid_response')
    const value = parsed.data
    if (value.numero2 !== snapshot.orderNumber || (id !== undefined && value.idpedido !== id))
      throw new BeplyOrdersProviderError('identity_conflict')
    if (totalCents(value.total) !== snapshot.totalGrossCents) throw new BeplyOrdersProviderError('amount_mismatch')
    return value
  }
  private marker(value: string, identity: BeplyOrderIdentity): boolean {
    return value.includes(`NETECO key=${identity.key}; hash=${identity.hash};`)
  }
  async upsertCustomer(snapshot: BeplyOrderSnapshot): Promise<string> {
    const customer = snapshot.customer
    const id = beplyCustomerCode(customer.externalKey)
    try {
      await this.request('clientes', 'POST', {
        codcliente: id,
        nombre: customer.legalName,
        razonsocial: customer.legalName,
        email: customer.email,
        ...(customer.taxId ? { cifnif: customer.taxId } : {}),
        ...(customer.phone ? { telefono1: customer.phone } : {}),
        codpago: this.configuration.paymentCodes[snapshot.paymentMethod],
        codserie: this.configuration.orderSeries,
        observaciones: `NETECO ${customer.externalKey}`
      })
    } catch (error) {
      // APIModel::doPOST returns HTTP 400 for a duplicate, not just 409.
      if (!(error instanceof BeplyOrdersProviderError) || !['duplicate', 'validation'].includes(error.code)) throw error
      const existing = z
        .object({ codcliente: z.literal(id), observaciones: z.string() })
        .passthrough()
        .safeParse(await this.request(`clientes/${encodeURIComponent(id)}`))
      if (!existing.success || existing.data.observaciones !== `NETECO ${customer.externalKey}`)
        throw new BeplyOrdersProviderError('identity_conflict')
    }
    return id
  }
  async createOrder(raw: BeplyOrderSnapshot, rawIdentity: BeplyOrderIdentity): Promise<BeplyOrderReceipt> {
    const snapshot = beplyOrderSnapshotSchema.parse(catalogPolicyOwnJson(raw)),
      identity = identitySchema.parse(rawIdentity)
    try {
      assertBeplyTaxCompatibility(snapshot, this.configuration.taxCalculationMethod ?? 'classic')
    } catch {
      throw new BeplyOrdersProviderError('tax_rounding_review_required')
    }
    if (identity.key !== `neteco-order:${snapshot.orderId}`) throw new BeplyOrdersProviderError('identity_conflict')
    const entries = snapshot.lines.map((line) => ({
      referencia: line.sku,
      descripcion: line.description,
      cantidad: line.quantity,
      pvpunitario: beplyNetUnit(line.netCents, line.quantity),
      dtopor: 0,
      codimpuesto: this.configuration.taxCodes[String(line.taxRateBasisPoints)],
      iva: line.taxRateBasisPoints / 100
    }))
    if (snapshot.shippingGrossCents > 0)
      entries.push({
        referencia: 'ENVIO',
        descripcion: 'Gastos de envío',
        cantidad: 1,
        pvpunitario: beplyNetUnit(snapshot.shippingNetCents, 1),
        dtopor: 0,
        codimpuesto: this.configuration.taxCodes[String(snapshot.shippingTaxRateBasisPoints)],
        iva: snapshot.shippingTaxRateBasisPoints / 100
      })
    if (entries.some((line) => !line.codimpuesto)) throw new BeplyOrdersProviderError('tax_mapping_missing')
    // ApiCreateDocument calls getNewProductLine(), which silently yields an
    // unreferenced line for an unknown SKU. Verify the variant mapping first.
    const skus = [...new Set(snapshot.lines.map((line) => line.sku))].sort()
    const variants = z
      .array(z.object({ referencia: z.string() }).passthrough())
      .safeParse(
        await this.list(
          `variantes?filter[referencia_gte]=${encodeURIComponent(skus[0]!)}&filter[referencia_lte]=${encodeURIComponent(skus.at(-1)!)}`
        )
      )
    if (!variants.success) throw new BeplyOrdersProviderError('invalid_response')
    if (skus.some((sku) => variants.data.filter((variant) => variant.referencia === sku).length !== 1))
      throw new BeplyOrdersProviderError('product_mapping_missing')
    await this.checkCalculator()
    let customerId: string, shippingContactId: string
    try {
      customerId = await this.upsertCustomer(snapshot)
      shippingContactId = await this.shippingContact(customerId, snapshot, identity)
    } catch (error) {
      // No order POST has been attempted: even an ambiguous customer outcome
      // can safely retry the deterministic customer key before creating once.
      if (error instanceof BeplyOrdersProviderError)
        throw new BeplyOrdersProviderError(error.code, error.retryable, false)
      throw error
    }
    const destination = snapshot.customer.address
    const document = await this.request(
      'crearPedidoCliente',
      'POST',
      {
        codcliente: customerId,
        codserie: this.configuration.orderSeries,
        codpago: this.configuration.paymentCodes[snapshot.paymentMethod],
        idempresa: this.configuration.companyId,
        coddivisa: snapshot.currency,
        dtopor1: '0',
        dtopor2: '0',
        irpf: '0',
        fecha: madridDateKey(new Date(snapshot.confirmedAt)),
        hora: madridTimeKey(new Date(snapshot.confirmedAt)),
        numero2: snapshot.orderNumber,
        nombrecliente: snapshot.customer.legalName,
        idcontactoenv: shippingContactId,
        ...(snapshot.customer.taxId ? { cifnif: snapshot.customer.taxId } : {}),
        direccion: [destination.line1, destination.line2].filter(Boolean).join(' · '),
        ciudad: destination.city,
        provincia: destination.region,
        codpostal: destination.postalCode,
        codpais: 'ESP',
        observaciones: beplySupportObservation(snapshot, identity),
        lineas: JSON.stringify(entries)
      },
      identity.key
    )
    try {
      const checked = this.document(document, snapshot)
      return { providerOrderId: checked.idpedido, code: checked.codigo }
    } catch (error) {
      // The order POST succeeded. Untrusted/mismatching receipt evidence does
      // not prove absence and must never release permission to POST again.
      throw new BeplyOrdersProviderError(
        error instanceof BeplyOrdersProviderError ? error.code : 'invalid_response',
        false,
        true
      )
    }
  }
  private async shippingContact(
    customerId: string,
    snapshot: BeplyOrderSnapshot,
    identity: BeplyOrderIdentity
  ): Promise<string> {
    const id = await remoteKey(`${identity.key}:shipping`),
      address = snapshot.shippingAddress
    const values = {
      idcontacto: id,
      codcliente: customerId,
      nombre: address.recipientName,
      telefono1: address.phone,
      direccion: [address.line1, address.line2].filter(Boolean).join(' · '),
      ciudad: address.city,
      provincia: address.region,
      codpostal: address.postalCode,
      codpais: 'ESP',
      descripcion: `NETECO ${snapshot.orderNumber}`,
      observaciones: `NETECO key=${identity.key}; hash=${identity.hash};`
    }
    let result: unknown
    try {
      result = unwrap(await this.request('contactos', 'POST', values, `${identity.key}:shipping`))
    } catch (error) {
      if (!(error instanceof BeplyOrdersProviderError) || !['duplicate', 'validation'].includes(error.code)) throw error
      result = unwrap(await this.request(`contactos/${id}`))
    }
    const parsed = z.object({ idcontacto: beplyRemoteId }).passthrough().safeParse(result)
    if (!parsed.success || Object.entries(values).some(([field, value]) => String(parsed.data[field] ?? '') !== value))
      throw new BeplyOrdersProviderError('shipping_identity_conflict')
    return id
  }
  async lookupOrder(snapshot: BeplyOrderSnapshot, identity: BeplyOrderIdentity): Promise<BeplyOrderReceipt | null> {
    identitySchema.parse(identity)
    const found = await this.request(
      `pedidoclientes?filter[numero2]=${encodeURIComponent(snapshot.orderNumber)}&limit=2`
    )
    if (!Array.isArray(found)) throw new BeplyOrdersProviderError('invalid_response')
    if (found.length === 0) return null
    if (found.length !== 1) throw new BeplyOrdersProviderError('identity_conflict')
    const value = this.document(found[0], snapshot)
    if (!this.marker(value.observaciones, identity)) throw new BeplyOrdersProviderError('identity_conflict')
    return { providerOrderId: value.idpedido, code: value.codigo }
  }
  async updateOrder(id: string, snapshot: BeplyOrderSnapshot, identity: BeplyOrderIdentity): Promise<void> {
    id = beplyRemoteId.parse(id)
    snapshot = beplyOrderSnapshotSchema.parse(catalogPolicyOwnJson(snapshot))
    identitySchema.parse(identity)
    const current = this.document(await this.request(`pedidoclientes/${encodeURIComponent(id)}`), snapshot, id)
    if (!this.marker(current.observaciones, identity)) throw new BeplyOrdersProviderError('identity_conflict')
    const manual = current.observaciones.replace(/\[NETECO\][\s\S]*?\[\/NETECO\]/g, '').trim()
    const observation = [manual, beplySupportObservation(snapshot, identity)].filter(Boolean).join('\n')
    if (observation.length > 65535) throw new BeplyOrdersProviderError('observation_too_large')
    // TransformerDocument forbids editing observations once transformed. Its
    // independent AttachedFileRelation remains editable and visible from the
    // order's files tab. Never unlock or reopen a fiscal document.
    if (current.editable === false || current.editable === 0 || current.editable === '0') {
      await this.updateSupportAttachment(id, snapshot, identity)
      return
    }
    this.document(
      await this.request(
        `pedidoclientes/${encodeURIComponent(id)}`,
        'PUT',
        { observaciones: observation },
        `${identity.key}:v${snapshot.version}`
      ),
      snapshot,
      id
    )
  }
  get taxCalculationMethod() {
    return this.configuration.taxCalculationMethod ?? 'classic'
  }
  private async checkCalculator(): Promise<void> {
    const settings = z
      .object({ name: z.literal('default'), properties: z.union([z.string(), z.record(z.string(), z.unknown())]) })
      .safeParse(unwrap(await this.request('settings/default')))
    if (!settings.success) throw new BeplyOrdersProviderError('invalid_response')
    const raw = settings.data
    let properties: Record<string, unknown>
    try {
      properties = z
        .record(z.string(), z.unknown())
        .parse(typeof raw.properties === 'string' ? JSON.parse(raw.properties) : raw.properties)
    } catch {
      throw new BeplyOrdersProviderError('invalid_response')
    }
    if (
      (properties.taxcalculationmethod ?? 'classic') !== (this.configuration.taxCalculationMethod ?? 'classic') ||
      (properties.decimals !== undefined && String(properties.decimals) !== '2')
    )
      throw new BeplyOrdersProviderError('calculator_configuration_mismatch')
  }
  private async list(path: string): Promise<unknown[]> {
    const result: unknown[] = []
    // Stable primary-key ordering is APIModel's default. A full last page
    // requires another read; never silently truncate document relationships.
    for (let offset = 0; offset <= 1000; offset += 100) {
      const raw = await this.request(`${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`)
      if (!Array.isArray(raw) || raw.length > 100) throw new BeplyOrdersProviderError('invalid_response')
      result.push(...raw)
      if (result.length > 1000) throw new BeplyOrdersProviderError('document_graph_too_large')
      if (raw.length < 100) return result
    }
    throw new BeplyOrdersProviderError('document_graph_too_large')
  }
  private async children(model: 'PedidoCliente' | 'AlbaranCliente', ids: string[]) {
    const numeric = ids.map((id) =>
      z
        .string()
        .regex(/^[1-9]\d{0,9}$/)
        .parse(id)
    )
    if (!numeric.length) return []
    // APIModel has no IN operator. One bounded interval query avoids one
    // request per delivery note; foreign interval rows are discarded locally.
    const bounds = numeric.map(Number).sort((a, b) => a - b)
    const filter =
      ids.length === 1
        ? `filter[iddoc1]=${numeric[0]}`
        : `filter[iddoc1_gte]=${bounds[0]}&filter[iddoc1_lte]=${bounds.at(-1)}`
    const rows = z
      .array(
        z
          .object({ model1: z.literal(model), iddoc1: beplyRemoteId, model2: z.string(), iddoc2: beplyRemoteId })
          .passthrough()
      )
      .parse(await this.list(`doctransformations?filter[model1]=${model}&${filter}`))
    if (ids.length === 1 && rows.some((row) => row.iddoc1 !== ids[0]))
      throw new BeplyOrdersProviderError('identity_conflict')
    return rows.filter((row) => ids.includes(row.iddoc1))
  }
  async readOrder(id: string, orderNumber: string): Promise<BeplyErpState> {
    id = beplyRemoteId.parse(id)
    const raw = documentSchema.parse(unwrap(await this.request(`pedidoclientes/${encodeURIComponent(id)}`)))
    if (raw.idpedido !== id || raw.numero2 !== orderNumber) throw new BeplyOrdersProviderError('identity_conflict')
    const lines = z
      .array(
        z.object({ idpedido: beplyRemoteId, cantidad: z.number().finite(), servido: z.number().finite() }).passthrough()
      )
      .parse(await this.list(`lineapedidoclientes?filter[idpedido]=${encodeURIComponent(id)}`))
    if (lines.some((line) => line.idpedido !== id || line.cantidad < 0 || line.servido < 0))
      throw new BeplyOrdersProviderError('identity_conflict')
    const edges = await this.children('PedidoCliente', [id])
    const deliveryNoteIds = [
      ...new Set(edges.filter((row) => row.model2 === 'AlbaranCliente').map((row) => row.iddoc2))
    ]
    const invoiceEdges = await this.children('AlbaranCliente', deliveryNoteIds)
    return {
      served: lines.length > 0 && lines.every((line) => line.servido >= line.cantidad),
      deliveryNoteIds,
      invoiceIds: [
        ...new Set(
          [...edges, ...invoiceEdges].filter((row) => row.model2 === 'FacturaCliente').map((row) => row.iddoc2)
        )
      ]
    }
  }
  private async updateSupportAttachment(
    id: string,
    snapshot: BeplyOrderSnapshot,
    identity: BeplyOrderIdentity
  ): Promise<void> {
    const idfile = this.configuration.supportFileId
    if (!idfile) throw new BeplyOrdersProviderError('support_attachment_missing')
    // Client-assigned INT primary key, checked for collisions with full order
    // identity. Repeating this PUT/POST can never create a second relation.
    const relationId = await remoteKey(identity.key)
    let current: unknown
    try {
      current = unwrap(await this.request(`attachedfilerelations/${relationId}`))
    } catch (error) {
      if (!(error instanceof BeplyOrdersProviderError) || error.code !== 'not_found') throw error
    }
    const schema = z
      .object({
        id: beplyRemoteId,
        idfile: beplyRemoteId,
        model: z.literal('PedidoCliente'),
        modelid: beplyRemoteId,
        observations: z.string()
      })
      .passthrough()
    let manual = ''
    if (current !== undefined) {
      const parsed = schema.safeParse(current)
      if (
        !parsed.success ||
        parsed.data.id !== relationId ||
        parsed.data.modelid !== id ||
        parsed.data.idfile !== idfile ||
        !this.marker(parsed.data.observations, identity)
      )
        throw new BeplyOrdersProviderError('support_identity_conflict')
      manual = parsed.data.observations.replace(/\[NETECO\][\s\S]*?\[\/NETECO\]/g, '').trim()
    }
    const values = {
      id: relationId,
      idfile,
      model: 'PedidoCliente',
      modelid: id,
      observations: [manual, beplySupportObservation(snapshot, identity)].filter(Boolean).join('\n')
    }
    if (values.observations.length > 65535) throw new BeplyOrdersProviderError('observation_too_large')
    const saved = schema.parse(
      unwrap(
        await this.request(
          current === undefined ? 'attachedfilerelations' : `attachedfilerelations/${relationId}`,
          current === undefined ? 'POST' : 'PUT',
          values,
          `${identity.key}:support:v${snapshot.version}`
        )
      )
    )
    if (
      saved.id !== relationId ||
      saved.modelid !== id ||
      saved.idfile !== idfile ||
      !this.marker(saved.observations, identity)
    )
      throw new BeplyOrdersProviderError('support_identity_conflict')
  }
  private async conversionState(model: string, target: string): Promise<string> {
    const rows = z
      .array(
        z
          .object({
            idestado: beplyRemoteId,
            tipodoc: z.literal(model),
            generadoc: z.literal(target),
            activo: z.literal(true),
            editable: z.literal(false),
            actualizastock: z.literal(0)
          })
          .passthrough()
      )
      .parse(await this.list(`estadodocumentos?filter[tipodoc]=${model}&filter[generadoc]=${target}&filter[activo]=1`))
    if (rows.length !== 1) throw new BeplyOrdersProviderError('conversion_state_ambiguous')
    return rows[0]!.idestado
  }
  private fiscalDocument(
    raw: unknown,
    column: 'idpedido' | 'idalbaran' | 'idfactura',
    id: string,
    contract: FiscalContract
  ) {
    const parsed = z
      .object({
        numero2: z.literal(contract.orderNumber),
        coddivisa: z.literal('EUR'),
        codserie: z.literal(contract.series),
        codcliente: z.string(),
        idempresa: beplyRemoteId,
        neto: z.union([z.string(), z.number()]),
        totaliva: z.union([z.string(), z.number()]),
        total: z.union([z.string(), z.number()]),
        observaciones: z.string(),
        fecha: z.string().optional()
      })
      .passthrough()
      .safeParse(unwrap(raw))
    const customerId = beplyCustomerCode(contract.customer.externalKey)
    if (
      !parsed.success ||
      String(parsed.data[column]) !== id ||
      parsed.data.codcliente !== customerId ||
      parsed.data.idempresa !== this.configuration.companyId ||
      totalCents(parsed.data.total) !== contract.totalGrossCents ||
      totalCents(parsed.data.neto) !== contract.totalNetCents ||
      totalCents(parsed.data.totaliva) !== contract.totalTaxCents
    )
      throw new BeplyOrdersProviderError('invoice_source_unconfirmed')
    return parsed.data
  }
  async convertToInvoice(source: BeplyInvoiceSource, raw: FiscalContract): Promise<FiscalReceipt> {
    const contract = fiscalContractSchema.parse(catalogPolicyOwnJson(raw))
    if (
      contract.provider !== 'beply' ||
      contract.environment !== this.configuration.environment ||
      contract.validationOnly ||
      contract.series !== this.configuration.orderSeries ||
      (source.kind === 'order' && source.id !== source.providerOrderId)
    )
      throw new BeplyOrdersProviderError('invoice_source_unconfirmed')
    assertBeplyTaxCompatibility(contract, this.configuration.taxCalculationMethod ?? 'classic')
    await this.checkCalculator()
    let facts = await this.readOrder(source.providerOrderId, contract.orderNumber)
    const marker = `NETECO invoice=${contract.idempotencyKey}; policy=${contract.policyFingerprint};`
    const recover = async (ids: string[]) => {
      if (ids.length !== 1) throw new BeplyOrdersProviderError('invoice_source_unconfirmed')
      const id = ids[0]!,
        document = this.fiscalDocument(
          await this.request(`facturaclientes/${encodeURIComponent(id)}`),
          'idfactura',
          id,
          contract
        )
      if (!document.observaciones.includes(marker)) throw new BeplyOrdersProviderError('invoice_source_unconfirmed')
      // The generator uses the server date, not the prototype's date. Verify it
      // before accepting; never silently issue for another fiscal day.
      if (
        document.fecha?.replace(/^(\d{2})-(\d{2})-(\d{4})$/, '$3-$2-$1') !== madridDateKey(new Date(contract.issuedOn))
      )
        throw new BeplyOrdersProviderError('invoice_source_unconfirmed')
      if (document.pagada !== true) {
        const paid = this.fiscalDocument(
          await this.request(`pagarFacturaCliente/${encodeURIComponent(id)}`, 'POST', {
            pagada: '1',
            codpago: this.configuration.paymentCodes.redsys,
            fechapago: madridDateKey(new Date(contract.issuedOn))
          }),
          'idfactura',
          id,
          contract
        )
        if (paid.pagada !== true || !paid.observaciones.includes(marker))
          throw new BeplyOrdersProviderError('invalid_response', false, true)
      }
      return {
        providerId: id,
        code: z.string().min(1).max(100).parse(document.codigo),
        status: 'issued' as const,
        amountCents: contract.totalGrossCents,
        currency: 'EUR' as const
      }
    }
    if (facts.invoiceIds.length) return recover(facts.invoiceIds)
    if (facts.deliveryNoteIds.length > 1 || (source.kind === 'delivery_note' && facts.deliveryNoteIds[0] !== source.id))
      throw new BeplyOrdersProviderError('invoice_source_unconfirmed')
    // Discover both transitions BEFORE making the first mutating call.
    const invoiceState = await this.conversionState('AlbaranCliente', 'FacturaCliente')
    if (!facts.deliveryNoteIds.length) {
      const order = this.fiscalDocument(
        await this.request(`pedidoclientes/${encodeURIComponent(source.providerOrderId)}`),
        'idpedido',
        source.providerOrderId,
        contract
      )
      const state = await this.conversionState('PedidoCliente', 'AlbaranCliente')
      if (order.editable !== true) throw new BeplyOrdersProviderError('invoice_source_unconfirmed')
      await this.request(
        `pedidoclientes/${encodeURIComponent(source.providerOrderId)}`,
        'PUT',
        { idestado: state },
        contract.idempotencyKey
      )
      facts = await this.readOrder(source.providerOrderId, contract.orderNumber)
      if (facts.invoiceIds.length || facts.deliveryNoteIds.length !== 1)
        throw new BeplyOrdersProviderError('invoice_source_unconfirmed', false, true)
    }
    const noteId = facts.deliveryNoteIds[0]!
    const note = this.fiscalDocument(
      await this.request(`albaranclientes/${encodeURIComponent(noteId)}`),
      'idalbaran',
      noteId,
      contract
    )
    if (note.editable !== true) throw new BeplyOrdersProviderError('invoice_source_unconfirmed')
    const observations = note.observaciones.includes(marker) ? note.observaciones : `${note.observaciones}\n${marker}`
    if (observations.length > 65535) throw new BeplyOrdersProviderError('observation_too_large')
    await this.request(
      `albaranclientes/${encodeURIComponent(noteId)}`,
      'PUT',
      { idestado: invoiceState, observaciones: observations },
      contract.idempotencyKey
    )
    facts = await this.readOrder(source.providerOrderId, contract.orderNumber)
    return recover(facts.invoiceIds)
  }
}
