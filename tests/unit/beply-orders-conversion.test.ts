import { describe, expect, it, vi } from 'vitest'
import { BeplyOrdersProvider } from '../../workers/integrations/beply-orders-provider'
import { BeplyOrderInvoiceProvider } from '../../workers/fiscal/beply-order-invoice'
import { configuredFiscalProvider } from '../../workers/runtime/operations-config'
import type { FiscalPolicy } from '../../shared/fiscal-issuance'
import { beplyFiscalContractFixture as contract, beplyOrderSnapshotFixture as snapshot } from '../fixtures/beply-orders'

const config = {
  baseUrl: 'https://sandbox.beply.es/api/3',
  token: 'synthetic',
  environment: 'sandbox' as const,
  companyId: '1',
  orderSeries: 'NE',
  paymentCodes: { redsys: 'CARD', bank_transfer: 'BANK', credit: 'CREDIT' },
  taxCodes: { '0': 'IVA0', '1000': 'IVA10', '2100': 'IVA21' },
  timeoutMs: 1000,
  supportFileId: '501'
}
const key = `neteco-order:${snapshot.orderId}`,
  hash = 'a'.repeat(64)
function world() {
  const order = {
    idpedido: 71,
    codigo: 'PED71',
    numero2: snapshot.orderId,
    neto: '10.00',
    totaliva: '2.10',
    total: '12.10',
    coddivisa: 'EUR',
    codcliente: 'NELMOUXWCW',
    idempresa: 1,
    codserie: 'NE',
    editable: true,
    observaciones: `NETECO key=${key}; hash=${hash};`
  }
  const note = { ...order, idpedido: undefined, idalbaran: 81, codigo: 'ALB81' }
  const invoice = { ...order, idpedido: undefined, idfactura: 91, codigo: 'FAC91', fecha: '12-11-2026' }
  const relations: Array<{
    id: number
    model1: string
    iddoc1: number
    model2: string
    iddoc2: number
    idlinea1: number
    idlinea2: number
    cantidad: number
  }> = []
  const support = new Map<string, Record<string, unknown>>()
  const relation = (model1: string, iddoc1: number, model2: string, iddoc2: number) => ({
    id: relations.length + 1,
    model1,
    iddoc1,
    model2,
    iddoc2,
    idlinea1: 1,
    idlinea2: 2,
    cantidad: 1
  })
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname.replace('/api/3/', ''),
      form = init?.body as URLSearchParams | undefined
    if (path === 'settings/default')
      return Response.json({
        name: 'default',
        properties: JSON.stringify({ taxcalculationmethod: 'classic', decimals: '2' })
      })
    if (path === 'estadodocumentos')
      return Response.json([
        {
          idestado: url.searchParams.get('filter[tipodoc]') === 'PedidoCliente' ? 12 : 13,
          tipodoc: url.searchParams.get('filter[tipodoc]'),
          generadoc: url.searchParams.get('filter[generadoc]'),
          activo: true,
          editable: false,
          actualizastock: 0
        }
      ])
    if (path === 'lineapedidoclientes')
      return Response.json([{ idlinea: 1, idpedido: 71, cantidad: 1, servido: relations.length ? 1 : 0 }])
    if (path === 'doctransformations')
      return Response.json(
        relations.filter(
          (r) =>
            r.model1 === url.searchParams.get('filter[model1]') &&
            (!url.searchParams.has('filter[iddoc1]') || String(r.iddoc1) === url.searchParams.get('filter[iddoc1]'))
        )
      )
    if (path === 'pedidoclientes/71') {
      if (init?.method === 'PUT') {
        if (form?.get('idestado')) {
          relations.push(relation('PedidoCliente', 71, 'AlbaranCliente', 81))
          order.editable = false
        }
        Object.assign(order, Object.fromEntries(form!))
        Object.assign(note, { observaciones: order.observaciones })
      }
      return Response.json(init?.method === 'PUT' ? { ok: 'updated', data: order } : order)
    }
    if (path === 'albaranclientes/81') {
      if (init?.method === 'PUT') {
        Object.assign(note, Object.fromEntries(form!))
        Object.assign(invoice, { observaciones: note.observaciones })
        if (form?.get('idestado')) relations.push(relation('AlbaranCliente', 81, 'FacturaCliente', 91))
      }
      return Response.json(init?.method === 'PUT' ? { ok: 'updated', data: note } : note)
    }
    if (path === 'facturaclientes/91') return Response.json(invoice)
    if (path === 'pagarFacturaCliente/91') return Response.json({ ok: 'updated', data: { ...invoice, pagada: true } })
    if (path.startsWith('attachedfilerelations/')) {
      const id = path.split('/')[1]!
      if (init?.method === 'PUT') {
        const saved = { ...support.get(id), ...Object.fromEntries(form!) }
        support.set(id, saved)
        return Response.json({ ok: 'updated', data: saved })
      }
      return support.has(id) ? Response.json(support.get(id)) : Response.json({ error: 'not found' }, { status: 404 })
    }
    if (path === 'attachedfilerelations' && init?.method === 'POST') {
      const saved = Object.fromEntries(form!),
        id = String(saved.id)
      if (support.has(id)) return Response.json({ error: 'duplicate' }, { status: 400 })
      support.set(id, saved)
      return Response.json({ ok: 'created', data: saved })
    }
    throw new Error(`Unexpected contract: ${init?.method ?? 'GET'} ${path}`)
  })
  return {
    provider: new BeplyOrdersProvider(config, fetcher),
    fetcher,
    order,
    note,
    invoice,
    relations,
    relation,
    support
  }
}
describe('FacturaScripts core document contracts, revision 37e1341d', () => {
  it('mounts the linked adapter in the governed fiscal factory, with no I/O during construction', async () => {
    const w = world(),
      policy = {
        id: contract.policyId,
        idempotencyKey: 'policy',
        provider: 'beply',
        environment: 'sandbox',
        series: 'NE',
        trigger: 'after_payment_capture',
        mappings: { companyId: '1', taxes: config.taxCodes, paymentCode: 'CARD' },
        evidenceRef: 'synthetic',
        reason: 'Synthetic contract',
        approvedAt: contract.issuedOn,
        fingerprint: contract.policyFingerprint
      } as FiscalPolicy
    const env = {
      APP_ENV: 'preprod',
      DB: {},
      BEPLY_ENABLED: 'true',
      BEPLY_ENVIRONMENT: 'sandbox',
      BEPLY_ORDERS_ENABLED: 'true',
      BEPLY_BASE_URL: config.baseUrl,
      BEPLY_API_TOKEN: config.token,
      BEPLY_COMPANY_ID: '1',
      BEPLY_INVOICE_SERIES: 'NE',
      BEPLY_ORDER_SERIES: 'NE',
      BEPLY_CORRECTIVE_SERIES: 'NR',
      BEPLY_TAX_CODE_0: 'IVA0',
      BEPLY_TAX_CODE_10: 'IVA10',
      BEPLY_TAX_CODE_21: 'IVA21',
      BEPLY_PAYMENT_CODE_REDSYS: 'CARD',
      BEPLY_PAYMENT_CODE_BANK_TRANSFER: 'BANK',
      BEPLY_PAYMENT_CODE_CREDIT: 'CREDIT',
      BEPLY_SUPPORT_FILE_ID: '501'
    } as unknown as CloudflareEnv
    expect(await configuredFiscalProvider(env, policy, w.fetcher)).toBeInstanceOf(BeplyOrderInvoiceProvider)
    expect(w.fetcher).not.toHaveBeenCalled()
  })
  it('chains an immutable synchronized D1 snapshot through the actual fiscal decorator', async () => {
    const w = world(),
      first = vi.fn().mockResolvedValue({
        provider_order_id: '71',
        create_state: 'known',
        synced_version: 1,
        create_payload: JSON.stringify(snapshot)
      })
    const database = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) } as unknown as D1Database
    const fiscal = {
      name: 'beply' as const,
      environment: 'sandbox' as const,
      mappingFingerprint: 'b'.repeat(64),
      issueInvoice: vi.fn(),
      downloadPdf: vi.fn()
    }
    const linked = BeplyOrderInvoiceProvider.fromDatabase(fiscal, database, w.provider)
    expect(await linked.issueInvoice(contract)).toMatchObject({ providerId: '91', amountCents: 1210 })
    expect(fiscal.issueInvoice).not.toHaveBeenCalled()
  })
  it('reads served quantities and DocTransformation edges, without invented header foreign keys', async () => {
    const w = world()
    w.relations.push(
      w.relation('PedidoCliente', 71, 'AlbaranCliente', 81),
      w.relation('AlbaranCliente', 81, 'FacturaCliente', 91)
    )
    expect(await w.provider.readOrder('71', snapshot.orderId)).toEqual({
      served: true,
      deliveryNoteIds: ['81'],
      invoiceIds: ['91']
    })
    expect(
      w.fetcher.mock.calls.some(
        ([input]) => String(input).includes('filter[idpedido]') && String(input).includes('/albaranclientes?')
      )
    ).toBe(false)
  })
  it('uses state-driven order → delivery note → invoice, then pays the linked invoice', async () => {
    const w = world()
    await expect(
      w.provider.convertToInvoice({ kind: 'order', id: '71', providerOrderId: '71' }, contract)
    ).resolves.toMatchObject({ providerId: '91', code: 'FAC91', amountCents: 1210 })
    expect(w.relations).toHaveLength(2)
    const mutations = w.fetcher.mock.calls.filter(([, init]) => init?.method !== 'GET')
    expect(mutations.map(([url]) => String(url).split('/api/3/')[1])).toEqual([
      'pedidoclientes/71',
      'albaranclientes/81',
      'pagarFacturaCliente/91'
    ])
    expect(mutations[0]![1]!.body).toBeInstanceOf(URLSearchParams)
    expect((mutations[1]![1]!.body as URLSearchParams).get('observaciones')).toContain(contract.idempotencyKey)
    await expect(
      w.provider.convertToInvoice({ kind: 'order', id: '71', providerOrderId: '71' }, contract)
    ).resolves.toMatchObject({ providerId: '91' })
    expect(w.relations).toHaveLength(2)
  })
  it('uses an existing delivery note and refuses foreign or partial documents before writes', async () => {
    const w = world()
    w.relations.push(w.relation('PedidoCliente', 71, 'AlbaranCliente', 81))
    w.note.total = '6.05'
    await expect(
      w.provider.convertToInvoice({ kind: 'delivery_note', id: '81', providerOrderId: '71' }, contract)
    ).rejects.toThrow('invoice_source_unconfirmed')
    expect(w.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })
  it('never adopts a previous invoice with a different fiscal intention', async () => {
    const w = world()
    w.relations.push(w.relation('PedidoCliente', 71, 'FacturaCliente', 91))
    await expect(
      w.provider.convertToInvoice({ kind: 'order', id: '71', providerOrderId: '71' }, contract)
    ).rejects.toThrow('invoice_source_unconfirmed')
    expect(w.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })
  it('rejects remote tax reallocation even when the total still matches', async () => {
    const w = world()
    w.order.neto = '9.99'
    w.order.totaliva = '2.11'
    await expect(
      w.provider.convertToInvoice({ kind: 'order', id: '71', providerOrderId: '71' }, contract)
    ).rejects.toThrow('invoice_source_unconfirmed')
    expect(w.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })
  it('does not retry a conversion after a lost response', async () => {
    const w = world()
    w.fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(
      w.provider.convertToInvoice({ kind: 'order', id: '71', providerOrderId: '71' }, contract)
    ).rejects.toMatchObject({ code: 'transport' })
    expect(w.fetcher).toHaveBeenCalledTimes(1)
  })
  it('keeps post-invoice support updates in an editable attachment relation without unlocking fiscal headers', async () => {
    const w = world()
    w.order.editable = false
    await w.provider.updateOrder('71', { ...snapshot, state: 'delivered', version: 2 }, { key, hash })
    const writes = w.fetcher.mock.calls.filter(([, init]) => init?.method !== 'GET')
    expect(writes).toHaveLength(1)
    expect(String(writes[0]![0])).toMatch(/\/attachedfilerelations$/)
    const form = writes[0]![1]!.body as URLSearchParams
    expect(form.get('observations')).toContain('Entregado')
    expect(form.get('model')).toBe('PedidoCliente')
    expect(form.get('modelid')).toBe('71')
    expect(form.get('idfile')).toBe('501')
  })
  it('updates one support relation, preserves manual notes and rejects a colliding identity', async () => {
    const w = world()
    w.order.editable = false
    await w.provider.updateOrder('71', { ...snapshot, state: 'delivered', version: 2 }, { key, hash })
    const [id, record] = [...w.support][0]!
    record.observations += '\nManual support note'
    await w.provider.updateOrder('71', { ...snapshot, state: 'returned', version: 3 }, { key, hash })
    expect(w.support.size).toBe(1)
    expect(w.support.get(id)!.observations).toContain('Manual support note')
    expect(w.support.get(id)!.observations).toContain('Devolución')
    w.support.get(id)!.modelid = '72'
    w.fetcher.mockClear()
    await expect(w.provider.updateOrder('71', snapshot, { key, hash })).rejects.toMatchObject({
      code: 'support_identity_conflict'
    })
    expect(w.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })
  it('recovers a lost conversion response from actual transformation edges without creating another document', async () => {
    const w = world(),
      original = w.fetcher.getMockImplementation()!
    let lost = false
    w.fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (String(input).endsWith('/albaranclientes/81') && init?.method === 'PUT' && !lost) {
        lost = true
        throw new Error('lost after commit')
      }
      return response
    })
    const source = { kind: 'order' as const, id: '71', providerOrderId: '71' }
    await expect(w.provider.convertToInvoice(source, contract)).rejects.toMatchObject({
      code: 'transport',
      ambiguous: true
    })
    expect(w.relations).toHaveLength(2)
    expect(await w.provider.convertToInvoice(source, contract)).toMatchObject({ providerId: '91' })
    expect(
      w.fetcher.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/albaranclientes/81') && init?.method === 'PUT'
      )
    ).toHaveLength(1)
  })
})
