import { BeplyOrdersProvider } from './beply-orders-provider'
import { beplyQueueMessageSchema, dispatchBeplyOrders, publishBeplyOrders, type BeplyOrderQueue } from './beply-orders'
import type { BeplyOrderAdapter } from '../../shared/beply-orders'

export interface BeplyOrdersVariables {
  APP_ENV?: string
  BEPLY_ORDERS_ENABLED?: string
  BEPLY_ENVIRONMENT?: string
  BEPLY_BASE_URL?: string
  BEPLY_API_TOKEN?: string
  BEPLY_ORDER_SERIES?: string
  BEPLY_COMPANY_ID?: string
  BEPLY_PAYMENT_CODE_REDSYS?: string
  BEPLY_PAYMENT_CODE_BANK_TRANSFER?: string
  BEPLY_PAYMENT_CODE_CREDIT?: string
  BEPLY_TAX_CODE_0?: string
  BEPLY_TAX_CODE_10?: string
  BEPLY_TAX_CODE_21?: string
  BEPLY_TAX_CALCULATION_METHOD?: string
  BEPLY_SUPPORT_FILE_ID?: string
}
/** Explicit server opt-in and matching tenant/environment are required.
 * Production activation retains deployment approval and sandbox acceptance. */
export function beplyOrdersRuntimeProvider(
  variables: BeplyOrdersVariables,
  fetcher: typeof fetch
): BeplyOrdersProvider | null {
  if (variables.BEPLY_ORDERS_ENABLED === undefined || variables.BEPLY_ORDERS_ENABLED === 'false') return null
  try {
    const environment = variables.APP_ENV === 'production' ? 'production' : 'sandbox'
    if (
      variables.BEPLY_ORDERS_ENABLED !== 'true' ||
      !['preview', 'preprod', 'preproduction', 'canary', 'production'].includes(variables.APP_ENV ?? '') ||
      (variables.BEPLY_ENVIRONMENT !== undefined && variables.BEPLY_ENVIRONMENT !== environment) ||
      (environment === 'production' && variables.BEPLY_ENVIRONMENT !== 'production')
    )
      throw new Error('invalid_flag')
    return new BeplyOrdersProvider(
      {
        baseUrl: variables.BEPLY_BASE_URL ?? '',
        token: variables.BEPLY_API_TOKEN ?? '',
        environment,
        companyId: variables.BEPLY_COMPANY_ID ?? '',
        orderSeries: variables.BEPLY_ORDER_SERIES ?? '',
        paymentCodes: {
          redsys: variables.BEPLY_PAYMENT_CODE_REDSYS ?? '',
          bank_transfer: variables.BEPLY_PAYMENT_CODE_BANK_TRANSFER ?? '',
          credit: variables.BEPLY_PAYMENT_CODE_CREDIT ?? ''
        },
        taxCodes: {
          '0': variables.BEPLY_TAX_CODE_0 ?? '',
          '1000': variables.BEPLY_TAX_CODE_10 ?? '',
          '2100': variables.BEPLY_TAX_CODE_21 ?? ''
        },
        timeoutMs: 10000,
        ...(variables.BEPLY_TAX_CALCULATION_METHOD
          ? { taxCalculationMethod: variables.BEPLY_TAX_CALCULATION_METHOD as 'classic' | 'price-adjusted' }
          : {}),
        supportFileId: variables.BEPLY_SUPPORT_FILE_ID ?? ''
      },
      fetcher
    )
  } catch {
    throw new Error('beply_orders_configuration_invalid')
  }
}
export async function consumeBeplyOrdersMessage(
  db: D1Database,
  adapter: BeplyOrderAdapter,
  message: unknown,
  input: { enabled: boolean; now: string }
): Promise<'invalid' | 'disabled' | 'processed'> {
  const parsed = beplyQueueMessageSchema.safeParse(message)
  if (!parsed.success) return 'invalid'
  if (!input.enabled) return 'disabled'
  // Provider failures and backoff are already durable in D1. The transport can
  // ack after dispatch returns; a thrown D1 failure must retry the message.
  await dispatchBeplyOrders(db, adapter, { enabled: true, now: input.now, limit: 1, orderId: parsed.data.orderId })
  return 'processed'
}

/** Shared by the scheduled entry point and isolated integration checks. */
export async function dispatchConfiguredBeplyOrders(
  dependencies: { database: D1Database; queue?: BeplyOrderQueue; fetcher: typeof fetch },
  variables: BeplyOrdersVariables,
  input: { now: string; limit?: number }
) {
  const provider = beplyOrdersRuntimeProvider(variables, dependencies.fetcher)
  if (!provider)
    return {
      disabled: true,
      completed: 0,
      retryable: 0,
      manualReview: 0,
      lostLease: 0,
      published: 0,
      queueRetryable: 0
    }
  const outbox = dependencies.queue
    ? await publishBeplyOrders(dependencies.database, dependencies.queue, input)
    : { published: 0, retryable: 0 }
  const report = await dispatchBeplyOrders(dependencies.database, provider, { ...input, enabled: true })
  return { ...report, published: outbox.published, queueRetryable: outbox.retryable }
}
