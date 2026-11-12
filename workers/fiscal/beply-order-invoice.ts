import { z } from 'zod'
import {
  assertBeplyTaxCompatibility,
  beplyOrderSnapshotSchema,
  beplyRemoteId,
  type BeplyTaxMethod
} from '../../shared/beply-orders'
import type { BeplyOrdersProvider } from '../integrations/beply-orders-provider'
import {
  fiscalContractSchema,
  fiscalReceiptSchema,
  fiscalUuid,
  type FiscalContract,
  type FiscalReceipt,
  type OrdinaryFiscalProvider
} from '../../shared/fiscal-issuance'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'

const sourceSchema = z
  .object({
    orderId: fiscalUuid,
    providerOrderId: beplyRemoteId,
    deliveryNoteIds: z.array(beplyRemoteId).max(100),
    invoiceIds: z.array(beplyRemoteId).max(100),
    totalGrossCents: z.number().int().positive(),
    synced: z.boolean()
  })
  .strict()
export interface BeplyInvoiceSource {
  kind: 'order' | 'delivery_note'
  id: string
  providerOrderId: string
}
export interface BeplyLinkedInvoiceAdapter {
  readSource(orderId: string): Promise<z.infer<typeof sourceSchema> | null>
  /** A verified server document-conversion operation is required. No guessed
   * REST endpoint and no fallback to an unrelated standalone invoice. */
  convertToInvoice(source: BeplyInvoiceSource, contract: FiscalContract): Promise<FiscalReceipt>
}
/** Decorates the existing governed fiscal provider: policy, series, amount,
 * issuance lease, uncertain outcome protocol and private PDF storage stay owned
 * by fiscal/issuance.ts. This adapter grants no authority and retries nothing. */
export class BeplyOrderInvoiceProvider implements OrdinaryFiscalProvider {
  readonly name = 'beply' as const
  readonly environment: OrdinaryFiscalProvider['environment']
  readonly mappingFingerprint: string
  constructor(
    private readonly fiscal: OrdinaryFiscalProvider,
    private readonly linked: BeplyLinkedInvoiceAdapter,
    private readonly taxMethod: BeplyTaxMethod = 'classic'
  ) {
    if (fiscal.name !== 'beply') throw new Error('invoice_source_unconfirmed')
    this.environment = fiscal.environment
    this.mappingFingerprint = fiscal.mappingFingerprint
  }
  static fromDatabase(fiscal: OrdinaryFiscalProvider, database: D1Database, orders: BeplyOrdersProvider) {
    const load = async (orderId: string) => {
      const row = await database
        .prepare(
          `SELECT provider_order_id,create_payload,create_state,synced_version FROM beply_order_sync WHERE order_id=?1`
        )
        .bind(fiscalUuid.parse(orderId))
        .first<{
          provider_order_id: string | null
          create_payload: string | null
          create_state: string
          synced_version: number
        }>()
      if (
        !row ||
        row.create_state !== 'known' ||
        !row.provider_order_id ||
        !row.create_payload ||
        row.synced_version < 1
      )
        return null
      const snapshot = beplyOrderSnapshotSchema.parse(JSON.parse(row.create_payload))
      if (snapshot.orderId !== orderId) throw new Error('invoice_source_unconfirmed')
      return { row, snapshot }
    }
    return new BeplyOrderInvoiceProvider(
      fiscal,
      {
        async readSource(orderId) {
          const source = await load(orderId)
          if (!source) return null
          const facts = await orders.readOrder(source.row.provider_order_id!, orderId)
          return {
            orderId,
            providerOrderId: source.row.provider_order_id!,
            totalGrossCents: source.snapshot.totalGrossCents,
            synced: true,
            deliveryNoteIds: facts.deliveryNoteIds,
            invoiceIds: facts.invoiceIds
          }
        },
        async convertToInvoice(source, contract) {
          const local = await load(contract.orderId)
          if (
            !local ||
            local.row.provider_order_id !== source.providerOrderId ||
            local.snapshot.customer.externalKey !== contract.customer.externalKey ||
            local.snapshot.totalNetCents !== contract.totalNetCents ||
            local.snapshot.totalTaxCents !== contract.totalTaxCents ||
            local.snapshot.shippingNetCents !== contract.shippingNetCents ||
            local.snapshot.shippingTaxCents !== contract.shippingTaxCents ||
            local.snapshot.lines.length !== contract.lines.length ||
            local.snapshot.lines.some(
              (line) =>
                !contract.lines.some(
                  (other) =>
                    other.lineIndex === line.lineIndex &&
                    other.sku === line.sku &&
                    other.quantity === line.quantity &&
                    other.netCents === line.netCents &&
                    other.taxCents === line.taxCents &&
                    other.taxRateBasisPoints === line.taxRateBasisPoints
                )
            )
          )
            throw new Error('invoice_source_unconfirmed')
          return orders.convertToInvoice(source, contract)
        }
      },
      orders.taxCalculationMethod
    )
  }
  downloadPdf(providerInvoiceId: string): Promise<Uint8Array> {
    return this.fiscal.downloadPdf(providerInvoiceId)
  }
  async issueInvoice(raw: FiscalContract): Promise<FiscalReceipt> {
    const contract = fiscalContractSchema.parse(catalogPolicyOwnJson(raw))
    if (contract.provider !== 'beply' || contract.environment !== this.environment || contract.validationOnly)
      throw new Error('invoice_source_unconfirmed')
    assertBeplyTaxCompatibility(contract, this.taxMethod)
    const parsed = sourceSchema.safeParse(catalogPolicyOwnJson(await this.linked.readSource(contract.orderId)))
    if (
      !parsed.success ||
      !parsed.data.synced ||
      parsed.data.orderId !== contract.orderId ||
      parsed.data.totalGrossCents !== contract.totalGrossCents ||
      parsed.data.invoiceIds.length > 0 ||
      parsed.data.deliveryNoteIds.length > 1
    )
      throw new Error('invoice_source_unconfirmed')
    const source = parsed.data,
      noteId = source.deliveryNoteIds[0]
    const receipt = fiscalReceiptSchema.parse(
      await this.linked.convertToInvoice(
        {
          kind: noteId ? 'delivery_note' : 'order',
          id: noteId ?? source.providerOrderId,
          providerOrderId: source.providerOrderId
        },
        contract
      )
    )
    if (receipt.amountCents !== contract.totalGrossCents || receipt.currency !== contract.currency)
      throw new Error('provider_amount_mismatch')
    return receipt
  }
}
