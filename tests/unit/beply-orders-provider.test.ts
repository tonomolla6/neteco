import { describe, expect, it, vi } from 'vitest'
import { BeplyOrdersProvider, BeplyOrdersProviderError } from '../../workers/integrations/beply-orders-provider'
import {
  assertBeplyTaxCompatibility,
  beplyOrderSnapshotSchema,
  beplySupportObservation
} from '../../shared/beply-orders'
import {
  beplyShippingContactFixture,
  beplyDeliveryFixture,
  beplyOrderFixture,
  beplyOrderSnapshotFixture as fixture
} from '../fixtures/beply-orders'

const config = {
  baseUrl: 'https://sandbox.beply.es/api/3',
  token: 'synthetic-token',
  environment: 'sandbox' as const,
  companyId: '1',
  orderSeries: 'NE',
  paymentCodes: { redsys: 'CARD', bank_transfer: 'TRANSFER', credit: 'CREDIT' },
  taxCodes: { '0': 'IVA0', '1000': 'IVA10', '2100': 'IVA21' },
  timeoutMs: 1000
}
const json = (body: unknown, status = 200) => Response.json(body, { status })
const key = `neteco-order:${fixture.orderId}`
const hash = 'a'.repeat(64)

describe('Beply orders synthetic API contracts', () => {
  it('synchronizes A-08 with the explicitly attested price-adjusted core setting', async () => {
    const lines = [0, 1].map((lineIndex) => ({
      ...fixture.lines[0]!,
      lineIndex,
      variantId: `v${lineIndex}`,
      sku: `SKU${lineIndex}`,
      netCents: 83,
      taxCents: 17,
      grossCents: 100
    }))
    const snapshot = { ...fixture, lines, totalNetCents: 166, totalTaxCents: 34, totalGrossCents: 200 }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/variantes')) return json([{ referencia: 'SKU0' }, { referencia: 'SKU1' }])
      if (path.endsWith('/settings/default'))
        return json({ name: 'default', properties: '{"taxcalculationmethod":"price-adjusted"}' })
      if (path.endsWith('/clientes')) return json({ ok: 'created' })
      if (path.endsWith('/contactos'))
        return json({ ok: 'created', data: Object.fromEntries(init!.body as URLSearchParams) })
      if (path.endsWith('/crearPedidoCliente'))
        return json({
          doc: { ...beplyOrderFixture, total: '2.00', neto: '1.66', totaliva: '0.34' },
          lines: JSON.parse((init!.body as URLSearchParams).get('lineas')!)
        })
      throw new Error('Unexpected source contract')
    })
    expect(
      await new BeplyOrdersProvider({ ...config, taxCalculationMethod: 'price-adjusted' }, fetcher).createOrder(
        snapshot,
        { key, hash }
      )
    ).toMatchObject({ providerOrderId: '71' })
  })
  it('rejects a different ERP calculator setting before customer, contact or order writes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ referencia: 'SKU-1' }]))
      .mockResolvedValueOnce(json({ name: 'default', properties: '{"taxcalculationmethod":"price-adjusted"}' }))
    await expect(new BeplyOrdersProvider(config, fetcher).createOrder(fixture, { key, hash })).rejects.toMatchObject({
      code: 'calculator_configuration_mismatch'
    })
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })
  it('never posts a document when a SKU is missing from the ERP variant catalog', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json([]))
    await expect(new BeplyOrdersProvider(config, fetcher).createOrder(fixture, { key, hash })).rejects.toMatchObject({
      code: 'product_mapping_missing',
      ambiguous: false
    })
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })
  it('keeps a failed customer upsert retryable without treating it as an ambiguous order POST', async () => {
    const provider = new BeplyOrdersProvider(
      config,
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json([{ referencia: 'SKU-1' }]))
        .mockResolvedValueOnce(json({ name: 'default', properties: '{}' }))
        .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
    )
    await expect(provider.createOrder(fixture, { key, hash })).rejects.toMatchObject({
      retryable: true,
      ambiguous: false
    })
  })
  it('treats invalid document evidence after an accepted POST as an uncertain creation', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ referencia: 'SKU-1' }]))
      .mockResolvedValueOnce(json({ name: 'default', properties: '{}' }))
      .mockResolvedValueOnce(json({ codcliente: 'synthetic' }))
      .mockResolvedValueOnce(json({ ok: 'created', data: beplyShippingContactFixture }))
      .mockResolvedValueOnce(json({ ...beplyOrderFixture, total: '12.11' }))
    await expect(new BeplyOrdersProvider(config, fetcher).createOrder(fixture, { key, hash })).rejects.toMatchObject({
      code: 'amount_mismatch',
      ambiguous: true
    })
  })
  it('creates header and all lines after customer upsert, with shipping address and external reference', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ referencia: 'SKU-1' }]))
      .mockResolvedValueOnce(json({ name: 'default', properties: '{}' }))
      .mockResolvedValueOnce(json({ codcliente: beplyOrderFixture.codcliente }, 201))
      .mockResolvedValueOnce(json({ ok: 'created', data: beplyShippingContactFixture }))
      .mockResolvedValueOnce(json({ doc: beplyOrderFixture, lines: [] }))
    const provider = new BeplyOrdersProvider(config, fetcher)
    await expect(provider.createOrder(fixture, { key, hash })).resolves.toMatchObject({
      providerOrderId: '71',
      code: 'PED2026NE71'
    })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://sandbox.beply.es/api/3/variantes?filter[referencia_gte]=SKU-1&filter[referencia_lte]=SKU-1&limit=100&offset=0',
      'https://sandbox.beply.es/api/3/settings/default',
      'https://sandbox.beply.es/api/3/clientes',
      'https://sandbox.beply.es/api/3/contactos',
      'https://sandbox.beply.es/api/3/crearPedidoCliente'
    ])
    const init = fetcher.mock.calls[4]![1]!
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Token: 'synthetic-token', 'Idempotency-Key': key }
    })
    const body = init.body as URLSearchParams
    expect(Object.fromEntries(body)).toMatchObject({
      numero2: fixture.orderNumber,
      codpago: 'CARD',
      codserie: 'NE',
      direccion: 'Synthetic Street 1',
      idcontactoenv: expect.stringMatching(/^\d+$/),
      codpais: 'ESP'
    })
    expect(JSON.parse(body.get('lineas')!)).toEqual([
      expect.objectContaining({
        referencia: 'SKU-1',
        cantidad: 1,
        pvpunitario: '10.000000',
        iva: 21,
        codimpuesto: 'IVA21'
      })
    ])
    expect(body.get('observaciones')).toContain(hash)
    expect(body.get('observaciones')).toContain('Confirmado')
  })
  it('preserves variant references, net discounts already in snapshots, shipping and credit payment', async () => {
    const snapshot = {
      ...fixture,
      paymentMethod: 'credit' as const,
      shippingNetCents: 100,
      shippingTaxCents: 21,
      shippingGrossCents: 121,
      totalNetCents: 1100,
      totalTaxCents: 231,
      totalGrossCents: 1331
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ referencia: 'SKU-1' }]))
      .mockResolvedValueOnce(json({ name: 'default', properties: '{}' }))
      .mockResolvedValueOnce(json({ codcliente: beplyOrderFixture.codcliente }))
      .mockResolvedValueOnce(json({ ok: 'created', data: beplyShippingContactFixture }))
      .mockResolvedValueOnce(json({ ...beplyOrderFixture, total: '13.31' }))
    await new BeplyOrdersProvider(config, fetcher).createOrder(snapshot, { key, hash })
    const form = fetcher.mock.calls[4]![1]!.body as URLSearchParams
    expect(form.get('codpago')).toBe('CREDIT')
    expect(JSON.parse(form.get('lineas')!)).toHaveLength(2)
    expect(form.get('observaciones')).toContain('variant-1')
  })
  it('finds only the exact external reference and immutable create fingerprint after an ambiguous POST', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json([{ ...beplyOrderFixture, observaciones: `NETECO key=${key}; hash=${hash};` }]))
    const provider = new BeplyOrdersProvider(config, fetcher)
    await expect(provider.lookupOrder(fixture, { key, hash })).resolves.toMatchObject({ providerOrderId: '71' })
    expect(String(fetcher.mock.calls[0]![0])).toContain('pedidoclientes?filter[numero2]=')
    fetcher.mockResolvedValue(json([{ ...beplyOrderFixture, observaciones: 'other document' }]))
    await expect(provider.lookupOrder(fixture, { key, hash })).rejects.toMatchObject({ code: 'identity_conflict' })
    fetcher.mockResolvedValue(json([beplyOrderFixture, beplyOrderFixture]))
    await expect(provider.lookupOrder(fixture, { key, hash })).rejects.toMatchObject({ code: 'identity_conflict' })
  })
  it('puts legible support status/ETA and every carrier/tracking without overwriting ERP status', async () => {
    const snapshot = {
      ...fixture,
      state: 'shipped' as const,
      version: 2,
      expectedDeliveryAt: '2026-11-14T10:00:00Z',
      shipments: [{ parcelIndex: 0, carrier: 'Synthetic carrier', trackingNumber: 'TRACK1', shipmentNumber: 'SHIP1' }]
    }
    const existing = { ...beplyOrderFixture, observaciones: `Manual note\nNETECO key=${key}; hash=${hash};` }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(existing)).mockResolvedValueOnce(json(existing))
    await new BeplyOrdersProvider(config, fetcher).updateOrder('71', snapshot, { key, hash })
    const form = fetcher.mock.calls[1]![1]!.body as URLSearchParams
    expect([...form.keys()]).toEqual(['observaciones'])
    expect(form.get('observaciones')).toContain('Manual note')
    expect(form.get('observaciones')).toContain('Enviado')
    expect(form.get('observaciones')).toContain('TRACK1')
    expect(form.get('observaciones')).toContain('2026-11-14T10:00:00Z')
  })
  it('reads ERP served, delivery notes and invoices without inventing delivery confirmation', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(beplyOrderFixture))
      .mockResolvedValueOnce(json([{ idpedido: 71, cantidad: 1, servido: 1 }]))
      .mockResolvedValueOnce(
        json([
          { model1: 'PedidoCliente', iddoc1: 71, model2: 'AlbaranCliente', iddoc2: beplyDeliveryFixture.idalbaran }
        ])
      )
      .mockResolvedValueOnce(json([{ model1: 'AlbaranCliente', iddoc1: 81, model2: 'FacturaCliente', iddoc2: 91 }]))
    await expect(new BeplyOrdersProvider(config, fetcher).readOrder('71', fixture.orderNumber)).resolves.toMatchObject({
      served: true,
      deliveryNoteIds: ['81'],
      invoiceIds: ['91']
    })
    const bad = vi.fn<typeof fetch>().mockResolvedValue(json({ ...beplyOrderFixture, numero2: 'someone-else' }))
    await expect(new BeplyOrdersProvider(config, bad).readOrder('71', fixture.orderNumber)).rejects.toMatchObject({
      code: 'identity_conflict'
    })
  })
  it.each([401, 403, 422, 429, 503])('sanitizes HTTP %s errors and classifies retryability', async (status) => {
    const provider = new BeplyOrdersProvider(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(new Response('secret / customer PII', { status }))
    )
    const error = await provider.readOrder('71', fixture.orderNumber).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(BeplyOrdersProviderError)
    expect(error).toMatchObject({ retryable: status === 429 || status === 503 })
    expect(String(error)).not.toMatch(/secret|PII|synthetic-token/)
  })
  it('bounds responses and rejects malformed JSON and forged document identity', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(262145), { headers: { 'content-type': 'application/json' } }))
    await expect(new BeplyOrdersProvider(config, fetcher).readOrder('71', fixture.orderNumber)).rejects.toMatchObject({
      code: 'invalid_response'
    })
    fetcher.mockResolvedValue(json({ ...beplyOrderFixture, idpedido: 72 }))
    await expect(new BeplyOrdersProvider(config, fetcher).readOrder('71', fixture.orderNumber)).rejects.toMatchObject({
      code: 'identity_conflict'
    })
  })
  it.each([
    'https://neteco.beply.es/api/3',
    'https://sandbox.beply.es/api/2',
    'http://sandbox.beply.es/api/3',
    'https://sandbox.beply.es/api/3?token=x'
  ])('rejects unsafe configuration %s before fetch', (baseUrl) => {
    const fetcher = vi.fn<typeof fetch>()
    expect(() => new BeplyOrdersProvider({ ...config, baseUrl }, fetcher)).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('order snapshot and fiscal compatibility boundaries', () => {
  it('validates totals, unique variants/line indices, dates and shipment state', () => {
    expect(beplyOrderSnapshotSchema.safeParse(fixture).success).toBe(true)
    for (const input of [
      { ...fixture, totalGrossCents: 1211 },
      { ...fixture, lines: [...fixture.lines, ...fixture.lines] },
      { ...fixture, confirmedAt: '2026-02-30T00:00:00Z' },
      {
        ...fixture,
        state: 'confirmed',
        shipments: [{ parcelIndex: 0, carrier: 'c', trackingNumber: 't', shipmentNumber: 's' }]
      }
    ])
      expect(beplyOrderSnapshotSchema.safeParse(input).success).toBe(false)
  })
  it('blocks A-08 before any provider mutation; never silently adjusts a captured order', async () => {
    const snapshot = {
      ...fixture,
      lines: [0, 1].map((lineIndex) => ({
        ...fixture.lines[0]!,
        lineIndex,
        variantId: `v${lineIndex}`,
        sku: `SKU${lineIndex}`,
        netCents: 83,
        taxCents: 17,
        grossCents: 100
      })),
      totalNetCents: 166,
      totalTaxCents: 34,
      totalGrossCents: 200
    }
    expect(() => assertBeplyTaxCompatibility(snapshot)).toThrow('tax_rounding_review_required')
    const fetcher = vi.fn<typeof fetch>()
    await expect(new BeplyOrdersProvider(config, fetcher).createOrder(snapshot, { key, hash })).rejects.toMatchObject({
      code: 'tax_rounding_review_required'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('documents state and variants in a bounded human-readable observation', () => {
    expect(beplySupportObservation(fixture, { key, hash })).toContain('SKU-1')
    expect(beplySupportObservation({ ...fixture, state: 'returned' }, { key, hash })).toContain('Devolución')
  })
})

describe('operational state source of truth', () => {
  it('distinguishes a requested return from goods actually received', async () => {
    const { beplyStateFromFacts } = await import('../../shared/beply-orders')
    expect(
      beplyStateFromFacts({ cancelled: false, returnState: 'requested', fulfillment: 'delivered', hasShipments: true })
    ).toBe('return_requested')
    expect(
      beplyStateFromFacts({ cancelled: false, returnState: 'received', fulfillment: 'delivered', hasShipments: true })
    ).toBe('returned')
    expect(
      beplyStateFromFacts({ cancelled: true, returnState: 'received', fulfillment: 'delivered', hasShipments: true })
    ).toBe('cancelled')
    expect(
      beplyStateFromFacts({ cancelled: false, returnState: null, fulfillment: 'packed', hasShipments: false })
    ).toBe('preparing')
    expect(
      beplyStateFromFacts({ cancelled: false, returnState: 'rejected', fulfillment: 'in_transit', hasShipments: true })
    ).toBe('shipped')
  })
})
