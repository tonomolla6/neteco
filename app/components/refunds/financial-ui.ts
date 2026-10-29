import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { fiscalUuid } from '~~/shared/fiscal-issuance'
import {
  orderRefundsViewSchema,
  refundPlanInputSchema,
  refundConfirmInputSchema,
  refundReconcileInputSchema,
  refundCommandReceiptSchema,
  type OrderRefundsView,
  type RefundView,
  type RefundPlanInput,
  type RefundConfirmInput,
  type RefundReconcileInput,
  type RefundCommandReceipt
} from '~~/shared/order-refunds'
import {
  creditViewSchema,
  creditQueueInputSchema,
  creditCommandReceiptSchema,
  type CreditView,
  type CreditQueueInput,
  type CreditCommandReceipt
} from '~~/shared/fiscal-credit'

export type FinancialAudience = 'admin' | 'customer'
export type FinancialSnapshot = { refunds: OrderRefundsView; credits: CreditView[] }
export type FinancialAction = 'plan' | 'confirm' | 'cancel' | 'queue_credit' | 'reconcile_refund' | 'reconcile_credit'
export type FinancialReceipt = RefundCommandReceipt | CreditCommandReceipt
type Body = RefundPlanInput | RefundConfirmInput | RefundReconcileInput | CreditQueueInput
const fail = () => {
  throw new Error('financial_read_unconfirmed')
}

export function parseRefunds(raw: unknown, orderId: string, audience: FinancialAudience): OrderRefundsView {
  fiscalUuid.parse(orderId)
  if (audience !== 'admin' && audience !== 'customer') fail()
  const view = orderRefundsViewSchema.parse(raw)
  if (view.orderId !== orderId || new Set(view.items.map((item) => item.id)).size !== view.items.length) fail()
  const creditIds = view.items.flatMap((item) => (item.creditId === null ? [] : [item.creditId]))
  if (new Set(creditIds).size !== creditIds.length) fail()
  for (const item of view.items) {
    const expected =
      item.workflow === 'completed'
        ? item.validationOnly
          ? 'validation_completed'
          : 'succeeded'
        : item.workflow === 'cancelled'
          ? 'cancelled'
          : item.workflow === 'pending_provider'
            ? 'pending'
            : ['submitting', 'uncertain', 'reconciling'].includes(item.workflow)
              ? 'uncertain'
              : 'not_submitted'
    if (
      item.orderId !== orderId ||
      item.financialStatus !== expected ||
      item.components.reduce((sum, line) => sum + line.grossCents, 0) !== item.amountCents ||
      new Set(item.components.map((line) => `${line.component}:${line.lineIndex}`)).size !== item.components.length ||
      (item.capabilities.confirm && item.workflow !== 'awaiting_confirmation') ||
      (item.capabilities.cancel &&
        !['awaiting_confirmation', 'queued', 'leased', 'manual_review'].includes(item.workflow)) ||
      (item.capabilities.reconcile && !['uncertain', 'pending_provider'].includes(item.workflow)) ||
      (item.workflow !== 'completed' && (item.creditId !== null || item.correctiveStatus !== 'not_due')) ||
      (audience === 'customer' && (item.lastErrorCode !== null || Object.values(item.capabilities).some(Boolean)))
    )
      fail()
  }
  if (
    view.reservedCents !==
      view.items.filter((item) => item.workflow !== 'cancelled').reduce((sum, item) => sum + item.amountCents, 0) ||
    view.confirmedCents !==
      view.items
        .filter((item) => item.workflow === 'completed' && !item.validationOnly)
        .reduce((sum, item) => sum + item.amountCents, 0) ||
    view.simulatedConfirmedCents !==
      view.items
        .filter((item) => item.workflow === 'completed' && item.validationOnly)
        .reduce((sum, item) => sum + item.amountCents, 0)
  )
    fail()
  return view
}
export function parseCredit(raw: unknown, refund: RefundView, audience: FinancialAudience): CreditView {
  const view = creditViewSchema.parse(raw)
  if (
    view.id !== refund.creditId ||
    view.refundId !== refund.id ||
    view.orderId !== refund.orderId ||
    view.amountCents !== refund.amountCents ||
    view.validationOnly !== refund.validationOnly ||
    (view.capabilities.reconcile && view.workflow !== 'uncertain') ||
    (audience === 'customer' && (view.capabilities.reconcile || view.lastErrorCode !== null))
  )
    fail()
  return view
}
export function parseFinancialSnapshot(raw: unknown, orderId: string, audience: FinancialAudience): FinancialSnapshot {
  const value = catalogPolicyOwnJson(raw)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'credits,refunds'
  )
    fail()
  const fields = value as Record<string, unknown>,
    refunds = parseRefunds(fields.refunds, orderId, audience)
  if (!Array.isArray(fields.credits)) fail()
  const rawCredits = fields.credits as unknown[],
    linked = refunds.items.filter((item) => item.creditId !== null)
  if (rawCredits.length !== linked.length) fail()
  const credits = rawCredits.map((entry) => {
    const candidate = creditViewSchema.parse(entry),
      refund = linked.find((item) => item.creditId === candidate.id)
    if (!refund) return fail()
    return parseCredit(candidate, refund, audience)
  })
  if (new Set(credits.map((item) => item.id)).size !== credits.length) fail()
  return { refunds, credits }
}
export function financialAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 1_000_000_000) fail()
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}
export function integerInput(raw: string, minimum: number, maximum: number): number {
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error('financial_input_invalid')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('financial_input_invalid')
  return value
}
export function refundLabel(view: RefundView): string {
  if (view.workflow === 'completed')
    return view.validationOnly
      ? 'Validación local completada · Sin movimiento bancario'
      : 'Operación de devolución confirmada'
  return {
    awaiting_confirmation: 'Solicitud preparada · Autorización pendiente',
    queued: 'Solicitud autorizada · Ejecución pendiente',
    leased: 'Comprobando solicitud',
    submitting: 'Operación en curso · No repetir',
    pending_provider: 'Resultado del proveedor pendiente',
    uncertain: 'Resultado financiero no confirmado',
    reconciling: 'Conciliación en curso',
    cancelled: 'Solicitud cancelada antes del envío',
    manual_review: 'Revisión manual necesaria'
  }[view.workflow]
}
export function creditLabel(view: CreditView): string {
  if (view.workflow === 'completed') {
    if (view.validationOnly)
      return view.fiscalStatus === 'fiscal_pending'
        ? 'Documento de prueba · Estado fiscal simulado pendiente'
        : 'Documento de prueba · Sin validez fiscal'
    return view.fiscalStatus === 'fiscal_pending'
      ? 'Rectificativa · Estado fiscal pendiente'
      : 'Factura rectificativa emitida'
  }
  return {
    queued: 'Rectificativa solicitada · Emisión pendiente',
    leased: 'Comprobando rectificativa',
    issuing: 'Emisión en curso · No repetir',
    uncertain: 'Resultado de rectificativa no confirmado',
    reconciling: 'Conciliación fiscal en curso',
    manual_review: 'Rectificativa requiere revisión manual'
  }[view.workflow]
}
export function privateCreditHref(view: CreditView, audience: FinancialAudience): string | null {
  const parsed = creditViewSchema.parse(view)
  if (!parsed.pdfAvailable || parsed.workflow !== 'completed' || !['admin', 'customer'].includes(audience)) return null
  return `/api/${audience === 'admin' ? 'admin/' : ''}orders/${parsed.orderId}/credits/${parsed.id}/pdf`
}
const correctiveLabels: Record<RefundView['correctiveStatus'], string> = {
  not_due: 'Rectificativa no solicitada: resultado financiero pendiente',
  blocked_policy: 'Rectificativa pendiente de política explícita',
  blocked_source: 'Rectificativa pendiente de factura original confirmada',
  queued: 'Rectificativa en cola',
  issuing: 'Rectificativa en curso',
  uncertain: 'Rectificativa sin confirmar',
  completed: 'Documento rectificativo confirmado',
  manual_review: 'Rectificativa requiere revisión manual'
}
export const correctiveLabel = (view: RefundView) => correctiveLabels[view.correctiveStatus]

function freeze<T>(raw: T): Readonly<T> {
  if (raw && typeof raw === 'object') {
    for (const value of Object.values(raw)) freeze(value)
    Object.freeze(raw)
  }
  return raw
}
export type FinancialIntent = Readonly<{
  action: FinancialAction
  operatorId: string
  orderId: string
  targetId: string | null
  refundId: string | null
  generation: number | null
  fingerprint: string | null
  validationOnly: boolean | null
  amountCents: number | null
  endpoint: string
  body: Body
}>
export function actionAvailable(action: FinancialAction, snapshot: FinancialSnapshot, targetId?: string): boolean {
  if (action === 'plan') return snapshot.refunds.reservedCents < snapshot.refunds.capturedCents
  if (action === 'reconcile_credit')
    return snapshot.credits.some((item) => item.id === targetId && item.capabilities.reconcile)
  const view = snapshot.refunds.items.find((item) => item.id === targetId)
  if (!view) return false
  if (action === 'queue_credit')
    return (
      view.workflow === 'completed' &&
      view.creditId === null &&
      ['blocked_policy', 'blocked_source'].includes(view.correctiveStatus)
    )
  return view.capabilities[action === 'reconcile_refund' ? 'reconcile' : action]
}
export function prepareFinancialIntent(
  action: FinancialAction,
  rawBody: unknown,
  context: { operatorId: string; orderId: string; snapshot: unknown; targetId?: string }
): FinancialIntent {
  fiscalUuid.parse(context.operatorId)
  const snapshot = parseFinancialSnapshot(context.snapshot, context.orderId, 'admin')
  if (!actionAvailable(action, snapshot, context.targetId)) throw new Error('financial_action_unavailable')
  const body =
      action === 'plan'
        ? refundPlanInputSchema.parse(rawBody)
        : action === 'confirm'
          ? refundConfirmInputSchema.parse(rawBody)
          : action === 'queue_credit'
            ? creditQueueInputSchema.parse(rawBody)
            : refundReconcileInputSchema.parse(rawBody),
    refund = snapshot.refunds.items.find((item) => item.id === context.targetId),
    credit = snapshot.credits.find((item) => item.id === context.targetId),
    targetId = action === 'plan' ? null : fiscalUuid.parse(context.targetId),
    generation = action === 'reconcile_credit' ? credit!.generation : (refund?.generation ?? null),
    fingerprint = refund?.contractFingerprint ?? null
  if (
    ('expectedGeneration' in body && body.expectedGeneration !== generation) ||
    ('contractFingerprint' in body && body.contractFingerprint !== fingerprint)
  )
    throw new Error('financial_context_changed')
  return freeze({
    action,
    operatorId: context.operatorId,
    orderId: context.orderId,
    targetId,
    refundId: action === 'reconcile_credit' ? credit!.refundId : (refund?.id ?? null),
    generation,
    fingerprint,
    validationOnly: credit?.validationOnly ?? refund?.validationOnly ?? null,
    amountCents: credit?.amountCents ?? refund?.amountCents ?? null,
    endpoint:
      action === 'plan'
        ? '/api/admin/refunds/requests'
        : action === 'reconcile_credit'
          ? `/api/admin/credits/${targetId}/reconcile`
          : `/api/admin/refunds/${targetId}/${action === 'queue_credit' ? 'credit' : action === 'reconcile_refund' ? 'reconcile' : action}`,
    body
  })
}
export function freshIntentAllowed(intent: FinancialIntent, snapshot: FinancialSnapshot, recovery: boolean): boolean {
  if (snapshot.refunds.orderId !== intent.orderId) return false
  if (intent.action === 'plan') return recovery || actionAvailable('plan', snapshot)
  if (intent.action === 'reconcile_credit') {
    const credit = snapshot.credits.find((view) => view.id === intent.targetId)
    return (
      !!credit &&
      credit.refundId === intent.refundId &&
      credit.validationOnly === intent.validationOnly &&
      (recovery
        ? credit.generation >= intent.generation!
        : credit.generation === intent.generation && actionAvailable(intent.action, snapshot, intent.targetId!))
    )
  }
  const refund = snapshot.refunds.items.find((view) => view.id === intent.targetId)
  return (
    !!refund &&
    refund.contractFingerprint === intent.fingerprint &&
    refund.validationOnly === intent.validationOnly &&
    (recovery
      ? refund.generation >= intent.generation!
      : refund.generation === intent.generation && actionAvailable(intent.action, snapshot, intent.targetId!))
  )
}
export function parseFinancialReceipt(raw: unknown, intent: FinancialIntent): FinancialReceipt {
  if (intent.action === 'queue_credit' || intent.action === 'reconcile_credit') {
    const value = creditCommandReceiptSchema.parse(raw)
    if (
      value.refundId !== intent.refundId ||
      value.validationOnly !== intent.validationOnly ||
      value.action !== (intent.action === 'queue_credit' ? 'queued' : 'reconciled') ||
      value.generation !== (intent.action === 'queue_credit' ? 1 : intent.generation! + 1) ||
      (intent.action === 'reconcile_credit' && value.id !== intent.targetId)
    )
      fail()
    return value
  }
  const value = refundCommandReceiptSchema.parse(raw),
    expected =
      intent.action === 'plan'
        ? 'planned'
        : intent.action === 'confirm'
          ? 'confirmed'
          : intent.action === 'cancel'
            ? 'cancelled'
            : 'reconciled'
  if (
    (value.action !== expected && !(intent.action === 'reconcile_refund' && value.action === 'blocked')) ||
    value.generation !== (intent.action === 'plan' ? 1 : intent.generation! + 1) ||
    (intent.action !== 'plan' &&
      (value.id !== intent.targetId ||
        value.contractFingerprint !== intent.fingerprint ||
        value.validationOnly !== intent.validationOnly))
  )
    fail()
  return value
}
const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
export function financialResponseErrorCode(context: unknown): string | null {
  const response = own(context, 'response')
  let status = own(response, 'status')
  if (status === undefined && response instanceof Response) {
    try {
      status = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get?.call(response)
    } catch {
      return null
    }
  }
  if (typeof status !== 'number' || status < 400 || status >= 500) return null
  try {
    const code = own(own(catalogPolicyOwnJson(own(response, '_data')), 'error'), 'code')
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : null
  } catch {
    return null
  }
}
export const financialAccessDenied = (code: string | null) =>
  code !== null && ['unauthenticated', 'forbidden', 'mfa_required', 'email_unverified'].includes(code)
export class FinancialHttpFailure extends Error {
  constructor(readonly code: string | null) {
    super('financial_command_unconfirmed')
  }
}
const definiteRejections = [
  'invalid_input',
  'version_conflict',
  'idempotency_conflict',
  'quantity_unavailable',
  'line_not_found',
  'policy_unavailable',
  'distinct_approver_required',
  'cancellation_not_safe',
  'reconciliation_not_safe',
  'lookup_unavailable',
  'csrf_rejected',
  'invalid_json',
  'json_required',
  'body_too_large',
  'rate_limited'
]
export type FinancialCommandResult =
  | { kind: 'confirmed'; receipt: FinancialReceipt; latest: FinancialSnapshot | null }
  | { kind: 'unknown' | 'not_sent' | 'stale' | 'rejected' | 'discarded' | 'ignored' }
/** Memory-only, exact command replay; no browser storage, economic executor or
 * provider retries. Changing owner/access invalidates every await and drops PII.
 * Recovery always performs a fresh authenticated GET before replaying the SAME
 * durable administrative command, even if its CAS generation has since advanced. */
export class FinancialCommandSession {
  #owner: string | null = null
  #epoch = 0
  #intent: FinancialIntent | null = null
  #busy = false
  #ambiguous = false
  constructor(private readonly changed: () => void = () => {}) {}
  get intent() {
    return this.#intent
  }
  get busy() {
    return this.#busy
  }
  get ambiguous() {
    return this.#ambiguous
  }
  setOwner(owner: string | null) {
    if (owner === this.#owner) return
    this.#owner = owner
    this.#epoch++
    this.#intent = null
    this.#busy = false
    this.#ambiguous = false
    this.changed()
  }
  prepare(intent: FinancialIntent) {
    if (this.#owner !== `${intent.operatorId}:${intent.orderId}` || this.#busy || this.#intent)
      throw new Error('financial_context_changed')
    this.#intent = intent
    this.changed()
  }
  discard() {
    if (this.#busy || this.#ambiguous) return false
    this.#intent = null
    this.changed()
    return true
  }
  async send(deps: {
    read: () => Promise<unknown>
    post: (intent: FinancialIntent) => Promise<unknown>
    authorized: () => boolean
  }): Promise<FinancialCommandResult> {
    const intent = this.#intent,
      epoch = this.#epoch,
      recovery = this.#ambiguous
    const authorized = () => {
      try {
        return deps.authorized() === true
      } catch {
        return false
      }
    }
    if (!intent || this.#busy) return { kind: 'ignored' }
    if (!authorized()) {
      this.setOwner(null)
      return { kind: 'ignored' }
    }
    const current = () => {
      if (this.#epoch !== epoch || this.#owner !== `${intent.operatorId}:${intent.orderId}`) return false
      if (authorized()) return true
      this.setOwner(null)
      return false
    }
    this.#busy = true
    this.changed()
    let sent = false
    try {
      const freshRaw = await deps.read()
      if (!current()) return { kind: 'discarded' }
      const fresh = parseFinancialSnapshot(freshRaw, intent.orderId, 'admin')
      if (!freshIntentAllowed(intent, fresh, recovery)) {
        if (recovery) return { kind: 'unknown' }
        this.#intent = null
        return { kind: 'stale' }
      }
      sent = true
      this.#ambiguous = true
      this.changed()
      const raw = await deps.post(intent)
      if (!current()) return { kind: 'discarded' }
      const receipt = parseFinancialReceipt(raw, intent)
      this.#intent = null
      this.#ambiguous = false
      this.changed()
      let latest: FinancialSnapshot | null = null
      try {
        const last = await deps.read()
        if (!current()) return { kind: 'discarded' }
        latest = parseFinancialSnapshot(last, intent.orderId, 'admin')
        if (intent.action === 'plan') {
          const item = latest.refunds.items.find((view) => view.id === receipt.id)
          if (
            !item ||
            item.contractFingerprint !== receipt.contractFingerprint ||
            !('returnPublicRef' in intent.body) ||
            item.returnPublicRef !== intent.body.returnPublicRef
          )
            latest = null
        }
      } catch {
        latest = null
      }
      if (!current()) return { kind: 'discarded' }
      return { kind: 'confirmed', receipt, latest }
    } catch (error) {
      if (!current()) return { kind: 'discarded' }
      if (
        !recovery &&
        error instanceof FinancialHttpFailure &&
        error.code !== null &&
        definiteRejections.includes(error.code)
      ) {
        this.#intent = null
        this.#ambiguous = false
        return { kind: 'rejected' }
      }
      this.#ambiguous = sent || recovery
      return { kind: this.#ambiguous ? 'unknown' : 'not_sent' }
    } finally {
      if (this.#epoch === epoch) {
        this.#busy = false
        this.changed()
      }
    }
  }
}
