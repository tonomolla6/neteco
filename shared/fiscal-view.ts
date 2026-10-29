import { z } from 'zod'
import { catalogPolicyOwnJson } from './catalog-publication-policy'
import { fiscalUuid, type FiscalOrderView } from './fiscal-issuance'

/** This view confirms a workflow and a separate fiscal outcome. Neither a
 * completed workflow nor a locally simulated receipt implies legal issuance. */
const fiscalOrderViewSchema = z
  .object({
    orderId: fiscalUuid,
    status: z.enum([
      'blocked_policy',
      'queued',
      'leased',
      'issuing',
      'uncertain',
      'reconciling',
      'completed',
      'manual_review'
    ]),
    intentId: fiscalUuid.nullable(),
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
    provider: z.enum(['local_fake', 'beply']).nullable(),
    validationOnly: z.boolean(),
    code: z.string().min(1).max(100).nullable(),
    fiscalStatus: z.enum(['issued', 'fiscal_pending']).nullable(),
    amountCents: z.number().int().min(1).max(1_000_000_000).nullable(),
    currency: z.literal('EUR'),
    pdfAvailable: z.boolean(),
    lastErrorCode: z.string().min(1).max(80).nullable(),
    capabilities: z
      .object({
        reconcile: z.boolean(),
        edit: z.literal(false),
        issueRetry: z.literal(false),
        creditNote: z.literal(false)
      })
      .strict()
  })
  .strict()
  .superRefine((view, context) => {
    const blocked = view.status === 'blocked_policy',
      completed = view.status === 'completed'
    if (
      (blocked &&
        (view.intentId !== null ||
          view.generation !== null ||
          view.provider !== null ||
          view.amountCents !== null ||
          view.validationOnly)) ||
      (!blocked &&
        (view.intentId === null || view.generation === null || view.provider === null || view.amountCents === null)) ||
      view.validationOnly !== (view.provider === 'local_fake') ||
      (view.code === null) !== (view.fiscalStatus === null) ||
      (blocked && view.code !== null) ||
      (completed ? view.code === null : view.pdfAvailable) ||
      (view.capabilities.reconcile && view.status !== 'uncertain')
    )
      context.addIssue({ code: 'custom', message: 'fiscal_view_unconfirmed' })
  })

export function parseFiscalOrderView(value: unknown, expectedOrderId: string): FiscalOrderView {
  fiscalUuid.parse(expectedOrderId)
  const view = fiscalOrderViewSchema.parse(catalogPolicyOwnJson(value))
  if (view.orderId !== expectedOrderId) throw new Error('fiscal_view_unconfirmed')
  return view
}
