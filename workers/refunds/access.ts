import { z } from 'zod'
import { orderRefundsViewSchema, refundViewSchema, type OrderRefundsView } from '../../shared/order-refunds'
import { creditViewSchema, type CreditView } from '../../shared/fiscal-credit'
import { fiscalUuid, fiscalHash, type PrivateFiscalStorage } from '../../shared/fiscal-issuance'
import { authorizeFiscalOrder, type FiscalOrderAccess } from '../fiscal/access'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { checksumFiscalPdf } from '../fiscal/issuance'
import { readCreditContract, validateCreditReceipt } from '../fiscal/credit-notes'
import { readRefundContract, readRefundWork, validateRefundReceipt } from './operations'
import { capturedSource } from './source'
import { checked, clock, RefundError, hash, parsedJson } from './authority'
import { readFinancialPolicy } from './policies'
import { localFiscalBlobBytes } from '../fiscal/local-provider'

export async function readD1OrderRefunds(
  database: D1Database,
  access: FiscalOrderAccess,
  orderId: string,
  options: { now?: string; appEnvironment: 'local' | 'preview' | 'production' }
): Promise<OrderRefundsView> {
  database = guardedFiscalDatabase(database)
  const now = clock(options)
  await authorizeFiscalOrder(database, access, orderId, now())
  const source = await capturedSource(database, orderId)
  const ids = checked(
    z
      .array(
        z
          .object({
            id: fiscalUuid,
            planned_by: fiscalUuid,
            credit_id: fiscalUuid.nullable(),
            receipt_json: z.string().max(16384).nullable(),
            event_payload: z.string().max(16384).nullable(),
            corrective: z.enum(['blocked_policy', 'blocked_source', 'queued', 'completed']).nullable(),
            credit_status: z.string().nullable()
          })
          .strict()
      )
      .max(100),
    (
      await database
        .prepare(
          `SELECT c.id,c.planned_by,credit.id AS credit_id,receipt.receipt_json,event.payload_json AS event_payload,o.status AS corrective,w.status AS credit_status FROM refund_contracts c LEFT JOIN refund_credit_obligations o ON o.refund_id=c.id LEFT JOIN refund_receipts receipt ON receipt.refund_id=c.id AND receipt.status='succeeded' LEFT JOIN order_events event ON event.id=o.source_event_id AND event.order_id=c.order_id AND event.correlation_id=c.id AND event.event_type='refund.succeeded' LEFT JOIN fiscal_credit_contracts credit ON credit.refund_id=c.id LEFT JOIN fiscal_credit_work w ON w.credit_id=credit.id WHERE c.order_id=?1 ORDER BY c.created_at,c.id LIMIT 101`
        )
        .bind(orderId)
        .all()
    ).results,
    'read_unconfirmed'
  )
  const items = []
  for (const row of ids) {
    const { contract, fingerprint } = await readRefundContract(database, row.id),
      work = await readRefundWork(database, row.id)
    if (work.status === 'completed') {
      if (row.receipt_json === null || row.event_payload === null || row.corrective === null)
        throw new RefundError('read_unconfirmed')
      const receipt = validateRefundReceipt(contract, fingerprint, parsedJson(row.receipt_json)),
        event = checked(
          z
            .object({
              refundId: z.literal(contract.refundId),
              returnId: z.literal(contract.returnId),
              amountCents: z.literal(contract.amountCents),
              validationOnly: z.literal(contract.validationOnly)
            })
            .strict(),
          parsedJson(row.event_payload),
          'read_unconfirmed'
        )
      if (receipt.status !== 'succeeded' || event.refundId !== contract.refundId)
        throw new RefundError('read_unconfirmed')
    }
    const policy = access.kind === 'admin' ? await readFinancialPolicy(database, contract.policyId, 'refund') : null
    if (contract.validationOnly && options.appEnvironment !== 'local') throw new RefundError('not_found')
    items.push(
      checked(
        refundViewSchema,
        {
          source: 'cloudflare',
          id: contract.refundId,
          orderId,
          returnPublicRef: contract.returnPublicRef,
          workflow: work.status,
          generation: work.generation,
          contractFingerprint: fingerprint,
          amountCents: contract.amountCents,
          ...(contract.tender ? { tender: contract.tender } : {}),
          components: contract.components,
          creditId: row.credit_id,
          currency: 'EUR',
          validationOnly: contract.validationOnly,
          financialStatus:
            work.status === 'completed'
              ? contract.validationOnly
                ? 'validation_completed'
                : 'succeeded'
              : work.status === 'cancelled'
                ? 'cancelled'
                : work.status === 'pending_provider'
                  ? 'pending'
                  : work.submitted_at !== null
                    ? 'uncertain'
                    : 'not_submitted',
          correctiveStatus:
            row.credit_status === 'uncertain' || row.credit_status === 'reconciling'
              ? 'uncertain'
              : row.credit_status === 'manual_review'
                ? 'manual_review'
                : row.credit_status === 'issuing'
                  ? 'issuing'
                  : (row.corrective ?? 'not_due'),
          lastErrorCode: access.kind === 'admin' ? work.last_error_code : null,
          inventoryEffect: 'none',
          custody: 'non_sellable',
          capabilities: {
            confirm:
              access.kind === 'admin' &&
              work.status === 'awaiting_confirmation' &&
              policy !== null &&
              (policy.approvalMode !== 'distinct_actor' || row.planned_by !== access.claims.identityId),
            cancel:
              access.kind === 'admin' &&
              work.submitted_at === null &&
              ['awaiting_confirmation', 'queued', 'leased', 'manual_review'].includes(work.status),
            reconcile: access.kind === 'admin' && ['uncertain', 'pending_provider'].includes(work.status),
            resend: false
          }
        },
        'read_unconfirmed'
      )
    )
  }
  const response = checked(
    orderRefundsViewSchema,
    {
      source: 'cloudflare',
      orderId,
      capturedCents: source.capture.capturedCents,
      ...(source.storeCreditCents > 0 ? { storeCreditCents: source.storeCreditCents } : {}),
      reservedCents: items
        .filter((item) => item.workflow !== 'cancelled')
        .reduce((sum, item) => sum + item.amountCents, 0),
      confirmedCents: items
        .filter((item) => item.workflow === 'completed' && !item.validationOnly)
        .reduce((sum, item) => sum + item.amountCents, 0),
      simulatedConfirmedCents: items
        .filter((item) => item.workflow === 'completed' && item.validationOnly)
        .reduce((sum, item) => sum + item.amountCents, 0),
      currency: 'EUR',
      items,
      inventoryEffect: 'none'
    },
    'read_unconfirmed'
  )
  await authorizeFiscalOrder(database, access, orderId, now())
  return response
}
export async function readD1CreditNote(
  database: D1Database,
  access: FiscalOrderAccess,
  orderId: string,
  id: string,
  options: { now?: string; appEnvironment: 'local' | 'preview' | 'production' }
): Promise<CreditView> {
  database = guardedFiscalDatabase(database)
  const now = clock(options)
  await authorizeFiscalOrder(database, access, orderId, now())
  const { contract } = await readCreditContract(database, id)
  if (contract.orderId !== orderId || (contract.validationOnly && options.appEnvironment !== 'local'))
    throw new RefundError('not_found')
  const raw = await database
    .prepare(
      `SELECT w.status,w.generation,w.last_error_code,r.receipt_json,d.credit_id AS document,
        EXISTS(SELECT 1 FROM financial_events event WHERE event.scope='credit' AND event.target_id=w.credit_id AND event.event_kind='completed' AND event.generation=w.generation AND event.created_at=w.completed_at) AS completion_confirmed,
        EXISTS(SELECT 1 FROM order_events event WHERE event.order_id=?2 AND event.correlation_id=w.credit_id AND event.event_type='invoice.issued' AND json_extract(event.payload_json,'$.invoiceId')=w.credit_id AND json_extract(event.payload_json,'$.documentKind')='credit_note') AS source_confirmed
       FROM fiscal_credit_work w LEFT JOIN fiscal_credit_receipts r ON r.credit_id=w.credit_id LEFT JOIN fiscal_credit_documents d ON d.credit_id=w.credit_id AND d.created_at=w.completed_at WHERE w.credit_id=?1`
    )
    .bind(id, orderId)
    .first()
  const row = checked(
    z
      .object({
        status: z.string(),
        generation: z.number().int(),
        last_error_code: z.string().nullable(),
        receipt_json: z.string().nullable(),
        document: fiscalUuid.nullable(),
        completion_confirmed: z.union([z.literal(0), z.literal(1)]),
        source_confirmed: z.union([z.literal(0), z.literal(1)])
      })
      .strict(),
    raw,
    'read_unconfirmed'
  )
  const receipt =
    row.receipt_json === null
      ? null
      : validateCreditReceipt(contract, await hash(contract), parsedJson(row.receipt_json))
  if (
    row.status === 'completed' &&
    (row.document === null || row.completion_confirmed !== 1 || row.source_confirmed !== 1)
  )
    throw new RefundError('read_unconfirmed')
  const response = checked(
    creditViewSchema,
    {
      source: 'cloudflare',
      id,
      refundId: contract.refundId,
      orderId,
      sourceInvoiceId: contract.sourceInvoiceId,
      workflow: row.status,
      generation: row.generation,
      amountCents: contract.amountCents,
      currency: 'EUR',
      validationOnly: contract.validationOnly,
      code: receipt?.code ?? null,
      fiscalStatus: receipt?.status ?? null,
      pdfAvailable: row.status === 'completed' && row.document !== null,
      lastErrorCode: access.kind === 'admin' ? row.last_error_code : null,
      capabilities: {
        reconcile: access.kind === 'admin' && row.status === 'uncertain',
        resend: false,
        editOriginal: false
      }
    },
    'read_unconfirmed'
  )
  await authorizeFiscalOrder(database, access, orderId, now())
  return response
}
export async function readPrivateCreditPdf(
  database: D1Database,
  access: FiscalOrderAccess,
  orderId: string,
  id: string,
  storage: PrivateFiscalStorage,
  options: { now?: string; appEnvironment: 'local' | 'preview' | 'production' }
) {
  database = guardedFiscalDatabase(database)
  const now = clock(options),
    view = await readD1CreditNote(database, access, orderId, id, options)
  if (!view.pdfAvailable) throw new RefundError('not_found')
  const row = checked(
    z
      .object({
        storage_key: z.literal('').or(z.string().max(300)),
        pdf_checksum: fiscalHash,
        pdf_size: z.number().int().min(16).max(5242880)
      })
      .strict(),
    await database
      .prepare('SELECT storage_key,pdf_checksum,pdf_size FROM fiscal_credit_documents WHERE credit_id=?1')
      .bind(id)
      .first(),
    'read_unconfirmed'
  )
  if (row.storage_key !== `fiscal/${id}/${row.pdf_checksum}.pdf`) throw new RefundError('read_unconfirmed')
  const value = await storage.get(row.storage_key),
    raw = value === null ? null : localFiscalBlobBytes(value)
  if (!raw || raw.byteLength !== row.pdf_size || (await checksumFiscalPdf(raw)) !== row.pdf_checksum)
    throw new RefundError('document_unconfirmed')
  const owned = new Uint8Array(raw.byteLength)
  owned.set(raw)
  await authorizeFiscalOrder(database, access, orderId, now())
  return owned
}
