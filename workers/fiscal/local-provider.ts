import {
  fiscalContractSchema,
  fiscalReceiptSchema,
  FISCAL_MAX_PDF_BYTES,
  type FiscalContract,
  type FiscalReceipt,
  type OrdinaryFiscalProvider,
  type FiscalLookupEvidence
} from '../../shared/fiscal-issuance'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { fiscalBatchEvidence } from './d1-boundary'

/** Durable synthetic provider. It performs no fetch, has no credentials, and
 * its records and references are explicitly NOT evidence of Beply acceptance. */
export class PersistentLocalFiscalProvider implements OrdinaryFiscalProvider {
  readonly name = 'local_fake' as const
  readonly environment = 'local_validation' as const
  readonly failures: {
    issue?: 'accepted_response_lost' | 'duplicate' | 'wrong_amount' | 'invalid_receipt' | 'before_acceptance'
    pdf?: 'invalid' | 'too_large' | 'lost'
    lookup?: 'wrong_key' | 'wrong_fingerprint' | 'multiple' | 'unavailable'
  } = {}
  constructor(
    private readonly database: D1Database,
    readonly mappingFingerprint: string
  ) {
    if (!/^[0-9a-f]{64}$/.test(mappingFingerprint)) throw new Error('invalid_local_mapping_fingerprint')
  }
  async issueInvoice(raw: FiscalContract): Promise<FiscalReceipt> {
    const request = fiscalContractSchema.parse(catalogPolicyOwnJson(raw))
    if (!request.validationOnly || request.provider !== 'local_fake' || request.environment !== 'local_validation')
      throw new Error('local_provider_requires_synthetic_contract')
    if (this.failures.issue === 'duplicate') throw new Error('synthetic_duplicate')
    if (this.failures.issue === 'before_acceptance') throw new Error('synthetic_transport_failure')
    const total = request.lines.reduce((sum, line) => sum + line.grossCents, request.shippingGrossCents)
    if (total !== request.totalGrossCents) throw new Error('synthetic_contract_amount_mismatch')
    const fingerprint = await sha256Hex(canonicalJson(request)),
      customerFingerprint = await sha256Hex(canonicalJson(request.customer))
    const providerId = `SYNTHETIC-${fingerprint.slice(0, 24)}`,
      customerId = `SYNTHETIC-CUSTOMER-${customerFingerprint.slice(0, 24)}`
    const receipt: FiscalReceipt = {
      providerId,
      code: `LOCAL-VALIDATION-${fingerprint.slice(0, 16)}`,
      status: 'issued',
      amountCents: total,
      currency: 'EUR'
    }
    const pdf = new TextEncoder().encode(
      `%PDF-1.4\n% SYNTHETIC LOCAL VALIDATION ONLY — NOT A FISCAL BEPLY DOCUMENT\n% ${providerId}\n%%EOF\n`
    )
    fiscalBatchEvidence(
      await this.database.batch([
        this.database
          .prepare(
            `INSERT INTO fiscal_fake_customers(external_key,fingerprint,provider_customer_id)
        VALUES(?1,?2,?3) ON CONFLICT(external_key) DO NOTHING`
          )
          .bind(request.customer.externalKey, customerFingerprint, customerId),
        this.database
          .prepare(
            `INSERT INTO fiscal_fake_invoices(external_key,contract_fingerprint,provider_invoice_id,receipt_json,pdf_bytes)
        VALUES(?1,?2,?3,?4,?5) ON CONFLICT(external_key) DO NOTHING`
          )
          .bind(request.idempotencyKey, fingerprint, providerId, canonicalJson(receipt), pdf),
        this.database
          .prepare(
            `INSERT INTO fiscal_atomic_guards(id,passed)SELECT 1,0 WHERE
        NOT EXISTS(SELECT 1 FROM fiscal_fake_customers WHERE external_key=?1 AND fingerprint=?2)
        OR NOT EXISTS(SELECT 1 FROM fiscal_fake_invoices WHERE external_key=?3 AND contract_fingerprint=?4)`
          )
          .bind(request.customer.externalKey, customerFingerprint, request.idempotencyKey, fingerprint)
      ]),
      3
    )
    if (this.failures.issue === 'accepted_response_lost') throw new Error('synthetic_accepted_response_lost')
    if (this.failures.issue === 'wrong_amount') return { ...receipt, amountCents: receipt.amountCents + 1 }
    if (this.failures.issue === 'invalid_receipt') return { ...receipt, providerId: 'bad / provider id' }
    return receipt
  }
  async lookupByExternalKey(externalKey: string, fingerprint: string): Promise<FiscalLookupEvidence> {
    if (this.failures.lookup === 'unavailable') throw new Error('synthetic_lookup_failure')
    const row = await this.database
      .prepare('SELECT contract_fingerprint,receipt_json FROM fiscal_fake_invoices WHERE external_key=?1')
      .bind(externalKey)
      .first<{ contract_fingerprint: string; receipt_json: string }>()
    if (row && row.contract_fingerprint !== fingerprint) throw new Error('synthetic_lookup_fingerprint_conflict')
    const receipts = row ? [fiscalReceiptSchema.parse(JSON.parse(row.receipt_json))] : []
    if (this.failures.lookup === 'multiple' && receipts[0])
      receipts.push({ ...receipts[0], providerId: 'SYNTHETIC-ANOTHER' })
    return {
      authoritative: true,
      externalKey: this.failures.lookup === 'wrong_key' ? 'WRONG' : externalKey,
      contractFingerprint: this.failures.lookup === 'wrong_fingerprint' ? 'f'.repeat(64) : fingerprint,
      receipts
    }
  }
  async downloadPdf(providerInvoiceId: string): Promise<Uint8Array> {
    if (this.failures.pdf === 'lost') throw new Error('synthetic_pdf_unavailable')
    if (this.failures.pdf === 'invalid')
      return new TextEncoder().encode('<html>not a PDF and not a fiscal receipt</html>')
    if (this.failures.pdf === 'too_large') return new Uint8Array(FISCAL_MAX_PDF_BYTES + 1)
    const row = await this.database
      .prepare('SELECT pdf_bytes FROM fiscal_fake_invoices WHERE provider_invoice_id=?1')
      .bind(providerInvoiceId)
      .first<unknown>()
    if (row === null) throw new Error('synthetic_pdf_not_found')
    if (!row || typeof row !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(row)))
      throw new Error('synthetic_pdf_invalid_source')
    const descriptor = Object.getOwnPropertyDescriptor(row, 'pdf_bytes')
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('synthetic_pdf_invalid_source')
    return localFiscalBlobBytes(descriptor.value)
  }
}
/** Native D1 BLOBs may be ArrayBuffer/byte arrays; node:sqlite returns a typed
 * array. All variants must be ordinary, bounded, owned dense data before copy. */
export function localFiscalBlobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype) {
    if (value.byteLength < 16 || value.byteLength > FISCAL_MAX_PDF_BYTES)
      throw new Error('synthetic_pdf_invalid_source')
    return Uint8Array.from(value)
  }
  if (value instanceof ArrayBuffer && Object.getPrototypeOf(value) === ArrayBuffer.prototype) {
    if (value.byteLength < 16 || value.byteLength > FISCAL_MAX_PDF_BYTES)
      throw new Error('synthetic_pdf_invalid_source')
    return new Uint8Array(value.slice(0))
  }
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 16 ||
    value.length > FISCAL_MAX_PDF_BYTES ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new Error('synthetic_pdf_invalid_source')
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable ||
      typeof descriptor.value !== 'number' ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    )
      throw new Error('synthetic_pdf_invalid_source')
    bytes[index] = descriptor.value
  }
  return bytes
}
