import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createLocalShopConfig } from '../../scripts/generate-shop-config'
import { createPreprodConfig } from '../../scripts/cloudflare-preprod'
import { createSafeVariables } from '../../scripts/lib/cloudflare-config-safety'

const root = fileURLToPath(new URL('../../', import.meta.url))
const account = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const databaseId = '11111111-1111-1111-1111-111111111111'
const namespaceId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
function source(): Record<string, unknown> {
  const path = fileURLToPath(new URL('../../wrangler.canary.jsonc', import.meta.url))
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
  if (parsed.error) throw new Error('invalid_test_manifest')
  return parsed.config as Record<string, unknown>
}
function resources() {
  return new Map([
    ['d1', { name: 'neteco-preprod', uuid: databaseId }],
    ['kv', { title: 'neteco-preprod-cache', id: namespaceId }],
    ['r2', { name: 'neteco-preprod-media' }],
    ['queue', { queue_name: 'neteco-preprod-jobs' }],
    ['dlq', { queue_name: 'neteco-preprod-jobs-dlq' }]
  ])
}
const projections = [
  ['local', (input: Record<string, unknown>) => createLocalShopConfig(input, root)],
  ['preprod', (input: Record<string, unknown>) => createPreprodConfig(input, root, account, resources())]
] as const

describe.each(projections)('Cloudflare %s pure input boundaries', (_, project) => {
  it('does not inherit recovery consent, sending policy or private recipients into another environment', () => {
    const input = source()
    input.vars = {
      CART_RECOVERY_ENABLED: 'true',
      CART_RECOVERY_DELIVERY_ENABLED: 'true',
      CART_RECOVERY_POLICY: '{"enabled":true,"waitSeconds":60,"frequencyCapSeconds":60,"tokenTtlSeconds":60}',
      CART_RECOVERY_ALLOWED_RECIPIENTS: '["private@example.net"]'
    }
    expect(project(input).vars).toMatchObject({
      CART_RECOVERY_ENABLED: 'false',
      CART_RECOVERY_DELIVERY_ENABLED: 'false',
      CART_RECOVERY_POLICY: 'null',
      CART_RECOVERY_ALLOWED_RECIPIENTS: '[]'
    })
  })
  it('keeps private commercial quotes and customer context OFF regardless of inherited opt-ins', () => {
    const input = source()
    input.vars = { SALES_QUOTES_ENABLED: 'true', CUSTOMER_360_ENABLED: 'true' }
    expect(project(input).vars).toMatchObject({ SALES_QUOTES_ENABLED: 'false', CUSTOMER_360_ENABLED: 'false' })
  })
  it('keeps product engagement and external watch delivery OFF instead of copying source opt-ins or recipients', () => {
    const input = source()
    input.vars = {
      PRODUCT_WATCH_ENABLED: 'true',
      PRODUCT_CONTRIBUTIONS_ENABLED: 'true',
      PRODUCT_WATCH_DELIVERY_ENABLED: 'true',
      PRODUCT_WATCH_ALLOWED_RECIPIENTS: '["private@example.net"]'
    }
    expect(project(input).vars).toMatchObject({
      PRODUCT_WATCH_ENABLED: 'false',
      PRODUCT_CONTRIBUTIONS_ENABLED: 'false',
      PRODUCT_WATCH_DELIVERY_ENABLED: 'false',
      PRODUCT_WATCH_ALLOWED_RECIPIENTS: '[]'
    })
  })
  it('keeps automatic inventory evaluation explicitly OFF even if the source opts in', () => {
    const input = source()
    input.vars = { INVENTORY_ALERTS_ENABLED: 'true' }
    expect(project(input).vars).toHaveProperty('INVENTORY_ALERTS_ENABLED', 'false')
  })
  it.each(['SUPPORT_SCAN_SECRET', 'SUPPORT_TURNSTILE_SECRET', 'NEWSLETTER_FEEDBACK_SECRET'])(
    'rejects optional secret %s in public variables without echoing it',
    (name) => {
      const input = source()
      input.vars = { [name]: 'synthetic-sensitive-not-a-real-secret' }
      expect(() => project(input)).toThrow('cloudflare_configuration_contains_credentials')
    }
  )
  it('projects new financial, support and campaign features OFF regardless of source opt-ins', () => {
    const input = source()
    input.vars = {
      REFUNDS_ENABLED: 'true',
      REFUND_DISPATCH_ENABLED: 'true',
      CREDIT_DISPATCH_ENABLED: 'true',
      SUPPORT_ENABLED: 'true',
      SUPPORT_POLICY: '{unapproved}',
      NEWSLETTER_EDITORIAL_ENABLED: 'true',
      NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'true',
      NEWSLETTER_LOCAL_VALIDATION_ENABLED: 'true',
      NEWSLETTER_FEEDBACK_ENABLED: 'true',
      TRANSACTIONAL_EMAIL_RENDERER_KEYS: '["invoice.credit.v1"]'
    }
    expect(project(input).vars).toMatchObject({
      REFUNDS_ENABLED: 'false',
      REFUND_DISPATCH_ENABLED: 'false',
      REFUND_POLICY_IDS: '[]',
      CREDIT_DISPATCH_ENABLED: 'false',
      CREDIT_POLICY_IDS: '[]',
      SUPPORT_ENABLED: 'false',
      SUPPORT_POLICY: 'null',
      SUPPORT_ATTACHMENTS_ENABLED: 'false',
      NEWSLETTER_EDITORIAL_ENABLED: 'false',
      NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'false',
      NEWSLETTER_LOCAL_VALIDATION_ENABLED: 'false',
      NEWSLETTER_CAMPAIGN_ALLOWED_RECIPIENTS: '[]',
      NEWSLETTER_FEEDBACK_ENABLED: 'false',
      TRANSACTIONAL_EMAIL_RENDERER_KEYS: '[]'
    })
  })
  it('rejects inherited declared secrets before copying the shipping value to the public alias', () => {
    const input = source()
    input.vars = Object.create({ FREE_SHIPPING_THRESHOLD_CENTS: '24681' })
    input.secrets = { required: ['FREE_SHIPPING_THRESHOLD_CENTS'] }
    expect(() => project(input)).toThrow('invalid_cloudflare_variables')
  })

  it('keeps rejecting the same declared secret when it is an ordinary own value', () => {
    const input = source()
    input.vars = { FREE_SHIPPING_THRESHOLD_CENTS: '24681' }
    input.secrets = { required: ['FREE_SHIPPING_THRESHOLD_CENTS'] }
    expect(() => project(input)).toThrow('cloudflare_configuration_contains_credentials')
  })

  it('rejects a changing compatibility date without invoking its getter', () => {
    const input = source()
    const getter = vi.fn(() => '2026-08-15')
    Object.defineProperty(input, 'compatibility_date', { enumerable: true, get: getter })
    expect(() => project(input)).toThrow('invalid_cloudflare_source_config')
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects an accessor variable without invoking it or copying its result', () => {
    const input = source()
    const getter = vi.fn(() => '24681')
    const variables = {}
    Object.defineProperty(variables, 'FREE_SHIPPING_THRESHOLD_CENTS', { enumerable: true, get: getter })
    input.vars = variables
    expect(() => project(input)).toThrow('invalid_cloudflare_variables')
    expect(getter).not.toHaveBeenCalled()
  })

  it('accepts null-prototype data records with ordinary own allowlisted values', () => {
    const input = source()
    const variables: Record<string, string> = Object.create(null)
    variables.FREE_SHIPPING_THRESHOLD_CENTS = '24681'
    input.vars = variables
    const output = project(input)
    expect(output.vars).toMatchObject({
      FREE_SHIPPING_THRESHOLD_CENTS: '24681',
      NUXT_PUBLIC_FREE_SHIPPING_THRESHOLD_CENTS: '24681'
    })
  })
})

describe('preproduction primitive resource boundaries', () => {
  it('rejects coercible account identifiers without invoking conversion hooks', () => {
    const identifier = { toString: vi.fn(() => account), toJSON: vi.fn(() => namespaceId) }
    expect(() => createPreprodConfig(source(), root, identifier as unknown as string, resources())).toThrow(
      'invalid_preprod_account'
    )
    expect(identifier.toString).not.toHaveBeenCalled()
    expect(identifier.toJSON).not.toHaveBeenCalled()
  })

  it.each(['d1', 'kv'] as const)(
    'rejects coercible %s identifiers before serialization can change their target',
    (kind) => {
      const identifier = {
        toString: vi.fn(() => (kind === 'd1' ? databaseId : namespaceId)),
        toJSON: vi.fn(() => (kind === 'd1' ? '22222222-2222-2222-2222-222222222222' : account))
      }
      const resolved = resources()
      const resource = resolved.get(kind)!
      if (kind === 'd1') resource.uuid = identifier as unknown as string
      else resource.id = identifier as unknown as string
      expect(() => createPreprodConfig(source(), root, account, resolved)).toThrow('invalid_resource_identifier')
      expect(identifier.toString).not.toHaveBeenCalled()
      expect(identifier.toJSON).not.toHaveBeenCalled()
    }
  )

  it('uses the same validated primitive identifiers in the serialized projection', () => {
    const output = createPreprodConfig(source(), root, account, resources())
    const serialized = JSON.parse(JSON.stringify(output))
    expect(serialized.account_id).toBe(account)
    expect(serialized.d1_databases[0].database_id).toBe(databaseId)
    expect(serialized.kv_namespaces[0].id).toBe(namespaceId)
  })

  it('protects the exported variables helper from a top-level accessor source', () => {
    const getter = vi.fn(() => ({ FREE_SHIPPING_THRESHOLD_CENTS: '24681' }))
    const input = {}
    Object.defineProperty(input, 'vars', { enumerable: true, get: getter })
    expect(() => createSafeVariables(input, 'local')).toThrow('invalid_cloudflare_source_config')
    expect(getter).not.toHaveBeenCalled()
  })
})
