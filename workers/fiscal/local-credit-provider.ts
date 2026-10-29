import { z } from 'zod'
import {
  creditContractSchema,
  creditReceiptSchema,
  type CreditContract,
  type CreditFiscalProvider
} from '../../shared/fiscal-credit'
import { fiscalBatchEvidence, guardedFiscalDatabase } from './d1-boundary'
import { localFiscalBlobBytes } from './local-provider'
import { canonicalJson } from '../catalog/inventory'
import { checked, hash, parsedJson, RefundError, guard } from '../refunds/authority'

export class PersistentLocalCreditProvider implements CreditFiscalProvider {
  readonly name = 'local_fake' as const
  readonly environment = 'local_validation' as const
  readonly failures: { responseLost?: boolean; pdfInvalid?: boolean; pdfLost?: boolean; pending?: boolean } = {}
  constructor(
    private readonly database: D1Database,
    readonly mappingFingerprint: string
  ) {}
  async issueCreditNote(raw: CreditContract) {
    const contract = checked(creditContractSchema, raw),
      fingerprint = await hash(contract),
      providerId = `SYNTHETIC-CREDIT-${fingerprint.slice(0, 24)}`
    if (!contract.validationOnly || contract.provider !== this.name || contract.environment !== this.environment)
      throw new RefundError('provider_configuration_unconfirmed')
    const receipt = checked(creditReceiptSchema, {
      providerId,
      code: `LOCAL-CREDIT-${fingerprint.slice(0, 16)}`,
      status: this.failures.pending ? 'fiscal_pending' : 'issued',
      amountCents: contract.amountCents,
      currency: 'EUR',
      sourceProviderInvoiceId: contract.sourceProviderInvoiceId,
      documentKind: 'credit_note',
      contractFingerprint: fingerprint,
      validationOnly: true
    })
    const pdf = new TextEncoder().encode(
      `%PDF-1.4\n% SYNTHETIC LOCAL CREDIT — NOT A FISCAL DOCUMENT\n% ${providerId}\n%%EOF\n`
    )
    fiscalBatchEvidence(
      await this.database.batch([
        this.database
          .prepare(
            'INSERT INTO fiscal_fake_credits(external_key,contract_fingerprint,provider_invoice_id,receipt_json,pdf_bytes) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(external_key) DO NOTHING'
          )
          .bind(contract.idempotencyKey, fingerprint, providerId, canonicalJson(receipt), pdf),
        guard(
          this.database,
          'EXISTS(SELECT 1 FROM fiscal_fake_credits WHERE external_key=?1 AND contract_fingerprint=?2)',
          [contract.idempotencyKey, fingerprint]
        )
      ]),
      2
    )
    if (this.failures.responseLost) throw new RefundError('synthetic_response_lost')
    return (await this.lookupByExternalKey(contract.idempotencyKey, fingerprint)).receipts[0]!
  }
  async lookupByExternalKey(externalKey: string, fingerprint: string) {
    const raw = await guardedFiscalDatabase(this.database)
      .prepare('SELECT contract_fingerprint,receipt_json FROM fiscal_fake_credits WHERE external_key=?1')
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
      receipts: [checked(creditReceiptSchema, parsedJson(row.receipt_json), 'lookup_unconfirmed')]
    }
  }
  async downloadPdf(providerId: string): Promise<Uint8Array> {
    if (this.failures.pdfLost) throw new RefundError('synthetic_pdf_lost')
    if (this.failures.pdfInvalid) return new TextEncoder().encode('synthetic invalid PDF')
    const row = await this.database
      .prepare('SELECT pdf_bytes FROM fiscal_fake_credits WHERE provider_invoice_id=?1')
      .bind(providerId)
      .first()
    if (!row || typeof row !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(row)))
      throw new RefundError('document_unconfirmed')
    const bytes = Object.getOwnPropertyDescriptor(row, 'pdf_bytes')
    if (!bytes || !Object.hasOwn(bytes, 'value')) throw new RefundError('document_unconfirmed')
    return localFiscalBlobBytes(bytes.value)
  }
}
