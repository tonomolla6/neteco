import { readFile } from 'node:fs/promises'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, REQUEST, ADMISSION, REASON, utc } from './d1-returns-fixture'
import { requestD1CustomerReturn, executeD1AdminReturnCommand } from '../../workers/returns/operations'
import { approveRefundPolicy, approveCreditPolicy } from '../../workers/refunds/policies'
import {
  approveFiscalPolicy,
  queueFiscalInvoice,
  dispatchFiscalIssuance,
  fiscalMappingFingerprint
} from '../../workers/fiscal/issuance'
import { PersistentLocalFiscalProvider } from '../../workers/fiscal/local-provider'
import { PersistentLocalRefundProvider } from '../../workers/refunds/local-provider'
import { PersistentLocalCreditProvider } from '../../workers/fiscal/local-credit-provider'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { fiscalRuntimeMappings } from './d1-fiscal-runtime-fixture'
import { hash } from '../../workers/refunds/authority'
import { planD1Refund, confirmD1Refund, dispatchD1Refunds } from '../../workers/refunds/operations'
import type { PromotionRule } from '../../shared/promotions'
import { provisionPromotionFixture } from '../support/promotion-fixture'
import { applyStoreCreditMigrations, fundStoreCredit } from './d1-store-credit-downstream-fixture'

export { CLAIMS, BUYER_CLAIMS, REASON, utc }
export async function refundsCreditFixture(
  options: {
    shipping?: boolean
    distinctActor?: boolean
    originalPending?: boolean
    couponCode?: string
    couponRule?: PromotionRule
    /** PRI-018: pay part of the order with store credit (the account is funded with this amount + 100). */
    storeCreditCents?: number
  } = {}
) {
  const fixture = await returnsFixture(),
    { database, sqlite } = fixture
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='refund_contracts'").get())
    sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0048_order_refunds_credit_notes.sql', import.meta.url), 'utf8')
    )
  if (options.shipping)
    sqlite.exec("UPDATE shipping_rates SET net_cents=100,tax_rate_basis_points=1000 WHERE id='pickup-rate'")
  if (options.couponRule) await provisionPromotionFixture(sqlite, options.couponRule, CLAIMS.identityId)
  if (options.storeCreditCents !== undefined) {
    await applyStoreCreditMigrations(sqlite)
    await fundStoreCredit(database, CUSTOMER, options.storeCreditCents + 100)
  }
  const orderId = await fixture.order(
      options.storeCreditCents !== undefined
        ? { storeCreditCents: options.storeCreditCents }
        : options.couponCode === undefined && !options.couponRule
          ? undefined
          : { couponCode: options.couponCode ?? options.couponRule!.code }
    ),
    requested = await requestD1CustomerReturn(database, BUYER_CLAIMS, orderId, REQUEST, {
      idempotencyKey: 'rma-request'
    })
  for (const input of [
    ADMISSION,
    { action: 'received', expectedVersion: 2, lines: [{ lineIndex: 0, quantity: 2 }] },
    {
      action: 'inspected',
      expectedVersion: 3,
      lines: [{ lineIndex: 0, quantity: 2, condition: 'opened', disposition: 'non_restockable' }]
    },
    {
      action: 'resolution_ready',
      expectedVersion: 4,
      resolution: REASON,
      cost: {
        amountCents: 0,
        currency: 'EUR',
        category: 'handling',
        evidenceRef: 'manual-no-charge',
        description: REASON
      }
    }
  ])
    await executeD1AdminReturnCommand(
      database,
      CLAIMS,
      requested.publicRef,
      { reason: REASON, publicMessage: REASON, evidence: REASON, ...input },
      { idempotencyKey: crypto.randomUUID() }
    )
  const mappings = {
      merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
      terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
      currencyCode: '978' as const
    },
    policy = await approveRefundPolicy(database, CLAIMS, {
      idempotencyKey: 'refund-policy',
      provider: 'local_fake',
      environment: 'local_validation',
      mappings,
      shipping: 'excluded',
      approvalMode: options.distinctActor ? 'distinct_actor' : 'same_actor_confirmation',
      maximumRefundCents: 100000,
      evidenceRef: 'synthetic-local-only',
      reason: REASON
    }),
    refundProvider = new PersistentLocalRefundProvider(database, await hash(mappings))
  const objects = new Map<string, Uint8Array>(),
    storage = {
      async put(key: string, bytes: Uint8Array) {
        objects.set(key, Uint8Array.from(bytes))
      },
      async get(key: string) {
        return objects.get(key) ?? null
      }
    }
  const ordinaryPolicy = await approveFiscalPolicy(
    database,
    CLAIMS,
    {
      idempotencyKey: 'ordinary-policy',
      provider: 'local_fake',
      environment: 'local_validation',
      series: 'LOCAL',
      trigger: 'after_payment_capture',
      mappings: fiscalRuntimeMappings,
      evidenceRef: 'synthetic-local-only',
      reason: REASON
    },
    { now: utc() }
  )
  const ordinary = await queueFiscalInvoice(database, CLAIMS, {
    eventId: `invoice-evaluation:${orderId}`,
    policyId: ordinaryPolicy.id,
    idempotencyKey: 'ordinary-request',
    now: utc()
  })
  const ordinaryProvider = new PersistentLocalFiscalProvider(
    database,
    await fiscalMappingFingerprint(fiscalRuntimeMappings)
  )
  if (options.originalPending) {
    const issue = ordinaryProvider.issueInvoice.bind(ordinaryProvider)
    ordinaryProvider.issueInvoice = async (contract) => ({ ...(await issue(contract)), status: 'fiscal_pending' })
  }
  await dispatchFiscalIssuance(database, ordinaryProvider, storage, {
    now: utc(),
    appEnvironment: 'local',
    allowProviderIssuance: true
  })
  const creditPolicy = await approveCreditPolicy(database, CLAIMS, {
      idempotencyKey: 'credit-policy',
      provider: 'local_fake',
      environment: 'local_validation',
      series: 'RECTLOCAL',
      trigger: 'after_confirmed_refund',
      mappings: fiscalRuntimeMappings,
      evidenceRef: 'synthetic-local-only',
      reason: REASON
    }),
    creditProvider = new PersistentLocalCreditProvider(database, await hash(fiscalRuntimeMappings))
  const plan = (quantity = 1, idempotencyKey = crypto.randomUUID()) =>
    planD1Refund(database, CLAIMS, {
      idempotencyKey,
      policyId: policy.id,
      returnPublicRef: requested.publicRef,
      expectedReturnVersion: 5,
      reason: REASON,
      evidenceRef: 'documented-local-case',
      lines: [{ lineIndex: 0, quantity }]
    })
  const confirm = (id: string, generation: number, fingerprint: string) =>
    confirmD1Refund(database, CLAIMS, id, {
      idempotencyKey: crypto.randomUUID(),
      expectedGeneration: generation,
      contractFingerprint: fingerprint,
      reason: REASON,
      evidenceRef: 'confirmed-local-case'
    })
  const dispatch = () =>
    dispatchD1Refunds(database, refundProvider, {
      now: utc(),
      appEnvironment: 'local',
      policyId: policy.id,
      enabled: true,
      localValidationEnabled: true
    })
  async function completed(quantity = 1) {
    const planned = await plan(quantity)
    await confirm(planned.id, planned.generation, planned.contractFingerprint)
    await dispatch()
    return planned
  }
  return {
    ...fixture,
    orderId,
    returnRef: requested.publicRef,
    policy,
    refundProvider,
    ordinary,
    ordinaryPolicy,
    ordinaryProvider,
    creditPolicy,
    creditProvider,
    storage,
    objects,
    plan,
    confirm,
    dispatch,
    completed
  }
}
