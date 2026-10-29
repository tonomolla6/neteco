import { describe, expect, it, vi } from 'vitest'
import type { RefundPolicy } from '../../shared/order-refunds'
import type { CreditPolicy } from '../../shared/fiscal-credit'
import {
  configuredSupportPolicy,
  financialRuntimeConfiguration,
  configuredRefundProvider,
  configuredCreditProvider,
  customerEmailConfiguration,
  customerEmailRenderers,
  configuredNewsletterEditorial,
  configuredEditorialSecrets,
  configuredNewsletterConsentMaintenance
} from '../../workers/runtime/customer-operations-config'
import {
  dispatchCustomerFinancialOperations,
  dispatchConfiguredNewsletterCampaigns
} from '../../workers/runtime/customer-operations-dispatch'
import { transportReady } from '../../workers/marketing/newsletter-campaign-transport'
import { environment } from '../support/customer-operations-fixture'
import { hash } from '../../workers/refunds/authority'

const ID = '10000000-0000-4000-8000-000000000048'
const REFUND: RefundPolicy = {
  id: ID,
  idempotencyKey: 'synthetic-refund-policy',
  provider: 'local_fake',
  environment: 'local_validation',
  mappings: { merchantCode: '999008881', terminal: '1', currencyCode: '978' },
  shipping: 'excluded',
  approvalMode: 'same_actor_confirmation',
  maximumRefundCents: 1000000,
  evidenceRef: 'synthetic-policy',
  reason: 'Synthetic approved policy',
  approvedAt: '2026-10-03T00:00:00Z',
  fingerprint: 'a'.repeat(64)
}
const CREDIT: CreditPolicy = {
  id: ID,
  idempotencyKey: 'synthetic-credit-policy',
  provider: 'local_fake',
  environment: 'local_validation',
  series: 'TEST',
  trigger: 'after_confirmed_refund',
  mappings: {
    companyId: 'SYNTHETIC',
    taxes: { '0': 'ZERO', '1000': 'REDUCED', '2100': 'GENERAL' },
    paymentCode: 'CARD'
  },
  evidenceRef: 'synthetic-policy',
  reason: 'Synthetic approved policy',
  approvedAt: '2026-10-03T00:00:00Z',
  fingerprint: 'a'.repeat(64)
}
describe('customer-operations explicit runtime authority', () => {
  it('constructs the signed real refund adapter only from matching explicit policy and runtime, without bank I/O', async () => {
    const { id, approvedAt, fingerprint: _old, ...input } = REFUND
    const realInput = { ...input, provider: 'redsys' as const, environment: 'sandbox' as const }
    const policy: RefundPolicy = {
        ...realInput,
        id,
        approvedAt,
        fingerprint: await hash({ scope: 'refund', input: realInput })
      },
      fetcher = vi.fn()
    const env = environment({
      APP_ENV: 'preprod',
      REDSYS_ENABLED: 'true',
      REDSYS_ENVIRONMENT: 'sandbox',
      REDSYS_MERCHANT_CODE: policy.mappings.merchantCode,
      REDSYS_TERMINAL: policy.mappings.terminal,
      REDSYS_SECRET_KEY: 'synthetic-explicit-secret-not-a-live-key'
    })
    expect((await configuredRefundProvider(env, policy, fetcher))?.name).toBe('redsys')
    for (const patch of [
      { REDSYS_ENABLED: 'false' },
      { APP_ENV: 'local' },
      { APP_ENV: 'production' },
      { REDSYS_ENVIRONMENT: 'production' },
      { REDSYS_TERMINAL: '2' },
      { REDSYS_MERCHANT_CODE: '123456789' },
      { REDSYS_SECRET_KEY: undefined },
      { REDSYS_SECRET_KEY: 'local-only-' + 'a'.repeat(64) }
    ])
      expect(await configuredRefundProvider({ ...env, ...patch }, policy, fetcher)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('keeps all financial opt-ins and policy selection OFF without touching bindings', () => {
    const env = environment()
    expect(financialRuntimeConfiguration(env)).toEqual({
      appEnvironment: 'local',
      enabled: false,
      refunds: { enabled: false, localValidationEnabled: false, policyIds: [] },
      credits: { enabled: false, localValidationEnabled: false, policyIds: [] }
    })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
  it.each(['REFUND_POLICY_IDS', 'CREDIT_POLICY_IDS'])(
    'allows only explicit unique bounded UUID policies in %s',
    (name) => {
      for (const value of [
        '',
        '{}',
        '[1]',
        JSON.stringify([ID, ID]),
        JSON.stringify(Array(11).fill(ID)),
        'x'.repeat(4097)
      ])
        expect(() => financialRuntimeConfiguration(environment({ [name]: value }))).toThrow(
          'operations_configuration_invalid'
        )
      expect(
        financialRuntimeConfiguration(environment({ [name]: JSON.stringify([ID]) }))[
          name === 'REFUND_POLICY_IDS' ? 'refunds' : 'credits'
        ].policyIds
      ).toEqual([ID])
    }
  )
  it.each([
    'REFUNDS_ENABLED',
    'REFUND_DISPATCH_ENABLED',
    'CREDIT_DISPATCH_ENABLED',
    'REFUND_LOCAL_VALIDATION_ENABLED',
    'CREDIT_LOCAL_VALIDATION_ENABLED'
  ])('does not coerce malformed financial switch %s', (name) => {
    for (const value of ['yes', 'TRUE', 1, null])
      expect(() => financialRuntimeConfiguration(environment({ [name]: value }))).toThrow()
  })
  it('does not query or sweep new tables while financial operations are OFF or unselected', async () => {
    for (const vars of [
      {},
      { REFUND_DISPATCH_ENABLED: 'true', CREDIT_DISPATCH_ENABLED: 'true' },
      { REFUNDS_ENABLED: 'true', REFUND_DISPATCH_ENABLED: 'true', CREDIT_DISPATCH_ENABLED: 'true' }
    ]) {
      const env = environment(vars)
      await dispatchCustomerFinancialOperations(env, '2026-10-03T00:00:00Z')
      expect(env.DB.prepare).not.toHaveBeenCalled()
      expect(env.MEDIA.put).not.toHaveBeenCalled()
    }
  })
  it('requires separate local-validation authority for each durable synthetic provider', async () => {
    const fetcher = vi.fn()
    for (const APP_ENV of ['local', 'preprod', 'production']) {
      expect(await configuredRefundProvider(environment({ APP_ENV }), REFUND, fetcher)).toBeNull()
      expect(await configuredCreditProvider(environment({ APP_ENV }), CREDIT, fetcher)).toBeNull()
    }
    expect(
      (await configuredRefundProvider(environment({ REFUND_LOCAL_VALIDATION_ENABLED: 'true' }), REFUND, fetcher))?.name
    ).toBe('local_fake')
    expect(
      (await configuredCreditProvider(environment({ CREDIT_LOCAL_VALIDATION_ENABLED: 'true' }), CREDIT, fetcher))?.name
    ).toBe('local_fake')
    expect(
      await configuredCreditProvider(environment({ REFUND_LOCAL_VALIDATION_ENABLED: 'true' }), CREDIT, fetcher)
    ).toBeNull()
    expect(
      await configuredRefundProvider(environment({ CREDIT_LOCAL_VALIDATION_ENABLED: 'true' }), REFUND, fetcher)
    ).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('never invents privacy acceptance, retention or support SLA from missing policy', () => {
    expect(configuredSupportPolicy(environment())).toBeNull()
    expect(configuredSupportPolicy(environment({ SUPPORT_POLICY: 'null' }))).toBeNull()
    const policy = {
      reference: 'synthetic-explicit-policy',
      version: 1,
      privacyNoticePath: '/privacidad',
      retentionDays: 30,
      responseMinutes: null,
      serviceHoursDescription: null
    }
    expect(configuredSupportPolicy(environment({ SUPPORT_POLICY: JSON.stringify(policy) }))).toEqual(policy)
    for (const value of [
      '{}',
      JSON.stringify({ ...policy, extra: 'unexpected' }),
      JSON.stringify({ ...policy, retentionDays: 0 }),
      JSON.stringify({ ...policy, responseMinutes: 0 })
    ])
      expect(() => configuredSupportPolicy(environment({ SUPPORT_POLICY: value }))).toThrow()
  })
  it('registers immutable known email renderers but enables none by default or ordinary invoice flag', () => {
    expect(customerEmailRenderers.map((entry) => entry.key)).toEqual([
      'refund.succeeded.v1',
      'invoice.credit.v1',
      'support.ticket.received.v1',
      'support.ticket.reply.v1',
      'order.operations.fulfillment.v1',
      'order.operations.cancelled.v1',
      'order.return.requested.v1',
      'order.return.status.v1',
      'order.payment.confirmed.v1'
    ])
    expect(Object.isFrozen(customerEmailRenderers)).toBe(true)
    expect(
      customerEmailConfiguration(environment({ INVOICE_EMAIL_ENABLED: 'true', TRANSACTIONAL_EMAIL_ENABLED: 'true' }))
    ).toEqual({ rendererOptIns: [], rendererValidationEnabled: false })
    expect(
      customerEmailConfiguration(environment({ TRANSACTIONAL_EMAIL_RENDERER_KEYS: '["support.ticket.reply.v1"]' }))
        .rendererOptIns
    ).toEqual(['support.ticket.reply.v1'])
    const allKeys = customerEmailRenderers.map((entry) => entry.key)
    expect(
      customerEmailConfiguration(environment({ TRANSACTIONAL_EMAIL_RENDERER_KEYS: JSON.stringify(allKeys) }))
    ).toEqual({ rendererOptIns: allKeys, rendererValidationEnabled: false })
    expect(
      customerEmailConfiguration(
        environment({
          TRANSACTIONAL_EMAIL_RENDERER_KEYS: '["order.operations.fulfillment.v1","order.operations.cancelled.v1"]'
        })
      ).rendererOptIns
    ).toEqual(['order.operations.fulfillment.v1', 'order.operations.cancelled.v1'])
    expect(
      customerEmailConfiguration(
        environment({ TRANSACTIONAL_EMAIL_RENDERER_KEYS: '["order.return.requested.v1","order.return.status.v1"]' })
      ).rendererOptIns
    ).toEqual(['order.return.requested.v1', 'order.return.status.v1'])
    expect(
      customerEmailConfiguration(environment({ TRANSACTIONAL_EMAIL_RENDERER_KEYS: '["order.payment.confirmed.v1"]' }))
        .rendererOptIns
    ).toEqual(['order.payment.confirmed.v1'])
    for (const value of ['{}', '["unknown"]', '["invoice.credit.v1","invoice.credit.v1"]'])
      expect(() => customerEmailConfiguration(environment({ TRANSACTIONAL_EMAIL_RENDERER_KEYS: value }))).toThrow()
  })
  it('never reads the real newsletter binding when delivery is OFF or in local mode', () => {
    const access = vi.fn(() => {
        throw new Error('unexpected_sender_access')
      }),
      env = environment()
    Object.defineProperty(env, 'NEWSLETTER_EMAIL', { get: access })
    expect(configuredNewsletterEditorial(env).transport?.mode).toBe('disabled')
    const local = configuredNewsletterEditorial({
      ...environment(),
      NEWSLETTER_HMAC_KEY: Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64url'),
      NEWSLETTER_EDITORIAL_ENABLED: 'true',
      NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'true'
    })
    expect(local.transport).toMatchObject({ mode: 'local-fake', externalEnabled: false, senderFactory: undefined })
    expect(transportReady(local.transport, local.publicOrigin)).toBe(false)
    expect(access).not.toHaveBeenCalled()
  })
  it('does not sweep campaign tables or contact email while newsletter is OFF', async () => {
    const env = environment({ NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'true' })
    expect(await dispatchConfiguredNewsletterCampaigns(env)).toEqual({ disabled: true })
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(env.NEWSLETTER_EMAIL.send).not.toHaveBeenCalled()
  })
  it('binds real editorial delivery only to the dedicated sender after explicit nonlocal delivery opt-in', async () => {
    const send = vi.fn(async () => ({ messageId: 'offline-test-only' })),
      transactional = vi.fn()
    const env = environment({
      APP_ENV: 'preprod',
      NEWSLETTER_EDITORIAL_ENABLED: 'true',
      NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'true',
      NEWSLETTER_PUBLIC_ORIGIN: 'https://preprod.neteco.es',
      NEWSLETTER_EMAIL_FROM: 'newsletter@neteco.es',
      NEWSLETTER_HMAC_KEY: Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64url'),
      NEWSLETTER_CAMPAIGN_ALLOWED_RECIPIENTS: '["approved@example.test"]',
      NEWSLETTER_EMAIL: { send },
      EMAIL: { send: transactional }
    })
    const deps = configuredNewsletterEditorial(env)
    expect(transportReady(deps.transport, deps.publicOrigin)).toBe(true)
    expect(send).not.toHaveBeenCalled()
    const message = {
      deliveryId: 'synthetic-delivery',
      to: 'approved@example.test',
      from: 'newsletter@neteco.es',
      subject: 'Synthetic preview',
      text: 'Synthetic',
      html: '<p>Synthetic</p>',
      headers: { 'List-Unsubscribe': '<https://preprod.neteco.es/newsletter/baja>' }
    }
    await deps.transport!.senderFactory!()!.send(message)
    expect(send).toHaveBeenCalledWith({
      to: message.to,
      from: message.from,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers
    })
    expect(transactional).not.toHaveBeenCalled()
    expect(
      transportReady(
        configuredNewsletterEditorial({ ...env, NEWSLETTER_CAMPAIGN_ALLOWED_RECIPIENTS: '[]' }).transport,
        deps.publicOrigin
      )
    ).toBe(false)
    expect(
      transportReady(
        configuredNewsletterEditorial({ ...env, NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'false' }).transport,
        deps.publicOrigin
      )
    ).toBe(false)
  })
  it('rejects invalid preproduction recipient lists and requires a dedicated feedback opt-in and secret', () => {
    for (const value of ['{}', '["not-email"]', '["a@example.test","a@example.test"]'])
      expect(() =>
        configuredNewsletterEditorial(environment({ NEWSLETTER_CAMPAIGN_ALLOWED_RECIPIENTS: value }))
      ).toThrow()
    const secret = 'synthetic-newsletter-feedback-secret-0123456789abcdef'
    expect(configuredNewsletterEditorial(environment({ NEWSLETTER_FEEDBACK_SECRET: secret })).feedback).toBeUndefined()
    expect(() =>
      configuredNewsletterEditorial(
        environment({ NEWSLETTER_EDITORIAL_ENABLED: 'true', NEWSLETTER_FEEDBACK_ENABLED: 'true' })
      )
    ).toThrow()
    expect(
      configuredNewsletterEditorial(
        environment({
          NEWSLETTER_EDITORIAL_ENABLED: 'true',
          NEWSLETTER_FEEDBACK_ENABLED: 'true',
          NEWSLETTER_FEEDBACK_SECRET: secret
        })
      ).feedback
    ).toEqual({ secret: new TextEncoder().encode(secret), provider: 'local-fake' })
  })
  it('decodes only the existing explicit marketing signing key; no synthetic default', () => {
    for (const value of [undefined, '', 'A'.repeat(43), 'not-a-key'])
      expect(configuredEditorialSecrets(value)).toBeUndefined()
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i + 1),
      encoded = Buffer.from(bytes).toString('base64url')
    expect(configuredEditorialSecrets(encoded)?.hmacKey).toEqual(bytes)
  })
  it('keeps valid opt-out authority when acquisition and email delivery are OFF, and disables campaign sending without it', () => {
    const env = environment({
      NEWSLETTER_HMAC_KEY: Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64url'),
      NEWSLETTER_ENABLED: 'false'
    })
    expect(configuredNewsletterConsentMaintenance(env)).toMatchObject({ publicOrigin: env.NEWSLETTER_PUBLIC_ORIGIN })
    expect(configuredNewsletterConsentMaintenance(environment())).toBeNull()
    expect(
      configuredNewsletterConsentMaintenance({ ...env, NEWSLETTER_PUBLIC_ORIGIN: 'http://neteco.invalid' })
    ).toBeNull()
    expect(
      configuredNewsletterEditorial(
        environment({ NEWSLETTER_EDITORIAL_ENABLED: 'true', NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'true' })
      ).transport?.mode
    ).toBe('disabled')
    expect(env.NEWSLETTER_EMAIL.send).not.toHaveBeenCalled()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
})
