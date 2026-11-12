import { describe, expect, it, vi } from 'vitest'
import { BeplyOrderInvoiceProvider } from '../../workers/fiscal/beply-order-invoice'
import { WorkerBeplyInvoiceProvider } from '../../workers/fiscal/beply-provider'
import { beplyOrderSnapshotFixture as snapshot, beplyFiscalContractFixture as contract } from '../fixtures/beply-orders'
const receipt = {
  providerId: '91',
  code: 'FAC91',
  status: 'issued' as const,
  amountCents: 1210,
  currency: 'EUR' as const
}
function world() {
  const legacy = {
    name: 'beply' as const,
    environment: 'sandbox' as const,
    mappingFingerprint: 'b'.repeat(64),
    issueInvoice: vi.fn(),
    downloadPdf: vi.fn().mockResolvedValue(new Uint8Array([1, 2]))
  }
  const linked = {
    readSource: vi.fn().mockResolvedValue({
      orderId: snapshot.orderId,
      providerOrderId: '71',
      deliveryNoteIds: ['81'],
      invoiceIds: [],
      synced: true,
      totalGrossCents: 1210
    }),
    convertToInvoice: vi.fn().mockResolvedValue(receipt)
  }
  return { legacy, linked, provider: new BeplyOrderInvoiceProvider(legacy, linked) }
}
describe('Beply invoice chaining preserves the fiscal authority boundary', () => {
  it('converts the synchronized delivery note, preserving the fiscal idempotency key and PDF adapter', async () => {
    const w = world()
    await expect(w.provider.issueInvoice(contract)).resolves.toEqual(receipt)
    expect(w.linked.convertToInvoice).toHaveBeenCalledWith(
      { kind: 'delivery_note', id: '81', providerOrderId: '71' },
      contract
    )
    expect(w.legacy.issueInvoice).not.toHaveBeenCalled()
    expect(await w.provider.downloadPdf('91')).toEqual(new Uint8Array([1, 2]))
    expect(w.provider.mappingFingerprint).toBe(w.legacy.mappingFingerprint)
  })
  it('converts the order when no delivery note exists', async () => {
    const w = world()
    w.linked.readSource.mockResolvedValue({
      orderId: snapshot.orderId,
      providerOrderId: '71',
      deliveryNoteIds: [],
      invoiceIds: [],
      synced: true,
      totalGrossCents: 1210
    })
    await w.provider.issueInvoice(contract)
    expect(w.linked.convertToInvoice.mock.calls[0]![0]).toEqual({ kind: 'order', id: '71', providerOrderId: '71' })
  })
  it.each([
    { synced: false },
    { totalGrossCents: 1211 },
    { orderId: '10000000-0000-4000-8000-000000000099' },
    { invoiceIds: ['91'] },
    { deliveryNoteIds: ['81', '82'] }
  ])('blocks unconfirmed, mismatching or already invoiced sources %j', async (patch) => {
    const w = world()
    w.linked.readSource.mockResolvedValue({
      orderId: snapshot.orderId,
      providerOrderId: '71',
      deliveryNoteIds: ['81'],
      invoiceIds: [],
      synced: true,
      totalGrossCents: 1210,
      ...patch
    })
    await expect(w.provider.issueInvoice(contract)).rejects.toThrow('invoice_source_unconfirmed')
    expect(w.linked.convertToInvoice).not.toHaveBeenCalled()
    expect(w.legacy.issueInvoice).not.toHaveBeenCalled()
  })
  it('preserves exact amount validation and never retries conversion on its own', async () => {
    const w = world()
    w.linked.convertToInvoice.mockResolvedValue({ ...receipt, amountCents: 1211 })
    await expect(w.provider.issueInvoice(contract)).rejects.toThrow('provider_amount_mismatch')
    expect(w.linked.convertToInvoice).toHaveBeenCalledTimes(1)
  })
  it('rejects A-08 on the existing worker adapter BEFORE customer or invoice I/O', async () => {
    const request = {
      ...contract,
      lines: [0, 1].map((lineIndex) => ({
        ...contract.lines[0]!,
        lineIndex,
        sku: `SKU${lineIndex}`,
        unitGrossCents: 100,
        unitNetCents: 83,
        lineNetCents: 83,
        netCents: 83,
        taxCents: 17,
        grossCents: 100
      })),
      totalNetCents: 166,
      totalTaxCents: 34,
      totalGrossCents: 200
    }
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('must not reach network'))
    const provider = await WorkerBeplyInvoiceProvider.create(
      {
        baseUrl: 'https://sandbox.beply.es/api/3',
        token: 'synthetic',
        invoiceSeries: 'NE',
        correctiveSeries: 'NR',
        taxCode0: 'IVA0',
        taxCode10: 'IVA10',
        taxCode21: 'IVA21',
        paymentCodeRedsys: 'CARD',
        paymentCodeBankTransfer: 'TRANSFER',
        companyId: '1',
        environment: 'sandbox'
      },
      fetcher
    )
    await expect(provider.issueInvoice(request)).rejects.toMatchObject({ code: 'tax_rounding_review_required' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
