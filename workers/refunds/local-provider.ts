import { z } from 'zod'
import {
  refundContractSchema,
  refundReceiptSchema,
  type RefundContract,
  type RefundReceipt,
  type GovernedRefundProvider
} from '../../shared/order-refunds'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { checked, hash, parsedJson, RefundError } from './authority'
import { canonicalJson } from '../catalog/inventory'

/** Durable local simulation, never a claim that Redsys returned money. */
export class PersistentLocalRefundProvider implements GovernedRefundProvider {
  readonly name = 'local_fake' as const
  readonly environment = 'local_validation' as const
  constructor(
    private database: D1Database,
    readonly mappingFingerprint: string,
    private faults: { responseLost?: boolean; pending?: boolean; badAmount?: boolean } = {}
  ) {
    this.database = guardedFiscalDatabase(database)
  }
  async refund(raw: RefundContract): Promise<RefundReceipt> {
    const contract = checked(refundContractSchema, raw),
      fingerprint = await hash(contract)
    if (
      !contract.validationOnly ||
      contract.provider !== this.name ||
      contract.environment !== this.environment ||
      (await hash(contract.capture.mappings)) !== this.mappingFingerprint
    )
      throw new RefundError('provider_configuration_unconfirmed')
    const value = checked(refundReceiptSchema, {
      providerReference: `LOCAL-REFUND-${contract.refundId}`,
      status: this.faults.pending ? 'pending' : 'succeeded',
      amountCents: contract.amountCents,
      currency: 'EUR',
      merchantOrder: contract.capture.merchantOrder,
      contractFingerprint: fingerprint,
      validationOnly: true
    })
    await this.database
      .prepare(
        'INSERT INTO refund_fake_effects(external_key,contract_fingerprint,receipt_json) VALUES(?1,?2,?3) ON CONFLICT(external_key) DO NOTHING'
      )
      .bind(contract.idempotencyKey, fingerprint, canonicalJson(value))
      .run()
    const proof = await this.lookupByExternalKey(contract.idempotencyKey, fingerprint)
    if (proof.receipts.length !== 1) throw new RefundError('lookup_unconfirmed')
    if (this.faults.responseLost) throw new RefundError('synthetic_response_lost')
    return this.faults.badAmount ? { ...proof.receipts[0]!, amountCents: contract.amountCents + 1 } : proof.receipts[0]!
  }
  async lookupByExternalKey(externalKey: string, fingerprint: string) {
    const raw = await this.database
      .prepare('SELECT contract_fingerprint,receipt_json FROM refund_fake_effects WHERE external_key=?1')
      .bind(externalKey)
      .first()
    if (raw === null)
      return { authoritative: true as const, externalKey, contractFingerprint: fingerprint, receipts: [] }
    const row = checked(
      z.object({ contract_fingerprint: z.literal(fingerprint), receipt_json: z.string().max(16384) }).strict(),
      raw,
      'lookup_unconfirmed'
    )
    return {
      authoritative: true as const,
      externalKey,
      contractFingerprint: fingerprint,
      receipts: [checked(refundReceiptSchema, parsedJson(row.receipt_json), 'lookup_unconfirmed')]
    }
  }
}
