import { describe, it, expect } from 'vitest'
import { experimental_readRawConfig } from 'wrangler'
import { createDemoConfig, DEMO_ACCOUNT, DEMO_DATABASE, DEMO_WORKER } from '../../scripts/generate-demo-config'
import { DEMO_ORIGIN } from '../../shared/demo-access'

describe('isolated Cloudflare demo configuration', () => {
  function config() {
    const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.canary.jsonc' })
    return createDemoConfig(rawConfig as Record<string, unknown>, process.cwd())
  }
  it('uses the isolated database, bucket, KV and worker, never production landing', () => {
    const output = config()
    expect(output.name).toBe(DEMO_WORKER)
    expect(output.account_id).toBe(DEMO_ACCOUNT)
    expect(output.d1_databases[0]?.database_id).toBe(DEMO_DATABASE)
    expect(output.r2_buckets).toEqual([{ binding: 'MEDIA', bucket_name: 'neteco-preprod-media', jurisdiction: 'eu' }])
    expect(output.workers_dev).toBe(false)
    expect(output.preview_urls).toBe(false)
    expect(output.routes).toEqual([])
  })
  it('has no outbound transport or background dispatch resources', () => {
    const output = config()
    for (const key of ['send_email', 'queues', 'workflows', 'triggers', 'secrets'])
      expect(output).not.toHaveProperty(key)
    for (const key of [
      'BEPLY_ENABLED',
      'REDSYS_ENABLED',
      'FISCAL_ISSUANCE_ENABLED',
      'REFUND_DISPATCH_ENABLED',
      'CREDIT_DISPATCH_ENABLED',
      'AUTH_EMAIL_ENABLED',
      'NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED',
      'TRANSACTIONAL_EMAIL_ENABLED',
      'INVOICE_EMAIL_ENABLED'
    ])
      expect(output.vars[key]).toBe('false')
  })
  it('aligns preview authentication and public runtime without granting production access', () => {
    const output = config()
    expect(output.vars.APP_ENV).toBe('preview')
    expect(output.vars.DEMO_ENABLED).toBe('true')
    expect(output.vars.NUXT_PUBLIC_DEMO_ENABLED).toBe('true')
    for (const key of [
      'AUTH_ORIGIN',
      'PUBLIC_SITE_ORIGIN',
      'MEDIA_ADMIN_ORIGIN',
      'PAYMENT_PUBLIC_BASE_URL',
      'NEWSLETTER_PUBLIC_ORIGIN',
      'NUXT_PUBLIC_BASE_URL'
    ])
      expect(output.vars[key]).toBe(DEMO_ORIGIN)
    expect(JSON.stringify(output)).not.toContain('neteco-landing')
  })
})
